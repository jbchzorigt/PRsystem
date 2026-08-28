import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from './bootstrap';
import type { LoginPrincipal } from './bootstrap';
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
/** A throwaway database the fingerprint sensitivity tests are allowed to tamper with. */
const SENSITIVITY_DATABASE = 'prsystem_migration_sensitivity';

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
/**
 * Every schema the kernel owns, plus the migration ledger's own schema. A
 * fingerprint that skipped the ledger schema could not detect drift in the thing
 * that records which migrations ran.
 */
const FINGERPRINT_SCHEMAS = ['platform', 'audit', 'police_audit', 'police', 'drizzle'];

async function schemaFingerprint(pool: Pool): Promise<string> {
  const schemas = FINGERPRINT_SCHEMAS;

  /** Runs one catalogue projection. Every query orders fully, so the result is stable. */
  const q = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await pool.query<Record<string, unknown>>(sql, [schemas])).rows;

  // Schema identity, ownership and ACLs — the security posture, not only shape.
  const namespaces = await q(
    `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner,
            coalesce(array_to_string(n.nspacl, ' '), '(default)') AS acl
       FROM pg_namespace n WHERE n.nspname = ANY($1) ORDER BY 1`,
  );

  // Default privileges decide what *future* objects inherit; drift here is
  // invisible in today's ACLs and shows up as a privilege bug much later.
  const defaultAcl = await q(
    `SELECT n.nspname, pg_get_userbyid(d.defaclrole) AS role, d.defaclobjtype::text AS objtype,
            coalesce(array_to_string(d.defaclacl, ' '), '') AS acl
       FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  // Relations of every kind, with ownership, ACLs, RLS flags, partitioning
  // strategy and partition bound.
  const relations = await q(
    `SELECT n.nspname, c.relname, c.relkind::text, c.relpersistence::text,
            pg_get_userbyid(c.relowner) AS owner,
            coalesce(array_to_string(c.relacl, ' '), '(default)') AS acl,
            c.relrowsecurity::text AS rls, c.relforcerowsecurity::text AS force_rls,
            coalesce(pg_get_partkeydef(c.oid), '') AS partition_key,
            coalesce(pg_get_expr(c.relpartbound, c.oid), '') AS partition_bound
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      ORDER BY 1, 2`,
  );

  const columns = await q(
    `SELECT c.table_schema, c.table_name, c.ordinal_position::text, c.column_name,
            c.data_type, c.udt_name, c.is_nullable,
            coalesce(c.column_default, '') AS column_default,
            coalesce(c.character_maximum_length::text, '') AS max_length,
            coalesce(c.numeric_precision::text, '') AS numeric_precision,
            coalesce(c.numeric_scale::text, '') AS numeric_scale,
            coalesce(c.collation_name, '') AS collation_name,
            c.is_identity, c.is_generated, coalesce(c.generation_expression, '') AS generation
       FROM information_schema.columns c
      WHERE c.table_schema = ANY($1) ORDER BY 1, 2, 3`,
  );

  const constraints = await q(
    `SELECT n.nspname, rel.relname, con.conname, con.contype::text,
            pg_get_constraintdef(con.oid) AS def, con.condeferrable::text, con.convalidated::text
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const indexes = await q(
    `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const policies = await q(
    `SELECT schemaname, tablename, policyname, permissive, cmd,
            coalesce(array_to_string(roles, ' '), '') AS roles,
            coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
       FROM pg_policies WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
  );

  // Sequence definitions only. `last_value` is state, not schema, and including
  // it would make the comparison depend on how many rows a test happened to write.
  const sequences = await q(
    `SELECT s.schemaname, s.sequencename, s.data_type::text, s.start_value::text,
            s.min_value::text, s.max_value::text, s.increment_by::text,
            s.cycle::text, s.cache_size::text,
            pg_get_userbyid(c.relowner) AS owner,
            coalesce(array_to_string(c.relacl, ' '), '(default)') AS acl
       FROM pg_sequences s
       JOIN pg_class c ON c.relname = s.sequencename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
      WHERE s.schemaname = ANY($1) ORDER BY 1, 2`,
  );

  // Types, enums and domains, including every enum label in order and every
  // domain constraint: a reordered enum is a different type.
  const types = await q(
    `SELECT n.nspname, t.typname, t.typtype::text, pg_get_userbyid(t.typowner) AS owner,
            coalesce(array_to_string(t.typacl, ' '), '(default)') AS acl,
            coalesce(
              (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid), '') AS enum_labels,
            coalesce(format_type(t.typbasetype, t.typtypmod), '') AS domain_base,
            t.typnotnull::text AS domain_not_null,
            coalesce(
              (SELECT string_agg(pg_get_constraintdef(dc.oid), ',' ORDER BY dc.conname)
                 FROM pg_constraint dc WHERE dc.contypid = t.oid), '') AS domain_constraints
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1) AND t.typtype IN ('e', 'd', 'c', 'r')
        AND NOT EXISTS (
          SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
      ORDER BY 1, 2`,
  );

  // Views and materialised views by definition, not merely by name.
  const views = await q(
    `SELECT n.nspname, c.relname, c.relkind::text, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm') ORDER BY 1, 2`,
  );

  // Functions by *complete* definition. Name, owner and security mode alone
  // would let a rewritten body pass as an identical schema, which is precisely
  // the drift a migration-equivalence check exists to catch.
  const functions = await q(
    `SELECT n.nspname, p.proname,
            pg_get_function_identity_arguments(p.oid) AS identity_args,
            pg_get_function_result(p.oid) AS returns,
            pg_get_functiondef(p.oid) AS def,
            p.prosecdef::text, p.provolatile::text, p.proleakproof::text, p.prokind::text,
            coalesce(array_to_string(p.proconfig, ' '), '') AS config,
            pg_get_userbyid(p.proowner) AS owner,
            coalesce(array_to_string(p.proacl, ' '), '(default)') AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')
      ORDER BY 1, 2, 3`,
  );

  const triggers = await q(
    `SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled::text
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const inheritance = await q(
    `SELECT pn.nspname AS parent_schema, pc.relname AS parent,
            cn.nspname AS child_schema, cc.relname AS child,
            coalesce(pg_get_expr(cc.relpartbound, cc.oid), '') AS bound
       FROM pg_inherits i
       JOIN pg_class cc ON cc.oid = i.inhrelid
       JOIN pg_namespace cn ON cn.oid = cc.relnamespace
       JOIN pg_class pc ON pc.oid = i.inhparent
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE cn.nspname = ANY($1) OR pn.nspname = ANY($1)
      ORDER BY 1, 2, 3, 4`,
  );

  // Extensions are schema too: a database missing one, or carrying a different
  // version, is not equivalent even when every table matches.
  const extensions = (
    await pool.query<Record<string, unknown>>(
      `SELECT e.extname, e.extversion, n.nspname AS schema
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql' ORDER BY 1`,
    )
  ).rows;

  return JSON.stringify(
    {
      namespaces,
      defaultAcl,
      relations,
      columns,
      constraints,
      indexes,
      policies,
      sequences,
      types,
      views,
      functions,
      triggers,
      inheritance,
      extensions,
    },
    null,
    0,
  );
}

