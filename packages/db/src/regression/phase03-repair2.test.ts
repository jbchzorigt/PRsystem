import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
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
import { assertRuntimePrincipal, readPrincipalFacts } from '../principal-guard';

/**
 * Regressions for the third Phase 03 review.
 *
 * Each reproduces a specific defect and fails against the code as it stood
 * before this repair.
 */

const logins = (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
  principal,
  password: TEST_LOGIN_PASSWORD,
}));

describe('B1 — bootstrap hardens the target database, not the admin URL database', () => {
  let dbA: TestDatabase;
  let dbB: TestDatabase;

  beforeAll(async () => {
    dbA = await createTestDatabase('regr2_admin_a');
    dbB = await createTestDatabase('regr2_target_b');
  }, 120000);

  afterAll(async () => {
    await dbA.drop();
    await dbB.drop();
  }, 60000);

  it('hardens B while leaving A untouched', async () => {
    // Baseline: A still has the default PUBLIC grant on `public`.
    const aBefore = await dbA.pool.query<{ acl: string }>(
      `SELECT coalesce(array_to_string(nspacl, ' '), '(default)') AS acl
         FROM pg_namespace WHERE nspname = 'public'`,
    );

    // The admin connection names database A; the target is database B. The
    // schema grants must land on B.
    await bootstrapCluster({
      adminUrl: dbA.url,
      database: dbB.name,
      logins,
    });

    const aAfter = await dbA.pool.query<{ acl: string }>(
      `SELECT coalesce(array_to_string(nspacl, ' '), '(default)') AS acl
         FROM pg_namespace WHERE nspname = 'public'`,
    );
    expect(aAfter.rows[0]?.acl).toBe(aBefore.rows[0]?.acl);

    // B must be the one that was hardened: PUBLIC revoked, migrate granted.
    const bAcl = await dbB.pool.query<{ acl: string }>(
      `SELECT coalesce(array_to_string(nspacl, ' '), '') AS acl
         FROM pg_namespace WHERE nspname = 'public'`,
    );
    expect(bAcl.rows[0]?.acl).toMatch(/prsystem_migrate=UC/);
    expect(bAcl.rows[0]?.acl).not.toMatch(/(^|\s)=UC?\//);
  }, 120000);
});

describe('B2 — the principal closure is exact and recursive', () => {
  let db: TestDatabase;
  let apiPool: Pool;
  let admin: Client;

  beforeAll(async () => {
    db = await createTestDatabase('regr2_closure');
    await bootstrapCluster({ adminUrl: db.url, database: db.name, logins });
    await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
    apiPool = new Pool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 1 });

    admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    // Serialise every role mutation in this file against the rest of the suite.
    await admin.query('SELECT pg_advisory_lock($1)', [918_273_645]);
  }, 120000);

  afterAll(async () => {
    await apiPool.end();
    try {
      await admin.query('SELECT pg_advisory_unlock($1)', [918_273_645]);
    } finally {
      await admin.end();
      await db.drop();
    }
  }, 60000);

  it('sees a SET-capable membership that grants no inherited privilege', async () => {
    // INHERIT FALSE hides the membership from pg_has_role(..., 'USAGE') while
    // SET TRUE still lets the login become that role at will.
    await admin.query(
      `GRANT prsystem_maintenance_fn TO prsystem_api_login WITH INHERIT FALSE, SET TRUE`,
    );
    try {
      const facts = await readPrincipalFacts(apiPool);
      expect(facts.memberOf).toContain('prsystem_maintenance_fn');
      await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
        name: 'PrincipalError',
      });
    } finally {
      await admin.query('REVOKE prsystem_maintenance_fn FROM prsystem_api_login');
    }
  }, 60000);

  it('does not exclude PostgreSQL predefined roles', async () => {
    await admin.query('GRANT pg_read_all_data TO prsystem_api_login');
    try {
      const facts = await readPrincipalFacts(apiPool);
      expect(facts.memberOf).toContain('pg_read_all_data');
      await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
        name: 'PrincipalError',
      });
    } finally {
      await admin.query('REVOKE pg_read_all_data FROM prsystem_api_login');
    }
  }, 60000);

  it('rejects a privileged attribute on an otherwise expected reachable group', async () => {
    await admin.query('ALTER ROLE prsystem_api BYPASSRLS');
    try {
      await expect(assertRuntimePrincipal(apiPool, 'prsystem_api')).rejects.toMatchObject({
        name: 'PrincipalError',
      });
    } finally {
      await admin.query('ALTER ROLE prsystem_api NOBYPASSRLS');
    }
  }, 60000);

  it('reports the attributes of every reachable role, not just the session role', async () => {
    const facts = await readPrincipalFacts(apiPool);
    expect(facts.reachable.length).toBeGreaterThan(0);
    for (const role of facts.reachable) {
      expect({ role: role.name, hasAttributes: typeof role.isSuperuser === 'boolean' }).toEqual({
        role: role.name,
        hasAttributes: true,
      });
    }
  });
});
