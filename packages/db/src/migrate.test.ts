import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from './bootstrap';
import type { LoginPrincipal } from './bootstrap';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import { schemaFingerprint } from './test-support/schema-fingerprint';
import { pinnedContainer, schemaDump } from './test-support/schema-dump';
import { DECLARED_TABLES } from './schema';
import {
  COMPARED_SCHEMAS,
  assertSchemaMatchesDeclaration,
  compareSchema,
} from './schema-comparator';
import { diffDeclarations, drizzleProjection } from './schema-projection';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import { getTableConfig } from 'drizzle-orm/pg-core';

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
/** A pristine database for the comparator mutation tests. */
const COMPARATOR_DATABASE = 'prsystem_migration_comparator';

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
  admin = quietPool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 5000 });
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
  for (const database of [
    FRESH_DATABASE,
    UPGRADE_DATABASE,
    SENSITIVITY_DATABASE,
    COMPARATOR_DATABASE,
  ]) {
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
  for (const database of [
    FRESH_DATABASE,
    UPGRADE_DATABASE,
    SENSITIVITY_DATABASE,
    COMPARATOR_DATABASE,
  ]) {
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

    const pool = quietPool({ connectionString: freshUrl, max: 1 });
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

  it('produces a byte-identical normalized schema dump by upgrade and by fresh install', async () => {
    // The contract is a normalized schema *dump*, not a selection of catalogue
    // columns. pg_dump emits everything PostgreSQL would need to recreate the
    // database — owners, grants, policies, function bodies, triggers,
    // reloptions — so a property nobody thought to project is still compared.
    const container = pinnedContainer();
    const fresh = schemaDump({ container, user: 'prsystem', database: FRESH_DATABASE });
    const upgraded = schemaDump({ container, user: 'prsystem', database: UPGRADE_DATABASE });

    expect(upgraded).toBe(fresh);
    // A dump that normalized itself down to nothing would compare equal too.
    expect(fresh.length).toBeGreaterThan(10_000);
    expect(fresh).toMatch(/CREATE POLICY/);
    expect(fresh).toMatch(/OWNER TO prsystem_migrate/);
    expect(fresh).toMatch(/GRANT /);
  }, 120000);

  it('keeps the catalogue fingerprint as a supplementary check', async () => {
    const fresh = quietPool({ connectionString: freshUrl, max: 1 });
    const upgraded = quietPool({ connectionString: upgradeUrl, max: 1 });
    try {
      expect(await schemaFingerprint(upgraded)).toBe(await schemaFingerprint(fresh));
    } finally {
      await fresh.end();
      await upgraded.end();
    }
  }, 60000);

  it('declares every root table the migration creates', async () => {
    // The previous check compared only the tables already in DECLARED_TABLES,
    // so a table nobody declared was a table nobody compared: audit.platform_event
    // and police_audit.security_event were both absent and both invisible.
    const pool = quietPool({ connectionString: freshUrl, max: 1 }, 'declared-tables');
    try {
      const live = await pool.query<{ table: string }>(
        `SELECT n.nspname || '.' || c.relname AS table
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('platform', 'audit', 'police_audit')
            AND c.relkind IN ('r', 'p')
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
          ORDER BY 1`,
      );
      const declared = DECLARED_TABLES.map((table) => {
        const config = getTableConfig(table);
        return `${config.schema ?? 'public'}.${config.name}`;
      }).sort();

      expect(live.rows.map((r) => r.table)).toEqual(declared);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('matches the declared schema on type, nullability, default and identity', async () => {
    // The title used to overstate this: it compared column names, types and
    // nullability only, so a lost default or a dropped identity passed it. The
    // Drizzle declaration now states both, and this compares the whole shape.
    const pool = quietPool({ connectionString: freshUrl, max: 1 }, 'declared-properties');
    try {
      const declared = drizzleProjection().columns;

      const live = await pool.query<{ table: string; column: string; shape: string }>(
        `SELECT n.nspname || '.' || c.relname AS table, a.attname AS column,
                format_type(a.atttypid, a.atttypmod)
                  || ' | ' || CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END
                  || ' | ' || CASE WHEN d.adbin IS NULL THEN 'no default'
                                   ELSE 'default ' || pg_get_expr(d.adbin, d.adrelid) END
                  || ' | ' || CASE WHEN a.attidentity = '' THEN 'no identity'
                                   ELSE 'identity ' || a.attidentity::text END
                  || ' | ' || CASE WHEN a.attgenerated = '' THEN 'not generated'
                                   ELSE 'generated ' || a.attgenerated::text END AS shape
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname IN ('platform', 'audit', 'police_audit')
            AND c.relkind IN ('r', 'p')
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY 1, 2`,
      );

      const key = (r: { table: string; column: string }): string => `${r.table}.${r.column}`;
      const liveByKey = new Map(live.rows.map((r) => [key(r), r.shape]));

      for (const column of declared) {
        expect({ column: key(column), shape: liveByKey.get(key(column)) }).toEqual({
          column: key(column),
          shape: column.shape,
        });
      }

      // And no live column is missing from the declaration.
      expect(live.rows.length).toBe(declared.length);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('matches the live keys, constraints and indexes', async () => {
    // Structure the Drizzle DSL cannot fully express is compared against the
    // database directly, so the declaration cannot drift silently past it.
    const pool = quietPool({ connectionString: freshUrl, max: 1 }, 'declared-structure');
    try {
      const constraints = await pool.query<{ table: string; kind: string; count: number }>(
        `SELECT n.nspname || '.' || rel.relname AS table, con.contype::text AS kind,
                count(*)::int AS count
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname IN ('platform', 'audit', 'police_audit')
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = rel.oid)
          GROUP BY 1, 2 ORDER BY 1, 2`,
      );
      // Every kernel table carries at least one constraint, and the primary and
      // foreign keys the model depends on are present.
      const kinds = new Set(constraints.rows.map((r) => `${r.table}:${r.kind}`));
      expect(kinds).toContain('platform.job_run:p');
      expect(kinds).toContain('platform.job_run:c');
      expect(kinds).toContain('platform.outbox_delivery:f');
      expect(kinds).toContain('platform.export_artifact:f');

      const indexes = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_indexes
          WHERE schemaname IN ('platform', 'audit', 'police_audit')`,
      );
      expect(Number(indexes.rows[0]?.n)).toBeGreaterThan(10);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('matches the declaration exactly, through the shared comparator', async () => {
    // The blocking check and the mutation tests below call the *same* function.
    // Two implementations would let the gate and its own proof disagree.
    const pool = quietPool({ connectionString: freshUrl, max: 1 }, 'comparator-fresh');
    try {
      await expect(assertSchemaMatchesDeclaration(pool)).resolves.toBeUndefined();
      expect(await compareSchema(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('matches the declaration on the upgraded database too', async () => {
    // The dump comparison alone cannot catch a defect the fresh and upgrade
    // paths share, because they run the same SQL. This compares each against a
    // declaration instead.
    const pool = quietPool({ connectionString: upgradeUrl, max: 1 }, 'comparator-upgrade');
    try {
      expect(await compareSchema(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('installs the extensions the data model depends on', async () => {
    const pool = quietPool({ connectionString: freshUrl, max: 1 });
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
    const pool = quietPool({ connectionString: freshUrl, max: 1 });
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

    const pool = quietPool({ connectionString: freshUrl, max: 1 });
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
    pool = quietPool({ connectionString: withDatabase(ADMIN_URL, SENSITIVITY_DATABASE), max: 1 });
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  /** The normalized dump of the throwaway sensitivity database. */
  const dumpSensitivity = (): string =>
    schemaDump({
      container: pinnedContainer(),
      user: 'prsystem',
      database: SENSITIVITY_DATABASE,
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

  it('changes when a column-level grant is revoked', async () => {
    // The table-level ACL is unchanged here: only the column list narrows.
    const before = await schemaFingerprint(pool);

    // The remaining column-scoped grant: the maintenance definer may set only
    // the three columns that record how its own job ended.
    await pool.query(`REVOKE UPDATE (error_name) ON platform.job_run FROM prsystem_maintenance_fn`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a global default privilege is added', async () => {
    // `defaclnamespace = 0`: applies to every schema, including ones that do not
    // exist yet, and appears in no object's current ACL.
    const before = await schemaFingerprint(pool);

    await pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE prsystem_migrate GRANT SELECT ON TABLES TO prsystem_api`,
    );

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a schema-local default privilege is added', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE prsystem_migrate IN SCHEMA platform
         GRANT SELECT ON SEQUENCES TO prsystem_worker`,
    );

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when replica identity changes', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`ALTER TABLE platform.outbox_event REPLICA IDENTITY FULL`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a relation option changes', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`ALTER TABLE platform.outbox_event SET (fillfactor = 70)`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when an RLS policy predicate changes', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`ALTER POLICY tenant_isolation ON platform.outbox_event USING (true)`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a trigger is dropped', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`DROP TRIGGER job_run_transition_guard ON platform.job_run`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a function security mode or search path changes', async () => {
    const before = await schemaFingerprint(pool);

    // Body identical; only the search_path setting differs. A fingerprint that
    // hashed the body alone would report these two databases as equivalent.
    await pool.query(
      `ALTER FUNCTION platform.maintenance_job_name() SET search_path = pg_catalog, pg_temp`,
    );

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a constraint is dropped', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`ALTER TABLE platform.job_run DROP CONSTRAINT job_run_terminal_has_finish`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when an index is dropped', async () => {
    const before = await schemaFingerprint(pool);

    await pool.query(`DROP INDEX platform.job_run_name_idx`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a view security option changes', async () => {
    // `security_invoker` decides whose privileges and whose RLS policies a view
    // runs under. Two databases differing only in this are not equivalent, and
    // the difference appears in `reloptions` rather than in the definition.
    await pool.query(
      `CREATE VIEW platform.security_option_probe WITH (security_invoker = true)
         AS SELECT hotel_id FROM platform.outbox_event`,
    );
    const before = await schemaFingerprint(pool);
    const beforeDump = dumpSensitivity();

    await pool.query(`ALTER VIEW platform.security_option_probe SET (security_invoker = false)`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
    expect(dumpSensitivity()).not.toBe(beforeDump);
  }, 60000);

  it('changes when a view security_barrier changes', async () => {
    const before = await schemaFingerprint(pool);
    await pool.query(`ALTER VIEW platform.security_option_probe SET (security_barrier = true)`);
    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when a view check option changes', async () => {
    await pool.query(
      `CREATE VIEW platform.check_option_probe AS
         SELECT hotel_id FROM platform.outbox_event WHERE hotel_id IS NOT NULL`,
    );
    const before = dumpSensitivity();

    await pool.query(`ALTER VIEW platform.check_option_probe SET (check_option = 'cascaded')`);

    expect(dumpSensitivity()).not.toBe(before);
  }, 60000);

  it('changes when a sequence loses its ownership link', async () => {
    // A sequence detached from its column survives a DROP COLUMN it should not.
    // The kernel's own sequence is an identity sequence, whose ownership
    // PostgreSQL will not let go, so this uses an ordinary owned sequence.
    await pool.query(`CREATE TABLE platform.sequence_probe (n integer)`);
    await pool.query(`CREATE SEQUENCE platform.sequence_probe_seq
                        OWNED BY platform.sequence_probe.n`);
    const before = await schemaFingerprint(pool);

    await pool.query(`ALTER SEQUENCE platform.sequence_probe_seq OWNED BY NONE`);

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('changes when an index access method changes', async () => {
    const before = await schemaFingerprint(pool);

    // btree -> hash on the same column: same index name, different structure.
    await pool.query(`DROP INDEX platform.outbox_delivery_claimable_idx`);
    await pool.query(
      `CREATE INDEX outbox_delivery_claimable_idx
         ON platform.outbox_delivery USING hash (event_id)`,
    );

    expect(await schemaFingerprint(pool)).not.toBe(before);
  }, 60000);

  it('records the tablespace of every relation, though only pg_default exists here', async () => {
    // Tablespaces need a filesystem location the pinned container does not
    // provide, so this asserts the projection is present and correct rather than
    // claiming to have exercised a non-default tablespace.
    const spaces = await pool.query<{ spcname: string }>(`SELECT spcname FROM pg_tablespace`);
    expect(spaces.rows.map((r) => r.spcname).sort()).toEqual(['pg_default', 'pg_global']);

    const fingerprint = JSON.parse(await schemaFingerprint(pool)) as {
      storage: { tablespace: string }[];
    };
    expect(fingerprint.storage.length).toBeGreaterThan(0);
    expect(new Set(fingerprint.storage.map((s) => s.tablespace))).toEqual(new Set(['(default)']));
  }, 60000);

  it('fails when a table exists that the declaration does not cover', async () => {
    // The undeclared-table case, driven rather than described: audit.platform_event
    // and police_audit.security_event were both missing from the declaration and
    // both invisible to a comparison that only walked the declared list.
    await pool.query(`CREATE TABLE platform.undeclared_probe (id integer PRIMARY KEY)`);
    try {
      const live = await pool.query<{ table: string }>(
        `SELECT n.nspname || '.' || c.relname AS table
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('platform', 'audit', 'police_audit') AND c.relkind IN ('r', 'p')
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)`,
      );
      const declared = DECLARED_TABLES.map((table) => {
        const config = getTableConfig(table);
        return `${config.schema ?? 'public'}.${config.name}`;
      });

      // Earlier sensitivity cases in this file also leave probe tables behind,
      // so the assertion is that this one is seen, not that it is alone.
      const undeclared = live.rows.map((r) => r.table).filter((t) => !declared.includes(t));
      expect(undeclared).toContain('platform.undeclared_probe');
    } finally {
      await pool.query(`DROP TABLE platform.undeclared_probe`);
    }
  }, 60000);

  it('fails when a declared column changes type', async () => {
    const before = dumpSensitivity();
    await pool.query(`ALTER TABLE platform.job_run ALTER COLUMN error_name TYPE varchar(200)`);

    const live = await pool.query<{ type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relname = 'job_run' AND a.attname = 'error_name'`,
    );
    // The declaration says text; the database now says varchar(200).
    expect(live.rows[0]?.type).not.toBe('text');
    expect(dumpSensitivity()).not.toBe(before);
  }, 60000);

  it('fails when a declared column loses its default', async () => {
    const before = dumpSensitivity();
    await pool.query(`ALTER TABLE platform.job_run ALTER COLUMN state DROP DEFAULT`);

    const live = await pool.query<{ has_default: boolean }>(
      `SELECT a.atthasdef AS has_default
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relname = 'job_run' AND a.attname = 'state'`,
    );
    expect(live.rows[0]?.has_default).toBe(false);
    expect(dumpSensitivity()).not.toBe(before);
  }, 60000);

  it('fails when a primary key is dropped', async () => {
    const before = dumpSensitivity();
    await pool.query(`ALTER TABLE platform.export_artifact DROP CONSTRAINT export_artifact_pkey`);
    expect(dumpSensitivity()).not.toBe(before);
  }, 60000);

  it('fails when a foreign key is dropped', async () => {
    const before = dumpSensitivity();
    const fk = await pool.query<{ conname: string }>(
      `SELECT con.conname FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'platform' AND rel.relname = 'outbox_delivery' AND con.contype = 'f'
        LIMIT 1`,
    );
    await pool.query(`ALTER TABLE platform.outbox_delivery DROP CONSTRAINT ${fk.rows[0]!.conname}`);
    expect(dumpSensitivity()).not.toBe(before);
  }, 60000);

  it('fails the determinism gate on a one-line security-relevant change', async () => {
    // The gate itself, not a proxy for it: two dumps that differ by one REVOKE
    // must not compare equal.
    const before = dumpSensitivity();

    await pool.query(`REVOKE SELECT ON platform.job_run FROM prsystem_api`);

    const after = dumpSensitivity();
    expect(after).not.toBe(before);
    expect(before).toMatch(/GRANT SELECT ON TABLE platform\.job_run TO prsystem_api/);
    expect(after).not.toMatch(/GRANT SELECT ON TABLE platform\.job_run TO prsystem_api/);
  }, 60000);
});

describe('server and extension evidence', () => {
  it('records the exact PostgreSQL version the gates ran against', async () => {
    const pool = quietPool({
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

      const pool = quietPool({ connectionString: url, max: 1 });
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

/**
 * Mutation tests for the exact comparator.
 *
 * Their own database: the sensitivity describe above deliberately leaves probe
 * tables and views behind, and a comparator that reports those as undeclared —
 * correctly — would make every "restored to clean" assertion here fail for the
 * wrong reason.
 */
describe('schema comparator mutations', () => {
  const comparatorUrl = asMigrationLogin(withDatabase(ADMIN_URL, COMPARATOR_DATABASE));
  let comparatorPool: Pool;

  beforeAll(async () => {
    await runMigrations(comparatorUrl);
    comparatorPool = quietPool(
      { connectionString: withDatabase(ADMIN_URL, COMPARATOR_DATABASE), max: 1 },
      'comparator-mutations',
    );
    // The starting point must be clean, or every assertion below is meaningless.
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 120000);

  afterAll(async () => {
    await comparatorPool?.end();
  });

  it('the comparator rejects a dropped column default', async () => {
    // Each of these calls the same compareSchema the blocking gate calls, and
    // asserts on the specific difference it introduced — not merely that
    // something changed.
    await comparatorPool.query(`ALTER TABLE platform.job_run ALTER COLUMN state DROP DEFAULT`);
    const differences = await compareSchema(comparatorPool);
    expect(differences).toContainEqual(
      expect.objectContaining({ kind: 'column', subject: 'platform.job_run.state' }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.job_run ALTER COLUMN state SET DEFAULT 'running'`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a changed column type', async () => {
    await comparatorPool.query(
      `ALTER TABLE platform.job_run ALTER COLUMN error_name TYPE varchar(200)`,
    );
    const differences = await compareSchema(comparatorPool);
    expect(differences).toContainEqual(
      expect.objectContaining({ kind: 'column', subject: 'platform.job_run.error_name' }),
    );
    await comparatorPool.query(`ALTER TABLE platform.job_run ALTER COLUMN error_name TYPE text`);
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped NOT NULL', async () => {
    await comparatorPool.query(`ALTER TABLE platform.job_run ALTER COLUMN job_name DROP NOT NULL`);
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'column', subject: 'platform.job_run.job_name' }),
    );
    await comparatorPool.query(`ALTER TABLE platform.job_run ALTER COLUMN job_name SET NOT NULL`);
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped primary key', async () => {
    await comparatorPool.query(
      `ALTER TABLE platform.export_artifact DROP CONSTRAINT export_artifact_pkey`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({
        kind: 'constraint',
        subject: 'platform.export_artifact.export_artifact_pkey',
      }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.export_artifact ADD CONSTRAINT export_artifact_pkey PRIMARY KEY (export_id)`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped composite audit primary key', async () => {
    // The audit parent's key is composite. The Drizzle DSL states it now, and
    // it lives in the canonical snapshot and must still be compared.
    const definition = await comparatorPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'audit' AND rel.relname = 'platform_event' AND con.contype = 'p'`,
    );
    expect(definition.rows[0]?.definition).toMatch(/PRIMARY KEY \(.*,.*\)/);

    await comparatorPool.query(
      `ALTER TABLE audit.platform_event DROP CONSTRAINT platform_event_pk`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'constraint' }),
    );
    await comparatorPool.query(
      `ALTER TABLE audit.platform_event ADD CONSTRAINT platform_event_pk ${definition.rows[0]!.definition}`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped foreign key', async () => {
    const fk = await comparatorPool.query<{ conname: string; definition: string }>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'platform' AND rel.relname = 'outbox_delivery' AND con.contype = 'f'
        LIMIT 1`,
    );
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_delivery DROP CONSTRAINT ${fk.rows[0]!.conname}`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'constraint' }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_delivery ADD CONSTRAINT ${fk.rows[0]!.conname} ${fk.rows[0]!.definition}`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped check constraint', async () => {
    const check = await comparatorPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'platform' AND rel.relname = 'job_run'
          AND con.conname = 'job_run_state_known'`,
    );
    await comparatorPool.query(`ALTER TABLE platform.job_run DROP CONSTRAINT job_run_state_known`);
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({
        kind: 'constraint',
        subject: 'platform.job_run.job_run_state_known',
      }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.job_run ADD CONSTRAINT job_run_state_known ${check.rows[0]!.definition}`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a changed index definition', async () => {
    const before = await comparatorPool.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname = 'platform' AND indexname = 'job_run_name_idx'`,
    );
    await comparatorPool.query(`DROP INDEX platform.job_run_name_idx`);
    // Same name, different column list: a partial or reordered index is a
    // different index, and the definition is what says so.
    await comparatorPool.query(`CREATE INDEX job_run_name_idx ON platform.job_run (job_identity)`);
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'index', subject: 'platform.job_run.job_run_name_idx' }),
    );
    await comparatorPool.query(`DROP INDEX platform.job_run_name_idx`);
    await comparatorPool.query(before.rows[0]!.definition);
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped column identity', async () => {
    // platform.outbox_event.event_id is GENERATED ALWAYS AS IDENTITY. Dropping
    // it leaves the type, nullability and default all unchanged, so nothing but
    // the identity itself distinguishes the two schemas.
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_event ALTER COLUMN event_id DROP IDENTITY`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'column', subject: 'platform.outbox_event.event_id' }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a changed identity kind', async () => {
    // ALWAYS to BY DEFAULT: the column stays an identity column and stops being
    // one the application cannot override.
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_event ALTER COLUMN event_id SET GENERATED BY DEFAULT`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'column', subject: 'platform.outbox_event.event_id' }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.outbox_event ALTER COLUMN event_id SET GENERATED ALWAYS`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a dropped unique constraint', async () => {
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event DROP CONSTRAINT provider_event_uq`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({
        kind: 'constraint',
        subject: 'platform.provider_event.provider_event_uq',
      }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event
         ADD CONSTRAINT provider_event_uq UNIQUE (provider, provider_event_id)`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects a widened unique constraint', async () => {
    // Same name, different columns: a uniqueness rule that no longer holds what
    // it says it holds. A presence-only check would not see this.
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event DROP CONSTRAINT provider_event_uq`,
    );
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event
         ADD CONSTRAINT provider_event_uq UNIQUE (provider, provider_event_id, event_kind)`,
    );
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({
        kind: 'constraint',
        subject: 'platform.provider_event.provider_event_uq',
      }),
    );
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event DROP CONSTRAINT provider_event_uq`,
    );
    await comparatorPool.query(
      `ALTER TABLE platform.provider_event
         ADD CONSTRAINT provider_event_uq UNIQUE (provider, provider_event_id)`,
    );
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('covers every partition child through pg_inherits, not a name pattern', async () => {
    // The index scan used to exclude partitions by a `%_20%` table-name match.
    // A partition named outside that pattern was silently compared as though it
    // were a root table; an ordinary table matching it was silently skipped.
    const children = await comparatorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)`,
      [[...COMPARED_SCHEMAS]],
    );
    // There are partition children, so the exclusion is doing real work.
    expect(Number(children.rows[0]?.count)).toBeGreaterThan(0);

    // A partition whose name does not match the old pattern at all.
    await comparatorPool.query(
      `CREATE TABLE audit.platform_event_archive PARTITION OF audit.platform_event
         FOR VALUES FROM ('1999-01-01+00') TO ('2000-01-01+00')`,
    );
    try {
      expect(await compareSchema(comparatorPool)).toEqual([]);
    } finally {
      await comparatorPool.query(`DROP TABLE audit.platform_event_archive`);
    }
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('the comparator rejects an undeclared table', async () => {
    await comparatorPool.query(`CREATE TABLE platform.comparator_probe (id integer PRIMARY KEY)`);
    expect(await compareSchema(comparatorPool)).toContainEqual(
      expect.objectContaining({ kind: 'table', subject: 'platform.comparator_probe' }),
    );
    await comparatorPool.query(`DROP TABLE platform.comparator_probe`);
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);
});

/**
 * The exact ownership manifest, proved on an *upgrade*.
 *
 * Every case drifts one owner on a fully migrated database and then attempts a
 * journal that has one genuinely new migration pending. The refusal has to
 * happen before that DDL runs, so each case asserts the probe table does not
 * exist and the ledger did not grow — "it failed eventually" is not the property
 * being claimed.
 */
describe('ownership manifest on upgrade', () => {
  const OWNERSHIP_DATABASE = 'prsystem_migration_ownership';
  const PROBE_TABLE = 'ownership_probe';
  let ownershipUrl: string;
  let pending: string;
  let pool: Pool;

  /** A journal identical to the shipped one plus one new, real migration. */
  function journalWithPendingMigration(): string {
    const folder = mkdtempSync(join(tmpdir(), 'prsystem-ownership-'));
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string; version: string; when: number }[] };

    for (const entry of journal.entries) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    const last = journal.entries[journal.entries.length - 1]!;
    writeFileSync(
      join(folder, '0002_ownership_probe.sql'),
      `CREATE TABLE platform.${PROBE_TABLE} (id int primary key);\n`,
      'utf8',
    );
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        ...journal,
        entries: [
          ...journal.entries,
          { ...last, idx: last.idx + 1, tag: '0002_ownership_probe', when: last.when + 1 },
        ],
      }),
      'utf8',
    );
    return folder;
  }

  async function probeApplied(): Promise<boolean> {
    const found = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'platform' AND table_name = $1`,
      [PROBE_TABLE],
    );
    return found.rows[0]?.count !== '0';
  }

  async function ledgerSize(): Promise<number> {
    return (await ledgerRows(pool)).length;
  }

  /**
   * Applies `mutate`, requires the upgrade to be refused with no new DDL, then
   * reverts. The revert runs whatever happened, so one failing case cannot
   * cascade into the next.
   */
  async function refusesUpgrade(
    mutate: string[],
    revert: string[],
    options: { readonly approvedOperatorOwners?: readonly string[] } = {},
  ): Promise<unknown> {
    const before = await ledgerSize();
    // On the ownership database, not the cluster's default: `admin` is
    // connected elsewhere and would report "schema platform does not exist".
    for (const statement of mutate) await pool.query(statement);
    try {
      let raised: unknown;
      try {
        await runMigrations(ownershipUrl, { migrationsFolder: pending, ...options });
      } catch (error) {
        raised = error;
      }
      // No new DDL: the probe table does not exist and the ledger did not grow.
      expect({ probe: await probeApplied(), ledger: await ledgerSize() }).toEqual({
        probe: false,
        ledger: before,
      });
      return raised;
    } finally {
      for (const statement of revert) await pool.query(statement).catch(() => undefined);
    }
  }

  beforeAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${OWNERSHIP_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${OWNERSHIP_DATABASE}`);
    await bootstrapCluster({
      adminUrl: withDatabase(ADMIN_URL, OWNERSHIP_DATABASE),
      database: OWNERSHIP_DATABASE,
      logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
        principal,
        password: TEST_LOGIN_PASSWORD,
      })),
    });
    ownershipUrl = asMigrationLogin(withDatabase(ADMIN_URL, OWNERSHIP_DATABASE));
    await runMigrations(ownershipUrl);
    pending = journalWithPendingMigration();
    pool = quietPool({ connectionString: withDatabase(ADMIN_URL, OWNERSHIP_DATABASE), max: 2 });
  }, 180000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${OWNERSHIP_DATABASE} WITH (FORCE)`);
  }, 60000);

  it('refuses when no approved operator owner is configured', async () => {
    // Not a warning and not a skip. A deployment that has not declared which
    // identity owns its database has not declared its ownership contract, and a
    // runner that quietly proceeded would be strictest exactly where it was
    // configured and silent everywhere else.
    const saved = process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'];
    delete process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'];
    try {
      const raised = await refusesUpgrade([], []);
      expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
      expect((raised as Error).message).toMatch(/PRSYSTEM_APPROVED_OPERATOR_OWNERS is required/);
    } finally {
      if (saved !== undefined) process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'] = saved;
    }
  }, 120000);

  it('refuses when the configured value is empty', async () => {
    const raised = await refusesUpgrade([], [], { approvedOperatorOwners: ['   ', ''] });
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
  }, 120000);

  it('refuses a database owner that is not an approved operator', async () => {
    // A real, non-project identity: an operator account nobody declared.
    const raised = await refusesUpgrade([], [], {
      approvedOperatorOwners: ['some_other_operator'],
    });
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/not an approved operator owner/);
  }, 120000);

  it('refuses a runtime-owned kernel schema', async () => {
    const raised = await refusesUpgrade(
      [`ALTER SCHEMA platform OWNER TO prsystem_api`],
      [`ALTER SCHEMA platform OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/prsystem_api/);
  }, 120000);

  it('refuses a runtime-owned kernel relation', async () => {
    const raised = await refusesUpgrade(
      [`ALTER TABLE platform.job_run OWNER TO prsystem_worker`],
      [`ALTER TABLE platform.job_run OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/prsystem_worker/);
  }, 120000);

  it('refuses a kernel owner role that owns the wrong object', async () => {
    // The case "the owner is one of the four kernel owners" could never catch.
    // prsystem_maintenance_fn owning platform.job_run would let the owner of the
    // maintenance functions rewrite the very ledger constraining them.
    const raised = await refusesUpgrade(
      [`ALTER TABLE platform.job_run OWNER TO prsystem_maintenance_fn`],
      [`ALTER TABLE platform.job_run OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(
      /platform\.job_run is owned by prsystem_maintenance_fn; the manifest requires prsystem_migrate/,
    );
  }, 120000);

  it('refuses a runtime-owned SECURITY DEFINER function', async () => {
    const raised = await refusesUpgrade(
      [`ALTER FUNCTION platform.schedule_maintenance_job(text, uuid, text) OWNER TO prsystem_api`],
      [
        `ALTER FUNCTION platform.schedule_maintenance_job(text, uuid, text) OWNER TO prsystem_maintenance_fn`,
      ],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/prsystem_api/);
  }, 120000);

  it('refuses a wrongly owned drizzle schema', async () => {
    const raised = await refusesUpgrade(
      [`ALTER SCHEMA drizzle OWNER TO prsystem_partition_mgr`],
      [`ALTER SCHEMA drizzle OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/schema drizzle/);
  }, 120000);

  it('refuses a wrongly owned migration ledger', async () => {
    const raised = await refusesUpgrade(
      [`ALTER TABLE drizzle.__drizzle_migrations OWNER TO prsystem_police`],
      [`ALTER TABLE drizzle.__drizzle_migrations OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/__drizzle_migrations/);
  }, 120000);

  it('refuses an audit partition parent handed to the DDL owner', async () => {
    // The partitioned parents belong to prsystem_partition_mgr. "Some kernel
    // owner" is not the contract; the named one is.
    const raised = await refusesUpgrade(
      [`ALTER TABLE audit.platform_event OWNER TO prsystem_migrate`],
      [`ALTER TABLE audit.platform_event OWNER TO prsystem_partition_mgr`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/audit\.platform_event/);
  }, 120000);

  it('applies the pending migration once ownership is intact', async () => {
    // The positive control. Every case above reverts in its own `finally`, so a
    // green result here proves the manifest rejects drift rather than everything.
    const before = await ledgerSize();
    const outcome = await runMigrations(ownershipUrl, { migrationsFolder: pending });
    expect(outcome.appliedAfter).toBe(before + 1);
    expect(await probeApplied()).toBe(true);

    await pool.query(`DROP TABLE platform.${PROBE_TABLE}`);
    await pool.query(`DELETE FROM drizzle.__drizzle_migrations WHERE id > $1`, [before]);
  }, 120000);
});

/**
 * The two declarations, held to each other.
 *
 * `schema.ts` used to be consulted for one thing only — its list of table names
 * — so an edit to a declared column's type, nullability, default or key changed
 * nothing the gate looked at. The snapshot still matched the database and the
 * run stayed green. These cases run without a database, because the property is
 * about the declarations rather than about any deployment.
 */
describe('the Drizzle declaration and the canonical snapshot are bound together', () => {
  it('agrees with the snapshot as shipped', () => {
    expect(diffDeclarations(drizzleProjection(), EXPECTED_SCHEMA_SNAPSHOT)).toEqual([]);
  });

  it('projects the defaults, identity and keys the DSL states', () => {
    const projection = drizzleProjection();
    // Not a vacuous projection: it carries the properties the DSL was extended
    // to express, so "it agrees" above is a statement about something.
    expect(projection.columns).toContainEqual({
      table: 'platform.job_run',
      column: 'state',
      shape: "text | NOT NULL | default 'running'::text | no identity | not generated",
    });
    expect(projection.columns).toContainEqual({
      table: 'platform.outbox_event',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | identity a | not generated',
    });
    expect(projection.constraints).toContainEqual({
      table: 'audit.platform_event',
      name: 'platform_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    });
    expect(projection.constraints).toContainEqual({
      table: 'platform.provider_event',
      name: 'provider_event_uq',
      kind: 'u',
      definition: 'UNIQUE (provider, provider_event_id)',
    });
  });

  const mutations: readonly {
    readonly title: string;
    readonly mutate: (
      p: ReturnType<typeof drizzleProjection>,
    ) => ReturnType<typeof drizzleProjection>;
    readonly kind: string;
    readonly subject: string;
  }[] = [
    {
      title: 'a changed column type',
      kind: 'declaration-column',
      subject: 'platform.job_run.error_name',
      mutate: (p) => ({
        ...p,
        columns: p.columns.map((c) =>
          c.table === 'platform.job_run' && c.column === 'error_name'
            ? { ...c, shape: c.shape.replace('text |', 'character varying(200) |') }
            : c,
        ),
      }),
    },
    {
      title: 'a dropped NOT NULL',
      kind: 'declaration-column',
      subject: 'platform.job_run.job_name',
      mutate: (p) => ({
        ...p,
        columns: p.columns.map((c) =>
          c.table === 'platform.job_run' && c.column === 'job_name'
            ? { ...c, shape: c.shape.replace('NOT NULL', 'NULL') }
            : c,
        ),
      }),
    },
    {
      title: 'a dropped default',
      kind: 'declaration-column',
      subject: 'platform.job_run.state',
      mutate: (p) => ({
        ...p,
        columns: p.columns.map((c) =>
          c.table === 'platform.job_run' && c.column === 'state'
            ? { ...c, shape: c.shape.replace("default 'running'::text", 'no default') }
            : c,
        ),
      }),
    },
    {
      title: 'a dropped identity',
      kind: 'declaration-column',
      subject: 'platform.outbox_event.event_id',
      mutate: (p) => ({
        ...p,
        columns: p.columns.map((c) =>
          c.table === 'platform.outbox_event' && c.column === 'event_id'
            ? { ...c, shape: c.shape.replace('identity a', 'no identity') }
            : c,
        ),
      }),
    },
    {
      title: 'a removed column',
      kind: 'declaration-column',
      subject: 'platform.job_run.issuer_ref',
      mutate: (p) => ({
        ...p,
        columns: p.columns.filter(
          (c) => !(c.table === 'platform.job_run' && c.column === 'issuer_ref'),
        ),
      }),
    },
    {
      title: 'an added column the snapshot does not have',
      kind: 'declaration-column',
      subject: 'platform.job_run.invented',
      mutate: (p) => ({
        ...p,
        columns: [
          ...p.columns,
          {
            table: 'platform.job_run',
            column: 'invented',
            shape: 'text | NULL | no default | no identity | not generated',
          },
        ],
      }),
    },
    {
      title: 'a reordered composite primary key',
      kind: 'declaration-key',
      subject: 'audit.platform_event.platform_event_pk',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.map((c) =>
          c.name === 'platform_event_pk'
            ? { ...c, definition: 'PRIMARY KEY (event_id, occurred_at)' }
            : c,
        ),
      }),
    },
    {
      title: 'a widened unique constraint',
      kind: 'declaration-key',
      subject: 'platform.provider_event.provider_event_uq',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.map((c) =>
          c.name === 'provider_event_uq'
            ? { ...c, definition: 'UNIQUE (provider, provider_event_id, event_kind)' }
            : c,
        ),
      }),
    },
    {
      title: 'a dropped unique constraint',
      kind: 'declaration-key',
      subject: 'platform.provider_event.provider_event_uq',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.filter((c) => c.name !== 'provider_event_uq'),
      }),
    },
  ];

  for (const mutation of mutations) {
    it(`reports ${mutation.title} in schema.ts`, () => {
      const differences = diffDeclarations(
        mutation.mutate(drizzleProjection()),
        EXPECTED_SCHEMA_SNAPSHOT,
      );
      expect(differences).toContainEqual(
        expect.objectContaining({ kind: mutation.kind, subject: mutation.subject }),
      );
      // And the unmutated projection is still clean, so the case is about the
      // mutation rather than about a projection that never agreed.
      expect(diffDeclarations(drizzleProjection(), EXPECTED_SCHEMA_SNAPSHOT)).toEqual([]);
    });
  }
});
