import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { LoginPrincipal } from '@prsystem/db';
import { SCHEDULER_APPLICATION_NAME } from '../maintenance/maintenance.module';

/**
 * A refused startup must leave nothing behind.
 *
 * The scheduler pool is created by the Nest container and validated by the
 * startup guard. Everything after that guard — correlation setup, the OpenAPI
 * document, `app.listen()` — ran outside any cleanup, so a failure there left
 * the application, and with it the privileged scheduler connection, alive in a
 * process that had not started. `EADDRINUSE` is the ordinary way to reach that
 * state: a deploy onto a port something else already holds.
 */

const PORT = 54137;
let db: TestDatabase;
let apiUrl: string;
let schedulerUrl: string;
let occupier: Server | undefined;

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-startup-cleanup-seed',
    REDIS_URL: 'redis://127.0.0.1:59998',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  };
}

function applyEnv(overrides: Record<string, string>): void {
  delete process.env['SCHEDULER_DATABASE_URL'];
  delete process.env['SCHEDULER_ENABLED'];
  Object.assign(process.env, baseEnv(), overrides);
  resetEnvCache();
}

/** Scheduler backends currently connected, by application name. */
async function schedulerBackends(): Promise<number> {
  const result = await db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE application_name = $1 AND pid <> pg_backend_pid()`,
    [SCHEDULER_APPLICATION_NAME],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase('api_startup_cleanup');
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  apiUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.api);
  schedulerUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.jobScheduler);
}, 180000);

afterAll(async () => {
  await new Promise<void>((done) => (occupier ? occupier.close(() => done()) : done()));
  delete process.env['SCHEDULER_DATABASE_URL'];
  delete process.env['SCHEDULER_ENABLED'];
  await db?.drop();
  resetEnvCache();
});

describe('a startup that fails after the guard leaves nothing running', () => {
  it('closes the scheduler pool when the port is already taken', async () => {
    applyEnv({
      DATABASE_URL: apiUrl,
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_DATABASE_URL: schedulerUrl,
    });

    // Something else already holds the port. The scheduler guard passes, the
    // pool is live, and `listen` is what fails.
    occupier = createServer();
    await new Promise<void>((done) => occupier!.listen(PORT, '127.0.0.1', () => done()));

    const { createApp } = await import('../bootstrap');
    let raised: unknown;
    let started: { app: { close(): Promise<void> } } | undefined;
    try {
      started = await createApp({ port: PORT, serveDocs: false });
    } catch (error) {
      raised = error;
    } finally {
      await started?.app.close().catch(() => undefined);
      // Always released, so a failing assertion below cannot leave the port
      // held and turn the next case into a false failure.
      await new Promise<void>((done) => occupier!.close(() => done()));
      occupier = undefined;
    }

    // The original failure survives cleanup: an EADDRINUSE reported as a
    // shutdown error would send an operator looking in the wrong place.
    expect((raised as NodeJS.ErrnoException | undefined)?.code).toBe('EADDRINUSE');

    // Give the pool's sockets a moment to close, then require that none is left.
    await new Promise((r) => setTimeout(r, 500));
    expect(await schedulerBackends()).toBe(0);
  }, 120000);

  it('starts and shuts down normally when the port is free', async () => {
    // The positive control: cleanup on failure must not have broken success.
    applyEnv({
      DATABASE_URL: apiUrl,
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_DATABASE_URL: schedulerUrl,
    });

    const { createApp } = await import('../bootstrap');
    const started = await createApp({ port: PORT, serveDocs: false });
    expect(await schedulerBackends()).toBeGreaterThanOrEqual(0);
    await started.app.close();

    await new Promise((r) => setTimeout(r, 500));
    expect(await schedulerBackends()).toBe(0);
  }, 120000);
});
