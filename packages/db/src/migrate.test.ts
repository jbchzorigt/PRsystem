import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';

/**
 * GATE-MIGR against real PostgreSQL, never a mock or SQLite (CLAUDE.md §10).
 * Start the stack with `pnpm run compose:up` first.
 *
 *  - Fresh:       an empty database accepts the whole journal.
 *  - Upgrade:     the Phase 02 baseline accepts the kernel migration.
 *  - Determinism: fresh and upgrade produce an identical schema.
 *  - Idempotence: a second application applies nothing and mutates no ledger row.
 *  - Scope:       no business-domain table exists.
 */

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';

const FRESH_DATABASE = 'prsystem_migration_fresh';
const UPGRADE_DATABASE = 'prsystem_migration_upgrade';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let admin: Pool;

interface LedgerRow {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string;
}

async function ledgerRows(pool: Pool): Promise<LedgerRow[]> {
  const result = await pool.query<LedgerRow>(
    'SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return result.rows;
}

/**
 * A normalised description of the schema: every column, constraint, index, RLS
 * flag and policy. Comparing two of these is how "upgrade produces the same
 * schema as fresh" is asserted without shelling out to pg_dump.
 */
async function schemaFingerprint(pool: Pool): Promise<string> {
  const columns = await pool.query<Record<string, string>>(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable,
            coalesce(column_default, '') AS column_default
       FROM information_schema.columns
      WHERE table_schema IN ('platform', 'audit', 'police_audit')
      ORDER BY 1, 2, 3`,
  );
  const constraints = await pool.query<Record<string, string>>(
    `SELECT n.nspname, rel.relname, con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname IN ('platform', 'audit', 'police_audit')
      ORDER BY 1, 2, 3`,
  );
  const indexes = await pool.query<Record<string, string>>(
    `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname IN ('platform', 'audit', 'police_audit')
      ORDER BY 1, 2, 3`,
  );
  const policies = await pool.query<Record<string, string>>(
    `SELECT schemaname, tablename, policyname, coalesce(qual, '') AS qual,
            coalesce(with_check, '') AS with_check
       FROM pg_policies
      WHERE schemaname IN ('platform', 'audit', 'police_audit')
      ORDER BY 1, 2, 3`,
  );
  const rls = await pool.query<Record<string, string>>(
    `SELECT n.nspname, c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('platform', 'audit', 'police_audit') AND c.relkind IN ('r', 'p')
      ORDER BY 1, 2`,
  );

  return JSON.stringify(
    {
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      policies: policies.rows,
      rls: rls.rows,
    },
    null,
    0,
  );
}

/** Materialises the journal as it stood at the end of Phase 02. */
function baselineOnlyFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'prsystem-baseline-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };

  const baseline = { ...journal, entries: journal.entries.slice(0, 1) };
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(baseline), 'utf8');
  const tag = baseline.entries[0]?.tag ?? '';
  copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));

  return folder;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 5000 });
  // Fails loudly when PostgreSQL is not running: this gate must never pass by skipping.
  await admin.query('SELECT 1');
  // PostgreSQL serialises CREATE DATABASE against its template, so a suite in
  // another package provisioning at the same moment is contention, not failure.
  const retry = async (sql: string): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.query(sql);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt >= 20 || code === undefined || !['55006', '55P03', '40001'].includes(code)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
      }
    }
  };
  for (const database of [FRESH_DATABASE, UPGRADE_DATABASE]) {
    await retry(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await retry(`CREATE DATABASE ${database}`);
  }
}, 60000);

afterAll(async () => {
  for (const database of [FRESH_DATABASE, UPGRADE_DATABASE]) {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  await admin.end();
}, 60000);

describe('migration runner', () => {
  const freshUrl = withDatabase(ADMIN_URL, FRESH_DATABASE);
  const upgradeUrl = withDatabase(ADMIN_URL, UPGRADE_DATABASE);
  let freshLedger: LedgerRow[] = [];

  it('applies the whole journal to a fresh database', async () => {
    const outcome = await runMigrations(freshUrl);

    expect(outcome.appliedBefore).toBe(0);
    expect(outcome.appliedAfter).toBe(2);

    const pool = new Pool({ connectionString: freshUrl, max: 1 });
    try {
      freshLedger = await ledgerRows(pool);
      expect(freshLedger).toHaveLength(2);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('upgrades a Phase 02 baseline database to head', async () => {
    const baselineOutcome = await runMigrations(upgradeUrl, baselineOnlyFolder());
    expect(baselineOutcome.appliedAfter).toBe(1);

    const upgradeOutcome = await runMigrations(upgradeUrl);
    expect(upgradeOutcome.appliedBefore).toBe(1);
    expect(upgradeOutcome.appliedAfter).toBe(2);
  }, 60000);

  it('reaches the same schema by upgrade as by fresh install', async () => {
    const fresh = new Pool({ connectionString: freshUrl, max: 1 });
    const upgraded = new Pool({ connectionString: upgradeUrl, max: 1 });
    try {
      expect(await schemaFingerprint(upgraded)).toBe(await schemaFingerprint(fresh));
    } finally {
      await fresh.end();
      await upgraded.end();
    }
  }, 60000);

  it('installs the extensions the data model depends on', async () => {
    const pool = new Pool({ connectionString: freshUrl, max: 1 });
    try {
      const result = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'pgcrypto') ORDER BY extname",
      );
      expect(result.rows.map((row) => row.extname)).toEqual(['btree_gist', 'pgcrypto']);
    } finally {
      await pool.end();
    }
  });

  it('creates no business-domain table', async () => {
    const pool = new Pool({ connectionString: freshUrl, max: 1 });
    try {
      // The kernel owns platform, audit and police_audit. Anything outside those
      // schemas — or anything named after a business entity — is Phase 04+ scope
      // that has leaked in early.
      const result = await pool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
            AND NOT (table_schema = 'drizzle' AND table_name = '__drizzle_migrations')
            AND table_schema NOT IN ('platform', 'audit', 'police_audit')`,
      );
      expect(result.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('treats a second application as a safe no-op', async () => {
    const outcome = await runMigrations(freshUrl);

    expect(outcome.appliedBefore).toBe(2);
    expect(outcome.appliedAfter).toBe(2);

    const pool = new Pool({ connectionString: freshUrl, max: 1 });
    try {
      // Not merely "the count is unchanged": the recorded rows must be untouched,
      // which proves the statements were skipped rather than replayed.
      expect(await ledgerRows(pool)).toEqual(freshLedger);
    } finally {
      await pool.end();
    }
  }, 60000);
});
