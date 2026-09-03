import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import type { BlockerFact, EntityKind, EntityState } from '../domain/lifecycle';
import {
  canTransition,
  deactivationOutcome,
  deletionBlockers,
  operationalBlockers,
  unavailableEvidence,
} from '../domain/lifecycle';
import type { EntityRow } from '../repositories/catalog.repository';
import { CatalogRepository } from '../repositories/catalog.repository';
import type { CatalogDependencies, CommandActor, RequestContext } from './catalog-context';
import { CatalogServiceBase } from './catalog-context';
import { probeDependencies } from './dependency-evidence';

/**
 * The `ACTIVE → RETIRING → INACTIVE` lifecycle and its reverse edges, for the
 * four catalog entities (docs 26 §§2–11, 07 §3.2; `RML-DEC-001`…`006`,
 * `RC-DEC-040`).
 *
 * The shape every command takes is the catalog module's: claim the idempotency
 * key, lock in the fixed order (category before room), authorize on the locked
 * state, compare-and-set on the revision the caller read, then history, audit
 * and outbox in the same transaction.
 *
 * What makes the lifecycle different from an ordinary edit is that the answer
 * depends on *other* aggregates — stays, bookings, tasks, stock — most of which
 * later phases own. The dependency registry names each of them, the probe
 * reports what it found, and this service applies two rules to the answers:
 *
 *  - an outstanding **operational** dependency turns a deactivation request
 *    into `RETIRING` rather than `INACTIVE`, and blocks finalization;
 *  - **unavailable** evidence blocks every transition and every deletion. A
 *    source that could not be read is not a source with no rows.
 *
 * `RETIRING → INACTIVE` is performed two ways. An operator may ask for it, and
 * the server also performs it on its own when a Phase 06 action resolves the
 * last blocker — today, a room in a retiring category becoming `INACTIVE` or
 * moving to another category. Both paths run `finalizeIfClear`, and the event
 * records who asked for the deactivation and who completed it (doc 26 §11).
 * Later phases resolve blockers of their own — a checkout, a booking moved or
 * cancelled, a task completed — and are to call the same contract inside their
 * transaction; the traceability entry records that duty.
 */

interface KindPermissions {
  readonly lifecycle: string;
  readonly hardDelete: string;
}

/** doc 18 §3: room and category are one row pair, product and template another. */
const PERMISSIONS: Readonly<Record<EntityKind, KindPermissions>> = {
  ROOM: {
    lifecycle: 'hotel.catalog.entity_lifecycle',
    hardDelete: 'hotel.catalog.entity_hard_delete',
  },
  ROOM_CATEGORY: {
    lifecycle: 'hotel.catalog.entity_lifecycle',
    hardDelete: 'hotel.catalog.entity_hard_delete',
  },
  MINIBAR_PRODUCT: {
    lifecycle: 'hotel.minibar.entity_lifecycle',
    hardDelete: 'hotel.minibar.entity_hard_delete',
  },
  MINIBAR_TEMPLATE: {
    lifecycle: 'hotel.minibar.entity_lifecycle',
    hardDelete: 'hotel.minibar.entity_hard_delete',
  },
};

const LIFECYCLE_VIEW = ['hotel.catalog.lifecycle_view', 'hotel.catalog.lifecycle_view.read'];

const AGGREGATE_TYPE: Readonly<Record<EntityKind, string>> = {
  ROOM: 'room',
  ROOM_CATEGORY: 'room_category',
  MINIBAR_PRODUCT: 'minibar_product',
  MINIBAR_TEMPLATE: 'minibar_template',
};

export interface LifecycleCommandInput {
  readonly hotelId: string;
  readonly kind: EntityKind;
  readonly entityId: string;
  readonly idempotencyKey: string;
  /** The revision the caller read. A stale one is refused, never overwritten. */
  readonly expectedRevision: number;
  readonly reason?: string;
}

export interface LifecycleView {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly name: string;
  readonly state: EntityState;
  readonly retirementRequestedAt: string | null;
  readonly retirementReason: string | null;
  readonly revision: number;
  /** Every dependency source, with what the probe found. */
  readonly dependencies: readonly BlockerFact[];
  /** The operational blockers outstanding — what keeps a `RETIRING` entity from `INACTIVE`. */
  readonly blockers: readonly BlockerFact[];
}

export interface TransitionView extends LifecycleView {
  readonly previousState: EntityState;
}

