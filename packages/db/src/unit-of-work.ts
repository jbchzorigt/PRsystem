import type { Pool, PoolClient } from 'pg';
import type { TenantContext } from './tenant-context';
import { TenantScopeError, assertTenantContext } from './tenant-context';

/**
 * The transaction boundary (ADR-0017, CLAUDE.md §6).
 *
 * Every money-changing or lifecycle-changing command runs inside exactly one of
 * these. The tenant context is established with `SET LOCAL`, so it dies with the
 * transaction and cannot survive on a pooled connection — the leak `SET` would
 * cause is the specific bug ADR-0017 §2 exists to prevent.
 */

/** The only handle a repository gets. It cannot reach the pool or open its own transaction. */
export interface UnitOfWork {
  readonly context: TenantContext;
  /** Server time, captured once per transaction (10-money-and-time-invariants §2.1). */
  readonly serverNow: Date;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

class TransactionUnitOfWork implements UnitOfWork {
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly serverNow: Date,
  ) {}

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    const result = await this.client.query(text, values as unknown[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }
}

async function applyContext(client: PoolClient, context: TenantContext): Promise<Date> {
  // set_config(..., is_local => true) is SET LOCAL with a bound parameter, so a
  // context value can never be concatenated into SQL text.
  await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', context.hotelId]);
  await client.query('SELECT set_config($1, $2, true)', ['app.realm', context.realm]);
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', context.actorRef]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.correlation_id',
    context.correlationId,
  ]);
  // Empty rather than absent when there is no authenticated account:
  // `platform.current_account_id()` maps the empty string to NULL, so an
  // account policy matches nothing instead of matching whatever the previous
  // transaction on this connection happened to set.
  await client.query('SELECT set_config($1, $2, true)', [
    'app.account_id',
    context.accountId ?? '',
  ]);

  const now = await client.query<{ now: Date }>('SELECT now() AS now');
  const serverNow = now.rows[0]?.now;
  if (serverNow === undefined) {
    throw new TenantScopeError('server time could not be established');
  }
  return serverNow;
}

/**
 * Runs `work` in one transaction under `context`, committing on success and
 * rolling back on any throw.
 *
 * Because domain mutation, audit append and outbox insert all go through the same
 * `UnitOfWork`, they commit or fail together — which is what makes a high-risk
 * action that cannot be attributed simply not happen (ADR-0018 §5).
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  context: TenantContext,
  work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  assertTenantContext(context);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const serverNow = await applyContext(client, context);
    const result = await work(new TransactionUnitOfWork(client, context, serverNow));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure means the connection is already unusable; the original
      // error is the one worth propagating.
    }
    throw error;
  } finally {
    // Belt and braces: SET LOCAL is already discarded by COMMIT/ROLLBACK, but an
    // explicit reset makes a leak impossible even if a future change opens a
    // transaction some other way. Only the app.* keys are reset — a blanket
    // RESET ALL would also drop the connection's role.
    try {
      await client.query(
        'RESET app.hotel_id; RESET app.realm; RESET app.actor_ref; RESET app.correlation_id; RESET app.account_id',
      );
    } catch {
      // Ignored: the connection is being released either way.
    }
    client.release();
  }
}

/**
 * Reads the tenant context PostgreSQL currently sees. Used by the pool-leak gate
 * to prove that a connection returned to the pool carries nothing forward.
 */
export async function readSessionScope(
  pool: Pool,
): Promise<{ hotelId: string | null; realm: string | null; accountId: string | null }> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      hotel_id: string | null;
      realm: string | null;
      account_id: string | null;
    }>(
      `SELECT nullif(current_setting('app.hotel_id', true), '')   AS hotel_id,
              nullif(current_setting('app.realm', true), '')      AS realm,
              nullif(current_setting('app.account_id', true), '') AS account_id`,
    );
    return {
      hotelId: result.rows[0]?.hotel_id ?? null,
      realm: result.rows[0]?.realm ?? null,
      accountId: result.rows[0]?.account_id ?? null,
    };
  } finally {
    client.release();
  }
}
