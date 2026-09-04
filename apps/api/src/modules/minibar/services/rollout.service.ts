import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { probeSources } from '../../catalog/contracts/dependency-probe';
import { readRoom } from '../../catalog/contracts/room-reads';
import { SAFE_POINT_SOURCES } from '../contracts/safe-point-sources';
import type { BatchState, Eligibility } from '../domain/versions';
import { deriveBatchState, isTerminalChange, rolloutEligibility } from '../domain/versions';
import type { BatchRoomRow, BatchRow, ChangeRow } from '../repositories/configuration.repository';
import { ConfigurationRepository } from '../repositories/configuration.repository';
import { InventoryRepository } from '../repositories/inventory.repository';
import { VersionRepository } from '../repositories/version.repository';
import type { ChangeView } from './configuration.service';
import type { ConfigurationService } from './configuration.service';
import { changeView, rollbackBounds } from './configuration.service';
import type { CommandActor, MinibarDependencies, RequestContext } from './minibar-context';
import { MinibarServiceBase, claim } from './minibar-context';

/**
 * Multi-room Rollout (doc 26 §36, doc 22 §7.2; `RML-DEC-025`…`028`).
 *
 * A batch is a grouping: one hotel, one template, one exact published target,
 * many rooms. Preview reads and writes nothing. Confirm re-checks every room on
 * authoritative state and applies **partial success** — each accepted room gets
 * its own change and blocker through the configuration service's core, each
 * skipped room a reason and nothing else — under one idempotency key, so a
 * duplicate Confirm creates nothing. Batch state is derived from the children
 * on every read and never stored.
 */

const BATCH = 'hotel.minibar.rollout_batch';
const BATCH_VIEW = ['hotel.minibar.rollout_batch_view', 'hotel.minibar.rollout_batch_view.read'];

export interface PreviewRow {
  readonly roomId: string;
  readonly eligibility: Eligibility['kind'];
  readonly code: string | null;
}

export interface BatchView {
  readonly batchId: string;
  readonly templateId: string;
  readonly targetVersionId: string;
  readonly retryOfBatchId: string | null;
  readonly createdAt: string;
  readonly state: BatchState;
  readonly counts: Record<string, number>;
  readonly rooms: readonly {
    readonly roomId: string;
    readonly result: 'ACCEPTED' | 'SKIPPED';
    readonly reasonCode: string | null;
    readonly change: ChangeView | null;
  }[];
}

export interface BatchInput {
  readonly hotelId: string;
  readonly templateId: string;
  readonly targetVersionId: string;
  readonly roomIds: readonly string[];
}

export class RolloutService extends MinibarServiceBase {
  constructor(
    deps: MinibarDependencies,
    private readonly configurations: ConfigurationService,
  ) {
    super(deps);
  }

