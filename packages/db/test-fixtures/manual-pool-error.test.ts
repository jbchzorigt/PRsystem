import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { adminUrl, quietPool } from '@prsystem/testing';
import type { Pool } from 'pg';

/**
 * A deliberately failing fixture. Not part of any suite glob.
 *
 * No `createTestDatabase` anywhere: this is a suite that manages its own pool,
 * the way `migrate.test.ts` does. Scope accounting covered the lifecycle a
 * scratch database owns, so a pool like this one recorded its unexpected
 * idle-client errors into a scope nothing ever read — the accounting held the
 * record and no assertion asked for it.
 *
 * The suite's own test passes and it calls no assertion itself. The run must
 * still exit non-zero.
 */

const PROBE_APPLICATION_NAME = 'prsystem_manual_pool_fixture';

let pool: Pool;

beforeAll(async () => {
  const parsed = new URL(adminUrl());
  pool = quietPool(
    { connectionString: parsed.toString(), max: 1, application_name: PROBE_APPLICATION_NAME },
    'manual-probe',
  );
  await pool.query('SELECT 1');
}, 60000);

afterAll(async () => {
  // No assertion call here on purpose.
  await pool?.end().catch(() => undefined);
}, 30000);

it('provokes an unexpected pool error in a self-managed suite and asserts nothing', async () => {
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
  expect(true).toBe(true);
}, 60000);