/**
 * The frozen Phase 02 baseline, committed as a fixture.
 *
 * Deliberately **not** a runtime copy of the live `0000`: copying head to build
 * the "previous release" would make the upgrade test assert that head upgrades
 * from head, which is a tautology. This is the artefact as released.
 */
const FROZEN_BASELINE = resolve(__dirname, 'test-support', 'frozen-baseline');
const FROZEN_BASELINE_SHA256 = '2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc';

function frozenBaselineChecksum(): string {
  return createHash('sha256')
    .update(readFileSync(join(FROZEN_BASELINE, '0000_baseline.sql')))
    .digest('hex');
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
  for (const database of [FRESH_DATABASE, UPGRADE_DATABASE, SENSITIVITY_DATABASE]) {
    await retry(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await retry(`CREATE DATABASE ${database}`);
    // Cluster bootstrap first: the migration refuses to run without it.
    await bootstrapCluster({
      adminUrl: withDatabase(ADMIN_URL, database),
      database,
      logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
        principal,
        password: TEST_LOGIN_PASSWORD,
      })),
    });
  }
}, 120000);

afterAll(async () => {
  for (const database of [FRESH_DATABASE, UPGRADE_DATABASE, SENSITIVITY_DATABASE]) {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  await admin.end();
}, 60000);

function asMigrationLogin(url: string): string {
  const parsed = new URL(url);
  parsed.username = TEST_LOGIN_PRINCIPALS.migrate;
  parsed.password = TEST_LOGIN_PASSWORD;
  return parsed.toString();
}

describe('migration runner', () => {
  const freshUrl = asMigrationLogin(withDatabase(ADMIN_URL, FRESH_DATABASE));
  const upgradeUrl = asMigrationLogin(withDatabase(ADMIN_URL, UPGRADE_DATABASE));
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

  it('uses the frozen Phase 02 artefact, not a copy of the current baseline', () => {
    expect(frozenBaselineChecksum()).toBe(FROZEN_BASELINE_SHA256);
  });

  it('upgrades a Phase 02 baseline database to head', async () => {
    const baselineOutcome = await runMigrations(upgradeUrl, { migrationsFolder: FROZEN_BASELINE });
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

/**
 * Sensitivity of the equivalence check itself.
 *
 * "Fresh equals upgraded" is only evidence if the comparison could have failed.
 * A fingerprint that lists function names but not bodies, or views but not their
 * definitions, reports equivalence for two genuinely different databases. These
 * tests tamper with a throwaway database and require the fingerprint to notice.
 */
describe('schema fingerprint sensitivity', () => {
  const migrateUrl = asMigrationLogin(withDatabase(ADMIN_URL, SENSITIVITY_DATABASE));
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations(migrateUrl);
    pool = new Pool({ connectionString: withDatabase(ADMIN_URL, SENSITIVITY_DATABASE), max: 1 });
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it('changes when a function body changes', async () => {
    const before = await schemaFingerprint(pool);

    // Same name, same signature, same attributes — only the body differs.
    await pool.query(
      `CREATE OR REPLACE FUNCTION platform.maintenance_job_name() RETURNS text
         LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
         SELECT 'platform.maintenance.tampered'::text
       $fn$`,
    );

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a view definition changes', async () => {
    await pool.query(`CREATE VIEW platform.fingerprint_probe AS SELECT 1 AS probe`);
    const before = await schemaFingerprint(pool);

    // Same view, same column name and type; only the expression differs.
    await pool.query(`CREATE OR REPLACE VIEW platform.fingerprint_probe AS SELECT 2 AS probe`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a grant is revoked', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`REVOKE SELECT ON platform.outbox_event FROM prsystem_worker`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);
});

describe('server and extension evidence', () => {
  it('records the exact PostgreSQL version the gates ran against', async () => {
    const pool = new Pool({
      connectionString: asMigrationLogin(withDatabase(ADMIN_URL, FRESH_DATABASE)),
      max: 1,
    });
    try {
      const version = await pool.query<{ full: string; num: string }>(
        `SELECT version() AS full, current_setting('server_version') AS num`,
      );
      // Pinned in docker-compose.yml. A gate that silently moved to another major
      // would invalidate every partitioning and RLS assertion above it.
      expect(version.rows[0]?.num).toMatch(/^17\./);

      const extensions = await pool.query<{ extname: string; extversion: string }>(
        `SELECT extname, extversion FROM pg_extension ORDER BY extname`,
      );
      const names = extensions.rows.map((r) => r.extname);
      expect(names).toContain('btree_gist');
      expect(names).toContain('pgcrypto');
    } finally {
      await pool.end();
    }
  });
});

describe('transactional failure recovery', () => {
  it('leaves the database untouched when a migration in the journal fails', async () => {
    const database = 'prsystem_migration_failure';
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    await bootstrapCluster({
      adminUrl: withDatabase(ADMIN_URL, database),
      database,
      logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
        principal,
        password: TEST_LOGIN_PASSWORD,
      })),
    });

    const url = asMigrationLogin(withDatabase(ADMIN_URL, database));
    try {
      // A journal whose second file is broken. The runner applies the journal in
      // one transaction, so a failure anywhere rolls the whole run back — a
      // forward fix therefore starts from the previous known state, never from a
      // half-applied schema.
      const folder = mkdtempSync(join(tmpdir(), 'prsystem-broken-'));
      mkdirSync(join(folder, 'meta'), { recursive: true });
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { idx: number; tag: string; version: string; when: number }[] };

      const first = journal.entries[0]!;
      copyFileSync(join(MIGRATIONS_FOLDER, `${first.tag}.sql`), join(folder, `${first.tag}.sql`));
      writeFileSync(
        join(folder, '0001_broken.sql'),
        'CREATE TABLE platform_broken_probe (id int);\n--> statement-breakpoint\nSELECT 1/0;\n',
        'utf8',
      );
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({
          ...journal,
          entries: [first, { ...first, idx: 1, tag: '0001_broken', when: first.when + 1 }],
        }),
        'utf8',
      );

      await expect(runMigrations(url, { migrationsFolder: folder })).rejects.toThrow();

      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        const leftover = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.tables
            WHERE table_name = 'platform_broken_probe'`,
        );
        expect(leftover.rows[0]?.count).toBe('0');

        const ledgerExists = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.tables
            WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
        );
        const applied =
          ledgerExists.rows[0]?.count === '0'
            ? '0'
            : (
                await pool.query<{ count: string }>(
                  'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
                )
              ).rows[0]?.count;

        // Nothing is recorded: the run is atomic across the whole journal, so a
        // broken file undoes even the files that had already succeeded.
        expect(applied).toBe('0');
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  }, 120000);
});