  /** Read-only classification of every selected room (doc 26 §36.1). */
  async preview(
    input: BatchInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly PreviewRow[]> {
    this.requireSelection(input.roomIds);
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      BATCH,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const rows: PreviewRow[] = [];
        for (const roomId of input.roomIds) {
          const eligibility = await this.classify(uow, input, roomId);
          rows.push({
            roomId,
            eligibility: eligibility.kind,
            code: eligibility.kind === 'INELIGIBLE' ? eligibility.code : null,
          });
        }
        return rows;
      },
    );
  }

  /** Confirm, with partial success (doc 26 §36.2). */
  async confirm(
    input: BatchInput & { readonly idempotencyKey: string; readonly retryOfBatchId?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<BatchView> {
    this.requireSelection(input.roomIds);
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      BATCH,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.rollout_confirm', input.idempotencyKey, {
          templateId: input.templateId,
          targetVersionId: input.targetVersionId,
          roomIds: [...input.roomIds].sort(),
          retryOfBatchId: input.retryOfBatchId ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as BatchView;
        const repository = new ConfigurationRepository(uow);
        const versions = new VersionRepository(uow);
        await versions.lockTemplate(input.templateId);
        const target = await versions.shareVersion(input.targetVersionId);
        await authorize();
        if (target === undefined || target.templateId !== input.templateId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (input.retryOfBatchId !== undefined) {
          const source = await repository.batchById(input.retryOfBatchId);
          if (source === undefined) throw new ApiError('NOT_FOUND', 'not found');
          const open = (await repository.changesOfBatch(input.retryOfBatchId)).filter(
            (change) => !isTerminalChange(change.state),
          );
          if (open.length > 0) {
            throw new ApiError(
              'CONFLICT',
              'RETRY_BLOCKED: the source batch still has non-terminal rooms',
            );
          }
        }
        const batch = await repository.createBatch({
          templateId: input.templateId,
          targetVersionId: input.targetVersionId,
          ...(input.retryOfBatchId === undefined ? {} : { retryOfBatchId: input.retryOfBatchId }),
          createdBy: gate.principal.accountId,
        });
        // Each room is its own atomic unit inside the batch: a refusal is a
        // result row, never an exception that undoes the rooms before it.
        // Refusals are decided by the change-opening core, which reports them
        // as values so nothing here has to roll back a savepoint.
        const alreadyAuthorized = async (): Promise<void> => undefined;
        for (const roomId of [...new Set(input.roomIds)].sort()) {
          const outcome = await this.configurations.openChange(
            uow,
            gate.principal.accountId,
            {
              hotelId: input.hotelId,
              roomId,
              kind: 'VERSION_ROLLOUT',
              targetTemplateId: input.templateId,
              targetVersionId: input.targetVersionId,
              batchId: batch.batchId,
            },
            alreadyAuthorized,
          );
          if (outcome.kind === 'opened') {
            await repository.addBatchRoom({
              batchId: batch.batchId,
              roomId,
              result: 'ACCEPTED',
              changeId: outcome.change.changeId,
            });
          } else {
            await repository.addBatchRoom({
              batchId: batch.batchId,
              roomId,
              result: 'SKIPPED',
              reasonCode: outcome.code,
            });
          }
        }
        const view = await this.buildView(uow, batch);
        await this.record(
          uow,
          gate.principal.accountId,
          batch.batchId,
          'CONFIRMED',
          'minibar.rollout_batch.confirm',
          {
            templateId: input.templateId,
            targetVersionId: input.targetVersionId,
            retryOfBatchId: input.retryOfBatchId ?? null,
            selected: input.roomIds.length,
            results: view.rooms.map((room) => ({
              roomId: room.roomId,
              result: room.result,
              reasonCode: room.reasonCode,
            })),
            state: view.state,
          },
        );
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** `Cancel remaining` (doc 26 §36.4). */
  async cancelRemaining(
    input: { hotelId: string; batchId: string; idempotencyKey: string; reason?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<BatchView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      BATCH,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.rollout_cancel_remaining', input.idempotencyKey, {
          batchId: input.batchId,
        });
        if (claimed.kind === 'replay') return claimed.body as BatchView;
        const repository = new ConfigurationRepository(uow);
        const inventory = new InventoryRepository(uow);
        const batch = await repository.batchById(input.batchId);
        await authorize();
        if (batch === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const cancelled: string[] = [];
        const rollingBack: string[] = [];
        for (const child of await repository.changesOfBatch(input.batchId)) {
          if (isTerminalChange(child.state) || child.state === 'ROLLBACK_REQUIRED') continue;
          await repository.ensureConfiguration(child.roomId);
          const locked = await repository.lockChange(child.changeId);
          if (locked === undefined || isTerminalChange(locked.state)) continue;
          const open = await repository.openTaskOf(locked.changeId);
          if (!locked.movementStarted) {
            const moved = await repository.transitionChange({
              changeId: locked.changeId,
              expectedRevision: locked.revision,
              toState: 'CANCELLED',
            });
            if (moved === undefined) throw new ApiError('CONFLICT', 'a child moved; retry');
            if (open !== undefined) {
              await repository.finishTask({
                taskId: open.taskId,
                expectedRevision: open.revision,
                state: 'CANCELLED',
              });
            }
            cancelled.push(locked.changeId);
          } else {
            const moved = await repository.transitionChange({
              changeId: locked.changeId,
              expectedRevision: locked.revision,
              toState: 'ROLLBACK_REQUIRED',
            });
            if (moved === undefined) throw new ApiError('CONFLICT', 'a child moved; retry');
            if (open !== undefined) {
              await repository.finishTask({
                taskId: open.taskId,
                expectedRevision: open.revision,
                state: 'CANCELLED',
              });
            }
            await repository.createTask({
              changeId: locked.changeId,
              roomId: locked.roomId,
              kind: 'ROLLBACK',
              bounds: rollbackBounds(
                await inventory.movementsForChange(locked.changeId),
                await inventory.roomStock(locked.roomId),
              ),
            });
            rollingBack.push(locked.changeId);
          }
        }
        const view = await this.buildView(uow, batch);
        await this.record(
          uow,
          gate.principal.accountId,
          input.batchId,
          'CANCEL_REMAINING',
          'minibar.rollout_batch.cancel_remaining',
          {
            cancelled,
            rollingBack,
            state: view.state,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        );
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  async view(
    target: { hotelId: string; batchId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<BatchView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      BATCH_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const batch = await new ConfigurationRepository(uow).batchById(target.batchId);
        if (batch === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return this.buildView(uow, batch);
      },
    );
  }

  // ------------------------------------------------------------ internals

  private requireSelection(roomIds: readonly string[]): void {
    if (new Set(roomIds).size < 2) {
      throw new ApiError('VALIDATION_FAILED', 'a batch selects two or more distinct rooms');
    }
  }

  private async classify(uow: UnitOfWork, input: BatchInput, roomId: string): Promise<Eligibility> {
    const versions = new VersionRepository(uow);
    const inventory = new InventoryRepository(uow);
    const repository = new ConfigurationRepository(uow);
    const template = await versions.templateById(input.templateId);
    const version = await versions.versionById(input.targetVersionId);
    if (
      template === undefined ||
      version === undefined ||
      version.templateId !== input.templateId
    ) {
      return { kind: 'INELIGIBLE', code: 'TARGET_NOT_PUBLISHED' };
    }
    const items = await versions.itemsOf(version.versionId);
    const products = await inventory.productsByIds(items.map((item) => item.productId));
    const everyProductActive =
      items.length > 0 && items.every((item) => products.get(item.productId)?.state === 'ACTIVE');
    const room = await readRoom(uow, roomId);
    if (room === undefined) return { kind: 'INELIGIBLE', code: 'ROOM_NOT_ACTIVE' };
    const configuration = await repository.configuration(roomId);
    const pending = await repository.pendingChangeOf(roomId);
    const safePoint = await probeSources(uow, SAFE_POINT_SOURCES, roomId);
    return rolloutEligibility(
      {
        roomState: room.state,
        mode: configuration?.mode ?? 'OFF',
        currentTemplateId: configuration?.templateId ?? null,
        currentVersionId: configuration?.currentVersionId ?? null,
        hasPendingChange: pending !== undefined,
        safePoint: safePoint.every(
          (fact) => fact.state === 'clear' || fact.state === 'not_yet_provisioned',
        ),
      },
      {
        templateId: input.templateId,
        versionId: input.targetVersionId,
        versionState: version.state,
        templateState: template.state,
        everyProductActive,
      },
    );
  }

  private async buildView(uow: UnitOfWork, batch: BatchRow): Promise<BatchView> {
    const repository = new ConfigurationRepository(uow);
    const rooms = await repository.batchRooms(batch.batchId);
    const changes = new Map(
      (await repository.changesOfBatch(batch.batchId)).map((change) => [change.changeId, change]),
    );
    const children = rooms.map((room: BatchRoomRow) => {
      const change = room.changeId === null ? undefined : changes.get(room.changeId);
      return { room, change };
    });
    const state = deriveBatchState(
      children.map(({ room, change }) => ({
        result: room.result,
        ...(change === undefined
          ? {}
          : { changeState: change.state, movementStarted: change.movementStarted }),
      })),
    );
    const counts: Record<string, number> = { selected: rooms.length, accepted: 0, SKIPPED: 0 };
    for (const { room, change } of children) {
      if (room.result === 'SKIPPED') counts['SKIPPED'] = (counts['SKIPPED'] ?? 0) + 1;
      else counts['accepted'] = (counts['accepted'] ?? 0) + 1;
      if (change !== undefined) counts[change.state] = (counts[change.state] ?? 0) + 1;
    }
    return {
      batchId: batch.batchId,
      templateId: batch.templateId,
      targetVersionId: batch.targetVersionId,
      retryOfBatchId: batch.retryOfBatchId,
      createdAt: batch.createdAt.toISOString(),
      state,
      counts,
      rooms: children.map(({ room, change }) => ({
        roomId: room.roomId,
        result: room.result,
        reasonCode: room.reasonCode,
        change: change === undefined ? null : changeView(change as ChangeRow),
      })),
    };
  }

  private async record(
    uow: UnitOfWork,
    actorAccountId: string,
    batchId: string,
    eventType: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await new ConfigurationRepository(uow).appendEvent({
      entityType: 'ROLLOUT_BATCH',
      entityId: batchId,
      eventType,
      payload,
      actorAccountId,
    });
    await recordPlatformAudit(uow, {
      action,
      outcome: 'allowed',
      targetType: 'rollout_batch',
      targetRef: batchId,
      payload,
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'rollout_batch',
      aggregateId: batchId,
      eventType: `minibar.rollout_batch.${eventType.toLowerCase()}`,
      payload,
    });
  }
}
