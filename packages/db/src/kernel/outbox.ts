import type { UnitOfWork } from '../unit-of-work';

/**
 * Transactional outbox (ADR-0010).
 *
 * The domain change and its events commit together. Delivery happens after
 * commit, at least once, and every consumer is idempotent on a natural key.
 *
 * D-05: `outbox_event` is strictly append-only, so its mutable delivery state
 * lives in `outbox_delivery`. The database pairs them on insert.
 */

export interface OutboxEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  /**
   * Never carries a secret, a token or a full identifier — a check constraint
   * rejects those key names outright (CLAUDE.md §8, GATE-UNIT event schemas).
   */
  readonly payload: Record<string, unknown>;
}

export interface ClaimedOutboxEvent {
  readonly eventId: string;
  readonly eventUuid: string;
  readonly hotelId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly attempts: number;
}

export async function appendOutboxEvent(
  uow: UnitOfWork,
  event: OutboxEventInput,
): Promise<{ eventId: string; eventUuid: string }> {
  const result = await uow.query<{ event_id: string; event_uuid: string }>(
    `INSERT INTO platform.outbox_event
       (hotel_id, aggregate_type, aggregate_id, event_type, event_version,
        payload, correlation_id, causation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING event_id::text AS event_id, event_uuid`,
    [
      uow.context.hotelId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.eventVersion ?? 1,
      JSON.stringify(event.payload),
      uow.context.correlationId,
      uow.context.causationId ?? null,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('outbox insert returned no row');
  }
  return { eventId: row.event_id, eventUuid: row.event_uuid };
}

/**
 * Claims a batch for one relay worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two workers unable to take the same row:
 * the second skips the locked row instead of blocking on it, so throughput scales
 * without ever double-delivering from the claim itself (ADR-0011).
 *
 * The lease (`claimed_until`) covers the other failure: a worker that crashes
 * mid-delivery leaves the row claimed but expiring, and it becomes claimable
 * again with the event untouched.
 */
export async function claimOutboxBatch(
  uow: UnitOfWork,
  workerId: string,
  batchSize: number,
  leaseSeconds = 30,
): Promise<ClaimedOutboxEvent[]> {
  const result = await uow.query<{
    event_id: string;
    event_uuid: string;
    hotel_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: number;
    payload: Record<string, unknown>;
    correlation_id: string | null;
    causation_id: string | null;
    attempts: number;
  }>(
    `WITH claimed AS (
       SELECT d.event_id
         FROM platform.outbox_delivery d
        WHERE d.state IN ('pending', 'claimed')
          AND d.available_at <= now()
          AND (d.claimed_until IS NULL OR d.claimed_until < now())
        ORDER BY d.event_id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     ), locked AS (
       UPDATE platform.outbox_delivery d
          SET state = 'claimed',
              claimed_by = $1,
              claimed_until = now() + make_interval(secs => $3),
              attempts = d.attempts + 1,
              revision = d.revision + 1
         FROM claimed
        WHERE d.event_id = claimed.event_id
        RETURNING d.event_id, d.attempts
     )
     SELECT e.event_id::text AS event_id, e.event_uuid, e.hotel_id,
            e.aggregate_type, e.aggregate_id, e.event_type, e.event_version,
            e.payload, e.correlation_id, e.causation_id, locked.attempts
       FROM locked
       JOIN platform.outbox_event e ON e.event_id = locked.event_id
      ORDER BY e.event_id`,
    [workerId, batchSize, leaseSeconds],
  );

  return result.rows.map((row) => ({
    eventId: row.event_id,
    eventUuid: row.event_uuid,
    hotelId: row.hotel_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    attempts: row.attempts,
  }));
}

export async function markOutboxPublished(uow: UnitOfWork, eventId: string): Promise<void> {
  await uow.query(
    `UPDATE platform.outbox_delivery
        SET state = 'published', published_at = now(), claimed_until = NULL,
            last_error = NULL, revision = revision + 1
      WHERE event_id = $1`,
    [eventId],
  );
}

/**
 * Records a failed attempt and backs the row off exponentially. The event row is
 * never touched — only its delivery state — so a permanently failing consumer
 * cannot destroy the record of what happened.
 */
export async function markOutboxFailed(
  uow: UnitOfWork,
  eventId: string,
  errorName: string,
  maxAttempts = 10,
): Promise<void> {
  await uow.query(
    `UPDATE platform.outbox_delivery
        SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            claimed_by = NULL,
            claimed_until = NULL,
            available_at = now() + make_interval(secs => least(300, power(2, attempts)::int)),
            last_error = $2,
            revision = revision + 1
      WHERE event_id = $1`,
    [eventId, errorName, maxAttempts],
  );
}
