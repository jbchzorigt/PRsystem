import type { Pool } from 'pg';
import type { PackageCode, SubscriptionSnapshot, SubscriptionStatePort } from '@prsystem/authz';
import { snapshotFrom } from '../domain/lifecycle';

/**
 * The authoritative subscription-state contract, backed by the database.
 *
 * Phase 04 shipped a port that answers nothing outside local, CI and test, so
 * every hotel action was denied at pipeline stage 5. This replaces it.
 *
 * Two properties matter, and both are structural rather than conventional.
 *
 * **It reads the authoritative row, never a projection.** ADR-0019 §4 forbids
 * authorization reading eventually-consistent data, and `OPS-DEC-016` requires
 * the state to be derived at request time. The query below hits
 * `platform.hotel_subscription` directly and the state is computed from
 * `expires_at` and the server clock — there is no stored state column to go
 * stale, and no projection to lag.
 *
 * **It still fails closed.** A hotel with no subscription row answers
 * `undefined`, which the pipeline denies on. That is the correct answer for a
 * tenant that was never provisioned, and it is the same answer Phase 04 gave
 * for every tenant.
 *
 * The read runs on its own short transaction under the hotel's scope, so the
 * ordinary tenant policy is what confines it: an authorization check for hotel A
 * cannot read hotel B's entitlement even if the caller asked it to.
 */
export class DatabaseSubscriptionState implements SubscriptionStatePort {
  constructor(private readonly pool: Pool) {}

  async snapshot(hotelId: string, now: Date): Promise<SubscriptionSnapshot | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The scope is the hotel being asked about, established transaction-locally
      // exactly as every other read establishes it. `set_config(..., true)` dies
      // with the transaction, so nothing leaks back to the pool.
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
      const result = await client.query<{
        effective_package: string;
        expires_at: Date;
        suspended_at: Date | null;
      }>(
        `SELECT effective_package, expires_at, suspended_at
           FROM platform.hotel_subscription WHERE hotel_id = $1`,
        [hotelId],
      );
      await client.query('COMMIT');

      const row = result.rows[0];
      if (row === undefined) return undefined;
      return snapshotFrom(
        {
          hotelId,
          effectivePackage: row.effective_package as PackageCode,
          expiresAt: row.expires_at,
          suspendedAt: row.suspended_at,
        },
        now,
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      // Belt and braces, exactly as the unit of work does: the setting is
      // transaction-local already, and an explicit reset makes a leak impossible
      // if a future change opens the transaction some other way.
      await client.query('RESET app.hotel_id').catch(() => undefined);
      client.release();
    }
  }
}
