import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { LoginPrincipal } from '@prsystem/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Real API startup ordering.
 *
 * `startup-guard.test.ts` exercises the guard helpers in isolation, which proves
 * they reject but says nothing about whether `createApp` actually calls them
 * before it binds. These tests drive the real `createApp` and observe the port.
 *
 * The positive control is load-bearing: without a case that genuinely binds the
 * port and is genuinely detected, "nothing is listening" would pass even if the
 * detector were broken, and the refusal cases would prove nothing.
 */

/** A fixed port, so "did startup bind?" is an observable fact rather than an assumption. */
const PORT = 54121;

let db: TestDatabase;
let apiUrl: string;

/** True when something is accepting connections on `PORT`. */
async function isListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(PORT, '127.0.0.1');
  });
}

/** The environment a healthy API needs, minus the two values under test. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    REDIS_URL: 'redis://127.0.0.1:59998',
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_BUCKET: 'prsystem-local',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  };
}

function applyEnv(overrides: Record<string, string>): void {
  Object.assign(process.env, baseEnv(), overrides);
  resetEnvCache();
}

beforeAll(async () => {
  db = await createTestDatabase('api_startup_order');
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
}, 180000);

afterAll(async () => {
  await db?.drop();
  resetEnvCache();
});

describe('createApp startup ordering', () => {
  it('binds the port when the principal and key management are both valid', async () => {
    // Positive control. Proves the port observation below can detect a listener.
    expect(await isListening()).toBe(false);

    applyEnv({
      DATABASE_URL: apiUrl,
      KMS_ADAPTER: 'local',
      KMS_SEED: 'synthetic-startup-order-seed',
    });

    const { createApp } = await import('../bootstrap');
    let app: NestFastifyApplication | undefined;
    try {
      const started = await createApp({ port: PORT, serveDocs: false });
      app = started.app;
      expect(started.port).toBe(PORT);
      expect(await isListening()).toBe(true);
    } finally {
      await app?.close();
    }

    expect(await isListening()).toBe(false);
  }, 120000);

  it('refuses an invalid database principal and never creates a listener', async () => {
    // `db.url` is the superuser credential: a valid connection, the wrong identity.
    applyEnv({
      DATABASE_URL: db.url,
      KMS_ADAPTER: 'local',
      KMS_SEED: 'synthetic-startup-order-seed',
    });

    expect(await isListening()).toBe(false);

    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });

    expect(await isListening()).toBe(false);
  }, 120000);

  it('refuses an unconfigured key manager and never creates a listener', async () => {
    // Principal is valid here, so the only reason to refuse is key management.
    applyEnv({ DATABASE_URL: apiUrl, KMS_ADAPTER: 'none' });

    expect(await isListening()).toBe(false);

    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toThrow(/INT-KMS-01/);

    expect(await isListening()).toBe(false);
  }, 120000);

  it('checks the principal before key management', async () => {
    // Both are invalid. The reported failure names the first check in the order,
    // which is what makes the previous test's "principal was valid" meaningful.
    applyEnv({ DATABASE_URL: db.url, KMS_ADAPTER: 'none' });

    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
    });

    expect(await isListening()).toBe(false);
  }, 120000);
});
