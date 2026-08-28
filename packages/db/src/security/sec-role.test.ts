import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { GROUP_ROLES, LOGIN_PRINCIPALS, UNREACHABLE_ROLES } from '../bootstrap';
import {
  PrincipalError,
  assertMigrationPrincipal,
  assertRuntimePrincipal,
} from '../principal-guard';
import { TEST_LOGIN_PASSWORD, quietPool } from '@prsystem/testing';

/**
 * SEC-ROLE — the cluster role model.
 *
 * Asserted through the real LOGIN principals a deployment creates, never through
 * a superuser with `SET ROLE`: a superuser bypasses RLS unconditionally and
 * `SET ROLE` leaves `session_user` unchanged, so both would report the wrong
 * answer while looking like a passing test.
 */

let env: ProvisionedDatabase;
/** Owned here so it is closed before the database is dropped. */
let migratePool: Pool;

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_role');
  migratePool = quietPool({ connectionString: env.migrateUrl, max: 1 });
}, 90000);

afterAll(async () => {
  await migratePool.end();
  await env.close();
}, 30000);

describe('group role attributes', () => {
  it('creates every group role NOLOGIN and unprivileged', async () => {
    const result = await env.admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin, rolbypassrls
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [GROUP_ROLES],
    );

    expect(result.rows).toHaveLength(GROUP_ROLES.length);
    for (const row of result.rows) {
      expect({
        role: row.rolname,
        super: row.rolsuper,
        createdb: row.rolcreatedb,
        createrole: row.rolcreaterole,
        replication: row.rolreplication,
        login: row.rolcanlogin,
      }).toEqual({
        role: row.rolname,
        super: false,
        createdb: false,
        createrole: false,
        replication: false,
        login: false,
      });
    }
  });

  it('grants BYPASSRLS to exactly one role, which owns nothing', async () => {
    const holders = await env.admin.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE 'prsystem\\_%' ORDER BY 1`,
    );
    expect(holders.rows.map((r) => r.rolname)).toEqual(['prsystem_maintenance']);

    const owned = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
        WHERE pg_get_userbyid(c.relowner) = 'prsystem_maintenance'`,
    );
    expect(owned.rows[0]?.count).toBe('0');
  });
});

describe('login principals', () => {
  it('creates each login unprivileged and in exactly one group', async () => {
    for (const [principal, group] of Object.entries(LOGIN_PRINCIPALS)) {
      const facts = await env.admin.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        groups: string;
      }>(
        `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
                COALESCE((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
                            FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                           WHERE m.member = r.oid), '') AS groups
           FROM pg_roles r WHERE r.rolname = $1`,
        [principal],
      );
      const row = facts.rows[0];
      expect({ principal, found: row !== undefined }).toEqual({ principal, found: true });
      expect({
        principal,
        privileged:
          row!.rolsuper ||
          row!.rolcreatedb ||
          row!.rolcreaterole ||
          row!.rolreplication ||
          row!.rolbypassrls,
        groups: row!.groups,
      }).toEqual({ principal, privileged: false, groups: group });
    }
  });
});

describe('unreachable roles (pg_has_role)', () => {
  it('lets no runtime login reach an owner, migration or maintenance role', async () => {
    const logins = Object.keys(LOGIN_PRINCIPALS).filter(
      (principal) => principal !== 'prsystem_migrate_login',
    );

    for (const login of logins) {
      for (const forbidden of UNREACHABLE_ROLES) {
        const result = await env.admin.query<{ reachable: boolean }>(
          'SELECT pg_has_role($1, $2, $3) AS reachable',
          [login, forbidden, 'USAGE'],
        );
        expect({ login, forbidden, reachable: result.rows[0]?.reachable }).toEqual({
          login,
          forbidden,
          reachable: false,
        });
      }
    }
  });

  it('keeps the migration principal out of the BYPASSRLS role', async () => {
    const result = await env.admin.query<{ reachable: boolean }>(
      `SELECT pg_has_role('prsystem_migrate_login', 'prsystem_maintenance', 'USAGE') AS reachable`,
    );
    expect(result.rows[0]?.reachable).toBe(false);
  });

  it('refuses SET ROLE into a role the login is not a member of', async () => {
    const client = await env.api.connect();
    try {
      await expect(client.query('SET ROLE prsystem_maintenance')).rejects.toThrow(
        /permission denied|must be a member/i,
      );
      await expect(client.query('SET ROLE prsystem_migrate')).rejects.toThrow(
        /permission denied|must be a member/i,
      );
      await expect(client.query('SET ROLE prsystem_audit_writer')).rejects.toThrow(
        /permission denied|must be a member/i,
      );
    } finally {
      client.release();
    }
  });
});