export interface DeletionView {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly deleted: true;
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function view(row: EntityRow, dependencies: readonly BlockerFact[]): LifecycleView {
  return {
    entityId: row.entityId,
    kind: row.kind,
    name: row.name,
    state: row.state,
    retirementRequestedAt: isoOrNull(row.retirementRequestedAt),
    retirementReason: row.retirementReason,
    revision: row.revision,
    dependencies,
    blockers: operationalBlockers(dependencies),
  };
}

/** The facts, serialised for a history payload: no names, no free text beyond the registry's. */
function factsPayload(facts: readonly BlockerFact[]): Record<string, unknown>[] {
  return facts.map((fact) => ({
    sourceId: fact.sourceId,
    owningPhase: fact.owningPhase,
    kind: fact.kind,
    state: fact.state,
    ...(fact.count === undefined ? {} : { count: fact.count }),
  }));
}

/** Refuses on evidence that could not be obtained (`RML-DEC-003`). */
function requireEvidence(facts: readonly BlockerFact[]): void {
  const unavailable = unavailableEvidence(facts);
  if (unavailable.length > 0) {
    throw new ApiError(
      'DEPENDENCY_UNAVAILABLE',
      'a dependency source could not be read; the transition is refused rather than assumed clear',
      unavailable.map((fact) => ({ field: fact.sourceId, issue: 'unavailable' })),
    );
  }
}

export class LifecycleService extends CatalogServiceBase {
  constructor(deps: CatalogDependencies) {
    super(deps);
  }

  /** The state and its blockers, as an operator or Reception reads them. */
  async view(
    target: { hotelId: string; kind: EntityKind; entityId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<LifecycleView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      LIFECYCLE_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const catalog = new CatalogRepository(uow);
        const row = await catalog.entity(target.kind, target.entityId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return view(row, await probeDependencies(catalog, target.kind, target.entityId));
      },
    );
  }

