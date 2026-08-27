import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { GROUP_ROLES, LOGIN_PRINCIPALS, UNREACHABLE_ROLES } from '../bootstrap';
import {
  PrincipalError,
  assertMigrationPrincipal,
  assertRuntimePrincipal,
} from '../principal-guard';

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
  migratePool = new Pool({ connectionString: env.migrateUrl, max: 1 });
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
    await expect(assertRuntimePrincipal(env.api, 'prsystem_worker')).rejects.toMatchObject({
      reason: 'missing_membership',
    });
  });
});
