import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resetEnvCache } from '@prsystem/config';

/**
 * The API refuses the migration credential at startup.
 *
 * `MIGRATION_DATABASE_URL` names a principal that can apply DDL. The shared
 * configuration schema used to declare it, so the API parsed it and returned it
 * on every start — while `.env.example` said the API rejected it. This holds the
 * refusal to the startup path the process actually runs.
 */

const MIGRATION_SECRET = 'migration-only-password-api';
const MIGRATION_URL = `postgresql://prsystem_migrate_login:${MIGRATION_SECRET}@127.0.0.1:55442/prsystem`;

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-migration-credential-seed',
    DATABASE_URL: 'postgresql://prsystem_api_login:pw@127.0.0.1:55442/prsystem',
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
  delete process.env['MIGRATION_DATABASE_URL'];
  delete process.env['SCHEDULER_DATABASE_URL'];
  delete process.env['SCHEDULER_ENABLED'];
  Object.assign(process.env, baseEnv(), overrides);
  resetEnvCache();
}

afterEach(() => {
  delete process.env['MIGRATION_DATABASE_URL'];
  resetEnvCache();
});

/** Starts the API and returns the error it refused with, or `undefined`. */
async function startupError(): Promise<Error | undefined> {
  const { createApp } = await import('../bootstrap');
  let started: { app: { close(): Promise<void> } } | undefined;
  try {
    started = await createApp({ port: 0, serveDocs: false });
  } catch (error) {
    return error as Error;
  } finally {
    await started?.app.close().catch(() => undefined);
  }
  return undefined;
}

describe('the API refuses the migration credential', () => {
  it('refuses to start when MIGRATION_DATABASE_URL is supplied', async () => {
    applyEnv({ MIGRATION_DATABASE_URL: MIGRATION_URL });
    const error = await startupError();
    expect(error?.name).toBe('EnvValidationError');
  }, 60000);

  it('refuses to start when MIGRATION_DATABASE_URL is empty', async () => {
    // Presence, not truthiness. An empty assignment is still an operator
    // handing the API a variable it must never be given.
    applyEnv({ MIGRATION_DATABASE_URL: '' });
    const error = await startupError();
    expect(error?.name).toBe('EnvValidationError');
  }, 60000);

  it('never puts the credential in the refusal', async () => {
    applyEnv({ MIGRATION_DATABASE_URL: MIGRATION_URL });
    const error = await startupError();
    expect(error?.message).toContain('MIGRATION_DATABASE_URL');
    expect(error?.message).not.toContain(MIGRATION_SECRET);
    expect(error?.message).not.toContain(MIGRATION_URL);
    expect(String(error?.stack ?? '')).not.toContain(MIGRATION_SECRET);
  }, 60000);
});

/**
 * Every shipped `.ts` file under `dir`, recursively.
 *
 * Test files are excluded: they are not part of either deployment, and the two
 * that name the variable do so in order to prove it is refused.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the migration contract is unreachable from the runtimes', () => {
  const roots = [resolve(__dirname, '..'), resolve(__dirname, '..', '..', '..', 'worker', 'src')];

  it('no runtime source reads MIGRATION_DATABASE_URL', () => {
    const offenders = roots
      .flatMap(sourceFiles)
      .filter((path) => /MIGRATION_DATABASE_URL/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no runtime source imports the migration-only loader', () => {
    const offenders = roots
      .flatMap(sourceFiles)
      .filter((path) => /loadMigrationEnv|migration-env/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
