import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { adminUrl, createTestDatabase, quietPool } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';

/**
 * A deliberately failing fixture. Not part of any suite glob.
 *
 * It is an *ordinary* suite: it uses `createTestDatabase`, opens a pool, and
 * never calls `assertNoUnexpectedPoolErrors` itself. An unexpected idle-client
 * error must still make the run exit non-zero, because `drop()` checks the
 * database's own account. `tools/validate-pool-error-fixture.mjs` runs this and
 * requires a non-zero exit; a zero exit means the accounting has stopped
 * catching anything.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('pool_error_fixture');
}, 120000);

afterAll(async () => {
  // No assertion call here on purpose. `drop()` is the only thing standing
  // between an infrastructure fault and a green run.
  await db?.drop();
}, 60000);

it('provokes an unexpected idle-client error and asserts nothing itself', async () => {
  const pool = quietPool({ connectionString: db.url, max: 1 }, 'fixture-probe');
  await pool.query('SELECT 1');

  const killer = new Client({ connectionString: adminUrl() });
  await killer.connect();
  try {
    const killed = await killer.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND state = 'idle'`,
      [db.name],
    );
    expect(Number(killed.rows[0]?.n)).toBeGreaterThan(0);
  } finally {
    await killer.end();
  }

  // Give the error time to reach the pool, then finish successfully. The test
  // itself passes; the run must still fail.
  await new Promise((r) => setTimeout(r, 500));
  await pool.end().catch(() => undefined);
  expect(true).toBe(true);
}, 60000);
