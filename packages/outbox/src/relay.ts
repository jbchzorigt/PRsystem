import type { Pool } from 'pg';
import type { ClaimedOutboxEvent, TenantContext } from '@prsystem/db';
import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
  withTenantTransaction,
} from '@prsystem/db';

/**
 * The outbox relay (ADR-0010).
 *
 * Delivery is at-least-once by construction: the row is marked published only
 * after the publish returns, so a crash in between causes a redelivery rather
 * than a lost event. Consumers are idempotent, which is what turns at-least-once
 * into exactly-one-effect.
 *
 * A provider call never happens inside a transaction. Each event is claimed,
 * published outside the claim, and marked in its own short transaction.
 */

export interface OutboxPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
}

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export interface RelayOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
}

/**
 * Runs one relay pass for one tenant scope.
 *
 * Scope is explicit rather than ambient: a job establishes its context
 * transactionally exactly as a request does (ADR-0017 §7).
 */
export async function relayOnce(
  pool: Pool,
  context: TenantContext,
  publisher: OutboxPublisher,
  options: RelayOptions,
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 32;

  const claimed = await withTenantTransaction(pool, context, (uow) =>
    claimOutboxBatch(uow, options.workerId, batchSize, options.leaseSeconds ?? 30),
  );

  let published = 0;
  let failed = 0;

  for (const event of claimed) {
    try {
      await publisher.publish(event);
      await withTenantTransaction(pool, context, (uow) => markOutboxPublished(uow, event.eventId));
      published += 1;
    } catch (error) {
      // Only the error's name is recorded. A message can carry a provider payload
      // or a connection string, and this row is durable (CLAUDE.md §8).
      await withTenantTransaction(pool, context, (uow) =>
        markOutboxFailed(
          uow,
          event.eventId,
          error instanceof Error ? error.name : 'UnknownError',
          options.maxAttempts ?? 10,
        ),
      );
      failed += 1;
    }
  }

  return { claimed: claimed.length, published, failed };
}
