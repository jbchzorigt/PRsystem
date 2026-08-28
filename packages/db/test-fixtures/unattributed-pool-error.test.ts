import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { adminUrl, createTestDatabase, quietPool } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';

/**
 * A deliberately failing fixture. Not part of any suite glob.
 *
 * The pool here names no database in its configuration, so nothing can attribute
 * its errors to a scratch database. That bucket used to be recorded and never
 * read by anything. An error nobody could attribute is still an error, so every
 * scratch-database teardown now asserts it too.
 */

const PROBE_APPLICATION_NAME = 'prsystem_unattributed_fixture';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('unattributed_pool_error_fixture');
}, 120000);

afterAll(async () => {
  // No assertion call here on purpose.
  await db?.drop();
}, 60000);

it('provokes an unattributable pool error and asserts nothing itself', async () => {
  const parsed = new URL(adminUrl());
  // Host, port and credentials only: with no database in the configuration the
  // harness has nothing to attribute the pool to.
  const pool = quietPool(
    {
      host: parsed.hostname,
      port: Number(parsed.port),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      max: 1,
      application_name: PROBE_APPLICATION_NAME,
    },
    'unattributed-probe',
  );
  await pool.query('SELECT 1');

  const killer = new Client({ connectionString: adminUrl() });
  await killer.connect();
  try {
    const killed = await killer.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [PROBE_APPLICATION_NAME],
    );
    expect(Number(killed.rows[0]?.n)).toBeGreaterThan(0);
  } finally {
    await killer.end();
  }

  await new Promise((r) => setTimeout(r, 500));
  await pool.end().catch(() => undefined);
  expect(true).toBe(true);
}, 60000);
