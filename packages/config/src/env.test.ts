import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env';

const valid: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://prsystem_api:pw@localhost:5432/prsystem',
  REDIS_URL: 'redis://localhost:6379',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'prsystem-local',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'local-access-key',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};

describe('loadEnv', () => {
  it('accepts a complete environment and applies documented defaults', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ENV).toBe('local');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.API_PORT).toBe(3000);
    expect(env.OBJECT_STORAGE_REGION).toBe('us-east-1');
  });

  it('coerces numeric ports from strings', () => {
    const env = loadEnv({ ...valid, API_PORT: '8081' });
    expect(env.API_PORT).toBe(8081);
    expect(typeof env.API_PORT).toBe('number');
  });

  it('fails closed when a required value is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = valid;
    expect(() => loadEnv(withoutDb)).toThrow(EnvValidationError);
  });

  it('rejects a database URL with the wrong scheme', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a redis URL with the wrong scheme', () => {
    expect(() => loadEnv({ ...valid, REDIS_URL: 'http://localhost:6379' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ ...valid, API_PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(EnvValidationError);
  });

  it('never places a secret value in the error message', () => {
    const secret = 'super-secret-value-should-not-appear';
    try {
      loadEnv({ ...valid, OBJECT_STORAGE_SECRET_ACCESS_KEY: '', SMTP_HOST: '' });
      expect.unreachable('expected loadEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('OBJECT_STORAGE_SECRET_ACCESS_KEY');
      expect(message).not.toContain(secret);
      expect(message).not.toContain(valid.OBJECT_STORAGE_SECRET_ACCESS_KEY!);
      expect(message).not.toContain('pw@localhost');
    }
  });

  it('reports every invalid field, not just the first', () => {
    try {
      loadEnv({});
      expect.unreachable('expected loadEnv to throw');
    } catch (error) {
      expect((error as EnvValidationError).issues.length).toBeGreaterThan(4);
    }
  });
});
