import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { BlockerFact } from '../../catalog/domain/lifecycle';
import { probeSources } from '../../catalog/contracts/dependency-probe';
import type { RoomState } from '../../catalog/contracts/room-reads';
import { lockRoom, readRoom, shareRoom } from '../../catalog/contracts/room-reads';
import { SAFE_POINT_SOURCES } from '../contracts/safe-point-sources';
import type { StockLine, TargetLine, TaskBound } from '../domain/inventory';
import { countVariances, reconciliationBounds, statusAgainstTarget } from '../domain/inventory';
import type {
  ChangeState,
  Eligibility,
  RoomEligibilityFacts,
  TargetFacts,
} from '../domain/versions';
import { isTerminalChange, rolloutEligibility } from '../domain/versions';
import type {
  ChangeKind,
  ChangeRow,
  ConfigurationRow,
  MinibarEntityType,
  TaskRow,
} from '../repositories/configuration.repository';
import { ConfigurationRepository } from '../repositories/configuration.repository';
import { InventoryRepository } from '../repositories/inventory.repository';
import type { VersionRow } from '../repositories/version.repository';
import { VersionRepository } from '../repositories/version.repository';
import type { CommandActor, MinibarDependencies, RequestContext } from './minibar-context';
import { MinibarServiceBase, claim } from './minibar-context';
import { insufficientStock } from './product.service';

/**
 * One current configuration, at most one pending change, and the reconciliation
 * that carries a room from one to the other (doc 26 §§14–23, §33; doc 22 §§6–8;
 * `RML-DEC-007`…`014`, `RML-DEC-022`…`024`, `INV-DEC-006`, `INV-DEC-007`).
 *
 * The shape of every command: lock in the module's order — products,
 * template, version (share), the catalog's room (share), the configuration,
 * the change, the task — authorize on that state, then compare-and-set, with
 * history, audit and outbox in the same transaction.
 *
 * **What the server decides and what a person confirms.** The server computes
 * the delta between what a room holds and what the pinned target says, and
 * hands the Cleaner a bounded task. The Cleaner confirms what physically moved,
 * within those bounds, and the ledger records it. The server then decides
 * again: apply, or block on stock or on a count variance for the Manager. A
 * change with posted movements is never cancelled; it is rolled back through
 * another bounded task (`RML-DEC-014`).
 *
 * **The safe point** is probed, not assumed: the stay, the checkout, the
 * report and the refill tasks are later phases' relations, and their absence
 * is evidence that nothing is in progress (doc 26 §15).
 */

const CHANGE_MANAGE = 'hotel.minibar.config_change_manage';
const ROLLOUT_SINGLE = 'hotel.minibar.rollout_single';
const RESOLUTION = 'hotel.minibar.config_resolution';
const EXECUTE = 'hotel.minibar.config_reconciliation_execute';
const OVERRIDE = 'hotel.minibar.shortage_override';
const VIEW = ['hotel.minibar.config_view', 'hotel.minibar.config_view.read'];

export interface ChangeView {
  readonly changeId: string;
  readonly roomId: string;
  readonly kind: ChangeKind;
  readonly targetTemplateId: string | null;
  readonly targetVersionId: string | null;
  readonly state: ChangeState;
  readonly batchId: string | null;
  readonly movementStarted: boolean;
  readonly blockerDetail: Record<string, unknown>;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly terminalAt: string | null;
  readonly revision: number;
}

export interface TaskView {
  readonly taskId: string;
  readonly changeId: string;
  readonly roomId: string;
  readonly kind: 'RECONCILE' | 'ROLLBACK';
  readonly state: TaskRow['state'];
  readonly bounds: readonly TaskBound[];
  readonly counted: readonly StockLine[] | null;
  readonly assignedAccountId: string | null;
  readonly revision: number;
}

/** What a check-in pins (doc 25 §3): see `ConfigurationService.checkInPin`. */
export interface CheckInPin {
  readonly blockers: readonly string[];
  readonly configuration: (ConfigurationRow & { readonly updatedAt: Date }) | null;
  readonly items: readonly {
    readonly productId: string;
    readonly targetQuantity: number;
    readonly name: string;
    readonly category: string | null;
    readonly unit: string | null;
    readonly sellingPriceMnt: bigint | null;
    readonly state: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  }[];
  readonly stock: readonly StockLine[];
}

export interface ConfigurationView {
  readonly roomId: string;
  readonly mode: 'ON' | 'OFF';
  readonly templateId: string | null;
  readonly currentVersionId: string | null;
  readonly minibarStatus: ConfigurationRow['minibarStatus'];
  readonly overrideId: string | null;
  readonly revision: number;
  readonly stock: readonly StockLine[];
  readonly pendingChange: ChangeView | null;
  readonly openTask: TaskView | null;
  /** doc 26 §3.1: why a new check-in would be refused, if it would. */
  readonly checkInBlockers: readonly string[];
  readonly safePoint: readonly BlockerFact[];
}

