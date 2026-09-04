import type { UnitOfWork } from '@prsystem/db';
import type { EntityKind } from '../domain/lifecycle';

/**
 * The contract a later phase calls when it resolves a lifecycle blocker of its
 * own (doc 26 §2, §11).
 *
 * A `RETIRING` entity completes its retirement when its last operational
 * dependency clears. The catalog cannot see a checkout, a returned stock or an
 * applied configuration happen; the module that performs it calls this inside
 * the same transaction, and the catalog re-evaluates the entity on the state
 * that transaction is about to commit. Nothing happens when the entity is not
 * `RETIRING` or a blocker remains; unavailable evidence throws, because the
 * caller has just changed state the decision depends on.
 */
export interface LifecycleResolutionPort {
  finalizeIfClear(
    uow: UnitOfWork,
    kind: EntityKind,
    entityId: string,
    trigger: { readonly source: string; readonly actorAccountId?: string },
  ): Promise<unknown>;
}
