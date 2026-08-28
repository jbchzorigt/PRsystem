import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  adminUrl,
  assertNoUnexpectedPoolErrors,
  closeTrackedPools,
  createTestDatabase,
  expectPoolTeardown,
  quietPool,
  resetPoolErrorReport,
  unexpectedPoolErrorReport,
} from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';

/**
 * SEC-POOL-ERRORS — the test harness must not hide infrastructure failures.
 *
 * A pool whose database is dropped emits an idle-client `error`, and an
 * unhandled `error` event takes the process down after the tests have passed.
 * The first fix for that attached an empty handler to every pool, which also
 * discarded every idle-client error a suite might genuinely need to see.
 *
 * These tests pin the distinction: an error on a pool that is knowingly being
 * torn down is suppressed; anything else is recorded and fails the gate.
 */

let db: TestDatabase;

/** Waits until `predicate` holds, so a pool error has time to arrive. */
async function eventually(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Kills the idle backends `pool` is holding, from an independent session. */
async function killIdleBackends(database: string): Promise<number> {
  const killer = new Client({ connectionString: adminUrl() });
  await killer.connect();
  try {
    const killed = await killer.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND state = 'idle'`,
      [database],
    );
    return Number(killed.rows[0]?.n ?? 0);
  } finally {
    await killer.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase('sec_pool_errors');
}, 120000);

afterAll(async () => {
  await db?.drop();
}, 60000);

afterEach(() => {
  // These tests deliberately provoke pool errors, so the shared report is
  // cleared between them. A suite that does not provoke them must not.
  resetPoolErrorReport();
});

describe('unexpected idle-client errors', () => {
  it('records an idle-client error that was not a teardown, and fails the gate', async () => {
    const pool = quietPool({ connectionString: db.url, max: 1 }, 'unexpected-probe');
    try {
      // Establish and release a connection, so the pool holds one idle.
      await pool.query('SELECT 1');
      expect(unexpectedPoolErrorReport()).toHaveLength(0);

      // Nothing has marked this pool as tearing down: the termination below is
      // exactly the kind of infrastructure fault the gate must not swallow.
      const killed = await killIdleBackends(db.name);
      expect(killed).toBeGreaterThan(0);

      await eventually(() => unexpectedPoolErrorReport().length > 0);

      const report = unexpectedPoolErrorReport();
      expect(report[0]?.label).toBe('unexpected-probe');
      // And the assertion a suite calls in afterAll fails on it.
      expect(() => {
        assertNoUnexpectedPoolErrors();
      }).toThrow(/unexpected pool error/i);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60000);

  it('suppresses the same termination once the pool is marked as tearing down', async () => {
    // The positive control for the suppression path. Without it, the test above
    // could pass for a harness that records every error and suppresses none.
    const pool = quietPool({ connectionString: db.url, max: 1 }, 'teardown-probe');
    try {
      await pool.query('SELECT 1');
      expectPoolTeardown(pool);

      const killed = await killIdleBackends(db.name);
      expect(killed).toBeGreaterThan(0);

      // Give any error the same window the previous test needed.
      await new Promise((r) => setTimeout(r, 500));

      expect(unexpectedPoolErrorReport()).toHaveLength(0);
      expect(() => {
        assertNoUnexpectedPoolErrors();
      }).not.toThrow();
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60000);

  it('closes tracked pools before a database is dropped', async () => {
    // The ordinary path: nothing is left for FORCE to terminate, so no error
    // arises at all and nothing has to be suppressed.
    const scratch = await createTestDatabase('sec_pool_drop_order');
    const pool = quietPool({ connectionString: scratch.url, max: 1 }, 'drop-order-probe');
    await pool.query('SELECT 1');

    await scratch.drop();

    expect(unexpectedPoolErrorReport()).toHaveLength(0);
    // The pool was ended by the drop, not left open. `pg` throws synchronously
    // on an ended pool, so the call is wrapped rather than awaited directly.
    await expect(async () => pool.query('SELECT 1')).rejects.toThrow(/after calling end/i);
  }, 120000);

  it('leaves query failures untouched', async () => {
    // Suppression governs the pool's out-of-band error event only. A failing
    // query must still reject, or an assertion could pass on a missing error.
    const pool = quietPool({ connectionString: db.url, max: 1 }, 'query-failure-probe');
    try {
      expectPoolTeardown(pool);
      await expect(pool.query('SELECT * FROM does_not_exist')).rejects.toMatchObject({
        code: '42P01',
      });
      expect(unexpectedPoolErrorReport()).toHaveLength(0);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60000);

  it('ends and forgets every tracked pool on request', async () => {
    const pool = quietPool({ connectionString: db.url, max: 1 }, 'close-tracked-probe');
    await pool.query('SELECT 1');

    await closeTrackedPools(db.name);

    await expect(async () => pool.query('SELECT 1')).rejects.toThrow(/after calling end/i);
    expect(unexpectedPoolErrorReport()).toHaveLength(0);
  }, 60000);
});
