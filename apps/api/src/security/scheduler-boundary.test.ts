import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { LoginPrincipal } from '@prsystem/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MaintenanceSchedulerService } from '../maintenance/scheduler.service';
import { SCHEDULER_POOL } from '../maintenance/maintenance.module';

/**
 * D-09 as a deployment fact.
 *
 * Issuance lives in the API control plane, on its own credential. The worker
 * deployment never receives that credential, so a compromised worker can execute
 * a job somebody else issued and cannot issue one. These tests hold both halves
 * of that claim to the code rather than to the comment describing it.
 */

const PORT = 54123;
const HOTEL = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const JOB_NAME = 'platform.maintenance.expire_idempotency_keys';

let db: TestDatabase;
let schedulerUrl: string;
let apiUrl: string;

async function isListening(): Promise<boolean> {
  return new Promise((resolve_) => {
    const probe = createServer();
    probe.once('error', () => resolve_(true));
    probe.once('listening', () => probe.close(() => resolve_(false)));
    probe.listen(PORT, '127.0.0.1');
  });
}

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-scheduler-boundary-seed',
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
  delete process.env['SCHEDULER_DATABASE_URL'];
  Object.assign(process.env, baseEnv(), overrides);
  resetEnvCache();
}

beforeAll(async () => {
  db = await createTestDatabase('api_scheduler_boundary');
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  schedulerUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.jobScheduler);
  apiUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.api);
}, 180000);

afterAll(async () => {
  delete process.env['SCHEDULER_DATABASE_URL'];
  await db?.drop();
  resetEnvCache();
});

describe('the API control plane issues', () => {
  it('resolves the service from the running application and issues through its own pool', async () => {
    // The application is started for real and the service is taken out of the
    // Nest container. Constructing MaintenanceSchedulerService by hand would
    // prove the SQL works and say nothing about whether the capability is wired
    // into the application that ships.
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_DATABASE_URL: schedulerUrl });
    const { createApp } = await import('../bootstrap');
    const started = await createApp({ port: PORT, serveDocs: false });

    try {
      const service = started.app.get(MaintenanceSchedulerService);
      expect(service).toBeInstanceOf(MaintenanceSchedulerService);

      const pool = started.app.get<Pool>(SCHEDULER_POOL, { strict: false });
      expect(pool).toBeDefined();

      const id = await service.issueMaintenanceJob(
        {
          hotelId: HOTEL,
          realm: 'operation',
          actorRef: 'whatever_the_caller_says',
          correlationId: 'corr-container-issue',
        },
        JOB_NAME,
        TEST_LOGIN_PRINCIPALS.worker,
      );

      const stored = await db.pool.query<{ issuer_ref: string; job_identity: string }>(
        `SELECT issuer_ref, job_identity FROM platform.job_run WHERE job_run_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.issuer_ref).toBe(TEST_LOGIN_PRINCIPALS.jobScheduler);
      expect(stored.rows[0]?.job_identity).toBe(TEST_LOGIN_PRINCIPALS.worker);

      // The pool is alive and serving the application, not opened per call.
      const alive = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(alive.rows[0]?.ok).toBe(1);

      // Shutting the application down closes it, through the Nest lifecycle.
      await started.app.close();
      await expect(async () => pool.query('SELECT 1')).rejects.toThrow(/after calling end/i);
    } finally {
      await started.app.close().catch(() => undefined);
    }
  }, 120000);

  it('issues through a directly constructed service too', async () => {
    const pool = new Pool({ connectionString: schedulerUrl, max: 1 });
    try {
      const service = new MaintenanceSchedulerService(pool);
      const id = await service.issueMaintenanceJob(
        {
          hotelId: HOTEL,
          realm: 'operation',
          // A claim, not an identity. The issuer recorded must ignore it.
          actorRef: 'whatever_the_caller_says',
          correlationId: 'corr-scheduler-boundary',
        },
        JOB_NAME,
        TEST_LOGIN_PRINCIPALS.worker,
      );

      const stored = await db.pool.query<{ issuer_ref: string; job_identity: string }>(
        `SELECT issuer_ref, job_identity FROM platform.job_run WHERE job_run_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.issuer_ref).toBe(TEST_LOGIN_PRINCIPALS.jobScheduler);
      expect(stored.rows[0]?.job_identity).toBe(TEST_LOGIN_PRINCIPALS.worker);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('exposes no route for it in Phase 03', async () => {
    // Issuance is a control-plane capability, not a public API. A route would
    // need the Phase 04 authorization pipeline in front of it.
    const controllers = resolve(__dirname, '..', 'maintenance', 'scheduler.service.ts');
    const source = readFileSync(controllers, 'utf8');
    expect(source).not.toMatch(/@Controller|@Post|@Get|@Put|@Patch|@Delete/);
  });
});

describe('the API refuses to start with the wrong scheduler credential', () => {
  it('refuses when SCHEDULER_DATABASE_URL is not the scheduler principal', async () => {
    // The API's own principal, handed to the scheduler slot: a valid connection
    // and the wrong authority.
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_DATABASE_URL: apiUrl });

    expect(await isListening()).toBe(false);
    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
    });
    expect(await isListening()).toBe(false);
  }, 120000);

  it('refuses a superuser scheduler credential', async () => {
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_DATABASE_URL: db.url });

    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });
    expect(await isListening()).toBe(false);
  }, 120000);

  it('starts with the correct scheduler credential', async () => {
    // The positive control: the only thing that changed is the credential.
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_DATABASE_URL: schedulerUrl });

    const { createApp } = await import('../bootstrap');
    let app: NestFastifyApplication | undefined;
    try {
      const started = await createApp({ port: PORT, serveDocs: false });
      app = started.app;
      expect(await isListening()).toBe(true);
    } finally {
      await app?.close();
    }
    expect(await isListening()).toBe(false);
  }, 120000);
});

describe('the worker deployment never receives the scheduler credential', () => {
  it('does not read SCHEDULER_DATABASE_URL anywhere in its sources', () => {
    // A deployment fact, held to the code: the worker has no path that could
    // consume the credential even if an operator set it in its environment.
    const workerSrc = resolve(__dirname, '..', '..', '..', 'worker', 'src');
    const files = ['main.ts', 'startup.ts', 'observability/connection-guard.ts', 'queues.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(workerSrc, file), 'utf8');
      expect({ file, mentions: /SCHEDULER_DATABASE_URL/.test(source) }).toEqual({
        file,
        mentions: false,
      });
    }
  });

  it('keeps issuance out of the worker entirely', () => {
    const workerSrc = resolve(__dirname, '..', '..', '..', 'worker', 'src');
    for (const file of ['main.ts', 'startup.ts']) {
      const source = readFileSync(resolve(workerSrc, file), 'utf8');
      expect(source).not.toMatch(/schedule_maintenance_job|MaintenanceSchedulerService/);
    }
  });
});