  /**
   * A deactivation request (doc 26 §2, §3).
   *
   * New operational use stops the moment this commits, whichever state results.
   * `INACTIVE` when no operational dependency is outstanding; `RETIRING`, with
   * the blockers recorded, when one is.
   */
  async requestDeactivation(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransitionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PERMISSIONS[input.kind].lifecycle,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.request_deactivation', input);
        if (claim.kind === 'replay') return claim.body as TransitionView;

        const catalog = new CatalogRepository(uow);
        const locked = await this.lockInOrder(catalog, input.kind, input.entityId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked, input.expectedRevision);
        if (locked.state !== 'ACTIVE') {
          throw new ApiError('CONFLICT', `the entity is ${locked.state}, not ACTIVE`);
        }

        const facts = await probeDependencies(catalog, input.kind, input.entityId);
        requireEvidence(facts);
        const outcome = deactivationOutcome(facts);

        const moved = await catalog.transition({
          kind: input.kind,
          entityId: input.entityId,
          expectedRevision: locked.revision,
          toState: outcome,
          reason: input.reason ?? null,
        });
        if (moved === undefined) throw new ApiError('CONFLICT', 'the entity moved; re-read it');

        const actorAccountId = gate.principal.accountId;
        await catalog.appendEvent({
          entityType: input.kind,
          entityId: input.entityId,
          eventType: 'RETIREMENT_REQUESTED',
          fromState: 'ACTIVE',
          toState: outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { outcome, blockers: factsPayload(operationalBlockers(facts)) },
          actorAccountId,
        });
        if (outcome === 'INACTIVE') {
          await catalog.appendEvent({
            entityType: input.kind,
            entityId: input.entityId,
            eventType: 'DEACTIVATED',
            fromState: 'ACTIVE',
            toState: 'INACTIVE',
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            payload: { finalizedBy: 'requester', requestedBy: actorAccountId },
            actorAccountId,
          });
        }
        await this.recordTransition(uow, input.kind, input.entityId, 'ACTIVE', outcome, {
          action: 'catalog.lifecycle.deactivation_requested',
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });

        // A room leaving operational use may have been the last thing keeping
        // its category in `RETIRING` (doc 26 §5).
        if (input.kind === 'ROOM' && outcome === 'INACTIVE') {
          await this.finalizeParentIfClear(uow, catalog, input.entityId);
        }

        const result: TransitionView = { ...view(moved, facts), previousState: 'ACTIVE' };
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** `RETIRING → ACTIVE`: the request is withdrawn (doc 26 §9). */
  async cancelDeactivation(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransitionView> {
    return this.returnToActive(input, actor, request, 'RETIRING', {
      operation: 'catalog.cancel_deactivation',
      eventType: 'RETIREMENT_CANCELLED',
      action: 'catalog.lifecycle.deactivation_cancelled',
    });
  }

  /** `INACTIVE → ACTIVE` (doc 26 §9, `RML-DEC-006`). */
  async reactivate(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransitionView> {
    return this.returnToActive(input, actor, request, 'INACTIVE', {
      operation: 'catalog.reactivate',
      eventType: 'REACTIVATED',
      action: 'catalog.lifecycle.reactivated',
    });
  }

  /**
   * `RETIRING → INACTIVE`, on request.
   *
   * Refused while an operational blocker remains, with the blockers named, so
   * an operator learns what still has to be resolved rather than being told no.
   */
  async finalizeRetirement(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransitionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PERMISSIONS[input.kind].lifecycle,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.finalize_retirement', input);
        if (claim.kind === 'replay') return claim.body as TransitionView;

        const catalog = new CatalogRepository(uow);
        const locked = await this.lockInOrder(catalog, input.kind, input.entityId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked, input.expectedRevision);
        if (locked.state !== 'RETIRING') {
          throw new ApiError('CONFLICT', `the entity is ${locked.state}, not RETIRING`);
        }

        const facts = await probeDependencies(catalog, input.kind, input.entityId);
        requireEvidence(facts);
        const blockers = operationalBlockers(facts);
        if (blockers.length > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'operational dependencies are still outstanding',
            blockers.map((fact) => ({ field: fact.sourceId, issue: fact.detail ?? 'blocked' })),
          );
        }

        const moved = await this.finalize(uow, catalog, locked, {
          finalizedBy: 'operator',
          actorAccountId: gate.principal.accountId,
        });
        const result: TransitionView = { ...view(moved, facts), previousState: 'RETIRING' };
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The hard delete (doc 26 §8, `RML-DEC-005`).
   *
   * Every source — operational and historical — has to answer `clear` or
   * `not_yet_provisioned`; one `blocked` or `unavailable` refuses. A pending
   * deactivation request is itself a dependency, so `RETIRING` refuses too. The
   * foreign keys are the second line: a reference the probe did not see makes
   * the DELETE raise, and the transaction rolls back with it.
   */
  async hardDelete(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<DeletionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PERMISSIONS[input.kind].hardDelete,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.hard_delete', input);
        if (claim.kind === 'replay') return claim.body as DeletionView;

        const catalog = new CatalogRepository(uow);
        const locked = await this.lockInOrder(catalog, input.kind, input.entityId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked, input.expectedRevision);
        if (locked.state === 'RETIRING') {
          throw new ApiError('CONFLICT', 'a deactivation request is pending; it is a dependency');
        }

        const facts = await probeDependencies(catalog, input.kind, input.entityId);
        requireEvidence(facts);
        const referenced = deletionBlockers(facts);
        if (referenced.length > 0) {
          throw new ApiError(
            'CONFLICT',
            'ENTITY_REFERENCED: the entity has been used; deactivate it instead',
            referenced.map((fact) => ({ field: fact.sourceId, issue: fact.detail ?? 'blocked' })),
          );
        }

        let deleted: boolean;
        try {
          deleted = await catalog.deleteEntity(input.kind, input.entityId, locked.revision);
        } catch (error) {
          if (isForeignKeyViolation(error)) {
            throw new ApiError('CONFLICT', 'ENTITY_REFERENCED: a row still references the entity');
          }
          throw error;
        }
        if (!deleted) throw new ApiError('CONFLICT', 'the entity moved; re-read it');

        const actorAccountId = gate.principal.accountId;
        await catalog.appendEvent({
          entityType: input.kind,
          entityId: input.entityId,
          eventType: 'HARD_DELETED',
          fromState: locked.state,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { previousRevision: locked.revision },
          actorAccountId,
        });
        // The security audit the decision requires: actor, entity, reason, time.
        await recordPlatformAudit(uow, {
          action: 'catalog.lifecycle.hard_deleted',
          outcome: 'allowed',
          targetType: AGGREGATE_TYPE[input.kind],
          targetRef: input.entityId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { kind: input.kind, previousState: locked.state },
        });
        await appendOutboxEvent(uow, {
          aggregateType: AGGREGATE_TYPE[input.kind],
          aggregateId: input.entityId,
          eventType: 'catalog.entity.hard_deleted',
          payload: { kind: input.kind, previousState: locked.state },
        });

        const result: DeletionView = { entityId: input.entityId, kind: input.kind, deleted: true };
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The transaction-bound contract a later phase calls when it resolves a
   * blocker of its own: re-evaluate one `RETIRING` entity and complete the
   * deactivation if nothing operational remains.
   *
   * Runs inside the caller's transaction and hotel scope; takes the entity's
   * lock; does nothing when the entity is not `RETIRING` or a blocker remains,
   * and refuses — by throwing — when evidence is unavailable, because the caller
   * has just changed state that this decision depends on.
   */
  async finalizeIfClear(
    uow: UnitOfWork,
    kind: EntityKind,
    entityId: string,
    trigger: { readonly source: string; readonly actorAccountId?: string },
  ): Promise<EntityRow | undefined> {
    const catalog = new CatalogRepository(uow);
    const locked = await catalog.lockEntity(kind, entityId);
    if (locked === undefined || locked.state !== 'RETIRING') return undefined;
    const facts = await probeDependencies(catalog, kind, entityId);
    requireEvidence(facts);
    if (operationalBlockers(facts).length > 0) return undefined;
    return this.finalize(uow, catalog, locked, {
      finalizedBy: 'system',
      triggerSource: trigger.source,
      ...(trigger.actorAccountId === undefined ? {} : { actorAccountId: trigger.actorAccountId }),
    });
  }

  // ------------------------------------------------------------ internals

  private async returnToActive(
    input: LifecycleCommandInput,
    actor: CommandActor,
    request: RequestContext,
    fromState: 'RETIRING' | 'INACTIVE',
    names: { operation: string; eventType: 'RETIREMENT_CANCELLED' | 'REACTIVATED'; action: string },
  ): Promise<TransitionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PERMISSIONS[input.kind].lifecycle,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, names.operation, input);
        if (claim.kind === 'replay') return claim.body as TransitionView;

        const catalog = new CatalogRepository(uow);
        const parent = await this.lockParent(catalog, input.kind, input.entityId);
        const locked = await catalog.lockEntity(input.kind, input.entityId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        this.requireRevision(locked, input.expectedRevision);
        if (locked.state !== fromState || !canTransition(locked.state, 'ACTIVE')) {
          throw new ApiError('CONFLICT', `the entity is ${locked.state}, not ${fromState}`);
        }

        // doc 26 §9: the related category must be active. The hotel-scoped room
        // number is unique whatever the state, so that check is structural — the
        // row kept its number while inactive and no other room could take it.
        if (input.kind === 'ROOM') {
          if (parent === undefined || parent.state !== 'ACTIVE') {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'ENTITY_NOT_ACTIVE: the room category is not active; reactivate it first',
            );
          }
        }

        const moved = await catalog.transition({
          kind: input.kind,
          entityId: input.entityId,
          expectedRevision: locked.revision,
          toState: 'ACTIVE',
        });
        if (moved === undefined) throw new ApiError('CONFLICT', 'the entity moved; re-read it');

        const facts = await probeDependencies(catalog, input.kind, input.entityId);
        await catalog.appendEvent({
          entityType: input.kind,
          entityId: input.entityId,
          eventType: names.eventType,
          fromState,
          toState: 'ACTIVE',
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: { dependencies: factsPayload(facts) },
          actorAccountId: gate.principal.accountId,
        });
        await this.recordTransition(uow, input.kind, input.entityId, fromState, 'ACTIVE', {
          action: names.action,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });

        const result: TransitionView = { ...view(moved, facts), previousState: fromState };
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** The `RETIRING → INACTIVE` write, shared by the operator path and the system path. */
  private async finalize(
    uow: UnitOfWork,
    catalog: CatalogRepository,
    locked: EntityRow,
    by: { finalizedBy: 'operator' | 'system'; actorAccountId?: string; triggerSource?: string },
  ): Promise<EntityRow> {
    const requester = await this.requesterOf(catalog, locked.kind, locked.entityId);
    const moved = await catalog.transition({
      kind: locked.kind,
      entityId: locked.entityId,
      expectedRevision: locked.revision,
      toState: 'INACTIVE',
    });
    if (moved === undefined) throw new ApiError('CONFLICT', 'the entity moved; re-read it');
    await catalog.appendEvent({
      entityType: locked.kind,
      entityId: locked.entityId,
      eventType: 'DEACTIVATED',
      fromState: 'RETIRING',
      toState: 'INACTIVE',
      payload: {
        finalizedBy: by.finalizedBy,
        requestedBy: requester ?? null,
        ...(by.triggerSource === undefined ? {} : { trigger: by.triggerSource }),
      },
      ...(by.actorAccountId === undefined ? {} : { actorAccountId: by.actorAccountId }),
    });
    await this.recordTransition(uow, locked.kind, locked.entityId, 'RETIRING', 'INACTIVE', {
      action:
        by.finalizedBy === 'system'
          ? 'catalog.lifecycle.deactivation_completed_by_system'
          : 'catalog.lifecycle.deactivation_completed',
    });
    return moved;
  }

  private async finalizeParentIfClear(
    uow: UnitOfWork,
    catalog: CatalogRepository,
    roomId: string,
  ): Promise<void> {
    const room = await catalog.roomById(roomId);
    if (room === undefined) return;
    await this.finalizeIfClear(uow, 'ROOM_CATEGORY', room.categoryId, {
      source: 'catalog.room.deactivated',
      ...(uow.context.accountId === undefined ? {} : { actorAccountId: uow.context.accountId }),
    });
  }

  /** The account that requested the retirement, from the history. */
  private async requesterOf(
    catalog: CatalogRepository,
    kind: EntityKind,
    entityId: string,
  ): Promise<string | undefined> {
    const events = await catalog.events(kind, entityId);
    const requested = [...events]
      .reverse()
      .find((event) => event['event_type'] === 'RETIREMENT_REQUESTED');
    const actor = requested?.['actor_account_id'];
    return typeof actor === 'string' ? actor : undefined;
  }

  /** Category before room, always; a minibar entity has no parent to take first. */
  private async lockInOrder(
    catalog: CatalogRepository,
    kind: EntityKind,
    entityId: string,
  ): Promise<EntityRow | undefined> {
    await this.lockParent(catalog, kind, entityId);
    return catalog.lockEntity(kind, entityId);
  }

  private async lockParent(
    catalog: CatalogRepository,
    kind: EntityKind,
    entityId: string,
  ): Promise<EntityRow | undefined> {
    if (kind !== 'ROOM') return undefined;
    const room = await catalog.roomById(entityId);
    if (room === undefined) return undefined;
    return catalog.lockEntity('ROOM_CATEGORY', room.categoryId);
  }

  private requireRevision(row: EntityRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new ApiError(
        'CONFLICT',
        `the entity is at revision ${String(row.revision)}, not ${String(expectedRevision)}`,
      );
    }
  }

  private async recordTransition(
    uow: UnitOfWork,
    kind: EntityKind,
    entityId: string,
    fromState: EntityState,
    toState: EntityState,
    detail: { action: string; reason?: string },
  ): Promise<void> {
    await recordPlatformAudit(uow, {
      action: detail.action,
      outcome: 'allowed',
      targetType: AGGREGATE_TYPE[kind],
      targetRef: entityId,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: { kind, fromState, toState },
    });
    await appendOutboxEvent(uow, {
      aggregateType: AGGREGATE_TYPE[kind],
      aggregateId: entityId,
      eventType: 'catalog.entity.state_changed',
      payload: { kind, fromState, toState },
    });
  }

  private async claim(
    uow: UnitOfWork,
    operation: string,
    input: LifecycleCommandInput,
  ): Promise<
    | { readonly kind: 'claimed'; readonly idempotencyId: string }
    | { readonly kind: 'replay'; readonly body: unknown }
  > {
    const outcome = await claimIdempotencyKey(uow, {
      operation,
      key: input.idempotencyKey,
      clientRef: uow.context.actorRef,
      payload: {
        kind: input.kind,
        entityId: input.entityId,
        expectedRevision: input.expectedRevision,
        reason: input.reason ?? null,
      },
    });
    switch (outcome.kind) {
      case 'claimed':
        return { kind: 'claimed', idempotencyId: outcome.idempotencyId };
      case 'replay':
        if (outcome.status >= 400) {
          throw new ApiError('CONFLICT', 'the original request was refused');
        }
        return { kind: 'replay', body: outcome.body };
      case 'in_progress':
        throw new ApiError('CONFLICT', 'the same request is already in progress');
      case 'key_reused_with_different_payload':
        throw new ApiError('CONFLICT', 'the idempotency key was reused with a different request');
    }
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}
