import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Pool } from 'pg';
import {
  TEST_LOGIN_PASSWORD,
  TEST_LOGIN_PRINCIPALS,
  adminUrl,
  createTestDatabase,
  quietPool,
} from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';
import { runMigrations } from '../migrate';
import {
  INTENDED_MEMBERSHIP_OPTIONS,
  assertMigrationPrincipal,
  assertRuntimePrincipal,
  readPrincipalFacts,
} from '../principal-guard';

/**
 * Regressions for the fourth Phase 03 review — membership options.
 *
 * PostgreSQL 17 models MEMBER, USAGE (inheritance), SET and ADMIN as separate
 * capabilities. A guard that reads only two of them is blind to the other
 * three, and the blind spot that matters most is `ADMIN TRUE, INHERIT FALSE,
 * SET FALSE`: it reports no inherited privilege and no `SET ROLE`, yet lets its
 * holder grant the role to anybody, itself included.
 *
 * Every case here fails against the guard as it stood before this repair.
 */

const CLUSTER_LOCK = 918_273_646;

const logins = (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
  principal,
  password: TEST_LOGIN_PASSWORD,
}));

let db: TestDatabase;
let apiPool: Pool;
let migrateUrl: string;
let admin: Client;

beforeAll(async () => {
  db = await createTestDatabase('regr3_membership');
  await bootstrapCluster({ adminUrl: db.url, database: db.name, logins });
  migrateUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate);
  await runMigrations(migrateUrl);
  apiPool = quietPool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 1 });

  admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  // Role changes are cluster-wide. Serialise this file against every other
  // suite that mutates roles.
  await admin.query('SELECT pg_advisory_lock($1)', [CLUSTER_LOCK]);
}, 180000);

afterAll(async () => {
  await apiPool.end();
  try {
    await admin.query('SELECT pg_advisory_unlock($1)', [CLUSTER_LOCK]);
  } finally {
    await admin.end();
    await db.drop();
  }
}, 60000);

/** Applies an edge, runs the assertions, and always restores the prior state. */
async function withEdge(grant: string, revoke: string, run: () => Promise<void>): Promise<void> {
  await admin.query(grant);
  try {
    await run();
  } finally {
    await admin.query(revoke);
  }
}

describe('C1 — ADMIN OPTION is a reachable capability, not an invisible one', () => {
  it('sees an ADMIN TRUE, INHERIT FALSE, SET FALSE edge and refuses startup', async () => {
    await withEdge(
      `GRANT prsystem_maintenance_fn TO prsystem_api_login WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      `REVOKE prsystem_maintenance_fn FROM prsystem_api_login`,
      async () => {
        const facts = await readPrincipalFacts(apiPool);

        // Reachable at all — the capability the old closure filter dropped.
        expect(facts.memberOf).toContain('prsystem_maintenance_fn');
        const reached = facts.reachable.find((r) => r.name === 'prsystem_maintenance_fn');
        // Each capability is modelled separately, and this edge carries only one.
        expect(reached).toMatchObject({
          member: true,
          usage: false,
          inherited: false,
          settable: false,
          admin: true,
        });

        await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
          name: 'PrincipalError',
        });
      },
    );
  });

  it('refuses the migration while that edge exists', async () => {
    await withEdge(
      `GRANT prsystem_maintenance_fn TO prsystem_api_login WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      `REVOKE prsystem_maintenance_fn FROM prsystem_api_login`,
      async () => {
        // The migration connection itself is clean; the cluster is not. Applying
        // DDL now would ship objects whose ownership is already escapable.
        await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
          name: 'PrincipalError',
          reason: 'forbidden_principal',
        });
      },
    );
  });

  it('refuses when a runtime principal holds ADMIN OPTION on its own group', async () => {
    // No new role is reachable here: the login already reaches prsystem_api.
    // ADMIN alone is the defect, because it lets the login grant that group on.
    await withEdge(
      `GRANT prsystem_api TO prsystem_api_login WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
      `GRANT prsystem_api TO prsystem_api_login WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
      async () => {
        await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
          name: 'PrincipalError',
          reason: 'admin_option',
        });
        await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
          name: 'PrincipalError',
          reason: 'admin_option',
        });
      },
    );
  });
});

