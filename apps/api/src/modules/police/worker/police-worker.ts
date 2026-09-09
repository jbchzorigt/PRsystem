import { Pool } from 'pg';
import { claimConsumption, withTenantTransaction } from '@prsystem/db';
import type { TenantContext } from '@prsystem/db';
import { newCorrelationId } from '@prsystem/contracts';

/**
 * doc 13 §8.3, trigger 1: the check-in that has just been recorded.
 *
 * The matcher is a *consumer*, not the outbox relay: it claims its own
 * consumption of each `stay.checked_in` event under the name `police.matcher`,
 * so a redelivery, a second worker or a replayed batch produces one match and
 * one alert (`POL-DEC-017`). It never claims the delivery row, because the
 * relay owns that and other consumers will want the same event.
 *
 * What it does with an event is call one database function. It cannot ask
 * whether somebody is wanted in any other way, it holds no privilege on any
 * Police table, and what it gets back is a match id or nothing — so a worker
 * log, a metric or a crash dump cannot carry a wanted person's identity.
 *
 * The hotel-facing side of a check-in is finished before this runs and does not
 * wait for it, which is what makes doc 13 §7's isolation gate true of timing as
 * well as of content: nothing a receptionist sees differs by whether a match
 * was found.
 */

export interface PoliceMatcherRuntime {
  /** Consumes the check-in events not yet matched. Answers how many matched. */
  matchPendingCheckIns(limit?: number): Promise<{ consumed: number; matched: number }>;
  close(): Promise<void>;
}

export interface PoliceMatcherConfig {
  readonly databaseUrl: string;
}

export function createPoliceMatcherRuntime(config: PoliceMatcherConfig): PoliceMatcherRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const runtime = attachPoliceMatcherRuntime(pool);
  return {
    ...runtime,
    async close(): Promise<void> {
      await runtime.close();
      await pool.end().catch(() => undefined);
    },
  };
}

/** Builds the runtime over a pool the caller owns — the test harness does. */
export function attachPoliceMatcherRuntime(pool: Pool): PoliceMatcherRuntime {
  return {
    async matchPendingCheckIns(limit = 50): Promise<{ consumed: number; matched: number }> {
      const correlationId = newCorrelationId();
      const due = await pool.query<{ event_id: string; hotel_id: string }>(
        `SELECT event_id::text AS event_id, hotel_id
           FROM police.pending_check_in_events($1::integer)`,
        [limit],
      );
      let consumed = 0;
      let matched = 0;
      for (const row of due.rows) {
        const scope: TenantContext = {
          hotelId: row.hotel_id,
          realm: 'hotel',
          actorRef: 'police.matcher',
          correlationId,
        };
        const outcome = await withTenantTransaction(pool, scope, async (uow) => {
          // The claim is in the same transaction as the effect it guards, so a
          // crash between them cannot leave a consumed event unmatched.
          const first = await claimConsumption(
            uow,
            'police.matcher',
            row.event_id,
            'platform.outbox_event',
          );
          if (!first) return { consumed: false, matched: false };

          const event = await uow.query<{ payload: Record<string, unknown> }>(
            `SELECT payload FROM platform.outbox_event WHERE event_id = $1::bigint`,
            [row.event_id],
          );
          const payload = event.rows[0]?.payload;
          if (payload === undefined) return { consumed: true, matched: false };
          const guest = payload['guest'] as Record<string, unknown> | undefined;
          const result = await uow.query<{ match_id: string | null }>(
            `SELECT police.record_check_in_match(
                      $1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, now(),
                      $6, $7, $8, $9) AS match_id`,
            [
              payload['stayId'] as string,
              row.hotel_id,
              (payload['roomNumber'] as string | undefined) ?? '',
              payload['checkInRecordedAt'] as string,
              payload['actualCheckInAt'] as string,
              (guest?.['policeMatchEligibility'] as string | undefined) ?? 'NOT_ELIGIBLE_EXACT_RD',
              (guest?.['lookupNamespace'] as string | null) ?? null,
              (guest?.['lookupToken'] as string | null) ?? null,
              (guest?.['lookupKeyVersion'] as string | null) ?? null,
            ],
          );
          return { consumed: true, matched: result.rows[0]?.match_id != null };
        });
        if (outcome.consumed) consumed += 1;
        if (outcome.matched) matched += 1;
      }
      return { consumed, matched };
    },
    close: () => Promise.resolve(),
  };
}
