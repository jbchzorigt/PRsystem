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
  // The wrapper, never the table: a runtime role holds no privilege on an audit
  // relation. Realm, actor, tenant scope and server time are derived inside the
  // function from the transaction context, so none of them is passed here.
  await uow.query(`SELECT audit.append_platform_audit_event($1, $2, $3, $4, $5, $6::jsonb)`, [
    event.action,
    event.outcome,
    event.targetType ?? null,
    event.targetRef ?? null,
    event.reason ?? null,
    JSON.stringify(event.payload ?? {}),
  ]);
}

/**
 * The Police stream is a separate table, in a separate schema, behind separate
 * grants. Platform operators cannot read it (ADR-0018 §1).
 */
export async function recordPoliceAudit(uow: UnitOfWork, event: PoliceAuditEvent): Promise<void> {
  await uow.query(`SELECT police_audit.append_police_security_event($1, $2, $3, $4, $5::jsonb)`, [
    event.action,
    event.outcome,
    event.caseRef ?? null,
    event.reason ?? null,
    JSON.stringify(event.payload ?? {}),
  ]);
}
