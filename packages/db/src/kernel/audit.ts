import type { UnitOfWork } from '../unit-of-work';

/**
 * Append-only audit (ADR-0018).
 *
 * Written through the same `UnitOfWork` as the effect it describes, so a
 * high-risk action whose audit record cannot be written does not happen: the
 * failed insert aborts the enclosing transaction.
 */

export type AuditOutcome = 'allowed' | 'denied' | 'failed';

export interface PlatformAuditEvent {
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly targetType?: string;
  readonly targetRef?: string;
  readonly reason?: string;
  /**
   * Non-sensitive context only. A database check constraint rejects the key names
   * from CLAUDE.md §8, so a leak fails the write rather than landing in the
   * permanent record.
   */
  readonly payload?: Record<string, unknown>;
}

export interface PoliceAuditEvent {
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly caseRef?: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * `occurred_at` is deliberately not a parameter: the partition key is the
 * server-recorded time (ADR-0018 §3), so a backdated business event still lands
 * in the month it was actually recorded.
 */
export async function recordPlatformAudit(
  uow: UnitOfWork,
  event: PlatformAuditEvent,
): Promise<void> {
  await uow.query(
    `INSERT INTO audit.platform_event
       (realm, action, outcome, actor_ref, hotel_id, target_type, target_ref,
        reason, correlation_id, causation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      uow.context.realm,
      event.action,
      event.outcome,
      uow.context.actorRef,
      uow.context.hotelId,
      event.targetType ?? null,
      event.targetRef ?? null,
      event.reason ?? null,
      uow.context.correlationId,
      uow.context.causationId ?? null,
      JSON.stringify(event.payload ?? {}),
    ],
  );
}

/**
 * The Police stream is a separate table, in a separate schema, behind separate
 * grants. Platform operators cannot read it (ADR-0018 §1).
 */
export async function recordPoliceAudit(uow: UnitOfWork, event: PoliceAuditEvent): Promise<void> {
  await uow.query(
    `INSERT INTO police_audit.security_event
       (action, outcome, actor_ref, case_ref, reason, correlation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.action,
      event.outcome,
      uow.context.actorRef,
      event.caseRef ?? null,
      event.reason ?? null,
      uow.context.correlationId,
      JSON.stringify(event.payload ?? {}),
    ],
  );
}
