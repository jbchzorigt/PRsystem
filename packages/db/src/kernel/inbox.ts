import { createHash } from 'node:crypto';
import type { UnitOfWork } from '../unit-of-work';

/**
 * Idempotent inbox and provider-event deduplication (ADR-0010, ADR-0019 §2,
 * CLAUDE.md §7).
 *
 * Delivery is at-least-once, so the consumer — not the producer — is responsible
 * for the effect happening once.
 */

/**
 * Records that `consumer` has handled `dedupKey`.
 *
 * Returns false when it already had. The unique index decides, so two workers
 * processing the same redelivered event concurrently still consume it once.
 * Call this in the same transaction as the projection update it guards.
 */
export async function claimConsumption(
  uow: UnitOfWork,
  consumer: string,
  dedupKey: string,
  source: string,
): Promise<boolean> {
  const result = await uow.query(
    `INSERT INTO platform.inbox_consumption (hotel_id, consumer, dedup_key, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (consumer, dedup_key) DO NOTHING`,
    [uow.context.hotelId, consumer, dedupKey, source],
  );
  return result.rowCount === 1;
}

export interface ProviderEventInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventKind: string;
  /** The raw body. Hashed here and then discarded — it is never stored. */
  readonly rawPayload: string;
  /**
   * Sanitised, non-sensitive fields only: amount, currency, reference, status.
   * A database check constraint rejects card, token and identifier key names.
   */
  readonly metadata: Record<string, unknown>;
}

export type ProviderEventOutcome =
  | { readonly kind: 'first_delivery'; readonly rowId: string }
  | { readonly kind: 'duplicate'; readonly payloadMatches: boolean };

export function payloadHash(rawPayload: string): string {
  return createHash('sha256').update(rawPayload, 'utf8').digest('hex');
}

/**
 * Deduplicates an inbound provider callback before any domain transition is
 * applied (CLAUDE.md §7 step 2).
 *
 * A duplicate whose payload hash differs is reported rather than merged: the same
 * provider event id carrying different content is a reconciliation case, never an
 * automatic state change.
 */
export async function registerProviderEvent(
  uow: UnitOfWork,
  event: ProviderEventInput,
): Promise<ProviderEventOutcome> {
  const hash = payloadHash(event.rawPayload);

  const inserted = await uow.query<{ provider_event_row_id: string }>(
    `INSERT INTO platform.provider_event
       (hotel_id, provider, provider_event_id, event_kind, payload_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING provider_event_row_id`,
    [
      uow.context.hotelId,
      event.provider,
      event.providerEventId,
      event.eventKind,
      hash,
      JSON.stringify(event.metadata),
    ],
  );

  const row = inserted.rows[0];
  if (row !== undefined) {
    return { kind: 'first_delivery', rowId: row.provider_event_row_id };
  }

  const existing = await uow.query<{ payload_hash: string }>(
    `SELECT payload_hash FROM platform.provider_event
      WHERE provider = $1 AND provider_event_id = $2`,
    [event.provider, event.providerEventId],
  );

  return {
    kind: 'duplicate',
    payloadMatches: existing.rows[0]?.payload_hash === hash,
  };
}
