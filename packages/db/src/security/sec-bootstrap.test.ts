import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { TEST_LOGIN_PASSWORD, adminUrl, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { GROUP_ROLES, LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';

/**
 * SEC-BOOTSTRAP — the documented group-only and partial-login workflows.
 *
 * A deployment may manage every login through IaC and hand this bootstrap only
 * the group roles, or manage some and supply others. Both are supported modes,
 * so an absent principal must not be an error and must never be created; an
 * existing one this run was not asked for must never be re-passworded, but must
 * still be validated, because it can connect whoever created it.
 *
 * These run against a real cluster with a test-scoped lock, because role state
 * is cluster-global and every case here mutates it.
 */

const CLUSTER_LOCK = 918_273_648;
const ALL_PRINCIPALS = Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[];

let db: TestDatabase;
let admin: Client;

/**
 * Drops every canonical login so each case starts from a known cluster state.
 *
 * Roles are cluster-global, and a role holding a privilege in *any* database
 * cannot be dropped from *this* one. `DROP OWNED BY` removes those privileges
 * per database, so this walks every PRsystem database first. Without it the
 * suite would pass or fail depending on what other suites happened to leave
 * behind, which is not a property a security gate may have.
 */
async function dropAllLogins(): Promise<void> {
  const databases = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database
      WHERE datname LIKE 'prsystem%' AND datallowconn ORDER BY 1`,
  );

  for (const { datname } of databases.rows) {
    const url = new URL(adminUrl());
    url.pathname = `/${datname}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      for (const principal of ALL_PRINCIPALS) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [principal]);
        if (exists.rowCount === 1) {
          // Privileges only: these logins own no object anywhere, because every
          // object is owned by a group role.
          // CASCADE: a privilege may be depended on by another grant. These
          // logins own no object anywhere — every object belongs to a group
          // role — so this removes privileges, not data.
          await client.query(`DROP OWNED BY ${principal} CASCADE`);
        }
      }
    } finally {
      await client.end();
    }
  }

  for (const principal of ALL_PRINCIPALS) {
    await admin.query(`DROP ROLE IF EXISTS ${principal}`);
  }
}

async function loginExists(name: string): Promise<boolean> {
  const row = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return row.rowCount === 1;
}

/** The membership edges of one role, with their options. */
async function edgesOf(
  name: string,
): Promise<
  { role: string; admin_option: boolean; inherit_option: boolean; set_option: boolean }[]
