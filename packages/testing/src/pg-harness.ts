import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

/**
 * Scratch-database harness for real PostgreSQL tests (CLAUDE.md §10).
 *
 * Every suite gets its own database inside the PRsystem compose Postgres. It
 * never touches a container, a volume, or any database it did not create, and it
 * drops only the database whose name it generated.
 */

export const DEFAULT_ADMIN_URL =
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';

export function adminUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_ADMIN_URL;
}

/** Every database this harness creates carries the prefix, so cleanup is unambiguous. */
export const TEST_DATABASE_PREFIX = 'prsystem_test_';

export function testDatabaseName(suite: string): string {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(suite)) {
    throw new Error('suite name must be lower snake case');
  }
  return `${TEST_DATABASE_PREFIX}${suite}`;
}

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  /** Connection string for a named LOGIN principal created by the bootstrap. */
  loginUrl(principal: string): string;
  /** Drops the scratch database. Leaves the server and every other database alone. */
  drop(): Promise<void>;
}

/**
 * Local/CI password for the bootstrap LOGIN principals.
 *
 * Stable across processes on purpose. Roles are cluster-global, so a
 * per-process value would have each test worker's bootstrap reset the password
 * out from under the others — the suites would fail with an authentication
 * error that looks nothing like the race it actually is.
 *
 * It is a local-container value of the same class as the compose password, never
 * a production credential, and CI can override it.
 */
export const TEST_LOGIN_PASSWORD =
  process.env['PRSYSTEM_TEST_LOGIN_PASSWORD'] ?? 'prsystem_local_dev_login_only';

/**
 * A `pg.Pool` that will not take the process down when its database disappears.
 *
 * `DROP DATABASE ... WITH (FORCE)` terminates the backends a pool is still
 * holding idle, and `pg.Pool` reports that as an `error` event. An `error` event
 * with no listener is a process-level exception, so the symptom is a test runner
 * that exits non-zero *after* every test has passed — an intermittent failure
 * with nothing in the report to explain it. Every pool a test opens against a
 * throwaway database should be created here.
 *
 * Only idle-client errors are swallowed. A query that fails still rejects, so no
 * assertion can pass because an error went missing.
 */
export function quietPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  pool.on('error', () => {
    // Deliberately empty: the connection is already gone, and the test that
    // owned it has finished.
  });
  return pool;
}

export const TEST_LOGIN_PRINCIPALS = {
  api: 'prsystem_api_login',
  worker: 'prsystem_worker_login',
  police: 'prsystem_police_login',
  auditReader: 'prsystem_audit_reader_login',
  policeAuditReader: 'prsystem_police_audit_reader_login',
  migrate: 'prsystem_migrate_login',
  jobScheduler: 'prsystem_job_scheduler_login',
} as const;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * A pool that connects **as a runtime role**.
 *
 * This matters more than it looks: a superuser bypasses row level security
 * unconditionally, `FORCE ROW LEVEL SECURITY` included. A suite that exercises
 * RLS through an administrative connection proves nothing, so every
 * policy-sensitive test runs through one of these instead.
 *
 * The role is set with the startup `options` parameter rather than a `SET ROLE`
 * statement, so it is in force before the first query and survives a reset.
 */
export function createRolePool(url: string, role: string, max = 8): Pool {
  if (!/^prsystem_[a-z_]+$/.test(role)) {
    throw new Error('role must be a prsystem_* role');
  }
  return quietPool({ connectionString: url, max, options: `-c role=${role}` });
}

/**
 * Creates an empty scratch database. Fails loudly when PostgreSQL is unreachable:
 * an integration gate must never pass by skipping.
 */
/**
 * PostgreSQL serialises `CREATE DATABASE` against its template, so two suites
 * provisioning at the same moment can collide with `object_in_use` (55006).
 * That is contention, not failure — retry briefly rather than forcing every
 * real-database gate to run one package at a time.
 */
async function withProvisioningRetry(work: () => Promise<unknown>): Promise<void> {
  const RETRYABLE = new Set(['55006', '55P03', '40001']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await work();
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 20 || code === undefined || !RETRYABLE.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
    }
  }
}

export async function createTestDatabase(suite: string): Promise<TestDatabase> {
  const name = testDatabaseName(suite);
  const admin = quietPool({ connectionString: adminUrl(), max: 1, connectionTimeoutMillis: 5000 });

  await admin.query('SELECT 1');
  await withProvisioningRetry(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  await withProvisioningRetry(() => admin.query(`CREATE DATABASE ${name}`));

  const url = withDatabase(adminUrl(), name);
  const pool = quietPool({ connectionString: url, max: 8 });

  return {
    name,
    url,
    pool,
    loginUrl(principal: string): string {
      const parsed = new URL(url);
      parsed.username = principal;
      parsed.password = TEST_LOGIN_PASSWORD;
      return parsed.toString();
    },
    async drop(): Promise<void> {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