describe('C2 — each membership capability is rejected on its own', () => {
  it('refuses a SET-only membership', async () => {
    await withEdge(
      `GRANT prsystem_partition_mgr TO prsystem_api_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
      `REVOKE prsystem_partition_mgr FROM prsystem_api_login`,
      async () => {
        const reached = (await readPrincipalFacts(apiPool)).reachable.find(
          (r) => r.name === 'prsystem_partition_mgr',
        );
        expect(reached).toMatchObject({ member: true, usage: false, settable: true, admin: false });
        await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
          name: 'PrincipalError',
        });
      },
    );
  });

  it('refuses an inheritance-only membership', async () => {
    await withEdge(
      `GRANT prsystem_audit_writer TO prsystem_api_login WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`,
      `REVOKE prsystem_audit_writer FROM prsystem_api_login`,
      async () => {
        const reached = (await readPrincipalFacts(apiPool)).reachable.find(
          (r) => r.name === 'prsystem_audit_writer',
        );
        expect(reached).toMatchObject({ member: true, usage: true, settable: false, admin: false });
        await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
          name: 'PrincipalError',
        });
      },
    );
  });

  it('refuses a predefined role that grants cluster-wide data access', async () => {
    await withEdge(
      `GRANT pg_write_all_data TO prsystem_api_login WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
      `REVOKE pg_write_all_data FROM prsystem_api_login`,
      async () => {
        expect((await readPrincipalFacts(apiPool)).memberOf).toContain('pg_write_all_data');
        await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
          name: 'PrincipalError',
          reason: 'unexpected_membership',
        });
      },
    );
  });

  it('refuses a recursive mixed-capability path', async () => {
    // login --INHERIT--> bridge --SET--> owner. Neither edge alone reaches the
    // owner, and the intermediate role is not itself forbidden, so only a
    // genuinely transitive closure sees the path.
    await admin.query(`DROP ROLE IF EXISTS prsystem_regr3_bridge`);
    await admin.query(`CREATE ROLE prsystem_regr3_bridge NOLOGIN`);
    try {
      await admin.query(
        `GRANT prsystem_regr3_bridge TO prsystem_api_login WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`,
      );
      await admin.query(
        `GRANT prsystem_maintenance_fn TO prsystem_regr3_bridge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
      );

      const facts = await readPrincipalFacts(apiPool);
      expect(facts.memberOf).toEqual(
        expect.arrayContaining(['prsystem_regr3_bridge', 'prsystem_maintenance_fn']),
      );
      await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
        name: 'PrincipalError',
      });
      await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
        name: 'PrincipalError',
        reason: 'forbidden_principal',
      });
    } finally {
      await admin.query(`REVOKE prsystem_regr3_bridge FROM prsystem_api_login`);
      await admin.query(`DROP ROLE IF EXISTS prsystem_regr3_bridge`);
    }
  });
});

describe('C3 — approved memberships are normalised to exact options', () => {
  it('states every option explicitly, because GRANT keeps the ones it omits', async () => {
    // PostgreSQL retains options a later GRANT does not mention, so a bare
    // re-grant cannot clear ADMIN. Bootstrap must state ADMIN FALSE.
    await admin.query(
      `GRANT prsystem_api TO prsystem_api_login WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
    );
    const tampered = await admin.query<{ admin_option: boolean }>(
      `SELECT am.admin_option FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname = 'prsystem_api_login' AND g.rolname = 'prsystem_api'`,
    );
    expect(tampered.rows[0]?.admin_option).toBe(true);

    // A plain re-grant leaves ADMIN in place: the documented behaviour, and the
    // reason the old reconciliation could not repair this.
    await admin.query(`GRANT prsystem_api TO prsystem_api_login`);
    const stillAdmin = await admin.query<{ admin_option: boolean }>(
      `SELECT am.admin_option FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname = 'prsystem_api_login' AND g.rolname = 'prsystem_api'`,
    );
    expect(stillAdmin.rows[0]?.admin_option).toBe(true);

    // Bootstrap normalises it.
    await bootstrapCluster({ adminUrl: db.url, database: db.name, logins });

    const facts = await readPrincipalFacts(apiPool);
    expect(facts.directMemberships).toHaveLength(1);
    expect(facts.directMemberships[0]).toMatchObject({
      member: 'prsystem_api_login',
      role: 'prsystem_api',
      admin: INTENDED_MEMBERSHIP_OPTIONS.admin,
      inherit: INTENDED_MEMBERSHIP_OPTIONS.inherit,
      set: INTENDED_MEMBERSHIP_OPTIONS.set,
    });
    await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).resolves.toBeDefined();
  }, 120000);

  it('accepts the migration principal once the cluster is contained', async () => {
    const migratePool = quietPool({ connectionString: migrateUrl, max: 1 });
    try {
      const facts = await assertMigrationPrincipal(migratePool);
      expect(facts.directMemberships).toHaveLength(1);
      expect(facts.directMemberships[0]).toMatchObject({
        role: 'prsystem_migrate',
        admin: false,
        inherit: true,
        set: true,
      });
      // The three owner roles, and nothing else.
      expect([...facts.memberOf].sort()).toEqual([
        'prsystem_audit_writer',
        'prsystem_maintenance_fn',
        'prsystem_migrate',
        'prsystem_partition_mgr',
      ]);
    } finally {
      await migratePool.end();
    }
  });
});
