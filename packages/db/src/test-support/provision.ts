import { Pool } from 'pg';
import type { TestDatabase } from '@prsystem/testing';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';
import { runMigrations } from '../migrate';

/**
 * Provisions a scratch database the way a deployment does: cluster bootstrap
 * first, then migrations as the restricted migration login.
 *
 * Every suite that asserts a security property uses the real LOGIN identities
 * this returns. A superuser connection with `SET ROLE` would not prove anything:
 * a superuser bypasses RLS unconditionally, and `SET ROLE` leaves `session_user`
 * unchanged, so membership checks read the wrong principal.
 */
export interface ProvisionedDatabase {
  readonly db: TestDatabase;
  /** Superuser connection. Setup and verification only — never a security assertion. */
  readonly admin: Pool;
  /** Pools connected as real, restricted LOGIN principals. */
  readonly api: Pool;
  readonly worker: Pool;
  readonly police: Pool;
  readonly auditReader: Pool;
  readonly policeAuditReader: Pool;
  /** D-09: issues privileged maintenance jobs and can do nothing else. */
  readonly jobScheduler: Pool;
  readonly migrateUrl: string;
  close(): Promise<void>;
}

function loginPool(db: TestDatabase, principal: string, max = 6): Pool {
  return new Pool({ connectionString: db.loginUrl(principal), max });
}

export async function provisionKernelDatabase(suite: string): Promise<ProvisionedDatabase> {
  const db = await createTestDatabase(suite);

  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });

  const migrateUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate);
  await runMigrations(migrateUrl);

  const pools = {
    api: loginPool(db, TEST_LOGIN_PRINCIPALS.api),
    worker: loginPool(db, TEST_LOGIN_PRINCIPALS.worker),
    police: loginPool(db, TEST_LOGIN_PRINCIPALS.police),
    auditReader: loginPool(db, TEST_LOGIN_PRINCIPALS.auditReader),
    policeAuditReader: loginPool(db, TEST_LOGIN_PRINCIPALS.policeAuditReader),
    jobScheduler: loginPool(db, TEST_LOGIN_PRINCIPALS.jobScheduler),
  };

  return {
    db,
    admin: db.pool,
    ...pools,
    migrateUrl,
    async close(): Promise<void> {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
      await db.drop();
    },
  };
}