export function changeView(row: ChangeRow): ChangeView {
  return {
    changeId: row.changeId,
    roomId: row.roomId,
    kind: row.kind,
    targetTemplateId: row.targetTemplateId,
    targetVersionId: row.targetVersionId,
    state: row.state,
    batchId: row.batchId,
    movementStarted: row.movementStarted,
    blockerDetail: row.blockerDetail,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    terminalAt: row.terminalAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

export function taskView(row: TaskRow): TaskView {
  return {
    taskId: row.taskId,
    changeId: row.changeId,
    roomId: row.roomId,
    kind: row.kind,
    state: row.state,
    bounds: row.bounds,
    counted: row.counted,
    assignedAccountId: row.assignedAccountId,
    revision: row.revision,
  };
}

export interface RequestChangeInput {
  readonly hotelId: string;
  readonly roomId: string;
  readonly idempotencyKey: string;
  readonly kind: ChangeKind;
  readonly targetTemplateId?: string;
  readonly targetVersionId?: string;
  readonly reason?: string;
}

export interface ChangeCommand {
  readonly hotelId: string;
  readonly changeId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export interface TaskCommand {
  readonly hotelId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface CompleteTaskInput extends TaskCommand {
  /** What the Cleaner counted in the room before moving anything. */
  readonly counted: readonly StockLine[];
  /** What the Cleaner physically moved, each within its bound. */
  readonly transfers: readonly { readonly productId: string; readonly quantity: number }[];
}

/** The facts about a target the eligibility rules consume, read under share locks. */
interface ResolvedTarget {
  readonly version: VersionRow;
  readonly templateState: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly items: readonly TargetLine[];
  readonly everyProductActive: boolean;
  readonly facts: TargetFacts;
}

export class ConfigurationService extends MinibarServiceBase {
  constructor(deps: MinibarDependencies) {
    super(deps);
  }

  // ------------------------------------------------------------------ view

  async view(
    target: { hotelId: string; roomId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ConfigurationView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const room = await readRoom(uow, target.roomId);
        if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return this.buildView(uow, room);
      },
    );
  }

  /**
   * doc 26 §3.1 and doc 22 §9, as the contract Phase 08's check-in evaluates:
   * every reason a new check-in or assignment would be refused for this room's
   * minibar, in the caller's transaction and scope.
   */
  async checkInBlockers(uow: UnitOfWork, roomId: string): Promise<readonly string[]> {
    const configurations = new ConfigurationRepository(uow);
    const versions = new VersionRepository(uow);
    const inventory = new InventoryRepository(uow);
    const configuration = await configurations.configuration(roomId);
    const blockers: string[] = [];
    const pending = await configurations.pendingChangeOf(roomId);
    if (pending !== undefined) blockers.push('CONFIGURATION_CHANGE_PENDING');
    if (configuration === undefined || configuration.mode === 'OFF') return blockers;
    if (configuration.templateId === null || configuration.currentVersionId === null) {
      blockers.push('NO_CURRENT_VERSION');
      return blockers;
    }
    const template = await versions.templateById(configuration.templateId);
    if (template === undefined || template.state !== 'ACTIVE') blockers.push('TEMPLATE_NOT_ACTIVE');
    const version = await versions.versionById(configuration.currentVersionId);
    if (version === undefined || version.state !== 'PUBLISHED')
      blockers.push('VERSION_NOT_PUBLISHED');
    if (version !== undefined) {
      const items = await versions.itemsOf(version.versionId);
      const products = await inventory.productsByIds(items.map((item) => item.productId));
      if ([...products.values()].some((product) => product.state !== 'ACTIVE')) {
        blockers.push('PRODUCT_NOT_ACTIVE');
      }
    }
    if (configuration.minibarStatus === 'UNKNOWN') blockers.push('MINIBAR_STATUS_UNKNOWN');
    if (configuration.minibarStatus === 'SHORT' && configuration.overrideId === null) {
      blockers.push('MINIBAR_SHORT_WITHOUT_OVERRIDE');
    }
    return blockers;
  }

  /**
   * doc 25 §3, doc 22 §8: what a check-in pins in its own transaction — the
   * configuration share-locked, its blockers, and for an `ON` room the exact
   * version's product list with the selling prices in force and what the room
   * holds. The caller writes the price book from this and nothing else.
   */
  async checkInPin(uow: UnitOfWork, roomId: string): Promise<CheckInPin> {
    const configurations = new ConfigurationRepository(uow);
    const versions = new VersionRepository(uow);
    const inventory = new InventoryRepository(uow);
    const configuration = await configurations.shareConfiguration(roomId);
    const blockers = await this.checkInBlockers(uow, roomId);
    if (configuration === undefined || configuration.mode === 'OFF') {
      return { blockers, configuration: configuration ?? null, items: [], stock: [] };
    }
    const items =
      configuration.currentVersionId === null
        ? []
        : await versions.itemsOf(configuration.currentVersionId);
    const products = await inventory.productsByIds(items.map((item) => item.productId));
    return {
      blockers,
      configuration,
      items: items.map((item) => {
        const product = products.get(item.productId);
        return {
          productId: item.productId,
          targetQuantity: item.targetQuantity,
          name: product?.name ?? '',
          category: product?.category ?? null,
          unit: product?.unit ?? null,
          sellingPriceMnt: product?.sellingPriceMnt ?? null,
          state: product?.state ?? 'INACTIVE',
        };
      }),
      stock: await inventory.roomStock(roomId),
    };
  }

  /**
   * The Manager's shortage override was for the next stay; that stay has now
   * opened, so the pointer is cleared in the check-in's transaction and the
   * override row stays as the audited exception it was (doc 22 §8).
   */
  async consumeOverride(uow: UnitOfWork, roomId: string, stayId: string): Promise<void> {
    const configurations = new ConfigurationRepository(uow);
    const configuration = await configurations.configuration(roomId);
    if (configuration === undefined || configuration.overrideId === null) return;
    const cleared = await configurations.clearOverride(roomId, configuration.revision);
    if (cleared === undefined) throw new ApiError('CONFLICT', 'the configuration moved; retry');
    await configurations.appendEvent({
      entityType: 'SHORTAGE_OVERRIDE',
      entityId: configuration.overrideId,
      eventType: 'CONSUMED',
      payload: { roomId, stayId },
    });
  }

  // ---------------------------------------------- the checkout's contract

  /**
   * What a room physically holds, per product (doc 22 §8). The checkout's
   * report reads it to know what the Cleaner is counting against; the stay
   * module never touches the stock tables itself.
   */
  async roomHoldings(uow: UnitOfWork, roomId: string): Promise<ReadonlyMap<string, number>> {
    const inventory = new InventoryRepository(uow);
    return new Map(
      (await inventory.roomStock(roomId)).map((line) => [line.productId, line.quantity]),
    );
  }

  /**
   * doc 04 §5.1: the Cleaner's confirmation of an active-stay refill is one
   * atomic warehouse → room transfer, linked to the stay, the room, the product
   * and the task. The request that asked for it moved nothing.
   */
  async transferToRoom(
    uow: UnitOfWork,
    input: {
      roomId: string;
      productId: string;
      quantity: number;
      /** Absent for the routine refill between stays, which belongs to no stay. */
      stayId?: string;
      taskId?: string;
      actorAccountId: string;
    },
  ): Promise<string> {
    const inventory = new InventoryRepository(uow);
    const movement = await inventory.appendMovement({
      productId: input.productId,
      movementType: 'TRANSFER_TO_ROOM',
      location: 'TRANSFER',
      roomId: input.roomId,
      quantity: input.quantity,
      ...(input.stayId === undefined ? {} : { stayId: input.stayId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      actorAccountId: input.actorAccountId,
    });
    return movement.movementId;
  }

  /**
   * doc 04 §8: the guest's consumption leaves the room's stock when the report
   * that priced it settles. It is the one movement type the ledger calls a
   * sale, and it carries the stay it belongs to.
   *
   * doc 22 §4 and `FIN-DEC-003`: it also carries the **cost**. The hotel's
   * weighted average is snapshotted onto the movement at the moment of the
   * sale, because that is the number doc 23 §3.1's COGS is computed from — and
   * a report that read today's average instead would reprice a sale that
   * happened months ago, which doc 23 §12 forbids in as many words. A product
   * whose warehouse has never been costed carries no snapshot rather than a
   * zero: an unknown cost is not free.
   */
  async postGuestConsumption(
    uow: UnitOfWork,
    input: {
      roomId: string;
      productId: string;
      quantity: number;
      stayId: string;
      versionId: string;
      actorAccountId: string;
    },
  ): Promise<string> {
    const inventory = new InventoryRepository(uow);
    const stock = await inventory.warehouseStock(input.productId);
    const movement = await inventory.appendMovement({
      productId: input.productId,
      movementType: 'GUEST_CONSUMPTION',
      location: 'ROOM',
      roomId: input.roomId,
      quantity: input.quantity,
      stayId: input.stayId,
      taskId: input.versionId,
      ...(stock.avgCostMnt === null ? {} : { unitCostMnt: stock.avgCostMnt }),
      actorAccountId: input.actorAccountId,
    });
    return movement.movementId;
  }

  /**
   * doc 22 §6.2: what left a room during a stay without a guest consuming it —
   * a return to the warehouse, waste, or a negative count adjustment. The
   * report subtracts these from what the guest could have taken.
   */
  async nonGuestStockOut(
    uow: UnitOfWork,
    stayId: string,
  ): Promise<
    readonly {
      readonly movementId: string;
      readonly productId: string;
      readonly quantity: number;
    }[]
  > {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT movement_id, product_id, quantity FROM platform.inventory_movement
        WHERE hotel_id = $1 AND stay_id = $2
          AND movement_type IN ('RETURN_TO_WAREHOUSE', 'WASTE', 'ADJUST_MINUS')
        ORDER BY occurred_at`,
      [uow.context.hotelId, stayId],
    );
    return result.rows.map((row) => ({
      movementId: row['movement_id'] as string,
      productId: row['product_id'] as string,
      quantity: Number(row['quantity']),
    }));
  }

  // -------------------------------------------------------------- requests

  /**
   * A configuration change request, of any kind (doc 26 §§14–19, §33). The
   * eligibility of the target and the room is decided on rows locked for the
   * transaction; the pending change and its blocker come into existence in one
   * atomic step with no gap a check-in could use (doc 26 §33.2).
   */
  async requestChange(
    input: RequestChangeInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ChangeView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      input.kind === 'VERSION_ROLLOUT' ? ROLLOUT_SINGLE : CHANGE_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.request_change', input.idempotencyKey, {
          roomId: input.roomId,
          kind: input.kind,
          targetTemplateId: input.targetTemplateId ?? null,
          targetVersionId: input.targetVersionId ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as ChangeView;
        const outcome = await this.openChange(uow, gate.principal.accountId, input, authorize);
        if (outcome.kind === 'refused') throw outcome.error;
        const result = changeView(outcome.change);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * The change-opening core, shared with the batch service: validates the
   * target and the room under locks, creates the change in the state the safe
   * point dictates, and creates the task when the room is ready. `authorize`
   * runs after the locks and before any write; a batch passes one that has
   * already run, so the whole batch is one authorization.
   */
  async openChange(
    uow: UnitOfWork,
    actorAccountId: string,
    input: Omit<RequestChangeInput, 'idempotencyKey'> & { readonly batchId?: string },
    authorize: () => Promise<void>,
  ): Promise<
    { kind: 'opened'; change: ChangeRow } | { kind: 'refused'; error: ApiError; code: string }
  > {
    const configurations = new ConfigurationRepository(uow);
    const versions = new VersionRepository(uow);
    const inventory = new InventoryRepository(uow);

    // Locks, in order: the target's template and version (share), the
    // catalog's room (share), then the configuration row (update).
    let target: ResolvedTarget | undefined;
    if (input.kind !== 'ON_TO_OFF') {
      if (input.targetTemplateId === undefined || input.targetVersionId === undefined) {
        await authorize();
        return refused(
          'TARGET_REQUIRED',
          'VALIDATION_FAILED',
          'a target template and version are required',
        );
      }
      target = await this.resolveTarget(
        versions,
        inventory,
        input.targetTemplateId,
        input.targetVersionId,
      );
    }
    const room = await shareRoom(uow, input.roomId);
    if (room === undefined) {
      await authorize();
      return refused('ROOM_NOT_FOUND', 'NOT_FOUND', 'not found');
    }
    const configuration = await configurations.ensureConfiguration(input.roomId);
    await authorize();

    if (target === undefined && input.targetVersionId !== undefined) {
      return refused('TARGET_NOT_FOUND', 'NOT_FOUND', 'not found');
    }
    const pending = await configurations.pendingChangeOf(input.roomId);
    if (pending !== undefined) {
      return refused(
        'PENDING_CHANGE',
        'CONFLICT',
        'the room already has a pending configuration change',
      );
    }

    // Per-kind eligibility (doc 26 §§16–18, §33.1).
    const eligibility = this.eligibilityFor(input.kind, room, configuration, target);
    if (eligibility.kind === 'INELIGIBLE') {
      return refused(eligibility.code, 'CONFLICT', `INELIGIBLE: ${eligibility.code}`);
    }

    // The safe point, as evidence (doc 26 §15).
    const safePoint = await probeSources(uow, SAFE_POINT_SOURCES, input.roomId);
    const unavailable = safePoint.filter((fact) => fact.state === 'unavailable');
    if (unavailable.length > 0) {
      throw new ApiError(
        'DEPENDENCY_UNAVAILABLE',
        'a safe-point source could not be read; the request is refused rather than scheduled blind',
        unavailable.map((fact) => ({ field: fact.sourceId, issue: 'unavailable' })),
      );
    }
    const ready = safePoint.every((fact) => fact.state !== 'blocked');

    const change = await configurations.createChange({
      roomId: input.roomId,
      kind: input.kind,
      targetTemplateId: target?.version.templateId ?? null,
      targetVersionId: target?.version.versionId ?? null,
      state: ready ? 'READY_FOR_RECONCILIATION' : 'SCHEDULED_AFTER_STAY',
      ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      requestedBy: actorAccountId,
    });
    let task: TaskRow | undefined;
    if (ready) {
      task = await configurations.createTask({
        changeId: change.changeId,
        roomId: input.roomId,
        kind: 'RECONCILE',
        bounds: reconciliationBounds(await inventory.roomStock(input.roomId), target?.items ?? []),
      });
    }
    await this.record(uow, actorAccountId, 'CONFIGURATION_CHANGE', change.changeId, {
      eventType: 'REQUESTED',
      toState: change.state,
      action:
        input.kind === 'VERSION_ROLLOUT' ? 'minibar.rollout.confirm' : 'minibar.change.request',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      payload: {
        roomId: input.roomId,
        kind: input.kind,
        currentTemplateId: configuration.templateId,
        currentVersionId: configuration.currentVersionId,
        targetTemplateId: target?.version.templateId ?? null,
        targetVersionId: target?.version.versionId ?? null,
        batchId: input.batchId ?? null,
        safePoint: safePoint.map((fact) => ({ sourceId: fact.sourceId, state: fact.state })),
        taskId: task?.taskId ?? null,
      },
    });
    return { kind: 'opened', change };
  }

  /**
   * Phase 08's hook: re-evaluate a change scheduled behind a stay once the
   * stay's checkout, payment, report and refills are terminal (doc 26 §15).
   * Idempotent: a change already ready, or still blocked, is left alone.
   */
  async advanceScheduled(
    uow: UnitOfWork,
    roomId: string,
    trigger: string,
  ): Promise<ChangeRow | undefined> {
    const configurations = new ConfigurationRepository(uow);
    const inventory = new InventoryRepository(uow);
    const versions = new VersionRepository(uow);
    const pending = await configurations.pendingChangeOf(roomId);
    if (pending === undefined || pending.state !== 'SCHEDULED_AFTER_STAY') return pending;
    const locked = await configurations.lockChange(pending.changeId);
    if (locked === undefined || locked.state !== 'SCHEDULED_AFTER_STAY') return locked;
    const safePoint = await probeSources(uow, SAFE_POINT_SOURCES, roomId);
    if (safePoint.some((fact) => fact.state === 'unavailable')) {
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'a safe-point source could not be read');
    }
    if (safePoint.some((fact) => fact.state === 'blocked')) return locked;
    const moved = await configurations.transitionChange({
      changeId: locked.changeId,
      expectedRevision: locked.revision,
      toState: 'READY_FOR_RECONCILIATION',
    });
    if (moved === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
    const items =
      locked.targetVersionId === null ? [] : await versions.itemsOf(locked.targetVersionId);
    const task = await configurations.createTask({
      changeId: locked.changeId,
      roomId,
      kind: 'RECONCILE',
      bounds: reconciliationBounds(await inventory.roomStock(roomId), items),
    });
    await this.record(uow, uow.context.accountId ?? '', 'CONFIGURATION_CHANGE', locked.changeId, {
      eventType: 'SAFE_POINT_REACHED',
      fromState: 'SCHEDULED_AFTER_STAY',
      toState: 'READY_FOR_RECONCILIATION',
      action: 'minibar.change.safe_point',
      payload: { trigger, taskId: task.taskId },
    });
    return moved;
  }

  /** Cancels a change no movement has been posted for (doc 26 §20). */
  async cancelChange(
    input: ChangeCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ChangeView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHANGE_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.cancel_change', input.idempotencyKey, {
          changeId: input.changeId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ChangeView;
        const configurations = new ConfigurationRepository(uow);
        const change = await configurations.changeById(input.changeId);
        if (change === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        await configurations.ensureConfiguration(change.roomId);
        const locked = await configurations.lockChange(input.changeId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked.revision, input.expectedRevision);
        if (isTerminalChange(locked.state)) {
          throw new ApiError('CONFLICT', `the change is already ${locked.state}`);
        }
        if (locked.movementStarted) {
          throw new ApiError(
            'CONFLICT',
            'MOVEMENT_STARTED: a change with posted movements is rolled back, not cancelled',
          );
        }
        const moved = await configurations.transitionChange({
          changeId: input.changeId,
          expectedRevision: locked.revision,
          toState: 'CANCELLED',
        });
        if (moved === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
        const task = await configurations.openTaskOf(input.changeId);
        if (task !== undefined) {
          await configurations.finishTask({
            taskId: task.taskId,
            expectedRevision: task.revision,
            state: 'CANCELLED',
          });
        }
        await this.record(uow, gate.principal.accountId, 'CONFIGURATION_CHANGE', input.changeId, {
          eventType: 'CANCELLED',
          fromState: locked.state,
          toState: 'CANCELLED',
          action: 'minibar.change.cancel',
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { roomId: locked.roomId, taskCancelled: task?.taskId ?? null },
        });
        const result = changeView(moved);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * Rolls back a change whose movements have been posted (doc 26 §20): the
   * reconciliation task is cancelled, and a rollback task carrying the exact
   * reverse of what was moved is created for the Cleaner.
   */
  async requestRollback(
    input: ChangeCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ChangeView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RESOLUTION,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.request_rollback', input.idempotencyKey, {
          changeId: input.changeId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ChangeView;
        const configurations = new ConfigurationRepository(uow);
        const inventory = new InventoryRepository(uow);
        const change = await configurations.changeById(input.changeId);
        if (change === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        await configurations.ensureConfiguration(change.roomId);
        const locked = await configurations.lockChange(input.changeId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked.revision, input.expectedRevision);
        if (isTerminalChange(locked.state) || locked.state === 'ROLLBACK_REQUIRED') {
          throw new ApiError('CONFLICT', `the change is ${locked.state}`);
        }
        if (!locked.movementStarted) {
          throw new ApiError(
            'CONFLICT',
            'NO_MOVEMENT: nothing was posted; cancel the change instead',
          );
        }
        const moved = await configurations.transitionChange({
          changeId: input.changeId,
          expectedRevision: locked.revision,
          toState: 'ROLLBACK_REQUIRED',
        });
        if (moved === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
        const open = await configurations.openTaskOf(input.changeId);
        if (open !== undefined) {
          await configurations.finishTask({
            taskId: open.taskId,
            expectedRevision: open.revision,
            state: 'CANCELLED',
          });
        }
        const bounds = rollbackBounds(
          await inventory.movementsForChange(input.changeId),
          await inventory.roomStock(locked.roomId),
        );
        const task = await configurations.createTask({
          changeId: input.changeId,
          roomId: locked.roomId,
          kind: 'ROLLBACK',
          bounds,
        });
        await this.record(uow, gate.principal.accountId, 'CONFIGURATION_CHANGE', input.changeId, {
          eventType: 'ROLLBACK_REQUESTED',
          fromState: locked.state,
          toState: 'ROLLBACK_REQUIRED',
          action: 'minibar.change.rollback_request',
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { roomId: locked.roomId, rollbackTaskId: task.taskId, bounds },
        });
        const result = changeView(moved);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The Manager's resolution of a blocked change (doc 26 §§17–18, §20): after
   * corrections or a receipt, re-evaluate; with `applyWithOverride`, apply a
   * target shortage as `SHORT` under an audited exception (doc 22 §8).
   */
  async resolveChange(
    input: ChangeCommand & { readonly applyWithOverride?: { readonly reason: string } },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ChangeView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RESOLUTION,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.resolve_change', input.idempotencyKey, {
          changeId: input.changeId,
          expectedRevision: input.expectedRevision,
          override: input.applyWithOverride?.reason ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as ChangeView;
        const configurations = new ConfigurationRepository(uow);
        const inventory = new InventoryRepository(uow);
        const versions = new VersionRepository(uow);
        const change = await configurations.changeById(input.changeId);
        if (change === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const target =
          change.targetTemplateId === null || change.targetVersionId === null
            ? undefined
            : await this.resolveTarget(
                versions,
                inventory,
                change.targetTemplateId,
                change.targetVersionId,
              );
        // The room is locked outright, not shared: this command finalizes the
        // room's retirement further down, and upgrading a share to an exclusive
        // lock there deadlocks against a check-in that shares the same room and
        // waits for this configuration (doc 26 §2; one order everywhere — the
        // room first, then its configuration).
        const room = await lockRoom(uow, change.roomId);
        const configuration = await configurations.ensureConfiguration(change.roomId);
        const locked = await configurations.lockChange(input.changeId);
        await authorize();
        if (locked === undefined || room === undefined)
          throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked.revision, input.expectedRevision);
        if (locked.state !== 'BLOCKED_STOCK' && locked.state !== 'BLOCKED_VARIANCE') {
          throw new ApiError('CONFLICT', `the change is ${locked.state}, not blocked`);
        }
        const task = await configurations.openTaskOf(input.changeId);
        const held = await inventory.roomStock(locked.roomId);
        if (locked.state === 'BLOCKED_VARIANCE') {
          // The Cleaner's count and the ledger must agree again: the Manager's
          // reasoned correction against the change is what brings them together.
          const variances = countVariances(held, task?.counted ?? held);
          if (variances.length > 0) {
            throw new ApiError(
              'CONFLICT',
              'VARIANCE_UNRESOLVED: the count still differs from the ledger; record a waste or adjustment',
              variances.map((v) => ({
                field: v.productId,
                issue: `held ${String(v.held)}, counted ${String(v.counted)}`,
              })),
            );
          }
        }
        const items = target?.items ?? [];
        const outcome = await this.evaluate(inventory, locked, held, items, target);
        if (outcome.kind === 'apply') {
          const applied = await this.apply(
            uow,
            gate.principal.accountId,
            room,
            configuration,
            locked,
            target,
            held,
            null,
          );
          const result = changeView(applied);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }
        // With an override the Manager accepts a shortage for the next stay
        // (`RML-DEC-010`). Excess is never overridden: the Cleaner returns it.
        if (input.applyWithOverride !== undefined) {
          if (outcome.kind === 'excess') {
            throw new ApiError(
              'CONFLICT',
              'EXCESS_STOCK: the room holds products the target does not; the Cleaner returns them',
              outcome.detail,
            );
          }
          if (locked.kind === 'ON_TO_OFF') {
            throw new ApiError('CONFLICT', 'an ON → OFF change has no shortage to override');
          }
          const override = await configurations.createOverride({
            roomId: locked.roomId,
            snapshot: { held, target: items, shortages: outcome.detail },
            reason: input.applyWithOverride.reason,
            createdBy: gate.principal.accountId,
          });
          await this.record(
            uow,
            gate.principal.accountId,
            'SHORTAGE_OVERRIDE',
            override.overrideId,
            {
              eventType: 'CREATED',
              action: 'minibar.override.create',
              reason: input.applyWithOverride.reason,
              payload: {
                roomId: locked.roomId,
                changeId: locked.changeId,
                shortages: outcome.detail,
              },
            },
          );
          const applied = await this.apply(
            uow,
            gate.principal.accountId,
            room,
            configuration,
            locked,
            target,
            held,
            override.overrideId,
          );
          const result = changeView(applied);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }
        // Work remains for the Cleaner — excess to return, or a shortage the
        // warehouse can now supply — against bounds recomputed from what the
        // room holds now.
        if (outcome.kind === 'excess' || outcome.warehouseCanSupply) {
          const moved = await configurations.transitionChange({
            changeId: locked.changeId,
            expectedRevision: locked.revision,
            toState: 'IN_PROGRESS',
            blockerDetail: {},
          });
          if (moved === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
          const bounds = reconciliationBounds(held, items);
          if (task === undefined) {
            await configurations.createTask({
              changeId: locked.changeId,
              roomId: locked.roomId,
              kind: 'RECONCILE',
              bounds,
            });
          } else if ((await configurations.reboundTask(task.taskId, bounds)) === undefined) {
            throw new ApiError('CONFLICT', 'the task moved; retry');
          }
          await this.record(
            uow,
            gate.principal.accountId,
            'CONFIGURATION_CHANGE',
            locked.changeId,
            {
              eventType: 'UNBLOCKED',
              fromState: locked.state,
              toState: 'IN_PROGRESS',
              action: 'minibar.change.resolve',
              payload: { roomId: locked.roomId },
            },
          );
          const result = changeView(moved);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }
        throw new ApiError(
          'CONFLICT',
          'STOCK_SHORT: the warehouse cannot supply the target; receive stock or apply with an override',
          outcome.detail,
        );
      },
    );
  }

  /** doc 22 §8: the exception for the next stay of a room that is short with no change pending. */
  async createOverride(
    input: { hotelId: string; roomId: string; idempotencyKey: string; reason: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{
    readonly overrideId: string;
    readonly roomId: string;
    readonly minibarStatus: string;
  }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OVERRIDE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.create_override', input.idempotencyKey, {
          roomId: input.roomId,
        });
        if (claimed.kind === 'replay')
          return claimed.body as { overrideId: string; roomId: string; minibarStatus: string };
        const configurations = new ConfigurationRepository(uow);
        const inventory = new InventoryRepository(uow);
        const versions = new VersionRepository(uow);
        const room = await shareRoom(uow, input.roomId);
        const configuration = await configurations.ensureConfiguration(input.roomId);
        await authorize();
        if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (configuration.mode !== 'ON' || configuration.currentVersionId === null) {
          throw new ApiError('CONFLICT', 'the room has no minibar to open short');
        }
        if ((await configurations.pendingChangeOf(input.roomId)) !== undefined) {
          throw new ApiError('CONFLICT', 'PENDING_CHANGE: resolve the pending change first');
        }
        if (configuration.minibarStatus !== 'SHORT') {
          throw new ApiError(
            'CONFLICT',
            `the minibar is ${configuration.minibarStatus}, not SHORT`,
          );
        }
        const held = await inventory.roomStock(input.roomId);
        const target = await versions.itemsOf(configuration.currentVersionId);
        const override = await configurations.createOverride({
          roomId: input.roomId,
          snapshot: { held, target },
          reason: input.reason,
          createdBy: gate.principal.accountId,
        });
        const written = await configurations.writeConfiguration({
          roomId: input.roomId,
          expectedRevision: configuration.revision,
          mode: 'ON',
          templateId: configuration.templateId,
          currentVersionId: configuration.currentVersionId,
          minibarStatus: 'SHORT',
          overrideId: override.overrideId,
        });
        if (written === undefined) throw new ApiError('CONFLICT', 'the configuration moved; retry');
        await this.record(uow, gate.principal.accountId, 'SHORTAGE_OVERRIDE', override.overrideId, {
          eventType: 'CREATED',
          action: 'minibar.override.create',
          reason: input.reason,
          payload: { roomId: input.roomId, held, target },
        });
        const result = {
          overrideId: override.overrideId,
          roomId: input.roomId,
          minibarStatus: 'SHORT',
        };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  // --------------------------------------------------------- Cleaner tasks

  async myTasks(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly TaskView[]> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId },
      EXECUTE,
      request,
      async (uow, gate, authorize) => {
        await authorize();
        const configurations = new ConfigurationRepository(uow);
        return (await configurations.tasksVisibleTo(gate.principal.accountId)).map(taskView);
      },
    );
  }

  /** Atomic claim of an open task (doc 04 §5.3). */
  async claimTask(
    input: TaskCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TaskView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      EXECUTE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.claim_task', input.idempotencyKey, {
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as TaskView;
        const configurations = new ConfigurationRepository(uow);
        const task = await configurations.lockTask(input.taskId);
        await authorize();
        if (task === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (task.state === 'CLAIMED' && task.assignedAccountId === gate.principal.accountId) {
          const same = taskView(task);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, same);
          return same;
        }
        if (task.state !== 'OPEN') throw new ApiError('CONFLICT', `the task is ${task.state}`);
        this.requireRevision(task.revision, input.expectedRevision);
        const taken = await configurations.claimTask(
          input.taskId,
          task.revision,
          gate.principal.accountId,
        );
        if (taken === undefined) throw new ApiError('CONFLICT', 'the task was taken');
        const change = await configurations.lockChange(task.changeId);
        if (change !== undefined && change.state === 'READY_FOR_RECONCILIATION') {
          await configurations.transitionChange({
            changeId: change.changeId,
            expectedRevision: change.revision,
            toState: 'IN_PROGRESS',
          });
        }
        await this.record(uow, gate.principal.accountId, 'RECONCILIATION_TASK', input.taskId, {
          eventType: 'CLAIMED',
          fromState: 'OPEN',
          toState: 'CLAIMED',
          action: 'minibar.task.claim',
          payload: { changeId: task.changeId, roomId: task.roomId },
        });
        const result = taskView(taken);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The Cleaner's confirmation: the count, and the transfers actually made,
   * each within its bound (doc 26 §§16–18, §21). The server posts the
   * movements, then decides: apply, block on stock, or block on variance.
   * A retry with the same key posts nothing twice; a retry with a new key
   * and the same transfers is refused by the bound, which the first posting
   * has already consumed.
   */
  async completeTask(
    input: CompleteTaskInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ readonly task: TaskView; readonly change: ChangeView }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      EXECUTE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.complete_task', input.idempotencyKey, {
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          counted: input.counted,
          transfers: input.transfers,
        });
        if (claimed.kind === 'replay')
          return claimed.body as { task: TaskView; change: ChangeView };
        const configurations = new ConfigurationRepository(uow);
        const inventory = new InventoryRepository(uow);
        const versions = new VersionRepository(uow);

        const peek = await configurations.taskById(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        // Products first, in id order, then the room, the configuration, the
        // change and the task.
        await inventory.lockProducts(peek.bounds.map((bound) => bound.productId));
        const change0 = await configurations.changeById(peek.changeId);
        const target =
          change0?.targetTemplateId != null && change0.targetVersionId != null
            ? await this.resolveTarget(
                versions,
                inventory,
                change0.targetTemplateId,
                change0.targetVersionId,
              )
            : undefined;
        // The room is locked outright, not shared: this command finalizes the
        // room's retirement further down, and upgrading a share to an exclusive
        // lock there deadlocks against a check-in that shares the same room and
        // waits for this configuration (doc 26 §2; one order everywhere — the
        // room first, then its configuration).
        const room = await lockRoom(uow, peek.roomId);
        const configuration = await configurations.ensureConfiguration(peek.roomId);
        const change = await configurations.lockChange(peek.changeId);
        const task = await configurations.lockTask(input.taskId);
        await authorize();
        if (task === undefined || change === undefined || room === undefined) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        // doc 18 §3: a Cleaner works only its own assigned task.
        if (task.state !== 'CLAIMED' || task.assignedAccountId !== gate.principal.accountId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        this.requireRevision(task.revision, input.expectedRevision);
        if (isTerminalChange(change.state))
          throw new ApiError('CONFLICT', `the change is ${change.state}`);

        // Every transfer inside its bound; anything else is refused whole.
        const bounds = new Map(task.bounds.map((bound) => [bound.productId, bound]));
        for (const transfer of input.transfers) {
          const bound = bounds.get(transfer.productId);
          if (bound === undefined) {
            throw new ApiError(
              'VALIDATION_FAILED',
              'OUT_OF_BOUNDS: the product is not in the task',
              [{ field: transfer.productId, issue: 'not in task' }],
            );
          }
          if (
            !Number.isInteger(transfer.quantity) ||
            transfer.quantity < 1 ||
            transfer.quantity > bound.maxQuantity
          ) {
            throw new ApiError(
              'VALIDATION_FAILED',
              'OUT_OF_BOUNDS: the quantity exceeds the task',
              [{ field: transfer.productId, issue: `at most ${String(bound.maxQuantity)}` }],
            );
          }
        }

        const heldBefore = await inventory.roomStock(task.roomId);
        // A rollback reverses exact postings (doc 26 §20); only a reconciliation
        // starts from the Cleaner's count of the room.
        const variances = task.kind === 'ROLLBACK' ? [] : countVariances(heldBefore, input.counted);
        if (variances.length > 0) {
          // The count disagrees with the ledger: nothing moves until the
          // Manager has resolved it with a reasoned correction.
          const recorded = await configurations.recordCount(
            task.taskId,
            task.revision,
            input.counted,
          );
          const blocked = await configurations.transitionChange({
            changeId: change.changeId,
            expectedRevision: change.revision,
            toState: 'BLOCKED_VARIANCE',
            blockerDetail: { variances },
          });
          if (recorded === undefined || blocked === undefined)
            throw new ApiError('CONFLICT', 'the task moved; retry');
          await this.record(
            uow,
            gate.principal.accountId,
            'CONFIGURATION_CHANGE',
            change.changeId,
            {
              eventType: 'BLOCKED_VARIANCE',
              fromState: change.state,
              toState: 'BLOCKED_VARIANCE',
              action: 'minibar.task.count_variance',
              payload: { taskId: task.taskId, roomId: task.roomId, variances },
            },
          );
          const result = { task: taskView(recorded), change: changeView(blocked) };
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }

        // Post the transfers. The ledger refuses an over-draw as a movement.
        let movementStarted = change.movementStarted;
        for (const transfer of input.transfers) {
          const bound = bounds.get(transfer.productId) as TaskBound;
          try {
            await inventory.appendMovement({
              productId: transfer.productId,
              movementType:
                bound.direction === 'TO_ROOM' ? 'TRANSFER_TO_ROOM' : 'RETURN_TO_WAREHOUSE',
              location: 'TRANSFER',
              roomId: task.roomId,
              quantity: transfer.quantity,
              taskId: task.taskId,
              configurationChangeId: change.changeId,
              actorAccountId: gate.principal.accountId,
            });
          } catch (error) {
            throw insufficientStock(error) ?? error;
          }
          movementStarted = true;
        }
        const recorded = await configurations.recordCount(
          task.taskId,
          task.revision,
          input.counted,
        );
        if (recorded === undefined) throw new ApiError('CONFLICT', 'the task moved; retry');
        let current = change;
        if (movementStarted && !change.movementStarted) {
          const marked = await configurations.markMovementStarted(change.changeId, change.revision);
          if (marked === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
          current = marked;
        }
        // Shrink the bounds by what was moved, so a second confirmation cannot
        // move the same quantity again (doc 22 §11).
        const remaining = task.bounds
          .map((bound) => {
            const moved =
              input.transfers.find((t) => t.productId === bound.productId)?.quantity ?? 0;
            return { ...bound, maxQuantity: bound.maxQuantity - moved };
          })
          .filter((bound) => bound.maxQuantity > 0);
        const rebounded = await configurations.reboundTask(task.taskId, remaining);
        if (rebounded === undefined) throw new ApiError('CONFLICT', 'the task moved; retry');
        const held = await inventory.roomStock(task.roomId);

        if (task.kind === 'ROLLBACK') {
          // Restored when every bound is exhausted and every reversed product
          // is back at the quantity the room held before the change posted.
          const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
          const restored =
            remaining.length === 0 &&
            task.bounds.every(
              (bound) => (holdings.get(bound.productId) ?? 0) === bound.targetQuantity,
            );
          if (restored) {
            const rolled = await configurations.transitionChange({
              changeId: current.changeId,
              expectedRevision: current.revision,
              toState: 'ROLLED_BACK',
            });
            const done = await configurations.finishTask({
              taskId: task.taskId,
              expectedRevision: rebounded.revision,
              state: 'COMPLETED',
            });
            if (rolled === undefined || done === undefined)
              throw new ApiError('CONFLICT', 'the change moved; retry');
            await this.record(
              uow,
              gate.principal.accountId,
              'CONFIGURATION_CHANGE',
              change.changeId,
              {
                eventType: 'ROLLED_BACK',
                fromState: 'ROLLBACK_REQUIRED',
                toState: 'ROLLED_BACK',
                action: 'minibar.change.rolled_back',
                payload: { taskId: task.taskId, roomId: task.roomId },
              },
            );
            const result = { task: taskView(done), change: changeView(rolled) };
            await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
            return result;
          }
          const stillOpen = await configurations.taskById(task.taskId);
          const result = { task: taskView(stillOpen as TaskRow), change: changeView(current) };
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }

        const items = target?.items ?? [];
        const outcome = await this.evaluate(inventory, current, held, items, target);
        if (outcome.kind === 'apply') {
          const applied = await this.apply(
            uow,
            gate.principal.accountId,
            room,
            configuration,
            current,
            target,
            held,
            null,
          );
          const done = await configurations.taskById(task.taskId);
          const result = { task: taskView(done as TaskRow), change: changeView(applied) };
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }
        const toState: ChangeState =
          outcome.kind === 'excess' ? 'BLOCKED_VARIANCE' : 'BLOCKED_STOCK';
        const blocked = await configurations.transitionChange({
          changeId: current.changeId,
          expectedRevision: current.revision,
          toState,
          blockerDetail: { [outcome.kind]: outcome.detail },
        });
        if (blocked === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
        await this.record(uow, gate.principal.accountId, 'CONFIGURATION_CHANGE', change.changeId, {
          eventType: toState,
          fromState: current.state,
          toState,
          action: 'minibar.task.blocked',
          payload: { taskId: task.taskId, roomId: task.roomId, detail: outcome.detail },
        });
        const still = await configurations.taskById(task.taskId);
        const result = { task: taskView(still as TaskRow), change: changeView(blocked) };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  // ------------------------------------------------------------ internals

  private eligibilityFor(
    kind: ChangeKind,
    room: RoomState,
    configuration: ConfigurationRow,
    target: ResolvedTarget | undefined,
  ): Eligibility {
    if (kind === 'ON_TO_OFF') {
      if (configuration.mode !== 'ON') return { kind: 'INELIGIBLE', code: 'MINIBAR_OFF' };
      return { kind: 'READY_NOW' };
    }
    if (target === undefined) return { kind: 'INELIGIBLE', code: 'TARGET_NOT_PUBLISHED' };
    if (kind === 'VERSION_ROLLOUT') {
      const facts: RoomEligibilityFacts = {
        roomState: room.state,
        mode: configuration.mode,
        currentTemplateId: configuration.templateId,
        currentVersionId: configuration.currentVersionId,
        hasPendingChange: false,
        safePoint: true,
      };
      return rolloutEligibility(facts, target.facts);
    }
    // OFF → ON and a template switch share the target rules of §33.1 minus
    // the same-template clause.
    if (target.facts.versionState !== 'PUBLISHED')
      return { kind: 'INELIGIBLE', code: 'TARGET_NOT_PUBLISHED' };
    if (target.facts.templateState !== 'ACTIVE')
      return { kind: 'INELIGIBLE', code: 'TARGET_TEMPLATE_NOT_ACTIVE' };
    if (!target.everyProductActive)
      return { kind: 'INELIGIBLE', code: 'TARGET_PRODUCT_NOT_ACTIVE' };
    if (room.state !== 'ACTIVE') return { kind: 'INELIGIBLE', code: 'ROOM_NOT_ACTIVE' };
    if (kind === 'OFF_TO_ON' && configuration.mode !== 'OFF') {
      return { kind: 'INELIGIBLE', code: 'ALREADY_ON_TARGET' };
    }
    if (kind === 'TEMPLATE_SWITCH') {
      if (configuration.mode !== 'ON') return { kind: 'INELIGIBLE', code: 'MINIBAR_OFF' };
      if (configuration.templateId === target.facts.templateId) {
        return { kind: 'INELIGIBLE', code: 'DIFFERENT_TEMPLATE' };
      }
    }
    return { kind: 'READY_NOW' };
  }

  private async resolveTarget(
    versions: VersionRepository,
    inventory: InventoryRepository,
    templateId: string,
    versionId: string,
  ): Promise<ResolvedTarget | undefined> {
    const template = await versions.templateById(templateId);
    const version = await versions.shareVersion(versionId);
    if (template === undefined || version === undefined || version.templateId !== templateId) {
      return undefined;
    }
    const items = await versions.itemsOf(versionId);
    const products = await inventory.productsByIds(items.map((item) => item.productId));
    const everyProductActive =
      items.length > 0 && items.every((item) => products.get(item.productId)?.state === 'ACTIVE');
    return {
      version,
      templateState: template.state,
      items,
      everyProductActive,
      facts: {
        templateId,
        versionId,
        versionState: version.state,
        templateState: template.state,
        everyProductActive,
      },
    };
  }

  /** What the room's stock says about the change now: apply, excess, or short. */
  private async evaluate(
    inventory: InventoryRepository,
    change: ChangeRow,
    held: readonly StockLine[],
    items: readonly TargetLine[],
    target: ResolvedTarget | undefined,
  ): Promise<
    | { kind: 'apply' }
    | { kind: 'excess'; detail: { field: string; issue: string }[] }
    | { kind: 'short'; detail: { field: string; issue: string }[]; warehouseCanSupply: boolean }
  > {
    const targets = new Map(items.map((item) => [item.productId, item.targetQuantity]));
    const excess = held
      .filter((line) => line.quantity > (targets.get(line.productId) ?? 0))
      .map((line) => ({
        field: line.productId,
        issue: `holds ${String(line.quantity)}, target ${String(targets.get(line.productId) ?? 0)}`,
      }));
    if (excess.length > 0) return { kind: 'excess', detail: excess };
    if (change.kind === 'ON_TO_OFF') return { kind: 'apply' };
    if (target === undefined) return { kind: 'apply' };
    const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
    const short: { field: string; issue: string }[] = [];
    let warehouseCanSupply = true;
    for (const item of items) {
      const have = holdings.get(item.productId) ?? 0;
      if (have < item.targetQuantity) {
        const missing = item.targetQuantity - have;
        const warehouse = await inventory.warehouseStock(item.productId);
        if (warehouse.quantity < missing) warehouseCanSupply = false;
        short.push({
          field: item.productId,
          issue: `short by ${String(missing)}; warehouse holds ${String(warehouse.quantity)}`,
        });
      }
    }
    if (short.length === 0) return { kind: 'apply' };
    return { kind: 'short', detail: short, warehouseCanSupply };
  }

  /**
   * The atomic apply (doc 26 §20): the configuration switches, the change goes
   * `APPLIED`, the task completes, and the catalog is told which blockers may
   * have cleared. Nothing here touches cleaning status.
   */
  private async apply(
    uow: UnitOfWork,
    actorAccountId: string,
    room: RoomState,
    configuration: ConfigurationRow,
    change: ChangeRow,
    target: ResolvedTarget | undefined,
    held: readonly StockLine[],
    overrideId: string | null,
  ): Promise<ChangeRow> {
    const configurations = new ConfigurationRepository(uow);
    const versions = new VersionRepository(uow);
    if (target !== undefined) {
      // Final recheck under the locks held (doc 26 §20).
      if (
        target.version.state !== 'PUBLISHED' ||
        target.templateState !== 'ACTIVE' ||
        !target.everyProductActive
      ) {
        throw new ApiError(
          'CONFLICT',
          'TARGET_NO_LONGER_ELIGIBLE: the pinned target is not published and active',
        );
      }
    }
    const previousTemplateId = configuration.templateId;
    const previousVersionId = configuration.currentVersionId;
    const written =
      change.kind === 'ON_TO_OFF'
        ? await configurations.writeConfiguration({
            roomId: room.roomId,
            expectedRevision: configuration.revision,
            mode: 'OFF',
            templateId: null,
            currentVersionId: null,
            minibarStatus: 'NOT_APPLICABLE',
            overrideId: null,
          })
        : await configurations.writeConfiguration({
            roomId: room.roomId,
            expectedRevision: configuration.revision,
            mode: 'ON',
            templateId: (target as ResolvedTarget).version.templateId,
            currentVersionId: (target as ResolvedTarget).version.versionId,
            minibarStatus:
              overrideId === null
                ? statusAgainstTarget(held, (target as ResolvedTarget).items)
                : 'SHORT',
            overrideId,
          });
    if (written === undefined) throw new ApiError('CONFLICT', 'the configuration moved; retry');
    const applied = await configurations.transitionChange({
      changeId: change.changeId,
      expectedRevision: change.revision,
      toState: 'APPLIED',
      blockerDetail: {},
    });
    if (applied === undefined) throw new ApiError('CONFLICT', 'the change moved; retry');
    const open = await configurations.openTaskOf(change.changeId);
    if (open !== undefined) {
      await configurations.finishTask({
        taskId: open.taskId,
        expectedRevision: open.revision,
        state: 'COMPLETED',
      });
    }
    await this.record(uow, actorAccountId, 'CONFIGURATION_CHANGE', change.changeId, {
      eventType: 'APPLIED',
      fromState: change.state,
      toState: 'APPLIED',
      action: 'minibar.change.apply',
      payload: {
        roomId: room.roomId,
        kind: change.kind,
        previousTemplateId,
        previousVersionId,
        templateId: written.templateId,
        currentVersionId: written.currentVersionId,
        minibarStatus: written.minibarStatus,
        overrideId,
        held,
      },
    });
    await this.record(uow, actorAccountId, 'ROOM_CONFIGURATION', room.roomId, {
      eventType: 'SWITCHED',
      action: 'minibar.configuration.switch',
      payload: {
        changeId: change.changeId,
        mode: written.mode,
        templateId: written.templateId,
        currentVersionId: written.currentVersionId,
        minibarStatus: written.minibarStatus,
      },
    });

    // Blockers that may have cleared (doc 26 §2): the room's own minibar, the
    // template it left, and the products no longer in any active version.
    await this.deps.lifecycle.finalizeIfClear(uow, 'ROOM', room.roomId, {
      source: 'minibar.configuration.applied',
      actorAccountId,
    });
    if (previousTemplateId !== null && previousTemplateId !== written.templateId) {
      await this.deps.lifecycle.finalizeIfClear(uow, 'MINIBAR_TEMPLATE', previousTemplateId, {
        source: 'minibar.configuration.applied',
        actorAccountId,
      });
    }
    if (previousVersionId !== null) {
      const previousItems = await versions.itemsOf(previousVersionId);
      const nowListed = new Set((target?.items ?? []).map((item) => item.productId));
      for (const item of previousItems) {
        if (nowListed.has(item.productId)) continue;
        await this.deps.lifecycle.finalizeIfClear(uow, 'MINIBAR_PRODUCT', item.productId, {
          source: 'minibar.configuration.applied',
          actorAccountId,
        });
      }
    }
    return applied;
  }

  private async buildView(uow: UnitOfWork, room: RoomState): Promise<ConfigurationView> {
    const configurations = new ConfigurationRepository(uow);
    const inventory = new InventoryRepository(uow);
    const configuration = (await configurations.configuration(room.roomId)) ?? {
      roomId: room.roomId,
      mode: 'OFF' as const,
      templateId: null,
      currentVersionId: null,
      minibarStatus: 'NOT_APPLICABLE' as const,
      overrideId: null,
      revision: 0,
    };
    const pending = await configurations.pendingChangeOf(room.roomId);
    const task =
      pending === undefined ? undefined : await configurations.openTaskOf(pending.changeId);
    return {
      roomId: room.roomId,
      mode: configuration.mode,
      templateId: configuration.templateId,
      currentVersionId: configuration.currentVersionId,
      minibarStatus: configuration.minibarStatus,
      overrideId: configuration.overrideId,
      revision: configuration.revision,
      stock: await inventory.roomStock(room.roomId),
      pendingChange: pending === undefined ? null : changeView(pending),
      openTask: task === undefined ? null : taskView(task),
      checkInBlockers: await this.checkInBlockers(uow, room.roomId),
      safePoint: await probeSources(uow, SAFE_POINT_SOURCES, room.roomId),
    };
  }

  private requireRevision(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new ApiError(
        'CONFLICT',
        `the row is at revision ${String(actual)}, not ${String(expected)}`,
      );
    }
  }

  private async record(
    uow: UnitOfWork,
    actorAccountId: string,
    entityType: MinibarEntityType,
    entityId: string,
    detail: {
      eventType: string;
      fromState?: string;
      toState?: string;
      action: string;
      reason?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await new ConfigurationRepository(uow).appendEvent({
      entityType,
      entityId,
      eventType: detail.eventType,
      ...(detail.fromState === undefined ? {} : { fromState: detail.fromState }),
      ...(detail.toState === undefined ? {} : { toState: detail.toState }),
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
      ...(actorAccountId === '' ? {} : { actorAccountId }),
    });
    await recordPlatformAudit(uow, {
      action: detail.action,
      outcome: 'allowed',
      targetType: entityType.toLowerCase(),
      targetRef: entityId,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
    });
    await appendOutboxEvent(uow, {
      aggregateType: entityType.toLowerCase(),
      aggregateId: entityId,
      eventType: `minibar.${entityType.toLowerCase()}.${detail.eventType.toLowerCase()}`,
      payload: detail.payload,
    });
  }
}

function refused(
  code: string,
  apiCode: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION_FAILED',
  message: string,
): { kind: 'refused'; error: ApiError; code: string } {
  return { kind: 'refused', error: new ApiError(apiCode, message), code };
}

/**
 * The exact reverse of what a change posted (doc 26 §20): every transfer to
 * the room comes back, every return goes out again, bounded to what the room
 * still holds for a return and expressed against the baseline the room is
 * restored to.
 */
export function rollbackBounds(
  movements: readonly {
    movementType: string;
    productId: string;
    quantity: number;
    originalMovementId: string | null;
  }[],
  held: readonly StockLine[],
): readonly TaskBound[] {
  const net = new Map<string, number>();
  for (const movement of movements) {
    if (movement.originalMovementId !== null) continue;
    const delta =
      movement.movementType === 'TRANSFER_TO_ROOM'
        ? movement.quantity
        : movement.movementType === 'RETURN_TO_WAREHOUSE'
          ? -movement.quantity
          : 0;
    net.set(movement.productId, (net.get(movement.productId) ?? 0) + delta);
  }
  const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
  const bounds: TaskBound[] = [];
  for (const [productId, delta] of [...net.entries()].sort()) {
    const now = holdings.get(productId) ?? 0;
    if (delta > 0) {
      bounds.push({
        productId,
        direction: 'TO_WAREHOUSE',
        maxQuantity: Math.min(delta, now),
        targetQuantity: now - delta,
      });
    } else if (delta < 0) {
      bounds.push({
        productId,
        direction: 'TO_ROOM',
        maxQuantity: -delta,
        targetQuantity: now - delta,
      });
    }
  }
  return bounds;
}
