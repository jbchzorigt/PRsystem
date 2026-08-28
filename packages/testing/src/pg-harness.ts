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

/**
 * `application_name` prefix of the coordination pool a scratch database owns.
 *
 * Set so the pool is identifiable in `pg_stat_activity` — which makes it
 * diagnosable during an incident and lets the negative fixture provoke an error
 * on exactly that backend instead of on whatever else happened to be idle.
 */
export const TEST_ADMIN_APPLICATION_NAME = 'prsystem_test_admin';

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
  /**
   * The logical test scope this pool belongs to.
   *
   * Usually the database it connects to, but not always: the admin pool a
   * `createTestDatabase` lifecycle opens connects to the *coordination*
   * database, and accounting it there meant its errors were filed under a
   * database no teardown ever asserted. The scope is the lifecycle, so every
   * pool a scratch database owns is checked when that database is dropped.
   */
  readonly scope: string;
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

/**
 * Pool bookkeeping, held on `globalThis`.
 *
 * A test file resolves `@prsystem/testing` to the built package while a vitest
 * setup file may load this module by relative path; module-scoped state then
 * splits into two instances, each with its own empty map, and an assertion in
 * one inspects a map the other writes to. Anchoring the state to the process
 * makes the accounting independent of how the module was resolved.
 */
interface PoolRegistry {
  readonly tracked: Map<Pool, TrackedPool>;
  readonly unexpectedByScope: Map<string, PoolErrorEntry[]>;
}

const REGISTRY_KEY = Symbol.for('prsystem.testing.poolRegistry');

function registry(): PoolRegistry {
  const host = globalThis as unknown as Record<symbol, PoolRegistry | undefined>;
  host[REGISTRY_KEY] ??= { tracked: new Map(), unexpectedByScope: new Map() };
  return host[REGISTRY_KEY];
}

const tracked = registry().tracked;

/**
 * Unexpected idle-client errors, accounted **per logical test scope**.
 *
 * A single process-global list made every suite share one mutable report: a
 * `reset` in one suite erased another suite's failure, and only the suites that
 * remembered to call the assertion ever failed on one. Keying by scope means a
 * lifecycle's own errors travel with it and are checked when its database is
 * dropped, whether or not the suite thought to ask.
 */
const unexpectedByScope = registry().unexpectedByScope;

/**
 * Errors from pools whose scope could not be determined.
 *
 * Not a quiet bucket: every scratch-database teardown asserts it as well as its
 * own scope. An error nobody could attribute is still an error, and leaving it
 * unexamined was the same silence as not recording it.
 */
export const UNATTRIBUTED_SCOPE = '(unattributed)';

function recordUnexpected(scope: string, entry: PoolErrorEntry): void {
  const existing = unexpectedByScope.get(scope);
  if (existing === undefined) unexpectedByScope.set(scope, [entry]);
  else existing.push(entry);
}

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
export function quietPool(config: PoolConfig, label = 'pool', scope?: string): Pool {
  const pool = new Pool(config);
  const database = databaseOf(config);
  const record: TrackedPool = {
    pool,
    label,
    database,
    // Explicit scope wins: it is how a lifecycle claims a pool that connects
    // somewhere else. Otherwise the database it connects to, and failing that
    // the unattributed bucket, which is asserted rather than ignored.
    scope: scope ?? database ?? UNATTRIBUTED_SCOPE,
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
    recordUnexpected(record.scope, entry);
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
export function unexpectedPoolErrorReport(scope?: string): readonly PoolErrorEntry[] {
  if (scope !== undefined) return [...(unexpectedByScope.get(scope) ?? [])];
  return [...unexpectedByScope.values()].flat();
}

/**
 * Clears the recorded errors for one database.
 *
 * Scoped deliberately: a suite that deliberately provokes an error must be able
 * to clear its own, and must not be able to clear anybody else's. Calling this
 * with no argument is refused for that reason.
 */
export function resetPoolErrorReport(scope: string): void {
  unexpectedByScope.delete(scope);
}

/**
 * Fails when any pool reported an error that was not an expected teardown.
 *
 * Suites that open pools call this in `afterAll`, so an infrastructure fault
 * during a run is a failure rather than a silence.
 */
export function assertNoUnexpectedPoolErrors(scope?: string): void {
  const entries = unexpectedPoolErrorReport(scope);
  if (entries.length === 0) return;
  const where = scope === undefined ? 'this process' : `scope ${scope}`;
  const detail = entries.map((e) => `${e.label}: ${e.code ?? '(no code)'} ${e.message}`).join('; ');
  throw new Error(`unexpected pool error(s) outside teardown in ${where}: ${detail}`);
}

/**
 * Asserts every scope this process recorded, whatever created the pool.
 *
 * Registered as a global `afterAll` by `setup-pool-errors.ts`, so it runs at the
 * end of every test file. Scope accounting covered the lifecycle a scratch
 * database owns; a suite managing its own `quietPool` — `migrate.test.ts`, for
 * one — recorded its errors into a scope nothing ever read. Making the final
 * assertion unconditional means no bucket, default, coordination or
 * unattributed, can end a run uninspected.
 */
export function assertAllPoolScopesClean(): void {
  assertNoUnexpectedPoolErrors();
}

/**
 * Asserts one scope and the unattributed bucket together.
 *
 * The complete logical scope of a `createTestDatabase` lifecycle: the scratch
 * database's own pools, the coordination pool it opened, and anything that could
 * not be attributed at all.
 */
export function assertScopeClean(scope: string): void {
  assertNoUnexpectedPoolErrors(scope);
  assertNoUnexpectedPoolErrors(UNATTRIBUTED_SCOPE);
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
  // Scoped to this lifecycle even though it connects to the coordination
  // database, and named so a fixture can target exactly this backend.
  const admin = quietPool(
    {
      connectionString: adminUrl(),
      max: 1,
      connectionTimeoutMillis: 5000,
      application_name: `${TEST_ADMIN_APPLICATION_NAME}:${name}`,
    },
    `admin:${name}`,
    name,
  );

  await admin.query('SELECT 1');
  await withProvisioningRetry(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  await withProvisioningRetry(() => admin.query(`CREATE DATABASE ${name}`));

  const url = withDatabase(adminUrl(), name);
  const pool = quietPool({ connectionString: url, max: 8 }, `scratch:${name}`, name);

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
      // Every suite that creates a database gets this check, whether or not it
      // remembered to ask for it. Pools were closed in order above, so anything
      // recorded here happened while the database was still expected to work.
      // The whole logical scope, not just the scratch database: the coordination
      // pool belongs to this lifecycle, and an unattributable error is still an
      // error.
      assertScopeClean(name);
    },
  };
}
