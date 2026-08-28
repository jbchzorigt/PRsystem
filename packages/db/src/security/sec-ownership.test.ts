import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  it('leaves the break-glass role with no standing grant of any kind', async () => {
    // ADR-0017 §5. BYPASSRLS without USAGE reaches nothing; that is the design.
    // A break-glass identity that permanently holds schema access is not
    // break-glass, it is a second superuser.
    const held = await env.admin.query<{ schema: string; privilege: string }>(
      `SELECT n.nspname AS schema, p.privilege
         FROM pg_namespace n
    CROSS JOIN LATERAL (VALUES ('USAGE'), ('CREATE')) AS p(privilege)
        WHERE n.nspname IN ('platform','audit','police_audit','police')
          AND has_schema_privilege('prsystem_maintenance', n.nspname, p.privilege)
        ORDER BY 1, 2`,
    );
    expect(held.rows).toEqual([]);
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
  it('lets two processes bootstrap two databases with observable overlap', async () => {
    const cwd = resolve(__dirname, '..', '..');
    // Plain node against a plain CommonJS child. No TypeScript loader: every
    // loader wrapper re-spawns a grandchild, and the handshake below does not
    // survive that hop.
    const script = resolve(cwd, 'test-support', 'bootstrap-once.cjs');
    if (!existsSync(script)) throw new Error(`bootstrap child is missing: ${script}`);

    const dbs = await Promise.all([
      createTestDatabase('boot_race_a'),
      createTestDatabase('boot_race_b'),
    ]);
    let children: ReturnType<typeof spawn>[] = [];

    try {
      // Spawned asynchronously and both started before either is awaited.
      // `spawnSync` in a `.map()` runs them one after another, which proves
      // nothing about contention on the cluster-wide role catalog.
      children = dbs.map((db) =>
        spawn(process.execPath, [script], {
          cwd,
          env: {
            ...process.env,
            BOOTSTRAP_DATABASE_URL: db.url,
            BOOTSTRAP_TARGET_DATABASE: db.name,
            BOOTSTRAP_TEST_PASSWORD: TEST_LOGIN_PASSWORD,
            BOOTSTRAP_WAIT_FOR_START: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );

      // A child that fails to start emits `error` and never `data`; without this
      // listener the wait below would spin until the suite timed out, with no
      // indication of why.
      const startupErrors: string[] = [];
      for (const child of children) {
        child.on('error', (error) => startupErrors.push(error.message));
      }

      const collected = children.map((child) => {
        const state = { out: '', err: '', ready: false };
        child.stdout.on('data', (chunk: Buffer) => {
          state.out += chunk.toString('utf8');
          if (state.out.includes('READY')) state.ready = true;
        });
        child.stderr.on('data', (chunk: Buffer) => {
          state.err += chunk.toString('utf8');
        });
        return state;
      });

      // Both must be up and waiting before either is released.
      const deadline = Date.now() + 20_000;
      while (!collected.every((c) => c.ready)) {
        if (startupErrors.length > 0) {
          throw new Error(`a bootstrap child failed to start: ${startupErrors.join('; ')}`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `a bootstrap child never signalled READY: ${JSON.stringify(
              collected.map((c) => ({ out: c.out.slice(0, 200), err: c.err.slice(0, 200) })),
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      for (const child of children) child.stdin.write('go\n');

      const exits = await Promise.all(
        children.map(
          (child) =>
            new Promise<number>((resolveExit) => {
              // Bounded: a child that never exits must fail this test, not hang
              // the suite until the runner is killed from outside.
              const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolveExit(-2);
              }, 30_000);
              child.on('close', (code) => {
                clearTimeout(timer);
                resolveExit(code ?? -1);
              });
            }),
        ),
      );

      for (const [index, code] of exits.entries()) {
        expect({ child: index, code, stderr: collected[index]!.err.slice(0, 400) }).toEqual({
          child: index,
          code: 0,
          stderr: '',
        });
      }

      const reports = collected.map((c) => {
        const line = c.out.split('\n').find((l) => l.startsWith('{'));
        return JSON.parse(line ?? '{}') as { pid: number; enteredAt: number; leftAt: number };
      });

      // Two genuinely different OS processes…
      expect(reports[0]!.pid).not.toBe(reports[1]!.pid);
      // …whose bootstrap windows overlap in wall-clock time. Without overlap
      // this is a sequential test wearing a concurrent name.
      const [first, second] = reports.sort((a, b) => a.enteredAt - b.enteredAt);
      expect(second!.enteredAt).toBeLessThanOrEqual(first!.leftAt);

      // Both databases ended up correctly hardened.
      for (const db of dbs) {
        const acl = await db.pool.query<{ acl: string }>(
          `SELECT coalesce(array_to_string(nspacl, ' '), '') AS acl
             FROM pg_namespace WHERE nspname = 'public'`,
        );
        expect({
          database: db.name,
          hardened: acl.rows[0]?.acl.includes('prsystem_migrate=UC/'),
        }).toEqual({ database: db.name, hardened: true });
      }
    } finally {
      // Nothing may outlive the test: children first, then every pool, then the
      // databases they were connected to.
      for (const child of children ?? []) child.kill('SIGKILL');
      await Promise.all(dbs.map((db) => db.drop()));
    }
  }, 120000);
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
