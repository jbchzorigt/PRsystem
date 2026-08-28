import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { LoginPrincipal } from '@prsystem/db';
import { KeyManagementError } from '@prsystem/ports';
import { createLogger } from '@prsystem/telemetry';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { ConnectionOptions, Worker } from 'bullmq';
import { startWorker } from './startup';

/**
 * Real worker startup ordering.
 *
 * The security preconditions are worth nothing if the process has already
 * connected to Redis and constructed consumers by the time they run. `startWorker`
 * takes the Redis connection and the consumer construction as injected factories
 * precisely so a test can assert they were *never invoked* on a refused startup —
 * which is a fact about ordering, not a claim about it.
 */

const logger = createLogger({ level: 'error', serviceName: 'worker-startup-test' });

let db: TestDatabase;
let workerUrl: string;

/** Spy factories plus a pool tracker, so both "not called" and "released" are observable. */
function makeDeps(connectionString: string, kmsFails: boolean) {
  const pools: Pool[] = [];
  const createConnection = vi.fn((): ConnectionOptions => ({ host: '127.0.0.1', port: 59998 }));
  const createWorkers = vi.fn((_connection: ConnectionOptions): readonly Worker[] => []);
  return {
    pools,
    createConnection,
    createWorkers,
    deps: {
      logger,
      openGuardPool: (): Pool => {
        const pool = new Pool({ connectionString, max: 1 });
        pools.push(pool);
        return pool;
      },
      verifyKeyManagement: (): void => {
        if (kmsFails) {
          throw new KeyManagementError(
            'INT-KMS-01: no key management adapter is configured',
            'unavailable',
          );
        }
      },
      createConnection,
      createWorkers,
    },
  };
}

/** A pool that has been `end()`ed reports itself ended; a leaked one would not. */
function allPoolsClosed(pools: Pool[]): boolean {
  return pools.every((pool) => (pool as unknown as { ended: boolean }).ended);
}

beforeAll(async () => {
  db = await createTestDatabase('worker_startup');
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  workerUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.worker);
}, 180000);

afterAll(async () => {
  await db?.drop();
});

describe('startWorker ordering', () => {
  it('constructs the Redis connection and consumers when both guards pass', async () => {
    // Positive control: without it, "the factories were not called" could pass
    // for a `startWorker` that never calls them at all.
    const { deps, pools, createConnection, createWorkers } = makeDeps(workerUrl, false);

    const started = await startWorker(deps);

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(createWorkers).toHaveBeenCalledTimes(1);
    // The consumers are built from the connection the factory returned.
    expect(createWorkers).toHaveBeenCalledWith(createConnection.mock.results[0]?.value);
    // Ordering: the connection exists before the consumers are constructed.
    expect(createConnection.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkers.mock.invocationCallOrder[0] ?? 0,
    );
    expect(allPoolsClosed(pools)).toBe(true);

    await started.close();
  }, 60000);

  it('never contacts Redis when the database principal is wrong', async () => {
    // `db.url` is the superuser credential: connectable, but the wrong identity.
    const { deps, pools, createConnection, createWorkers } = makeDeps(db.url, false);

    await expect(startWorker(deps)).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });

    expect(createConnection).not.toHaveBeenCalled();
    expect(createWorkers).not.toHaveBeenCalled();
    // A refused startup leaves no connection behind.
    expect(allPoolsClosed(pools)).toBe(true);
  }, 60000);

  it('never contacts Redis when key management is unconfigured', async () => {
    // The principal is valid here, so the refusal can only come from key management.
    const { deps, pools, createConnection, createWorkers } = makeDeps(workerUrl, true);

    await expect(startWorker(deps)).rejects.toBeInstanceOf(KeyManagementError);

    expect(createConnection).not.toHaveBeenCalled();
    expect(createWorkers).not.toHaveBeenCalled();
    expect(allPoolsClosed(pools)).toBe(true);
  }, 60000);

  it('checks the principal before key management', async () => {
    // Both invalid: the reported failure names the first check in the order.
    const { deps, createConnection } = makeDeps(db.url, true);

    await expect(startWorker(deps)).rejects.toMatchObject({ name: 'PrincipalError' });
    expect(createConnection).not.toHaveBeenCalled();
  }, 60000);
});

describe('the worker refuses the migration credential', () => {
  /**
   * `MIGRATION_DATABASE_URL` names a principal that can apply DDL. The shared
   * configuration schema used to declare it, so the worker parsed it and
   * returned it on every start — while `.env.example` said the worker rejected
   * it. `workerEnv()` is what `main.ts` calls, so this is the startup path.
   */
  const MIGRATION_SECRET = 'migration-only-password-worker';
  const MIGRATION_URL = `postgresql://prsystem_migrate_login:${MIGRATION_SECRET}@127.0.0.1:55442/prsystem`;

  function workerBaseEnv(): Record<string, string> {
    return {
      NODE_ENV: 'test',
      APP_ENV: 'ci',
      LOG_LEVEL: 'error',
      DATABASE_URL: 'postgresql://prsystem_worker_login:pw@127.0.0.1:55442/prsystem',
      REDIS_URL: 'redis://127.0.0.1:59998',
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORAGE_BUCKET: 'prsystem-local',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
    };
  }

  async function loadWorkerConfig(overrides: Record<string, string>): Promise<Error | undefined> {
    const { workerEnv, resetEnvCache } = await import('@prsystem/config');
    delete process.env['MIGRATION_DATABASE_URL'];
    Object.assign(process.env, workerBaseEnv(), overrides);
    resetEnvCache();
    try {
      workerEnv();
      return undefined;
    } catch (error) {
      return error as Error;
    } finally {
      delete process.env['MIGRATION_DATABASE_URL'];
      resetEnvCache();
    }
  }

  it('refuses a supplied MIGRATION_DATABASE_URL', async () => {
    const error = await loadWorkerConfig({ MIGRATION_DATABASE_URL: MIGRATION_URL });
    expect(error?.name).toBe('EnvValidationError');
  });

  it('refuses an empty MIGRATION_DATABASE_URL', async () => {
    const error = await loadWorkerConfig({ MIGRATION_DATABASE_URL: '' });
    expect(error?.name).toBe('EnvValidationError');
  });

  it('never puts the credential in the refusal', async () => {
    const error = await loadWorkerConfig({ MIGRATION_DATABASE_URL: MIGRATION_URL });
    expect(error?.message).toContain('MIGRATION_DATABASE_URL');
    expect(error?.message).not.toContain(MIGRATION_SECRET);
    expect(String(error?.stack ?? '')).not.toContain(MIGRATION_SECRET);
  });

  it('starts normally when it is absent', async () => {
    const error = await loadWorkerConfig({});
    expect(error).toBeUndefined();
  });
});
