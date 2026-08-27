import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from './migrate';

/**
 * GATE-MIGR, Phase 02 subset — run against real PostgreSQL, never a mock or
 * SQLite (CLAUDE.md §10). Start the stack with `pnpm run compose:up` first.
 *
 * Covered here:
 *  - Fresh:       an empty database accepts the whole journal.
 *  - Idempotence: a second application applies nothing and mutates no ledger row.
 *  - Scope:       the journal creates no table, so Phase 03 starts from a clean
 *                 slate — this is what makes the baseline business-table-free.
 *
 * Upgrade, constraint-presence, append-only and determinism assertions arrive with
 * the first real schema in Phase 03.
 */

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';

/** Scratch database. Dropped and recreated so every run starts genuinely fresh. */
const SCRATCH_DATABASE = 'prsystem_migration_gate';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const scratchUrl = withDatabase(ADMIN_URL, SCRATCH_DATABASE);

let admin: Pool;
let scratch: Pool;

interface LedgerRow {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string;
}

async function ledgerRows(): Promise<LedgerRow[]> {
  const result = await scratch.query<LedgerRow>(
    'SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return result.rows;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 5000 });
  // Fails loudly when PostgreSQL is not running: this gate must never pass by
  // skipping. `pnpm run compose:up` provides the server.
  await admin.query('SELECT 1');
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DATABASE}`);
  scratch = new Pool({ connectionString: scratchUrl, max: 1 });
}, 30000);

afterAll(async () => {
  await scratch?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE} WITH (FORCE)`);
  await admin.end();
}, 30000);

describe('migration runner', () => {
  let firstLedger: LedgerRow[] = [];

  it('applies the whole journal to a fresh database', async () => {
    const outcome = await runMigrations(scratchUrl);

    expect(outcome.appliedBefore).toBe(0);
    expect(outcome.appliedAfter).toBe(1);

    firstLedger = await ledgerRows();
    expect(firstLedger).toHaveLength(1);
  }, 30000);

  it('installs the extensions the data model depends on', async () => {
    const result = await scratch.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'pgcrypto') ORDER BY extname",
    );

    expect(result.rows.map((row) => row.extname)).toEqual(['btree_gist', 'pgcrypto']);
  });

  it('creates no platform, IAM, audit, outbox, idempotency or business table', async () => {
    // Only the migration ledger itself may exist. Any other base table means a
    // Phase 03+ schema leaked into the Phase 02 baseline.
    const result = await scratch.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND NOT (table_schema = 'drizzle' AND table_name = '__drizzle_migrations')
        ORDER BY table_schema, table_name`,
    );

    expect(result.rows).toEqual([]);
  });

  it('treats a second application as a safe no-op', async () => {
    const outcome = await runMigrations(scratchUrl);

    expect(outcome.appliedBefore).toBe(1);
    expect(outcome.appliedAfter).toBe(1);

    // Not merely "the count is unchanged": the recorded rows must be untouched,
    // which proves the statements were skipped rather than replayed.
    expect(await ledgerRows()).toEqual(firstLedger);
  }, 30000);
});
