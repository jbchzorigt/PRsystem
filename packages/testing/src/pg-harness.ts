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
 * Pool bookkeeping for tests.
 *
 * `DROP DATABASE ... WITH (FORCE)` terminates the backends a pool is still
 * holding idle, and `pg.Pool` reports that as an `error` event. An `error` event
 * with no listener is a process-level exception, so the symptom was a runner
 * that exits non-zero *after* every test passed.
 *
 * The first fix attached an empty handler to every pool. That removed the crash
 * and, with it, every idle-client error the suite might genuinely need to see —
 * a connection reset by an overloaded server, a backend killed by the OOM
 * killer, a certificate failure. A gate that cannot fail on infrastructure
 * trouble is not a gate.
 *
 * So: pools are tracked, closed before the database is dropped, and only an
 * error that arrives on a pool explicitly marked as being torn down, and that
 * looks like a termination, is suppressed. Everything else is recorded, and
 * `assertNoUnexpectedPoolErrors()` fails the suite on it.
 */
interface TrackedPool {
  readonly pool: Pool;
  readonly label: string;
  /** The database this pool connects to, so a drop closes only its own pools. */
  readonly database: string | undefined;
  /** Set once the pool is knowingly about to lose its server. */
  tearingDown: boolean;
  readonly suppressed: string[];
  readonly unexpected: PoolErrorEntry[];
}

export interface PoolErrorEntry {
  readonly label: string;
  readonly message: string;
  readonly code: string | undefined;
}

const tracked = new Map<Pool, TrackedPool>();
const unexpectedPoolErrors: PoolErrorEntry[] = [];

/**
 * SQLSTATEs and messages PostgreSQL produces when it terminates a connection
 * because the database is going away. Anything outside this set is a real fault.
 */
function isTeardownTermination(error: Error & { code?: string }): boolean {
  const code = error.code ?? '';
  if (code === '57P01' || code === '57P02' || code === '57P03' || code === '08006') return true;
  return /terminating connection|Connection terminated|server closed the connection/i.test(
    error.message,
  );
}

/**
 * A tracked `pg.Pool`.
 *
 * Query failures still reject exactly as before: this only governs the pool's
 * out-of-band `error` event, so no assertion can pass because an error went
 * missing.
 */
export function quietPool(config: PoolConfig, label = 'pool'): Pool {
  const pool = new Pool(config);
  const record: TrackedPool = {
    pool,
    label,
    database: databaseOf(config),
    tearingDown: false,
    suppressed: [],
    unexpected: [],
  };
  tracked.set(pool, record);

  pool.on('error', (error: Error & { code?: string }) => {
    if (record.tearingDown && isTeardownTermination(error)) {
      record.suppressed.push(error.message);
      return;
    }
    const entry = { label, message: error.message, code: error.code };
    record.unexpected.push(entry);
    unexpectedPoolErrors.push(entry);
  });

  return pool;
}

/** The database a pool config names, for scoping a teardown to one database. */
function databaseOf(config: PoolConfig): string | undefined {
  if (typeof config.database === 'string') return config.database;
  if (typeof config.connectionString !== 'string') return undefined;
  try {
    return new URL(config.connectionString).pathname.replace(/^\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Marks `pool` as knowingly about to lose its server. */
export function expectPoolTeardown(pool: Pool): void {
  const record = tracked.get(pool);
  if (record !== undefined) record.tearingDown = true;
}

/**
 * Ends tracked pools, marking them as tearing down first.
 *
 * Called before a database is dropped, so in the ordinary case there is no idle
 * connection left for the server to terminate at all. Scoped to one database
 * when a name is given: dropping one scratch database must not close the pools
 * another suite is still using.
 */
export async function closeTrackedPools(database?: string): Promise<void> {
  const records = [...tracked.values()].filter(
    (record) => database === undefined || record.database === database,
  );
  for (const record of records) record.tearingDown = true;
  await Promise.all(
    records.map(async (record) => {
      try {
        await record.pool.end();
      } catch {
        // Already ended, or already gone. Either way there is nothing to close.
      }
      tracked.delete(record.pool);
    }),
  );
}

/** Every idle-client error that was *not* an expected teardown termination. */
export function unexpectedPoolErrorReport(): readonly PoolErrorEntry[] {
  return [...unexpectedPoolErrors];
}

/** Clears the recorded errors. For the tests that assert on this machinery. */
export function resetPoolErrorReport(): void {
  unexpectedPoolErrors.length = 0;
}

/**
 * Fails when any pool reported an error that was not an expected teardown.
 *
 * Suites that open pools call this in `afterAll`, so an infrastructure fault
 * during a run is a failure rather than a silence.
 */
export function assertNoUnexpectedPoolErrors(): void {
  if (unexpectedPoolErrors.length === 0) return;
  const detail = unexpectedPoolErrors
    .map((e) => `${e.label}: ${e.code ?? '(no code)'} ${e.message}`)
    .join('; ');
  throw new Error(`unexpected pool error(s) outside teardown: ${detail}`);
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
      // Every tracked pool is closed *before* the database is dropped, so the
      // FORCE below normally has no idle connection left to terminate. The
      // teardown marking covers the connections a test opened and did not end.
      expectPoolTeardown(pool);
      await closeTrackedPools(name);
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
