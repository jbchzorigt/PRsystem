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

/**
 * Resolves a provider, or `undefined` when the module never registered it.
 *
 * Nest throws for an unknown token even with `strict: false`, and "the provider
 * does not exist" is exactly the state these tests assert.
 */
function tryGet<T>(
  container: {
    get<TInput, TResult>(
      token: string | symbol | (new (...args: never[]) => TInput),
      options: { strict: boolean },
    ): TResult;
  },
  token: string | symbol | (new (...args: never[]) => unknown),
): T | undefined {
  try {
    return container.get<unknown, T>(token, { strict: false });
  } catch {
    return undefined;
  }
}

/**
 * Starts the API and returns the name of the error it refused with, or
 * `'(started)'` when it started.
 *
 * Deliberately not `expect(createApp(...)).rejects`: when the call resolves
 * instead of rejecting, vitest serialises the resolved value into the diff, and
 * a whole running Nest application exhausts the heap before the assertion is
 * ever reported.
 */
async function startupErrorName(): Promise<string> {
  const { createApp } = await import('../bootstrap');
  let started: { app: NestFastifyApplication; port: number } | undefined;
  try {
    started = await createApp({ port: PORT, serveDocs: false });
  } catch (error) {
    return (error as Error).name;
  } finally {
    await started?.app.close().catch(() => undefined);
  }
  return '(started)';
}

function applyEnv(overrides: Record<string, string>): void {
  delete process.env['SCHEDULER_DATABASE_URL'];
  delete process.env['SCHEDULER_ENABLED'];
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
  delete process.env['SCHEDULER_ENABLED'];
  await db?.drop();
  resetEnvCache();
});

describe('the API control plane issues', () => {
  it('resolves the service from the running application and issues through its own pool', async () => {
    // The application is started for real and the service is taken out of the
    // Nest container. Constructing MaintenanceSchedulerService by hand would
    // prove the SQL works and say nothing about whether the capability is wired
    // into the application that ships.
    applyEnv({
      DATABASE_URL: apiUrl,
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_DATABASE_URL: schedulerUrl,
    });
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
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_ENABLED: 'true', SCHEDULER_DATABASE_URL: apiUrl });

    expect(await isListening()).toBe(false);
    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
    });
    expect(await isListening()).toBe(false);
  }, 120000);

  it('refuses a superuser scheduler credential', async () => {
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_ENABLED: 'true', SCHEDULER_DATABASE_URL: db.url });

    const { createApp } = await import('../bootstrap');
    await expect(createApp({ port: PORT, serveDocs: false })).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });
    expect(await isListening()).toBe(false);
  }, 120000);

  it('starts with the correct scheduler credential', async () => {
    // The positive control: the only thing that changed is the credential.
    applyEnv({
      DATABASE_URL: apiUrl,
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_DATABASE_URL: schedulerUrl,
    });

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

describe('the scheduler capability is a decision, not a leftover variable', () => {
  it('builds no scheduler pool and no scheduler service when the capability is disabled', async () => {
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_ENABLED: 'false' });

    const { createApp } = await import('../bootstrap');
    const started = await createApp({ port: PORT, serveDocs: false });
    try {
      expect(tryGet(started.app, SCHEDULER_POOL)).toBeUndefined();
      expect(tryGet(started.app, MaintenanceSchedulerService)).toBeUndefined();
    } finally {
      await started.app.close();
    }
  }, 120000);

  it('refuses to start a disabled API that was handed a scheduler credential', async () => {
    // Stale privileged configuration. Creating the pool anyway is what made
    // SCHEDULER_ENABLED decorative: the flag said off and the credential was
    // still opened, held and usable.
    applyEnv({
      DATABASE_URL: apiUrl,
      SCHEDULER_ENABLED: 'false',
      SCHEDULER_DATABASE_URL: schedulerUrl,
    });

    expect(await isListening()).toBe(false);
    expect(await startupErrorName()).toBe('EnvValidationError');
    expect(await isListening()).toBe(false);
  }, 120000);

  it('refuses to start an enabled API with no scheduler credential', async () => {
    applyEnv({ DATABASE_URL: apiUrl, SCHEDULER_ENABLED: 'true' });

    expect(await startupErrorName()).toBe('EnvValidationError');
    expect(await isListening()).toBe(false);
  }, 120000);

  it('ignores a scheduler credential in the ambient environment when told disabled', async () => {
    // The provider must take its configuration from the injected value, not
    // from process.env. With the credential present and the capability
    // explicitly disabled, nothing may be constructed.
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../app.module');

    applyEnv({ DATABASE_URL: apiUrl });
    process.env['SCHEDULER_DATABASE_URL'] = schedulerUrl;

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          scheduler: { enabled: false },
          // Stated the same way the scheduler capability is: from the injected
          // value, never from the ambient environment.
          iam: {
            config: {
              databaseUrl: apiUrl,
              appEnv: 'ci',
              kmsAdapter: 'local',
              kmsSeed: 'synthetic-scheduler-boundary-seed',
            },
          },
          onboarding: {
            config: {
              databaseUrl: apiUrl,
              appEnv: 'ci',
              kmsAdapter: 'local',
              kmsSeed: 'synthetic-scheduler-boundary-seed',
            },
          },
        }),
      ],
    }).compile();
    try {
      expect(tryGet(moduleRef, SCHEDULER_POOL)).toBeUndefined();
      expect(tryGet(moduleRef, MaintenanceSchedulerService)).toBeUndefined();
    } finally {
      await moduleRef.close();
      delete process.env['SCHEDULER_DATABASE_URL'];
    }
  }, 60000);

  it('generates the OpenAPI document with the capability explicitly disabled', () => {
    const source = readFileSync(resolve(__dirname, '..', 'openapi.ts'), 'utf8');
    expect(source).toMatch(/AppModule\.forRoot\(\s*\{\s*scheduler:\s*\{\s*enabled:\s*false\s*\}/);
  });

  it('takes the credential from injected configuration, never from process.env', () => {
    const source = readFileSync(
      resolve(__dirname, '..', 'maintenance', 'maintenance.module.ts'),
      'utf8',
    );
    // Prose about process.env is fine; reading it in the provider is the defect.
    expect(source).not.toMatch(/process\.env\s*[[.]/);
  });
});