> {
  const rows = await admin.query<{
    role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT g.rolname AS role, am.admin_option, am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = $1 ORDER BY 1`,
    [name],
  );
  return rows.rows;
}

function credential(principal: LoginPrincipal, password = TEST_LOGIN_PASSWORD) {
  return { principal, password };
}

beforeAll(async () => {
  db = await createTestDatabase('sec_bootstrap');
  admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock($1)', [CLUSTER_LOCK]);
}, 120000);

afterAll(async () => {
  // Leave the cluster as every other suite expects to find it.
  try {
    await bootstrapCluster({
      adminUrl: db.url,
      database: db.name,
      logins: ALL_PRINCIPALS.map((p) => credential(p)),
    });
  } finally {
    try {
      await admin.query('SELECT pg_advisory_unlock($1)', [CLUSTER_LOCK]);
    } finally {
      await admin.end();
      await db.drop();
    }
  }
}, 120000);

describe('group-only bootstrap', () => {
  it('succeeds with no credentials and no login roles present', async () => {
    await dropAllLogins();

    const result = await bootstrapCluster({ adminUrl: db.url, database: db.name, logins: [] });

    expect(result.groupRoles).toBe(GROUP_ROLES.length);
    expect(result.loginsConfigured).toBe(0);
    expect(result.loginsAbsent).toBe(ALL_PRINCIPALS.length);
    expect(result.loginsValidated).toBe(0);

    // Absent principals are absent, not created.
    for (const principal of ALL_PRINCIPALS) {
      expect({ principal, exists: await loginExists(principal) }).toEqual({
        principal,
        exists: false,
      });
    }

    // Every group role exists, and the structural owner edges are reconciled
    // whatever the login policy is.
    for (const group of GROUP_ROLES) {
      expect({ group, exists: await loginExists(group) }).toEqual({ group, exists: true });
    }
    expect(await edgesOf('prsystem_migrate')).toEqual(
      expect.arrayContaining([
        {
          role: 'prsystem_audit_writer',
          admin_option: false,
          inherit_option: true,
          set_option: true,
        },
        {
          role: 'prsystem_partition_mgr',
          admin_option: false,
          inherit_option: true,
          set_option: true,
        },
        {
          role: 'prsystem_maintenance_fn',
          admin_option: false,
          inherit_option: true,
          set_option: true,
        },
      ]),
    );
  }, 120000);

  it('is idempotent when applied again', async () => {
    const again = await bootstrapCluster({ adminUrl: db.url, database: db.name, logins: [] });
    expect(again.loginsConfigured).toBe(0);
    expect(again.loginsAbsent).toBe(ALL_PRINCIPALS.length);
  }, 120000);
});

describe('partial bootstrap', () => {
  it('creates only the supplied principal', async () => {
    await dropAllLogins();

    const result = await bootstrapCluster({
      adminUrl: db.url,
      database: db.name,
      logins: [credential('prsystem_api_login')],
    });

    expect(result.loginsConfigured).toBe(1);
    expect(result.loginsAbsent).toBe(ALL_PRINCIPALS.length - 1);

    expect(await loginExists('prsystem_api_login')).toBe(true);
    for (const principal of ALL_PRINCIPALS.filter((p) => p !== 'prsystem_api_login')) {
      expect({ principal, exists: await loginExists(principal) }).toEqual({
        principal,
        exists: false,
      });
    }

    // Exact membership, exact options.
    expect(await edgesOf('prsystem_api_login')).toEqual([
      { role: 'prsystem_api', admin_option: false, inherit_option: true, set_option: true },
    ]);
  }, 120000);

  it('creates several and leaves several absent', async () => {
    await dropAllLogins();

    const supplied: LoginPrincipal[] = [
      'prsystem_api_login',
      'prsystem_worker_login',
      'prsystem_migrate_login',
    ];
    const result = await bootstrapCluster({
      adminUrl: db.url,
      database: db.name,
      logins: supplied.map((p) => credential(p)),
    });

    expect(result.loginsConfigured).toBe(3);
    expect(result.loginsAbsent).toBe(ALL_PRINCIPALS.length - 3);

    for (const principal of supplied) {
      expect({ principal, exists: await loginExists(principal) }).toEqual({
        principal,
        exists: true,
      });
    }
    for (const principal of ALL_PRINCIPALS.filter((p) => !supplied.includes(p))) {
      expect({ principal, exists: await loginExists(principal) }).toEqual({
        principal,
        exists: false,
      });
    }
  }, 120000);
});

describe('IaC-managed principals this run was not asked for', () => {
  it('validates a safe omitted login and does not modify its password', async () => {
    await dropAllLogins();
    // Created out-of-band, exactly as IaC would.
    await admin.query(
      `CREATE ROLE prsystem_police_login LOGIN PASSWORD 'iac_managed_password'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`,
    );
    await admin.query(
      `GRANT prsystem_police TO prsystem_police_login WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );

    const before = await admin.query<{ h: string }>(
      `SELECT rolpassword AS h FROM pg_authid WHERE rolname = 'prsystem_police_login'`,
    );

    const result = await bootstrapCluster({
      adminUrl: db.url,
      database: db.name,
      logins: [credential('prsystem_api_login')],
    });

    expect(result.loginsConfigured).toBe(1);
    expect(result.loginsValidated).toBe(1);

    // The password is byte-for-byte what IaC set. A bootstrap that rewrote it
    // would silently break the deployment that owns the credential.
    const after = await admin.query<{ h: string }>(
      `SELECT rolpassword AS h FROM pg_authid WHERE rolname = 'prsystem_police_login'`,
    );
    expect(after.rows[0]?.h).toBe(before.rows[0]?.h);
  }, 120000);

  it('fails closed on an omitted login holding a privileged attribute', async () => {
    await dropAllLogins();
    await admin.query(`CREATE ROLE prsystem_police_login LOGIN PASSWORD 'x' BYPASSRLS INHERIT`);
    await admin.query(`GRANT prsystem_police TO prsystem_police_login`);

    await expect(
      bootstrapCluster({
        adminUrl: db.url,
        database: db.name,
        logins: [credential('prsystem_api_login')],
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      message: expect.stringMatching(/prsystem_police_login.*BYPASSRLS/s) as unknown as string,
    });
  }, 120000);

  it('fails closed on an omitted login whose membership has drifted', async () => {
    await dropAllLogins();
    await admin.query(`CREATE ROLE prsystem_police_login LOGIN PASSWORD 'x' INHERIT`);
    await admin.query(`GRANT prsystem_police TO prsystem_police_login`);
    // A second group: reach the design never granted it.
    await admin.query(`GRANT prsystem_api TO prsystem_police_login`);

    await expect(
      bootstrapCluster({
        adminUrl: db.url,
        database: db.name,
        logins: [credential('prsystem_api_login')],
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      message: expect.stringMatching(/membership has drifted/) as unknown as string,
    });
  }, 120000);

  it('fails closed on an omitted login whose membership options have drifted', async () => {
    await dropAllLogins();
    await admin.query(`CREATE ROLE prsystem_police_login LOGIN PASSWORD 'x' INHERIT`);
    await admin.query(
      `GRANT prsystem_police TO prsystem_police_login WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
    );

    await expect(
      bootstrapCluster({
        adminUrl: db.url,
        database: db.name,
        logins: [credential('prsystem_api_login')],
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      message: expect.stringMatching(/ADMIN true/) as unknown as string,
    });
  }, 120000);
});

describe('concurrent partial bootstrap', () => {
  it('serialises two runners supplying different principals', async () => {
    await dropAllLogins();

    // Both run against the same cluster at the same time, each responsible for a
    // different principal. The coordination lock is what stops one runner's
    // membership reconciliation from racing the other's role creation.
    const [a, b] = await Promise.all([
      bootstrapCluster({
        adminUrl: db.url,
        database: db.name,
        logins: [credential('prsystem_api_login')],
      }),
      bootstrapCluster({
        adminUrl: db.url,
        database: db.name,
        logins: [credential('prsystem_worker_login')],
      }),
    ]);

    expect(a.loginsConfigured).toBe(1);
    expect(b.loginsConfigured).toBe(1);

    // Both principals exist, each with exactly its own group.
    expect(await edgesOf('prsystem_api_login')).toEqual([
      { role: 'prsystem_api', admin_option: false, inherit_option: true, set_option: true },
    ]);
    expect(await edgesOf('prsystem_worker_login')).toEqual([
      { role: 'prsystem_worker', admin_option: false, inherit_option: true, set_option: true },
    ]);
  }, 180000);
});

describe('exact database and schema ACLs', () => {
  it('revokes a stray grantee and proves the final grantee set exactly', async () => {
    // "Exact final grants" must mean every grantee, not only the ones the
    // bootstrap names. A grant handed to an unrelated role by an operator is
    // precisely the one nobody inspects.
    await admin.query(`DROP ROLE IF EXISTS prsystem_stray_probe`);
    await admin.query(`CREATE ROLE prsystem_stray_probe NOLOGIN`);
    try {
      const target = new Client({ connectionString: db.url });
      await target.connect();
      try {
        await target.query(`GRANT CONNECT ON DATABASE ${db.name} TO prsystem_stray_probe`);
        await target.query(`GRANT USAGE ON SCHEMA public TO prsystem_stray_probe`);

        const before = await target.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT (aclexplode(datacl)).grantee AS oid FROM pg_database WHERE datname = $1
           ) a JOIN pg_roles r ON r.oid = a.oid WHERE r.rolname = 'prsystem_stray_probe'`,
          [db.name],
        );
        expect(Number(before.rows[0]?.n)).toBe(1);

        await bootstrapCluster({
          adminUrl: db.url,
          database: db.name,
          logins: ALL_PRINCIPALS.map((p) => credential(p)),
        });

        // The stray grant is gone from both the database and the schema.
        const after = await target.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT (aclexplode(datacl)).grantee AS oid FROM pg_database WHERE datname = $1
             UNION ALL
             SELECT (aclexplode(nspacl)).grantee AS oid FROM pg_namespace WHERE nspname = 'public'
           ) a JOIN pg_roles r ON r.oid = a.oid WHERE r.rolname = 'prsystem_stray_probe'`,
          [db.name],
        );
        expect(Number(after.rows[0]?.n)).toBe(0);

        // And the surviving grantees are exactly the accounted-for set.
        const grantees = await target.query<{ grantee: string }>(
          `SELECT DISTINCT r.rolname AS grantee FROM (
             SELECT (aclexplode(datacl)).grantee AS oid FROM pg_database WHERE datname = $1
             UNION ALL
             SELECT (aclexplode(nspacl)).grantee AS oid FROM pg_namespace WHERE nspname = 'public'
           ) a JOIN pg_roles r ON r.oid = a.oid WHERE a.oid <> 0 ORDER BY 1`,
          [db.name],
        );
        const owner = await target.query<{ owner: string }>(
          `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
          [db.name],
        );
        const expected = new Set([
          owner.rows[0]!.owner,
          // PostgreSQL's own owner of schema `public` since 15. It is the schema
          // owner, so the allow-list keeps it: revoking from it would leave a
          // schema nobody can administer.
          'pg_database_owner',
          'prsystem_migrate',
          'prsystem_api',
          'prsystem_worker',
          'prsystem_police',
          'prsystem_audit_reader',
          'prsystem_police_audit_reader',
          'prsystem_job_scheduler',
        ]);
        expect(new Set(grantees.rows.map((r) => r.grantee))).toEqual(expected);
      } finally {
        await target.end();
      }
    } finally {
      await admin.query(`DROP ROLE IF EXISTS prsystem_stray_probe`);
    }
  }, 120000);
});
