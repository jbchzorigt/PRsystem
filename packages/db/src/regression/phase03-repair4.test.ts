import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TEST_LOGIN_PASSWORD,
  TEST_LOGIN_PRINCIPALS,
  adminUrl,
  createTestDatabase,
} from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';
import { runMigrations } from '../migrate';
import { assertRuntimePrincipal } from '../principal-guard';
import type { ContainedGroup } from '../principal-guard';

/**
 * Regressions for the fifth Phase 03 review.
 *
 * Containment previously covered API, Worker and Police only, so an audit reader
 * that could reach the migration role — or a scheduler that could reach a
 * predefined role — passed every gate. The SQL precondition tested `USAGE`
 * alone, which is blind to SET-only and ADMIN-only memberships.
 *
 * Each case is asserted twice: startup must refuse the principal, and the
 * migration must refuse to run while the cluster is in that shape.
 */

const CLUSTER_LOCK = 918_273_647;

const logins = (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
  principal,
  password: TEST_LOGIN_PASSWORD,
}));

let db: TestDatabase;
let migrateUrl: string;
let admin: Client;
const pools = new Map<string, Pool>();

/** The migration's own precondition block, executed without the TypeScript runner. */
const PRECONDITION_SQL = (() => {
  const source = readFileSync(
    resolve(__dirname, '..', '..', 'migrations', '0001_kernel.sql'),
    'utf8',
  );
  const start = source.indexOf('DO $precondition$');
  const end = source.indexOf('$precondition$;', start) + '$precondition$;'.length;
  if (start < 0 || end <= start) throw new Error('precondition block not found in 0001_kernel.sql');
  return source.slice(start, end);
})();

beforeAll(async () => {
  db = await createTestDatabase('regr4_containment');
  await bootstrapCluster({ adminUrl: db.url, database: db.name, logins });
  migrateUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate);
  await runMigrations(migrateUrl);

  for (const [key, principal] of Object.entries(TEST_LOGIN_PRINCIPALS)) {
    pools.set(key, new Pool({ connectionString: db.loginUrl(principal), max: 1 }));
  }

  admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock($1)', [CLUSTER_LOCK]);
}, 180000);

afterAll(async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  try {
    await admin.query('SELECT pg_advisory_unlock($1)', [CLUSTER_LOCK]);
  } finally {
    await admin.end();
    await db.drop();
  }
}, 60000);

/**
 * Runs the migration's own precondition as the migration role, with no
 * TypeScript guard in the way.
 *
 * The convenience runner checks the principal before it applies anything, so a
 * test that only called `runMigrations` could not tell whether the SQL or the
 * TypeScript did the refusing. This executes the SQL alone.
 */
async function runPreconditionSql(): Promise<{ code?: string; message?: string } | undefined> {
  const client = new Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    await client.query('SET ROLE prsystem_migrate');
    await client.query(PRECONDITION_SQL);
    return undefined;
  } catch (error) {
    return error as { code?: string; message?: string };
  } finally {
    await client.end();
  }
}

/** Applies drift, asserts all three layers refuse it, and always restores. */
async function withDrift(
  apply: readonly string[],
  restore: readonly string[],
  principal: { pool: string; group: ContainedGroup } | undefined,
  run?: () => Promise<void>,
): Promise<void> {
  for (const sql of apply) await admin.query(sql);
  try {
    if (principal !== undefined) {
      // 1. Startup refuses the principal.
      await expect(
        assertRuntimePrincipal(pools.get(principal.pool)!, principal.group),
      ).rejects.toMatchObject({ name: 'PrincipalError' });
    }

    // 2. The migration refuses to run.
    await expect(runMigrations(migrateUrl)).rejects.toMatchObject({ name: 'PrincipalError' });

    // 3. And the migration SQL refuses on its own, with no TypeScript involved.
    const sqlError = await runPreconditionSql();
    expect(sqlError, 'the SQL precondition must refuse this drift by itself').toBeDefined();
    expect(sqlError?.code).toBe('42501');

    if (run !== undefined) await run();
  } finally {
    for (const sql of restore) await admin.query(sql);
  }
}

