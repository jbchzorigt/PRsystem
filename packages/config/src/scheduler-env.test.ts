import { describe, expect, it } from 'vitest';
import { EnvValidationError } from './env';
import { loadApiEnv } from './api-env';
import { loadWorkerEnv } from './worker-env';

/**
 * Scheduler capability configuration (D-09).
 *
 * The capability and its credential are one decision, not two independent
 * variables. Every combination below is either a working deployment or a
 * configuration mistake somebody must be told about at startup — there is no
 * combination that is allowed to start and be wrong later.
 */

const base: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://prsystem_api:pw@localhost:5432/prsystem',
  REDIS_URL: 'redis://localhost:6379',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'prsystem-local',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'local-access-key',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};

const SCHEDULER_URL = 'postgresql://prsystem_job_scheduler_login:pw@localhost:5432/prsystem';

describe('API scheduler configuration', () => {
  it('rejects the capability enabled with no credential, in every environment', () => {
    for (const APP_ENV of ['local', 'ci', 'staging', 'production'] as const) {
      let raised: unknown;
      try {
        loadApiEnv({ ...base, APP_ENV, SCHEDULER_ENABLED: 'true' });
      } catch (error) {
        raised = error;
      }
      expect({ APP_ENV, isEnvError: raised instanceof EnvValidationError }).toEqual({
        APP_ENV,
        isEnvError: true,
      });
      expect((raised as EnvValidationError).message).toMatch(/SCHEDULER_DATABASE_URL/);
    }
  });

  it('rejects a credential supplied while the capability is disabled', () => {
    // Stale privileged configuration. A scheduler credential sitting in the
    // environment of a deployment that will never use it is a live credential
    // nobody is accounting for, not a harmless leftover.
    expect(() =>
      loadApiEnv({
        ...base,
        APP_ENV: 'ci',
        SCHEDULER_ENABLED: 'false',
        SCHEDULER_DATABASE_URL: SCHEDULER_URL,
      }),
    ).toThrow(EnvValidationError);
  });

  it('accepts the capability disabled with no credential and reports it disabled', () => {
    const config = loadApiEnv({ ...base, APP_ENV: 'ci', SCHEDULER_ENABLED: 'false' });
    expect(config.scheduler).toEqual({ enabled: false });
  });

  it('accepts the capability enabled with its credential', () => {
    const config = loadApiEnv({
      ...base,
      APP_ENV: 'ci',
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_DATABASE_URL: SCHEDULER_URL,
    });
    expect(config.scheduler).toEqual({ enabled: true, databaseUrl: SCHEDULER_URL });
  });

  it('defaults to disabled outside production and to enabled in production', () => {
    expect(loadApiEnv({ ...base, APP_ENV: 'ci' }).scheduler.enabled).toBe(false);
    // Production defaults on, so a production API that forgot the credential is
    // told at startup rather than failing the first time somebody issues a job.
    expect(() => loadApiEnv({ ...base, APP_ENV: 'production' })).toThrow(EnvValidationError);
  });

  it('rejects a malformed scheduler URL', () => {
    expect(() =>
      loadApiEnv({
        ...base,
        APP_ENV: 'ci',
        SCHEDULER_ENABLED: 'true',
        SCHEDULER_DATABASE_URL: 'mysql://localhost/db',
      }),
    ).toThrow(EnvValidationError);
  });

  it('never places the scheduler credential in an error message', () => {
    const secret = 'super-secret-scheduler-password';
    try {
      loadApiEnv({
        ...base,
        APP_ENV: 'ci',
        SCHEDULER_ENABLED: 'false',
        SCHEDULER_DATABASE_URL: `postgresql://u:${secret}@localhost:5432/prsystem`,
      });
      expect.unreachable('expected loadApiEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('worker configuration', () => {
  it('validates in production with no scheduler variables at all', () => {
    const config = loadWorkerEnv({ ...base, APP_ENV: 'production', NODE_ENV: 'production' });
    expect(config.APP_ENV).toBe('production');
  });

  it('never returns or exposes a scheduler field', () => {
    const config = loadWorkerEnv({ ...base, APP_ENV: 'production' });
    expect(Object.keys(config).filter((key) => key.startsWith('SCHEDULER'))).toEqual([]);
  });

  it('rejects a worker handed scheduler credentials', () => {
    // D-09 is a deployment separation. A worker holding the issuing credential
    // is the arrangement the decision exists to prevent, so it refuses to start
    // rather than quietly ignoring the variable.
    expect(() =>
      loadWorkerEnv({ ...base, APP_ENV: 'production', SCHEDULER_DATABASE_URL: SCHEDULER_URL }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a worker told the scheduler capability is enabled', () => {
    expect(() =>
      loadWorkerEnv({ ...base, APP_ENV: 'production', SCHEDULER_ENABLED: 'true' }),
    ).toThrow(EnvValidationError);
  });

  it('never places the scheduler credential in the rejection message', () => {
    const secret = 'super-secret-scheduler-password';
    try {
      loadWorkerEnv({
        ...base,
        SCHEDULER_DATABASE_URL: `postgresql://u:${secret}@localhost:5432/prsystem`,
      });
      expect.unreachable('expected loadWorkerEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('the scheduler default is API-specific', () => {
  it('keeps the capability out of the shared configuration path entirely', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const shared = readFileSync(resolve(__dirname, 'env.ts'), 'utf8');
    expect(/SCHEDULER_/.test(shared)).toBe(false);
  });

  it('declares the credential and its default in api-env.ts and nowhere else', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // The worker names the variables in order to refuse them. What it must not
    // do is declare them as configuration or resolve the default, because that
    // is what would let a non-API deployment inherit the capability.
    const declaring = readdirSync(__dirname)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => {
        const source = readFileSync(resolve(__dirname, file), 'utf8');
        return (
          /SCHEDULER_DATABASE_URL:\s*postgresUrl/.test(source) ||
          /function resolveSchedulerEnabled/.test(source)
        );
      });
    expect(declaring).toEqual(['api-env.ts']);
  });

  it('refuses the scheduler credential in the worker without reading its value', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, 'worker-env.ts'), 'utf8');
    // Presence only. `source[key] !== undefined` never binds the value.
    expect(source).toMatch(/source\[key\] !== undefined/);
    expect(source).not.toMatch(/postgresUrl|databaseUrl|connectionString/);
  });
});
