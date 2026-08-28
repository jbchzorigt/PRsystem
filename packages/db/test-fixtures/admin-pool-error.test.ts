import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { TEST_ADMIN_APPLICATION_NAME, adminUrl, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';

/**
 * A deliberately failing fixture. Not part of any suite glob.
 *
 * The pool under attack is the **coordination** pool a `createTestDatabase`
 * lifecycle opens. It connects to the coordination database, so its errors used
 * to be filed under a database no teardown ever asserted — the accounting held
 * a record nobody read. It now belongs to the scratch database's logical scope,
 * so `drop()` must fail the run.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('admin_pool_error_fixture');
}, 120000);

afterAll(async () => {
  // No assertion call here on purpose.
  await db?.drop();
}, 60000);

it('provokes an error on the coordination pool and asserts nothing itself', async () => {
  const killer = new Client({ connectionString: adminUrl() });
  await killer.connect();
  try {
    // Exactly this lifecycle's coordination backend, by application_name —
    // not whatever else happened to be idle on the coordination database.
    const killed = await killer.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [`${TEST_ADMIN_APPLICATION_NAME}:${db.name}`],
    );
    expect(Number(killed.rows[0]?.n)).toBeGreaterThan(0);
  } finally {
    await killer.end();
  }

  await new Promise((r) => setTimeout(r, 500));
  expect(true).toBe(true);
}, 60000);
