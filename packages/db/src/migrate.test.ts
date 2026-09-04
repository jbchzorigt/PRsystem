import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
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
import { diffDeclarations, drizzleProjection, identityKey } from './schema-projection';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import { KERNEL_OWNERS, assertOwnershipManifest } from './ownership-manifest';
import type { ManifestClient } from './ownership-manifest';
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
/** The accepted Phase 03 database that receives only the Phase 04 migration. */
const PHASE_04_DATABASE = 'prsystem_migration_phase04';
const PHASE_05_DATABASE = 'prsystem_migration_phase05';
/** The accepted Phase 05 database that receives only the Phase 06 migration. */
const PHASE_06_DATABASE = 'prsystem_migration_phase06';
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

/** Runs `work` against a short-lived pool, and always closes it. */
async function withPool<T>(url: string, work: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = quietPool({ connectionString: url, max: 1 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
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

/**
 * The accepted Phase 03 state: `0000_baseline` + `0001_kernel`, as accepted.
 *
 * The upgrade a real cluster performs is not "Phase 02 to head" — it is "the
 * accepted release, plus exactly the one migration the new phase adds". This
 * artefact is that accepted release, pinned by checksum so an in-place edit to
 * either accepted file fails the gate instead of silently re-baselining it.
 */
const FROZEN_PHASE_03 = resolve(__dirname, 'test-support', 'frozen-phase-03');
const FROZEN_PHASE_03_SHA256: Readonly<Record<string, string>> = {
  '0000_baseline.sql': '2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc',
  '0001_kernel.sql': '00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4',
};

/**
 * The accepted Phase 04 state: the three migrations as accepted at `e5fcf19`.
 *
 * The newest accepted release, and therefore the one a running cluster is
 * actually on when Phase 05 deploys. Phase 03's artefact is kept beside it and
 * still exercised: a phase that only tested the newest accepted release would
 * stop proving that an older cluster can still reach head.
 */
const FROZEN_PHASE_04 = resolve(__dirname, 'test-support', 'frozen-phase-04');
const FROZEN_PHASE_04_SHA256: Readonly<Record<string, string>> = {
  '0000_baseline.sql': '2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc',
  '0001_kernel.sql': '00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4',
  '0002_iam_rbac_staff.sql': '25aae0e6cdbb6d6c18ff32068b6e0a6761bee130af45d336aa82aa269e038b47',
};

/**
 * The accepted Phase 05 state: the seven migrations as accepted at `35314ba`.
 *
 * The newest accepted release, and therefore the one a running cluster is
 * actually on when Phase 06 deploys. The Phase 03 and Phase 04 artefacts are
 * kept beside it and still exercised.
 */
const FROZEN_PHASE_05 = resolve(__dirname, 'test-support', 'frozen-phase-05');
const FROZEN_PHASE_05_SHA256: Readonly<Record<string, string>> = {
  '0000_baseline.sql': '2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc',
  '0001_kernel.sql': '00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4',
  '0002_iam_rbac_staff.sql': '25aae0e6cdbb6d6c18ff32068b6e0a6761bee130af45d336aa82aa269e038b47',
  '0003_onboarding_subscription.sql':
    '0f246511c1c811aefd9d3688e7e73ee6c53c088539a3efc60b525f7357dbbee6',
  '0004_onboarding_remediation.sql':
    'd06d81d1c33f10c65f4b98269361766ff60f8160ea3e9d1f83c3bc7df46e6ea4',
  '0005_onboarding_remediation2.sql':
    '00b3aac3e305ff806c5589266a653ddd324fe5054916530ecd6d39676492ba3f',
  '0006_onboarding_remediation3.sql':
    '4aeba55fd1915863e8dc282550a6d3a7b46bf2c8c9996065e372e1843e9c74f5',
};

function checksumOf(folder: string, file: string): string {
  return createHash('sha256')
    .update(readFileSync(join(folder, file)))
    .digest('hex');
}

function frozenBaselineChecksum(): string {
  return checksumOf(FROZEN_BASELINE, '0000_baseline.sql');
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
    PHASE_04_DATABASE,
    PHASE_05_DATABASE,
    PHASE_06_DATABASE,
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
    PHASE_04_DATABASE,
    PHASE_05_DATABASE,
    PHASE_06_DATABASE,
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
  const phase04Url = asMigrationLogin(withDatabase(ADMIN_URL, PHASE_04_DATABASE));
  const phase05Url = asMigrationLogin(withDatabase(ADMIN_URL, PHASE_05_DATABASE));
  const phase06Url = asMigrationLogin(withDatabase(ADMIN_URL, PHASE_06_DATABASE));
  let freshLedger: LedgerRow[] = [];

  it('applies the whole journal to a fresh database', async () => {
    const outcome = await runMigrations(freshUrl);

    expect(outcome.appliedBefore).toBe(0);
    // 0000_baseline, 0001_kernel, 0002_iam_rbac_staff, 0003_onboarding_subscription,
    // 0004_onboarding_remediation, 0005_onboarding_remediation2,
    // 0006_onboarding_remediation3, 0007_hotel_catalog, 0008_minibar_inventory.
    expect(outcome.appliedAfter).toBe(9);

    const pool = quietPool({ connectionString: freshUrl, max: 1 });
    try {
      freshLedger = await ledgerRows(pool);
      expect(freshLedger).toHaveLength(9);
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
    expect(upgradeOutcome.appliedAfter).toBe(9);
  }, 60000);

  it('holds the accepted Phase 03 migrations byte-for-byte, and only those', () => {
    // ADR-0004: an accepted migration is immutable. Pinning both checksums is
    // what makes that testable — an in-place edit to `0000` or `0001` fails
    // here rather than re-baselining the upgrade path onto whatever they became.
    for (const [file, expected] of Object.entries(FROZEN_PHASE_03_SHA256)) {
      expect({ file, sha256: checksumOf(FROZEN_PHASE_03, file) }).toEqual({
        file,
        sha256: expected,
      });
    }
    const frozen = readdirSync(FROZEN_PHASE_03)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    // Phase 04's own migration is deliberately absent: it is the one thing the
    // upgrade below is supposed to apply.
    expect(frozen).toEqual(['0000_baseline.sql', '0001_kernel.sql']);
  });

  it('holds the accepted Phase 04 migrations byte-for-byte, and only those', () => {
    for (const [file, expected] of Object.entries(FROZEN_PHASE_04_SHA256)) {
      expect({ file, sha256: checksumOf(FROZEN_PHASE_04, file) }).toEqual({
        file,
        sha256: expected,
      });
    }
    const frozen = readdirSync(FROZEN_PHASE_04)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    // Phase 05's own migration is deliberately absent: it is the one thing the
    // upgrade below is supposed to apply.
    expect(frozen).toEqual(['0000_baseline.sql', '0001_kernel.sql', '0002_iam_rbac_staff.sql']);
  });

  it('reaches head from an accepted Phase 03 database', async () => {
    // The older accepted release still upgrades: three migrations, not one.
    const accepted = await runMigrations(phase04Url, { migrationsFolder: FROZEN_PHASE_03 });
    expect({ before: accepted.appliedBefore, after: accepted.appliedAfter }).toEqual({
      before: 0,
      after: 2,
    });

    const toHead = await runMigrations(phase04Url);
    expect({ before: toHead.appliedBefore, after: toHead.appliedAfter }).toEqual({
      before: 2,
      after: 9,
    });
  }, 120000);

  it('carries an accepted Phase 04 database to head', async () => {
    // The deployment step a cluster that never took Phase 05 would make.
    const accepted = await runMigrations(phase05Url, { migrationsFolder: FROZEN_PHASE_04 });
    expect({ before: accepted.appliedBefore, after: accepted.appliedAfter }).toEqual({
      before: 0,
      after: 3,
    });

    // `0003_onboarding_subscription` and its forward-only remediations
    // `0004_onboarding_remediation`, `0005_onboarding_remediation2` and
    // `0006_onboarding_remediation3`, then Phase 06's `0007_hotel_catalog` and
    // Phase 07's `0008_minibar_inventory`; nothing accepted is rewritten.
    const toHead = await runMigrations(phase05Url);
    expect({ before: toHead.appliedBefore, after: toHead.appliedAfter }).toEqual({
      before: 3,
      after: 9,
    });

    // Applying it again is a no-op, and mutates no ledger row.
    const ledgerAfter = await withPool(phase05Url, ledgerRows);
    const repeat = await runMigrations(phase05Url);
    expect({ before: repeat.appliedBefore, after: repeat.appliedAfter }).toEqual({
      before: 9,
      after: 9,
    });
    expect(await withPool(phase05Url, ledgerRows)).toEqual(ledgerAfter);
  }, 120000);

  it('holds the accepted Phase 05 migrations byte-for-byte, and only those', () => {
    for (const [file, expected] of Object.entries(FROZEN_PHASE_05_SHA256)) {
      expect({ file, sha256: checksumOf(FROZEN_PHASE_05, file) }).toEqual({
        file,
        sha256: expected,
      });
    }
    const frozen = readdirSync(FROZEN_PHASE_05)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    // The Phase 06 and Phase 07 migrations are deliberately absent: they are
    // what the upgrade below is supposed to apply.
    expect(frozen).toEqual([
      '0000_baseline.sql',
      '0001_kernel.sql',
      '0002_iam_rbac_staff.sql',
      '0003_onboarding_subscription.sql',
      '0004_onboarding_remediation.sql',
      '0005_onboarding_remediation2.sql',
      '0006_onboarding_remediation3.sql',
    ]);
  });

  it('applies exactly the Phase 06 and Phase 07 migrations to an accepted Phase 05 database', async () => {
    // The deployment step the running cluster actually takes: the accepted
    // Phase 05 state, then the forward migrations of the unaccepted phases and
    // nothing else. Phase 06 is not accepted, so no frozen Phase 06 set exists
    // yet; the accepted base is still Phase 05's.
    const accepted = await runMigrations(phase06Url, { migrationsFolder: FROZEN_PHASE_05 });
    expect({ before: accepted.appliedBefore, after: accepted.appliedAfter }).toEqual({
      before: 0,
      after: 7,
    });

    const phase06 = await runMigrations(phase06Url);
    expect({ before: phase06.appliedBefore, after: phase06.appliedAfter }).toEqual({
      before: 7,
      after: 9,
    });

    // Applying it again is a no-op, and mutates no ledger row.
    const ledgerAfter = await withPool(phase06Url, ledgerRows);
    const repeat = await runMigrations(phase06Url);
    expect({ before: repeat.appliedBefore, after: repeat.appliedAfter }).toEqual({
      before: 9,
      after: 9,
    });
    expect(await withPool(phase06Url, ledgerRows)).toEqual(ledgerAfter);
  }, 120000);

  it('reaches the same schema by the Phase 06 upgrade as by a fresh install', async () => {
    const container = pinnedContainer();
    const fresh = schemaDump({ container, user: 'prsystem', database: FRESH_DATABASE });
    const upgraded = schemaDump({ container, user: 'prsystem', database: PHASE_06_DATABASE });

    expect(upgraded).toBe(fresh);
  }, 60000);

  it('matches the declaration on the Phase 06 upgraded database', async () => {
    const pool = quietPool({ connectionString: phase06Url, max: 1 }, 'comparator-phase06');
    try {
      expect(await compareSchema(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('reaches the same schema by the Phase 05 upgrade as by a fresh install', async () => {
    const container = pinnedContainer();
    const fresh = schemaDump({ container, user: 'prsystem', database: FRESH_DATABASE });
    const upgraded = schemaDump({ container, user: 'prsystem', database: PHASE_05_DATABASE });

    expect(upgraded).toBe(fresh);
  }, 60000);

  it('matches the declaration on the Phase 04 upgraded database', async () => {
    const pool = quietPool({ connectionString: phase04Url, max: 1 }, 'comparator-phase04');
    try {
      expect(await compareSchema(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
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

      const live = await pool.query<{
        schema: string;
        table: string;
        column: string;
        shape: string;
      }>(
        `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
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
          ORDER BY 1, 2, 3`,
      );

      // The identity tuple, not a dotted concatenation: a schema, table or
      // column name may contain a dot, and two different columns then key alike.
      const key = (r: { schema: string; table: string; column: string }): string =>
        identityKey(r.schema, r.table, r.column);
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

    expect(outcome.appliedBefore).toBe(9);
    expect(outcome.appliedAfter).toBe(9);

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

  it('the comparator rejects an undeclared enum type', async () => {
    // Enum labels and their order are persistent — they decide which values a
    // column accepts and how it sorts — and nothing read `pg_enum` at all, so a
    // type appearing in a compared schema produced no difference.
    await comparatorPool.query(`CREATE TYPE platform.comparator_mood AS ENUM ('a', 'b')`);
    try {
      expect(await compareSchema(comparatorPool)).toContainEqual(
        expect.objectContaining({ kind: 'enum', subject: 'platform.comparator_mood' }),
      );
    } finally {
      await comparatorPool.query(`DROP TYPE platform.comparator_mood`);
    }
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('reads comma, quote and Unicode labels losslessly from the catalogue', async () => {
    // Joined text could not say where one label ended. These two types differ
    // only in where the boundaries fall, and both joined to the same string.
    const readLabels = async (definition: string): Promise<string | undefined> => {
      await comparatorPool.query(`CREATE TYPE platform.comparator_labels AS ENUM (${definition})`);
      try {
        return (await compareSchema(comparatorPool)).find(
          (difference) => difference.subject === 'platform.comparator_labels',
        )?.actual;
      } finally {
        await comparatorPool.query(`DROP TYPE platform.comparator_labels`);
      }
    };

    const oneCommaLabel = await readLabels(`'a, b'`);
    const twoLabels = await readLabels(`'a', 'b'`);
    expect(oneCommaLabel).toBe('["a, b"]');
    expect(twoLabels).toBe('["a","b"]');
    expect(oneCommaLabel).not.toBe(twoLabels);

    expect(await readLabels(`'a"b', 'c''d'`)).toBe('["a\\"b","c\'d"]');
    expect(await readLabels(`'ᠮᠣᠩᠭᠣᠯ', 'улс'`)).toBe('["ᠮᠣᠩᠭᠣᠯ","улс"]');
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('tells one comma-containing policy role from two roles', async () => {
    // `array_to_string(roles, ', ')` made `TO "probe_x, probe_y"` and
    // `TO probe_x, probe_y` the same text. They grant different things.
    const reportedFor = async (target: string): Promise<string | undefined> => {
      await comparatorPool.query(`ALTER POLICY tenant_isolation ON platform.job_run TO ${target}`);
      try {
        return (await compareSchema(comparatorPool)).find(
          (difference) => difference.subject === 'platform.job_run.tenant_isolation',
        )?.actual;
      } finally {
        await comparatorPool.query(`ALTER POLICY tenant_isolation ON platform.job_run TO public`);
      }
    };

    await comparatorPool.query(`CREATE ROLE "probe_x, probe_y" NOLOGIN`);
    await comparatorPool.query(`CREATE ROLE probe_x NOLOGIN`);
    await comparatorPool.query(`CREATE ROLE probe_y NOLOGIN`);
    try {
      const oneRole = await reportedFor('"probe_x, probe_y"');
      const twoRoles = await reportedFor('probe_x, probe_y');
      expect(oneRole).toContain('["probe_x, probe_y"]');
      expect(twoRoles).toContain('["probe_x","probe_y"]');
      expect(oneRole).not.toBe(twoRoles);
    } finally {
      for (const role of ['"probe_x, probe_y"', 'probe_x', 'probe_y']) {
        await comparatorPool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }
    expect(await compareSchema(comparatorPool)).toEqual([]);
  }, 60000);

  it('reads enum labels in PostgreSQL sort order, not insertion order', async () => {
    // `enumsortorder`, not `oid`: `ALTER TYPE ... ADD VALUE ... BEFORE` gives a
    // later-created label an earlier position, and the position is what decides
    // ordering comparisons on the column.
    await comparatorPool.query(`CREATE TYPE platform.comparator_mood AS ENUM ('b', 'c')`);
    try {
      await comparatorPool.query(`ALTER TYPE platform.comparator_mood ADD VALUE 'a' BEFORE 'b'`);
      const reported = (await compareSchema(comparatorPool)).find(
        (difference) => difference.subject === 'platform.comparator_mood',
      );
      expect(reported?.actual).toBe('["a","b","c"]');
    } finally {
      await comparatorPool.query(`DROP TYPE platform.comparator_mood`);
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
 * The migration principal must be the canonical migration login.
 *
 * `assertMigrationPrincipal` verified an exact `prsystem_migrate` closure and
 * treated it as sufficient, exactly as the runtime guard once did. A new LOGIN
 * with one otherwise-perfect membership could therefore apply DDL: a second
 * migration credential nothing bootstraps, rotates or audits, accepted by the
 * real runner.
 *
 * Proved through `runMigrations`, not through the guard in isolation: the claim
 * is about what the deployment command does, and a guard test would pass even if
 * the runner stopped calling it.
 */
describe('the migration runner requires the canonical migration login', () => {
  const ROGUE = 'prsystem_rogue_migrate_login';
  const CANONICAL_DATABASE = 'prsystem_migration_canonical';
  let canonicalAdmin: Pool;

  beforeAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${CANONICAL_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${CANONICAL_DATABASE}`);
    await bootstrapCluster({
      adminUrl: withDatabase(ADMIN_URL, CANONICAL_DATABASE),
      database: CANONICAL_DATABASE,
      logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
        principal,
        password: TEST_LOGIN_PASSWORD,
      })),
    });
    canonicalAdmin = quietPool(
      { connectionString: withDatabase(ADMIN_URL, CANONICAL_DATABASE), max: 2 },
      'canonical-migrate',
    );
  }, 180000);

  afterAll(async () => {
    await canonicalAdmin?.end();
    await admin.query(`DROP OWNED BY ${ROGUE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${ROGUE}`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${CANONICAL_DATABASE} WITH (FORCE)`);
  }, 60000);

  async function ledgerCount(): Promise<number> {
    const present = await canonicalAdmin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
    );
    if (present.rows[0]?.count === '0') return 0;
    const applied = await canonicalAdmin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    return Number(applied.rows[0]?.count ?? '0');
  }

  it('refuses a non-canonical migration login before any DDL', async () => {
    // Everything about this login is right except which login it is: LOGIN, no
    // privileged attribute, exactly one membership in prsystem_migrate with the
    // exact options.
    await admin.query(`DROP ROLE IF EXISTS ${ROGUE}`);
    await admin.query(
      `CREATE ROLE ${ROGUE} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT prsystem_migrate TO ${ROGUE} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
    await canonicalAdmin.query(
      `GRANT CONNECT, CREATE ON DATABASE ${CANONICAL_DATABASE} TO ${ROGUE}`,
    );

    const before = await ledgerCount();
    const rogueUrl = new URL(withDatabase(ADMIN_URL, CANONICAL_DATABASE));
    rogueUrl.username = ROGUE;
    rogueUrl.password = TEST_LOGIN_PASSWORD;

    let raised: unknown;
    try {
      await runMigrations(rogueUrl.toString(), { approvedOperatorOwners: ['prsystem'] });
    } catch (error) {
      raised = error;
    }

    expect((raised as { name?: string; reason?: string } | undefined)?.name).toBe('PrincipalError');
    expect((raised as { reason?: string }).reason).toBe('not_canonical');
    // Nothing was applied: the refusal happened before any DDL.
    expect(await ledgerCount()).toBe(before);
    const schemas = await canonicalAdmin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata
        WHERE schema_name = 'platform'`,
    );
    expect(schemas.rows[0]?.count).toBe('0');
  }, 180000);

  it('accepts the canonical migration login', async () => {
    // The positive control, through the same runner.
    const url = asMigrationLogin(withDatabase(ADMIN_URL, CANONICAL_DATABASE));
    await expect(
      runMigrations(url, { approvedOperatorOwners: ['prsystem'] }),
    ).resolves.toMatchObject({ appliedAfter: 9 });
  }, 180000);
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
    adminMutate: string[] = [],
    adminRevert: string[] = [],
  ): Promise<unknown> {
    const before = await ledgerSize();
    // On the ownership database, not the cluster's default: `admin` is
    // connected elsewhere and would report "schema platform does not exist".
    for (const statement of mutate) await pool.query(statement);
    // `ALTER DATABASE ... OWNER TO` must run from another database.
    for (const statement of adminMutate) await admin.query(statement);
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
      for (const statement of adminRevert) await admin.query(statement).catch(() => undefined);
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
    // Reported by the narrow-owner census, which now runs first and is the more
    // general statement of the same rule: a narrow owner holds only what the
    // manifest names, in any schema.
    expect((raised as Error).message).toMatch(
      /platform\.job_run is owned by prsystem_maintenance_fn, which owns only what the manifest names/,
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
    // Reported by the census, which names the catalogue class.
    expect((raised as Error).message).toMatch(/pg_namespace drizzle/);
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

  /**
   * No project role may own the database or `public`, whatever the allow-list
   * says.
   *
   * Bootstrap forbids every project role at these two positions
   * unconditionally, and the manifest accepted any name the operator list
   * happened to contain — so approving `prsystem_migrate` or
   * `prsystem_maintenance_fn` made a kernel owner the database owner, and the
   * two checks disagreed about one invariant.
   *
   * Changing an owner drops the previous owner's implicit rights, so each case
   * re-grants `CONNECT` to the migration role. Without it PostgreSQL refuses the
   * connection and the run never reaches the manifest — a refusal, but not the
   * one being tested, and one that would keep passing if the manifest were
   * deleted.
   */
  const PROJECT_OWNER_CASES = [
    // The two kernel owners are caught even earlier, and by a different guard:
    // owning the database makes them implicit members of `pg_database_owner`,
    // which the migration principal must not reach. That is a stricter refusal
    // than the manifest's, so it is asserted as what actually happens rather
    // than worked around.
    { kind: 'kernel owner', role: 'prsystem_migrate', databaseError: 'PrincipalError' },
    { kind: 'narrow owner', role: 'prsystem_maintenance_fn', databaseError: 'PrincipalError' },
    { kind: 'runtime', role: 'prsystem_api', databaseError: 'MigrationOwnershipError' },
    {
      kind: 'canonical login',
      role: 'prsystem_worker_login',
      databaseError: 'MigrationOwnershipError',
    },
  ] as const;

  for (const { kind, role, databaseError } of PROJECT_OWNER_CASES) {
    it(`refuses the ${kind} ${role} as database owner even when approved`, async () => {
      const raised = await refusesUpgrade(
        [],
        [],
        { approvedOperatorOwners: [role] },
        [
          `ALTER DATABASE ${OWNERSHIP_DATABASE} OWNER TO ${role}`,
          `GRANT CONNECT, CREATE ON DATABASE ${OWNERSHIP_DATABASE} TO prsystem_migrate`,
        ],
        [
          `ALTER DATABASE ${OWNERSHIP_DATABASE} OWNER TO prsystem`,
          // Transferring ownership rewrites the database ACL, so the grants
          // bootstrap applied are restored explicitly. Without this the next
          // case — and the positive control — fail on "permission denied for
          // database", which would be a fixture artefact rather than a finding.
          `GRANT CONNECT, CREATE ON DATABASE ${OWNERSHIP_DATABASE} TO prsystem_migrate`,
        ],
      );
      expect((raised as Error | undefined)?.name).toBe(databaseError);
    }, 120000);

    it(`refuses the ${kind} ${role} as owner of schema public even when approved`, async () => {
      // Ownership of `public` does not change what the migration principal
      // reaches, so the manifest is the guard in every one of these.
      const raised = await refusesUpgrade(
        [`ALTER SCHEMA public OWNER TO ${role}`],
        [`ALTER SCHEMA public OWNER TO pg_database_owner`],
        { approvedOperatorOwners: [role, 'prsystem'] },
        [`GRANT CONNECT, CREATE ON DATABASE ${OWNERSHIP_DATABASE} TO prsystem_migrate`],
        [],
      );
      expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
      // A runtime or login role "must own nothing"; a narrow owner "owns only
      // what the manifest names". Both are refusals of the same position.
      expect((raised as Error).message).toMatch(
        /must own nothing|owns only what the manifest names/,
      );
    }, 120000);
  }

  /**
   * A narrow owner owns only what the manifest names, by exact signature and in
   * every schema.
   *
   * Two gaps met here. Functions were keyed by `schema.name`, so an added
   * overload inherited the exception granted to the real function; and the
   * reverse census excluded all four kernel owners, so a narrow owner could hold
   * arbitrary objects in `public` or in a schema an operator created and nothing
   * looked.
   */
  it('refuses an extra overload owned by a narrow owner', async () => {
    // Same schema, same name, different arguments — and therefore a different
    // function. By name alone this inherited prsystem_maintenance_fn from the
    // real scheduler wrapper and passed.
    const raised = await refusesUpgrade(
      [
        `CREATE FUNCTION platform.schedule_maintenance_job(p_only text)
           RETURNS void LANGUAGE sql AS $fn$ SELECT $fn$`,
        `ALTER FUNCTION platform.schedule_maintenance_job(text) OWNER TO prsystem_maintenance_fn`,
      ],
      [`DROP FUNCTION IF EXISTS platform.schedule_maintenance_job(text)`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/schedule_maintenance_job\(p_only text\)/);
  }, 120000);

  it('refuses a public function owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE FUNCTION public.rogue_helper() RETURNS void LANGUAGE sql AS $fn$ SELECT $fn$`,
        `ALTER FUNCTION public.rogue_helper() OWNER TO prsystem_audit_writer`,
      ],
      [`DROP FUNCTION IF EXISTS public.rogue_helper()`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/public\.rogue_helper/);
  }, 120000);

  it('refuses a relation in a rogue schema owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE SCHEMA IF NOT EXISTS rogue_ops`,
        `CREATE TABLE rogue_ops.stash (id int primary key)`,
        `ALTER TABLE rogue_ops.stash OWNER TO prsystem_partition_mgr`,
      ],
      [`DROP SCHEMA IF EXISTS rogue_ops CASCADE`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/rogue_ops\.stash/);
  }, 120000);

  it('refuses a function in a rogue schema owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE SCHEMA IF NOT EXISTS rogue_fns`,
        `CREATE FUNCTION rogue_fns.helper() RETURNS void LANGUAGE sql AS $fn$ SELECT $fn$`,
        `ALTER FUNCTION rogue_fns.helper() OWNER TO prsystem_maintenance_fn`,
      ],
      [`DROP SCHEMA IF EXISTS rogue_fns CASCADE`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/rogue_fns\.helper/);
  }, 120000);

  it('refuses the wrong narrow owner on an existing declared function', async () => {
    // The audit writer holding a scheduler wrapper: still one of the four, and
    // still not the owner this object is declared to have.
    const raised = await refusesUpgrade(
      [`ALTER FUNCTION platform.begin_worker_job(text, uuid) OWNER TO prsystem_audit_writer`],
      [`ALTER FUNCTION platform.begin_worker_job(text, uuid) OWNER TO prsystem_maintenance_fn`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/begin_worker_job/);
  }, 120000);

  it('accepts the audit partitions a narrow owner legitimately owns', async () => {
    // The positive control for the census: partition descendants are resolved
    // through pg_inherits to their declared root, so the month partitions of
    // audit.platform_event are accepted without being listed one by one.
    const children = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE pg_get_userbyid(c.relowner) = 'prsystem_partition_mgr'`,
    );
    expect(Number(children.rows[0]?.count)).toBeGreaterThan(0);
    await expect(
      runMigrations(ownershipUrl, { migrationsFolder: MIGRATIONS_FOLDER }),
    ).resolves.toBeDefined();
  }, 120000);

  /**
   * The census must cover every ownable class, not the three it happened to
   * query.
   *
   * `pg_class`, `pg_proc` and `pg_namespace` were scanned by hand, so a foreign
   * table, an enum, a domain or a composite type owned by a narrow owner was
   * invisible. Extension members were excluded from the invariant altogether,
   * which turned "a narrow owner owns only what the manifest names" into "…
   * unless somebody made it an extension member".
   */
  it('refuses a foreign table owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE FOREIGN DATA WRAPPER census_probe_fdw`,
        `CREATE SERVER census_probe_server FOREIGN DATA WRAPPER census_probe_fdw`,
        `CREATE FOREIGN TABLE platform.census_probe_ft (id int) SERVER census_probe_server`,
        `ALTER FOREIGN TABLE platform.census_probe_ft OWNER TO prsystem_partition_mgr`,
      ],
      [
        `DROP FOREIGN TABLE IF EXISTS platform.census_probe_ft`,
        `DROP SERVER IF EXISTS census_probe_server CASCADE`,
        `DROP FOREIGN DATA WRAPPER IF EXISTS census_probe_fdw CASCADE`,
      ],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/census_probe_ft/);
  }, 120000);

  it('refuses an enum type owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE TYPE platform.census_probe_enum AS ENUM ('a', 'b')`,
        `ALTER TYPE platform.census_probe_enum OWNER TO prsystem_audit_writer`,
      ],
      [`DROP TYPE IF EXISTS platform.census_probe_enum`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/census_probe_enum/);
  }, 120000);

  it('refuses a domain type owned by a narrow owner', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE DOMAIN platform.census_probe_domain AS text CHECK (VALUE <> '')`,
        `ALTER DOMAIN platform.census_probe_domain OWNER TO prsystem_maintenance_fn`,
      ],
      [`DROP DOMAIN IF EXISTS platform.census_probe_domain`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/census_probe_domain/);
  }, 120000);

  it('refuses a composite type owned by a runtime role', async () => {
    const raised = await refusesUpgrade(
      [
        `CREATE TYPE platform.census_probe_composite AS (a int, b text)`,
        `ALTER TYPE platform.census_probe_composite OWNER TO prsystem_api`,
      ],
      [`DROP TYPE IF EXISTS platform.census_probe_composite`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/census_probe_composite/);
  }, 120000);

  it('refuses an extension object owned by a narrow owner', async () => {
    // Extension membership is not an exemption. A narrow owner holding an
    // extension function owns something the manifest never granted it, and the
    // fact that an extension created the object changes nothing about that.
    const raised = await refusesUpgrade(
      [`ALTER FUNCTION public.digest(text, text) OWNER TO prsystem_audit_writer`],
      [`ALTER FUNCTION public.digest(text, text) OWNER TO prsystem_migrate`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/digest/);
  }, 120000);

  it('refuses an unknown ownable class rather than ignoring it', async () => {
    // Extended statistics are ownable, are recorded in pg_shdepend, and are not
    // a class this census knows how to name. Failing closed is the only safe
    // answer: silently skipping an unrecognised class is exactly how foreign
    // tables and types went unseen.
    const raised = await refusesUpgrade(
      [
        `CREATE STATISTICS platform.census_probe_stat (dependencies)
           ON job_name, state FROM platform.job_run`,
        `ALTER STATISTICS platform.census_probe_stat OWNER TO prsystem_partition_mgr`,
      ],
      [`DROP STATISTICS IF EXISTS platform.census_probe_stat`],
    );
    expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
    expect((raised as Error).message).toMatch(/cannot identify|pg_statistic_ext/);
  }, 120000);

  it('matches extension dependencies on their full catalogue identity', () => {
    // A structural check, deliberately, and it is worth saying why rather than
    // leaving the reader to assume a behavioural one was skipped for effort.
    //
    // The defect is that `pg_depend.objid = c.oid` with no `classid` compares an
    // OID from pg_class against OIDs recorded for pg_proc, pg_type and every
    // other catalogue — OIDs are unique within a catalogue, not across them. A
    // behavioural case would need a kernel relation whose OID equals an
    // extension member's OID in another catalogue, and PostgreSQL allocates
    // OIDs from a single global counter, so two objects created at different
    // times cannot collide. The collision is reachable only after counter
    // wraparound, which a test cannot construct. So the predicate is asserted
    // directly instead of being demonstrated.
    const source = readFileSync(resolve(__dirname, 'ownership-manifest.ts'), 'utf8');
    const predicates = [...source.matchAll(/FROM pg_depend e\b([\s\S]*?)\)/g)].map((m) => m[1]);
    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(predicate).toMatch(/e\.classid\s*=/);
      expect(predicate).toMatch(/e\.objid\s*=/);
      expect(predicate).toMatch(/e\.objsubid\s*=/);
      expect(predicate).toMatch(/e\.refclassid\s*=\s*'pg_extension'::regclass/);
      expect(predicate).toMatch(/e\.deptype\s*=\s*'e'/);
    }

    // And the census resolves extension membership the same way, on the
    // dependency's full identity rather than on its object id alone.
    const census = source.slice(source.indexOf('OWNERSHIP_CENSUS_QUERY'));
    const membership = census.slice(
      census.indexOf('FROM pg_depend dep'),
      census.indexOf('::text AS extension'),
    );
    expect(membership).toMatch(/dep\.classid = o\.classid/);
    expect(membership).toMatch(/dep\.objid = o\.objid/);
    expect(membership).toMatch(/dep\.refclassid = 'pg_extension'::regclass/);
    expect(membership).toMatch(/dep\.deptype = 'e'/);
  });

  /**
   * Every object inside a kernel schema has an expected owner, whoever owns it
   * now.
   *
   * Two checks each covered part of the ground and neither covered this. The
   * census enumerates objects owned by a *restricted or narrow* role, so an
   * external role is outside it. The expected-owner comparison enumerates
   * schemas, relations and functions, so an enum, a domain, a composite type or
   * extended statistics is outside that. An arbitrary role owning an omitted
   * class inside `platform` therefore passed both.
   */
  const EXTERNAL_OWNER = 'outside_owner';

  const EXTERNAL_OWNERSHIP_CASES = [
    {
      what: 'an enum type',
      create: `CREATE TYPE platform.probe_enum AS ENUM ('a', 'b')`,
      own: `ALTER TYPE platform.probe_enum OWNER TO ${EXTERNAL_OWNER}`,
      drop: `DROP TYPE IF EXISTS platform.probe_enum`,
      subject: /platform\.probe_enum/,
    },
    {
      what: 'a domain',
      create: `CREATE DOMAIN platform.probe_domain AS text`,
      own: `ALTER DOMAIN platform.probe_domain OWNER TO ${EXTERNAL_OWNER}`,
      drop: `DROP DOMAIN IF EXISTS platform.probe_domain`,
      subject: /platform\.probe_domain/,
    },
    {
      what: 'a composite type',
      create: `CREATE TYPE platform.probe_composite AS (a int, b text)`,
      own: `ALTER TYPE platform.probe_composite OWNER TO ${EXTERNAL_OWNER}`,
      drop: `DROP TYPE IF EXISTS platform.probe_composite`,
      subject: /platform\.probe_composite/,
    },
    {
      what: 'extended statistics',
      create: `CREATE STATISTICS platform.probe_stat (dependencies)
                 ON job_name, state FROM platform.job_run`,
      own: `ALTER STATISTICS platform.probe_stat OWNER TO ${EXTERNAL_OWNER}`,
      drop: `DROP STATISTICS IF EXISTS platform.probe_stat`,
      subject: /probe_stat|pg_statistic_ext|cannot identify/,
    },
  ] as const;

  for (const kernelCase of EXTERNAL_OWNERSHIP_CASES) {
    it(`refuses ${kernelCase.what} in a kernel schema owned by an external role`, async () => {
      await admin.query(`DROP ROLE IF EXISTS ${EXTERNAL_OWNER}`).catch(() => undefined);
      await admin.query(`CREATE ROLE ${EXTERNAL_OWNER} NOLOGIN`);
      try {
        const raised = await refusesUpgrade([kernelCase.create, kernelCase.own], [kernelCase.drop]);
        expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
        expect((raised as Error).message).toMatch(kernelCase.subject);
      } finally {
        await pool.query(kernelCase.drop).catch(() => undefined);
        await admin.query(`DROP OWNED BY ${EXTERNAL_OWNER}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${EXTERNAL_OWNER}`).catch(() => undefined);
      }
    }, 120000);
  }

  /**
   * The same four classes, owned by the pinned bootstrap superuser.
   *
   * `pg_shdepend` is PostgreSQL's ownership dependency, and PostgreSQL does not
   * record a row in it for an object owned by a pinned role — OID 10, the
   * bootstrap superuser created by initdb. A census that derives its inventory
   * from `pg_shdepend` therefore sees nothing at all for those objects: an enum,
   * a domain, a composite type or extended statistics inside a kernel schema
   * could be reassigned to the bootstrap operator and stay invisible, and it is
   * the operator identity an attacker with cluster access already has.
   *
   * These objects are created by the admin connection, which *is* that role, so
   * no reassignment is needed to reach the invisible state.
   */
  const BOOTSTRAP_OWNERSHIP_CASES = [
    {
      what: 'an enum type',
      create: `CREATE TYPE platform.bootstrap_enum AS ENUM ('a', 'b')`,
      drop: `DROP TYPE IF EXISTS platform.bootstrap_enum`,
      own: `ALTER TYPE platform.bootstrap_enum OWNER TO ${KERNEL_OWNERS.migrate}`,
      subject: /platform\.bootstrap_enum/,
    },
    {
      what: 'a domain',
      create: `CREATE DOMAIN platform.bootstrap_domain AS text`,
      drop: `DROP DOMAIN IF EXISTS platform.bootstrap_domain`,
      own: `ALTER DOMAIN platform.bootstrap_domain OWNER TO ${KERNEL_OWNERS.migrate}`,
      subject: /platform\.bootstrap_domain/,
    },
    {
      what: 'a composite type',
      create: `CREATE TYPE platform.bootstrap_composite AS (a int, b text)`,
      drop: `DROP TYPE IF EXISTS platform.bootstrap_composite`,
      own: `ALTER TYPE platform.bootstrap_composite OWNER TO ${KERNEL_OWNERS.migrate}`,
      subject: /platform\.bootstrap_composite/,
    },
    {
      what: 'extended statistics',
      create: `CREATE STATISTICS platform.bootstrap_stat (dependencies)
                 ON job_name, state FROM platform.job_run`,
      drop: `DROP STATISTICS IF EXISTS platform.bootstrap_stat`,
      own: `ALTER STATISTICS platform.bootstrap_stat OWNER TO ${KERNEL_OWNERS.migrate}`,
      subject: /platform\.bootstrap_stat/,
    },
  ] as const;

  it('the admin connection is the pinned bootstrap superuser, and it owns without a shdepend row', async () => {
    // The premise of every case below, asserted rather than assumed.
    const identity = await pool.query<{ bootstrap: boolean }>(
      `SELECT (SELECT oid FROM pg_roles WHERE rolname = current_user) = 10 AS bootstrap`,
    );
    expect(identity.rows[0]?.bootstrap).toBe(true);

    await pool.query(`CREATE TYPE platform.shdepend_probe AS ENUM ('a')`);
    try {
      const rows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_shdepend d
          WHERE d.deptype = 'o' AND d.refclassid = 'pg_authid'::regclass
            AND d.classid = 'pg_type'::regclass
            AND d.objid = 'platform.shdepend_probe'::regtype::oid`,
      );
      expect(rows.rows[0]?.count).toBe('0');
    } finally {
      await pool.query(`DROP TYPE IF EXISTS platform.shdepend_probe`);
    }
  }, 60000);

  for (const kernelCase of BOOTSTRAP_OWNERSHIP_CASES) {
    it(`refuses ${kernelCase.what} in a kernel schema owned by the bootstrap operator`, async () => {
      const raised = await refusesUpgrade([kernelCase.create], [kernelCase.drop]);
      expect((raised as Error | undefined)?.name).toBe('MigrationOwnershipError');
      expect((raised as Error).message).toMatch(kernelCase.subject);
    }, 120000);

    it(`accepts ${kernelCase.what} owned by the DDL owner`, async () => {
      // The positive control for the case above: the same object, the same
      // schema, the expected owner — and the upgrade proceeds. Without it the
      // refusal could be "any object of this class is rejected".
      const before = await ledgerSize();
      await pool.query(kernelCase.create);
      await pool.query(kernelCase.own);
      try {
        const outcome = await runMigrations(ownershipUrl, { migrationsFolder: pending });
        expect(outcome.appliedAfter).toBe(before + 1);
        expect(await probeApplied()).toBe(true);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS platform.${PROBE_TABLE}`).catch(() => undefined);
        await pool
          .query(`DELETE FROM drizzle.__drizzle_migrations WHERE id > $1`, [before])
          .catch(() => undefined);
        await pool.query(kernelCase.drop).catch(() => undefined);
      }
    }, 120000);
  }

  it('fails closed on a schema-contained catalogue nobody classified', async () => {
    // The coverage guard, driven by a stub rather than by a PostgreSQL release:
    // a future version that adds an ownable schema-contained catalogue must stop
    // the migration rather than silently leave that class uncensused.
    const client: ManifestClient = {
      query: <R>(text: string) => {
        if (text.includes('pg_catalog') && text.includes('namespace$')) {
          return Promise.resolve({
            rows: [{ catalogue: 'pg_future_thing', has_owner: true }] as R[],
          });
        }
        return Promise.resolve({ rows: [] as R[] });
      },
    };
    await expect(assertOwnershipManifest(client, new Set(['operator']))).rejects.toThrow(
      /pg_future_thing/,
    );
  });

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
/**
 * Shipped-schema mutations, applied to `schema.ts` itself.
 *
 * The declaration-mutation cases below alter a produced projection. These edit
 * the real file, reload the module, and require `compareDeclarationToSnapshot()`
 * to become non-empty — which is the property that actually protects the
 * schema: a change a developer makes to `schema.ts` must not pass.
 *
 * The file is restored in `finally` and its bytes are compared afterwards, so a
 * failing case cannot leave the repository modified.
 */
describe('a real edit to schema.ts is caught', () => {
  const SCHEMA_PATH = resolve(__dirname, 'schema.ts');
  const ORIGINAL = readFileSync(SCHEMA_PATH, 'utf8');

  const EDITS = [
    {
      title: 'a foreign key loses its ON DELETE action',
      find: ".onDelete('restrict')",
      replace: '',
    },
    {
      title: 'a check predicate is weakened',
      find: "sql`(state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text]))`",
      replace:
        "sql`(state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'any'::text]))`",
    },
    {
      title: 'an index loses its descending order',
      find: 'table.startedAt.desc().nullsFirst()',
      replace: 'table.startedAt',
    },
    {
      title: 'an index loses its partial predicate',
      find: '.where(sql`resolved_at IS NULL`)',
      replace: '',
    },
    {
      title: 'the identity sequence gains a step',
      find: '.generatedAlwaysAsIdentity()',
      replace: '.generatedAlwaysAsIdentity({ increment: 2 })',
    },
    {
      title: 'a table loses row level security',
      find: '.enableRLS();',
      replace: ';',
    },
    {
      title: 'a tenant-isolation policy is weakened',
      find: 'using: sql`(hotel_id = platform.current_hotel_id())`',
      replace: 'using: sql`(true)`',
    },
    {
      title: 'a column loses NOT NULL',
      find: "jobName: text('job_name').notNull()",
      replace: "jobName: text('job_name')",
    },
  ] as const;

  afterAll(() => {
    writeFileSync(SCHEMA_PATH, ORIGINAL, 'utf8');
  });

  for (const edit of EDITS) {
    it(`reports ${edit.title}`, async () => {
      expect(ORIGINAL).toContain(edit.find);
      try {
        writeFileSync(SCHEMA_PATH, ORIGINAL.replace(edit.find, edit.replace), 'utf8');
        // A child process, not a dynamic import: the module graph in this
        // worker has already loaded `schema.ts`, and re-importing it would
        // compare the version held in memory rather than the edited file.
        const probe = spawnSync(
          'pnpm',
          [
            'exec',
            'tsx',
            '-e',
            "import { compareDeclarationToSnapshot } from './src/schema-projection';" +
              'const d = compareDeclarationToSnapshot();' +
              'process.stdout.write(String(d.length));',
          ],
          { cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000 },
        );
        // A thrown extractor (a parameterised fragment, say) is also a
        // detection, but an empty diff is not.
        const detected = probe.status !== 0 || Number(probe.stdout) > 0;
        expect({ edit: edit.title, detected }).toEqual({ edit: edit.title, detected: true });
      } finally {
        writeFileSync(SCHEMA_PATH, ORIGINAL, 'utf8');
      }
    }, 60000);
  }

  it('leaves schema.ts byte-identical', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(ORIGINAL);
  });
});

describe('the Drizzle declaration and the canonical snapshot are bound together', () => {
  it('agrees with the snapshot as shipped', () => {
    expect(diffDeclarations(drizzleProjection(), EXPECTED_SCHEMA_SNAPSHOT)).toEqual([]);
  });

  it('projects the defaults, identity and keys the DSL states', () => {
    const projection = drizzleProjection();
    // Not a vacuous projection: it carries the properties the DSL was extended
    // to express, so "it agrees" above is a statement about something.
    expect(projection.columns).toContainEqual({
      schema: 'platform',
      table: 'job_run',
      column: 'state',
      shape: "text | NOT NULL | default 'running'::text | no identity | not generated",
    });
    expect(projection.columns).toContainEqual({
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | identity a | not generated',
    });
    expect(projection.constraints).toContainEqual({
      schema: 'audit',
      table: 'platform_event',
      name: 'platform_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    });
    expect(projection.constraints).toContainEqual({
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_uq',
      kind: 'u',
      definition: 'UNIQUE (provider, provider_event_id)',
    });
    expect(projection.constraints).toContainEqual({
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_event_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (event_id) REFERENCES platform.outbox_event(event_id) ON DELETE RESTRICT',
    });
    expect(projection.constraints).toContainEqual({
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))",
    });
    expect(projection.indexes).toContainEqual({
      schema: 'platform',
      table: 'operational_alert',
      name: 'operational_alert_open_idx',
      definition:
        'CREATE INDEX operational_alert_open_idx ON platform.operational_alert ' +
        'USING btree (alert_code, raised_at DESC) WHERE (resolved_at IS NULL)',
    });
  });

  it('reports an enum label list that the snapshot does not carry', () => {
    // Declaration against snapshot, with no database involved: the property is
    // about the two declarations agreeing on the type's labels and their order.
    const projection = drizzleProjection();
    const withEnum = {
      ...projection,
      enums: [{ schema: 'platform', name: 'mood', labels: ['sad', 'happy'] }],
    };
    expect(diffDeclarations(withEnum, EXPECTED_SCHEMA_SNAPSHOT)).toEqual([
      {
        kind: 'declaration-enum',
        subject: 'platform.mood',
        expected: 'present in the snapshot',
        actual: '["sad","happy"]',
      },
    ]);
  });

  it('tells one comma-containing label from two labels, against the snapshot', () => {
    // The two declarations below are different PostgreSQL types. Joined with a
    // delimiter they were the same text, so this comparison reported nothing.
    const projection = drizzleProjection();
    const declared = {
      ...projection,
      enums: [{ schema: 'platform', name: 'mood', labels: ['a, b'] }],
    };
    const snapshot = {
      ...EXPECTED_SCHEMA_SNAPSHOT,
      enums: [{ schema: 'platform', name: 'mood', labels: ['a', 'b'] }],
    };
    expect(diffDeclarations(declared, snapshot)).toEqual([
      {
        kind: 'declaration-enum',
        subject: 'platform.mood',
        expected: '["a","b"]',
        actual: '["a, b"]',
      },
    ]);
  });

  it('tells one comma-containing policy target from two, against the snapshot', () => {
    const projection = drizzleProjection();
    const one = projection.policies[0];
    if (one === undefined) throw new Error('the declaration projects no policy');
    const declared = {
      ...projection,
      policies: [{ ...one, to: ['probe_x, probe_y'] }, ...projection.policies.slice(1)],
    };
    const snapshot = {
      ...EXPECTED_SCHEMA_SNAPSHOT,
      policies: EXPECTED_SCHEMA_SNAPSHOT.policies.map((policy) =>
        policy.table === one.table && policy.name === one.name
          ? { ...policy, to: ['probe_x', 'probe_y'] }
          : policy,
      ),
    };
    const reported = diffDeclarations(declared, snapshot);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.subject).toBe(`${one.schema}.${one.table}.${one.name}`);
  });

  it('reports a reordered enum label list', () => {
    const projection = drizzleProjection();
    const declared = {
      ...projection,
      enums: [{ schema: 'platform', name: 'mood', labels: ['happy', 'sad'] }],
    };
    const snapshot = {
      ...EXPECTED_SCHEMA_SNAPSHOT,
      enums: [{ schema: 'platform', name: 'mood', labels: ['sad', 'happy'] }],
    };
    expect(diffDeclarations(declared, snapshot)).toEqual([
      {
        kind: 'declaration-enum',
        subject: 'platform.mood',
        expected: '["sad","happy"]',
        actual: '["happy","sad"]',
      },
    ]);
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
          c.schema === 'platform' && c.table === 'job_run' && c.column === 'error_name'
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
          c.schema === 'platform' && c.table === 'job_run' && c.column === 'job_name'
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
          c.schema === 'platform' && c.table === 'job_run' && c.column === 'state'
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
          c.schema === 'platform' && c.table === 'outbox_event' && c.column === 'event_id'
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
          (c) => !(c.schema === 'platform' && c.table === 'job_run' && c.column === 'issuer_ref'),
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
            schema: 'platform',
            table: 'job_run',
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
      title: 'a changed generated-column state',
      kind: 'declaration-column',
      subject: 'platform.job_run.job_name',
      mutate: (p) => ({
        ...p,
        columns: p.columns.map((c) =>
          c.schema === 'platform' && c.table === 'job_run' && c.column === 'job_name'
            ? { ...c, shape: c.shape.replace('not generated', 'generated s') }
            : c,
        ),
      }),
    },
    {
      title: 'a changed foreign-key action',
      kind: 'declaration-key',
      subject: 'platform.outbox_delivery.outbox_delivery_event_id_fkey',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.map((c) =>
          c.name === 'outbox_delivery_event_id_fkey'
            ? { ...c, definition: c.definition.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE') }
            : c,
        ),
      }),
    },
    {
      title: 'a dropped foreign key',
      kind: 'declaration-key',
      subject: 'platform.export_artifact.export_artifact_job_run_id_fkey',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.filter((c) => c.name !== 'export_artifact_job_run_id_fkey'),
      }),
    },
    {
      title: 'a weakened check constraint',
      kind: 'declaration-key',
      subject: 'platform.job_run.job_run_state_known',
      mutate: (p) => ({
        ...p,
        constraints: p.constraints.map((c) =>
          c.name === 'job_run_state_known'
            ? {
                ...c,
                definition: c.definition.replace("'failed'::text", "'failed'::text, 'any'::text"),
              }
            : c,
        ),
      }),
    },
    {
      title: 'a changed ordinary index',
      kind: 'declaration-index',
      subject: 'platform.job_run.job_run_name_idx',
      mutate: (p) => ({
        ...p,
        indexes: p.indexes.map((i) =>
          i.name === 'job_run_name_idx'
            ? { ...i, definition: i.definition.replace('started_at DESC', 'started_at') }
            : i,
        ),
      }),
    },
    {
      title: 'a dropped index predicate',
      kind: 'declaration-index',
      subject: 'platform.operational_alert.operational_alert_open_idx',
      mutate: (p) => ({
        ...p,
        indexes: p.indexes.map((i) =>
          i.name === 'operational_alert_open_idx'
            ? { ...i, definition: i.definition.replace(' WHERE (resolved_at IS NULL)', '') }
            : i,
        ),
      }),
    },
    {
      title: 'a unique index made non-unique',
      kind: 'declaration-index',
      subject: 'platform.idempotency_key.idempotency_key_scope_uq',
      mutate: (p) => ({
        ...p,
        indexes: p.indexes.map((i) =>
          i.name === 'idempotency_key_scope_uq'
            ? { ...i, definition: i.definition.replace('CREATE UNIQUE INDEX', 'CREATE INDEX') }
            : i,
        ),
      }),
    },
    {
      title: 'a dropped index',
      kind: 'declaration-index',
      subject: 'platform.outbox_delivery.outbox_delivery_claimable_idx',
      mutate: (p) => ({
        ...p,
        indexes: p.indexes.filter((i) => i.name !== 'outbox_delivery_claimable_idx'),
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