describe('E1 — readers and the scheduler are contained like every other principal', () => {
  it('rejects an audit reader with SET-only reach to the migration role', async () => {
    await withDrift(
      [
        `GRANT prsystem_migrate TO prsystem_audit_reader_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
      ],
      [`REVOKE prsystem_migrate FROM prsystem_audit_reader_login`],
      { pool: 'auditReader', group: 'prsystem_audit_reader' },
    );
  });

  it('rejects a police audit reader with ADMIN-only reach to an owner role', async () => {
    await withDrift(
      [
        `GRANT prsystem_audit_writer TO prsystem_police_audit_reader_login WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      ],
      [`REVOKE prsystem_audit_writer FROM prsystem_police_audit_reader_login`],
      { pool: 'policeAuditReader', group: 'prsystem_police_audit_reader' },
    );
  });

  it('rejects a scheduler that reaches a predefined PostgreSQL role', async () => {
    await withDrift(
      [
        `GRANT pg_read_all_data TO prsystem_job_scheduler_login WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
      ],
      [`REVOKE pg_read_all_data FROM prsystem_job_scheduler_login`],
      { pool: 'jobScheduler', group: 'prsystem_job_scheduler' },
    );
  });

  it('rejects a runtime group holding pg_write_all_data', async () => {
    await withDrift(
      [`GRANT pg_write_all_data TO prsystem_worker WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`],
      [`REVOKE pg_write_all_data FROM prsystem_worker`],
      { pool: 'worker', group: 'prsystem_worker' },
    );
  });

  it('rejects a mixed recursive membership path from a reader', async () => {
    await admin.query(`DROP ROLE IF EXISTS prsystem_regr4_bridge`);
    await admin.query(`CREATE ROLE prsystem_regr4_bridge NOLOGIN`);
    try {
      await withDrift(
        [
          `GRANT prsystem_regr4_bridge TO prsystem_audit_reader_login WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`,
          `GRANT prsystem_partition_mgr TO prsystem_regr4_bridge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        ],
        [`REVOKE prsystem_regr4_bridge FROM prsystem_audit_reader_login`],
        { pool: 'auditReader', group: 'prsystem_audit_reader' },
      );
    } finally {
      await admin.query(`DROP ROLE IF EXISTS prsystem_regr4_bridge`);
    }
  });
});

describe('E2 — privileged attributes are rejected on every principal', () => {
  it('rejects an API login carrying BYPASSRLS', async () => {
    await admin.query(`ALTER ROLE prsystem_api_login BYPASSRLS`);
    try {
      await expect(assertRuntimePrincipal(pools.get('api')!, 'prsystem_api')).rejects.toMatchObject(
        { name: 'PrincipalError', reason: 'privileged_attribute' },
      );

      await expect(runMigrations(migrateUrl)).rejects.toMatchObject({ name: 'PrincipalError' });

      const sqlError = await runPreconditionSql();
      expect(sqlError?.code).toBe('42501');
      expect(sqlError?.message).toMatch(/BYPASSRLS/i);
    } finally {
      await admin.query(`ALTER ROLE prsystem_api_login NOBYPASSRLS`);
    }
  });

  it('rejects a scheduler login carrying CREATEROLE', async () => {
    await admin.query(`ALTER ROLE prsystem_job_scheduler_login CREATEROLE`);
    try {
      await expect(
        assertRuntimePrincipal(pools.get('jobScheduler')!, 'prsystem_job_scheduler'),
      ).rejects.toMatchObject({ name: 'PrincipalError', reason: 'privileged_attribute' });

      const sqlError = await runPreconditionSql();
      expect(sqlError?.code).toBe('42501');
    } finally {
      await admin.query(`ALTER ROLE prsystem_job_scheduler_login NOCREATEROLE`);
    }
  });
});

describe('E3 — the migration graph must be exactly right, not merely extra-free', () => {
  it('rejects a missing migration-owner edge', async () => {
    // Nothing gains reach here: an edge is removed. A check that only looked for
    // unexpected extras would see a perfectly clean cluster.
    await admin.query(`REVOKE prsystem_audit_writer FROM prsystem_migrate`);
    try {
      await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
        name: 'PrincipalError',
        reason: 'missing_membership',
      });

      const sqlError = await runPreconditionSql();
      expect(sqlError?.code).toBe('42501');
      expect(sqlError?.message).toMatch(/missing the edge/i);
    } finally {
      await admin.query(
        `GRANT prsystem_audit_writer TO prsystem_migrate WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
      );
    }
  });

  it('rejects wrong options on a migration-owner edge', async () => {
    await admin.query(
      `GRANT prsystem_partition_mgr TO prsystem_migrate WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
    );
    try {
      await expect(runMigrations(migrateUrl)).rejects.toMatchObject({ name: 'PrincipalError' });

      const sqlError = await runPreconditionSql();
      expect(sqlError?.code).toBe('42501');
    } finally {
      await admin.query(
        `GRANT prsystem_partition_mgr TO prsystem_migrate WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
      );
    }
  });

  it('rejects an unexpected membership for the migration role', async () => {
    await withDrift(
      [`GRANT pg_read_all_data TO prsystem_migrate WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`],
      [`REVOKE pg_read_all_data FROM prsystem_migrate`],
      undefined,
    );
  });

  it('accepts the cluster once every edge is exactly right', async () => {
    // The positive control. Without it, every refusal above could be explained
    // by a precondition that refuses unconditionally.
    await expect(runMigrations(migrateUrl)).resolves.toMatchObject({ appliedAfter: 2 });
    expect(await runPreconditionSql()).toBeUndefined();
  });
});

describe('E4 — principal verification cannot be switched off', () => {
  it('exposes no option to skip it', async () => {
    const source = readFileSync(resolve(__dirname, '..', 'migrate.ts'), 'utf8');
    expect(source).not.toMatch(/verifyPrincipal/);
    expect(source).toMatch(/await assertMigrationPrincipal\(client\)/);
  });

  it('refuses a superuser connection even though the cluster is healthy', async () => {
    await expect(runMigrations(db.url)).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });
  });
});
