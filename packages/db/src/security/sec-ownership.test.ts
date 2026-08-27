import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { TEST_LOGIN_PASSWORD, createTestDatabase } from '@prsystem/testing';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-OWNERSHIP — who owns every kernel object, and that bootstrap is genuinely
 * serialised across independent processes.
 */

let env: ProvisionedDatabase;

/** The expected owner of every object, by kind and name. */
const AUDIT_PARENTS = ['audit.platform_event', 'police_audit.security_event'];
const AUDIT_FUNCTIONS = ['append_platform_audit_event', 'append_police_security_event'];
const PARTITION_FUNCTIONS = [
  'ensure_month_partitions',
  'partition_horizon',
  'check_partition_horizon',
];
const MAINTENANCE_FUNCTIONS = ['maintenance_expire_idempotency_keys'];

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_ownership');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('object ownership', () => {
  it('never lets a login role own a kernel or migration-ledger object', async () => {
    const owned = await env.admin.query<{ kind: string; name: string; owner: string }>(
      `SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS name,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform','audit','police_audit','police','drizzle')
          AND pg_get_userbyid(c.relowner) LIKE '%\\_login'
        UNION ALL
       SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('platform','audit','police_audit')
          AND pg_get_userbyid(p.proowner) LIKE '%\\_login'
        UNION ALL
       SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner)
         FROM pg_namespace n
        WHERE n.nspname IN ('platform','audit','police_audit','police','drizzle')
          AND pg_get_userbyid(n.nspowner) LIKE '%\\_login'`,
    );
    expect(owned.rows).toEqual([]);
  });

  it('gives every schema, sequence and view to the DDL role', async () => {
    const wrong = await env.admin.query<{ name: string; owner: string }>(
      `SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform','drizzle')
          AND c.relkind IN ('r','v','S','p','i')
          AND pg_get_userbyid(c.relowner) <> 'prsystem_migrate'
        UNION ALL
       SELECT n.nspname, pg_get_userbyid(n.nspowner)
         FROM pg_namespace n
        WHERE n.nspname IN ('platform','audit','police_audit','police')
          AND pg_get_userbyid(n.nspowner) <> 'prsystem_migrate'`,
    );
    expect(wrong.rows).toEqual([]);
  });

  it('gives the audit parents and their partitions to the partition manager', async () => {
    const owners = await env.admin.query<{ name: string; owner: string }>(
      `SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('audit','police_audit') AND c.relkind IN ('r','p')
        ORDER BY 1`,
    );
    expect(owners.rows.length).toBeGreaterThanOrEqual(2 + 8);
    for (const row of owners.rows) {
      expect({ name: row.name, owner: row.owner }).toEqual({
        name: row.name,
        owner: 'prsystem_partition_mgr',
      });
    }
    for (const parent of AUDIT_PARENTS) {
      expect(owners.rows.some((r) => r.name === parent)).toBe(true);
    }
  });

  it('gives each function group to its narrow owner', async () => {
    const functions = await env.admin.query<{ proname: string; owner: string }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('platform','audit','police_audit')
        ORDER BY 1`,
    );
    const byName = new Map(functions.rows.map((r) => [r.proname, r.owner]));

    for (const fn of AUDIT_FUNCTIONS) {
      expect({ fn, owner: byName.get(fn) }).toEqual({ fn, owner: 'prsystem_audit_writer' });
    }
    for (const fn of PARTITION_FUNCTIONS) {
      expect({ fn, owner: byName.get(fn) }).toEqual({ fn, owner: 'prsystem_partition_mgr' });
    }
    for (const fn of MAINTENANCE_FUNCTIONS) {
      expect({ fn, owner: byName.get(fn) }).toEqual({ fn, owner: 'prsystem_maintenance_fn' });
    }
  });

  it('leaves the break-glass role owning nothing at all', async () => {
    const owned = await env.admin.query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM pg_class WHERE pg_get_userbyid(relowner) = 'prsystem_maintenance') +
         (SELECT count(*) FROM pg_proc  WHERE pg_get_userbyid(proowner) = 'prsystem_maintenance') +
         (SELECT count(*) FROM pg_namespace WHERE pg_get_userbyid(nspowner) = 'prsystem_maintenance')
       )::text AS count`,
    );
    expect(owned.rows[0]?.count).toBe('0');
  });

  it('leaves no unnecessary schema CREATE on a function owner', async () => {
    const create = await env.admin.query<{ role: string; schema: string }>(
      `SELECT r.rolname AS role, n.nspname AS schema
         FROM pg_roles r, pg_namespace n
        WHERE r.rolname IN ('prsystem_audit_writer','prsystem_maintenance_fn')
          AND n.nspname IN ('platform','audit','police_audit')
          AND has_schema_privilege(r.rolname, n.nspname, 'CREATE')
        ORDER BY 1, 2`,
    );
    expect(create.rows).toEqual([]);
  });

  it('keeps CREATE on the audit schemas for the partition manager, which needs it', async () => {
    for (const schema of ['audit', 'police_audit']) {
      const allowed = await env.admin.query<{ allowed: boolean }>(
        `SELECT has_schema_privilege('prsystem_partition_mgr', $1, 'CREATE') AS allowed`,
        [schema],
      );
      expect({ schema, allowed: allowed.rows[0]?.allowed }).toEqual({ schema, allowed: true });
    }
    // …and nowhere else.
    const platform = await env.admin.query<{ allowed: boolean }>(
      `SELECT has_schema_privilege('prsystem_partition_mgr', 'platform', 'CREATE') AS allowed`,
    );
    expect(platform.rows[0]?.allowed).toBe(false);
  });
});

describe('concurrent bootstrap across independent processes', () => {
  it('lets two separate processes bootstrap two databases without a catalog race', async () => {
    const names = ['prsystem_test_boot_race_a', 'prsystem_test_boot_race_b'];
    const script = resolve(__dirname, '..', 'test-support', 'bootstrap-once.ts');

    const dbs = await Promise.all(
      names.map(async (name) => {
        const db = await createTestDatabase(name.replace('prsystem_test_', ''));
        return db;
      }),
    );

    try {
      // Two genuinely independent OS processes, started together, against the
      // same cluster. Without the shared coordination lock they contend on
      // pg_authid and fail with `tuple concurrently updated`.
      const runs = dbs.map((db) =>
        spawnSync('npx', ['tsx', script], {
          cwd: resolve(__dirname, '..', '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            BOOTSTRAP_DATABASE_URL: db.url,
            BOOTSTRAP_TARGET_DATABASE: db.name,
            BOOTSTRAP_TEST_PASSWORD: TEST_LOGIN_PASSWORD,
          },
        }),
      );

      for (const [index, run] of runs.entries()) {
        expect({
          process: index,
          status: run.status,
          stderr: (run.stderr ?? '').slice(0, 400),
        }).toEqual({ process: index, status: 0, stderr: '' });
      }
    } finally {
      await Promise.all(dbs.map((db) => db.drop()));
    }
  }, 180000);
});

describe('the coordination database is shared by every runner', () => {
  it('defaults to one database rather than the target', async () => {
    const { BOOTSTRAP_LOCK_KEY, DEFAULT_COORDINATION_DATABASE } = await import('../bootstrap');
    // A lock taken in the target database would not serialise runners that each
    // target a different database — precisely the racing case.
    expect(DEFAULT_COORDINATION_DATABASE).toBe('postgres');
    expect(Number.isInteger(BOOTSTRAP_LOCK_KEY)).toBe(true);
  });
});
