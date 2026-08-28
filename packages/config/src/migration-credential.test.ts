import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnvValidationError } from './env';
import { loadApiEnv } from './api-env';
import { loadWorkerEnv } from './worker-env';
import { loadMigrationEnv } from './migration-env';

/**
 * The migration credential is not runtime configuration.
 *
 * `MIGRATION_DATABASE_URL` names a principal that can apply DDL. Neither
 * long-lived runtime holds it, and neither may *receive* it: the shared schema
 * declared it, so both runtimes parsed it and returned it, while `.env.example`
 * said both would reject it. A process that accepts a credential it must never
 * hold has the credential, whatever it does with it afterwards.
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

const MIGRATION_SECRET = 'migration-only-password';
const MIGRATION_URL = `postgresql://prsystem_migrate_login:${MIGRATION_SECRET}@localhost:5432/prsystem`;

describe('runtime configuration refuses the migration credential', () => {
  for (const [name, load] of [
    ['API', loadApiEnv],
    ['worker', loadWorkerEnv],
  ] as const) {
    it(`${name}: refuses a supplied MIGRATION_DATABASE_URL`, () => {
      expect(() => load({ ...base, MIGRATION_DATABASE_URL: MIGRATION_URL })).toThrow(
        EnvValidationError,
      );
    });

    it(`${name}: refuses an empty MIGRATION_DATABASE_URL`, () => {
      // Presence, not truthiness. An empty assignment is still an operator
      // handing this process a variable it must not be given, and the mistake
      // that put it there is the one worth reporting.
      expect(() => load({ ...base, MIGRATION_DATABASE_URL: '' })).toThrow(EnvValidationError);
    });

    it(`${name}: never returns or exposes the credential`, () => {
      const config = load({ ...base }) as Record<string, unknown>;
      expect(Object.keys(config)).not.toContain('MIGRATION_DATABASE_URL');
      expect(JSON.stringify(config)).not.toContain(MIGRATION_SECRET);
    });

    it(`${name}: never places the credential value in the refusal`, () => {
      try {
        load({ ...base, MIGRATION_DATABASE_URL: MIGRATION_URL });
        expect.unreachable('expected the loader to throw');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('MIGRATION_DATABASE_URL');
        expect(message).not.toContain(MIGRATION_SECRET);
        expect(message).not.toContain(MIGRATION_URL);
      }
    });
  }
});

describe('the migration-only contract', () => {
  it('loads the credential and the ownership contract together', () => {
    const config = loadMigrationEnv({
      MIGRATION_DATABASE_URL: MIGRATION_URL,
      PRSYSTEM_APPROVED_OPERATOR_OWNERS: 'prsystem_operator',
    });
    expect(config.migrationDatabaseUrl).toBe(MIGRATION_URL);
    expect(config.approvedOperatorOwners).toEqual(['prsystem_operator']);
  });

  it('refuses a missing credential', () => {
    expect(() =>
      loadMigrationEnv({ PRSYSTEM_APPROVED_OPERATOR_OWNERS: 'prsystem_operator' }),
    ).toThrow(EnvValidationError);
  });

  it('refuses a missing ownership contract', () => {
    expect(() => loadMigrationEnv({ MIGRATION_DATABASE_URL: MIGRATION_URL })).toThrow(
      EnvValidationError,
    );
  });

  it('never falls back to DATABASE_URL', () => {
    // Comments are stripped first: the file says in prose that there is no
    // fallback, and matching that sentence would make the check pass on the
    // documentation rather than on the code.
    const code = readFileSync(resolve(__dirname, 'migration-env.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/(?<!MIGRATION_)DATABASE_URL/);
  });

  it('never places the credential value in a refusal message', () => {
    try {
      loadMigrationEnv({
        MIGRATION_DATABASE_URL: `mysql://u:${MIGRATION_SECRET}@localhost/db`,
        PRSYSTEM_APPROVED_OPERATOR_OWNERS: 'prsystem_operator',
      });
      expect.unreachable('expected loadMigrationEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(MIGRATION_SECRET);
    }
  });
});

describe('the migration credential is confined to the migration contract', () => {
  it('is declared in migration-env.ts and nowhere else in the package', () => {
    const declaring = readdirSync(__dirname)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) =>
        /MIGRATION_DATABASE_URL/.test(readFileSync(resolve(__dirname, file), 'utf8')),
      );
    // env.ts and worker-env.ts name it only through the shared rejection helper,
    // which lives in one place.
    expect(declaring.sort()).toEqual(['env.ts', 'migration-env.ts']);
  });
});