describe('startup credential guards', () => {
  it('accepts the migration principal for a migration', async () => {
    // The same connection the runner verifies before applying anything.
    const facts = await assertMigrationPrincipal(migratePool);
    expect(facts.sessionUser).toBe('prsystem_migrate_login');
    expect(facts.isSuperuser).toBe(false);
  });

  it('rejects a superuser connection for a migration', async () => {
    await expect(assertMigrationPrincipal(env.admin)).rejects.toBeInstanceOf(PrincipalError);
  });

  it('rejects a migration credential for the API runtime', async () => {
    await expect(assertRuntimePrincipal(migratePool, 'prsystem_api')).rejects.toMatchObject({
      name: 'PrincipalError',
    });
  });

  it('rejects a DBA credential for the API runtime', async () => {
    await expect(assertRuntimePrincipal(env.admin, 'prsystem_api')).rejects.toMatchObject({
      reason: 'superuser',
    });
  });

  it('accepts each runtime principal for its own group', async () => {
    for (const [pool, group] of [
      [env.api, 'prsystem_api'],
      [env.worker, 'prsystem_worker'],
      [env.police, 'prsystem_police'],
    ] as const) {
      const facts = await assertRuntimePrincipal(pool, group);
      expect({ group, superuser: facts.isSuperuser, bypass: facts.bypassRls }).toEqual({
        group,
        superuser: false,
        bypass: false,
      });
    }
  });

  it('rejects a runtime principal presented as the wrong group', async () => {
    // Reported as `not_canonical` rather than `missing_membership`: the identity
    // check runs first and names both the login and the login that group
    // expects, which is the more useful diagnostic of the two.
    await expect(assertRuntimePrincipal(env.api, 'prsystem_worker')).rejects.toMatchObject({
      reason: 'not_canonical',
    });
  });
});

describe('R9 — a startup guard requires the canonical login, not merely the group', () => {
  /**
   * An exact group closure is necessary and was treated as sufficient.
   *
   * `assertRuntimePrincipal` verified that `session_user` reached exactly the
   * expected group and nothing else — but never that it *was* the login the
   * platform provisions for that group. A new LOGIN with one otherwise-perfect
   * membership passed startup, so an operator could mint a second API, Worker,
   * Police, reader or Scheduler credential that nothing bootstraps, rotates or
   * audits and every guard accepted.
   */
  const CASES = [
    { group: 'prsystem_api', login: 'prsystem_rogue_api_login' },
    { group: 'prsystem_worker', login: 'prsystem_rogue_worker_login' },
    { group: 'prsystem_police', login: 'prsystem_rogue_police_login' },
    { group: 'prsystem_audit_reader', login: 'prsystem_rogue_reader_login' },
    { group: 'prsystem_police_audit_reader', login: 'prsystem_rogue_preader_login' },
    { group: 'prsystem_job_scheduler', login: 'prsystem_rogue_sched_login' },
  ] as const;

  for (const { group, login } of CASES) {
    it(`refuses a non-canonical login holding an exact ${group} closure`, async () => {
      await env.admin.query(`DROP ROLE IF EXISTS ${login}`);
      await env.admin.query(
        `CREATE ROLE ${login} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT ` +
          `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await env.admin.query(`GRANT ${group} TO ${login} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);

      const pool = quietPool(
        { connectionString: env.db.loginUrl(login), max: 1 },
        `rogue-${group}`,
      );
      try {
        await expect(assertRuntimePrincipal(pool, group)).rejects.toMatchObject({
          name: 'PrincipalError',
          reason: 'not_canonical',
        });
      } finally {
        await pool.end();
        await env.admin.query(`DROP OWNED BY ${login}`).catch(() => undefined);
        await env.admin.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
      }
    }, 60000);
  }

  it('still accepts every canonical principal', async () => {
    // The positive control: the rule is "the canonical login", not "nothing".
    const canonical = [
      [env.api, 'prsystem_api'],
      [env.worker, 'prsystem_worker'],
      [env.police, 'prsystem_police'],
      [env.auditReader, 'prsystem_audit_reader'],
      [env.policeAuditReader, 'prsystem_police_audit_reader'],
      [env.jobScheduler, 'prsystem_job_scheduler'],
    ] as const;
    for (const [pool, group] of canonical) {
      const facts = await assertRuntimePrincipal(pool, group);
      expect(facts.sessionUser).toBe(`${group}_login`);
    }
  }, 60000);
});

describe('R9 — one canonical mapping, not three', () => {
  /**
   * Bootstrap, the startup guards and the SQL closure check must agree about
   * which login belongs to which group. TypeScript now takes the table from one
   * place; SQL cannot import it, so the SQL copy is held to the same table here
   * rather than left to drift.
   */
  it('the SQL closure check names the same canonical logins as roles.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { CANONICAL_LOGIN_BY_GROUP } = await import('../roles');

    const sql = readFileSync(
      resolve(__dirname, '..', '..', 'migrations', '0001_kernel.sql'),
      'utf8',
    );
    const block = sql.slice(sql.indexOf('v_canonical := CASE p_group'));
    const pairs = [
      ...block.slice(0, block.indexOf('END;')).matchAll(/WHEN '([a-z_]+)'\s+THEN '([a-z_]+)'/g),
    ];

    expect(pairs.length).toBeGreaterThan(0);
    for (const [, group, login] of pairs) {
      expect({ group, login }).toEqual({ group, login: CANONICAL_LOGIN_BY_GROUP[group!] });
    }
  });

  it('declares the canonical mapping in exactly one TypeScript module', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(__dirname, '..');
    const declaring = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) =>
        /prsystem_api_login:\s*'prsystem_api'/.test(readFileSync(resolve(dir, file), 'utf8')),
      );
    expect(declaring).toEqual(['roles.ts']);
  });
});
