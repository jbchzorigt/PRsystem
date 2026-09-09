import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET, Secret } from '@prsystem/ports';
import { EnvValidationError, loadEnv } from './env';
import { loadApiEnv } from './api-env';

/**
 * The Phase 20 adapter configuration: what a deployment may name, what it
 * must then supply, and what it may never hold.
 */

const base: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://prsystem_api:pw@localhost:5432/prsystem',
  REDIS_URL: 'redis://localhost:6379',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};
const STORAGE_SECRET = 'adapters-env-canary-secret';
const s3: NodeJS.ProcessEnv = {
  ADAPTER_STORAGE: 's3',
  OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:59000',
  OBJECT_STORAGE_BUCKET: 'prsystem-local',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'prsystem_local',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: STORAGE_SECRET,
};
const production: NodeJS.ProcessEnv = {
  ...base,
  APP_ENV: 'production',
  NODE_ENV: 'production',
  KMS_ADAPTER: 'awskms',
};

function refusal(source: NodeJS.ProcessEnv): EnvValidationError {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected loadEnv to refuse');
}

describe('adapter slots', () => {
  it('default to simulators below production and to disabled at it', () => {
    expect(new Set(Object.values(loadEnv(base).adapters.slots))).toEqual(new Set(['simulator']));
    expect(new Set(Object.values(loadEnv({ ...base, APP_ENV: 'ci' }).adapters.slots))).toEqual(
      new Set(['simulator']),
    );
    expect(new Set(Object.values(loadEnv(production).adapters.slots))).toEqual(
      new Set(['disabled']),
    );
    expect(loadEnv(production).adapters.storage).toBeUndefined();
  });

  it('refuse a simulator in production, naming the variable and the gate', () => {
    const error = refusal({ ...production, ADAPTER_SMS: 'simulator' });
    expect(error.issues.join('\n')).toMatch(/ADAPTER_SMS: sms: the simulator is not permitted/);
  });

  it('refuse a production adapter whose gate is not cleared, naming the gate', () => {
    const error = refusal({ ...production, ...s3 });
    const text = error.issues.join('\n');
    expect(text).toMatch(/ADAPTER_STORAGE: storage: .*cannot be enabled while INT-STORAGE-01/);
    expect(text).not.toContain(STORAGE_SECRET);
  });

  it('refuse an adapter nobody has written', () => {
    const error = refusal({ ...base, ADAPTER_SMS: 'callpro' });
    expect(error.issues.join('\n')).toMatch(
      /ADAPTER_SMS: sms: no production adapter named "callpro"/,
    );
    expect(refusal({ ...base, ADAPTER_SMS: 'Not Valid' }).issues.join('\n')).toMatch(/ADAPTER_SMS/);
  });
});

describe('the storage credential', () => {
  it('is required when the s3 adapter is named, and every issue is reported together', () => {
    const error = refusal({ ...base, ADAPTER_STORAGE: 's3' });
    const text = error.issues.join('\n');
    for (const key of [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ]) {
      expect(text).toContain(`${key} is required when ADAPTER_STORAGE=s3`);
    }
  });

  it('is refused when the storage adapter cannot use it, without echoing it', () => {
    const error = refusal({ ...base, OBJECT_STORAGE_SECRET_ACCESS_KEY: STORAGE_SECRET });
    const text = error.issues.join('\n');
    expect(text).toContain(
      'OBJECT_STORAGE_SECRET_ACCESS_KEY is set while ADAPTER_STORAGE is simulator',
    );
    expect(text).not.toContain(STORAGE_SECRET);
    expect(
      refusal({ ...production, OBJECT_STORAGE_SECRET_ACCESS_KEY: STORAGE_SECRET }).message,
    ).toContain('ADAPTER_STORAGE is disabled');
  });

  it('becomes a Secret on the selection and is not returned as a string', () => {
    const env = loadEnv({ ...base, ...s3 });
    expect(env.adapters.slots.storage).toBe('s3');
    expect(env.adapters.storage?.secretAccessKey).toBeInstanceOf(Secret);
    expect(env.adapters.storage?.secretAccessKey.expose()).toBe(STORAGE_SECRET);
    expect(env.adapters.storage?.bucket).toBe('prsystem-local');
    expect(env.adapters.storage?.region).toBe('us-east-1');
    expect(
      (env as unknown as Record<string, unknown>)['OBJECT_STORAGE_SECRET_ACCESS_KEY'],
    ).toBeUndefined();
    expect((env as unknown as Record<string, unknown>)['ADAPTER_STORAGE']).toBeUndefined();
    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain(STORAGE_SECRET);
    expect(serialised).toContain(REDACTED_SECRET);
  });

  it('refuses an endpoint that is not a bare origin, naming the rule and not the value', () => {
    const error = refusal({
      ...base,
      ...s3,
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:59000/bucket',
    });
    expect(error.issues.join('\n')).toMatch(/OBJECT_STORAGE_ENDPOINT: .*bare origin/);
  });
});

describe('the API callback allowlists', () => {
  const api: NodeJS.ProcessEnv = { ...base, APP_ENV: 'ci', SCHEDULER_ENABLED: 'false' };

  it('parse into CIDR lists per provider, and are absent when unset', () => {
    expect(loadApiEnv(api).callbackAllowlists).toEqual({});
    const env = loadApiEnv({ ...api, CALLBACK_ALLOWLIST_QPAY: '203.0.113.0/24, 2001:db8::/32' });
    expect(env.callbackAllowlists.QPAY).toHaveLength(2);
    expect(env.callbackAllowlists.KHAAN).toBeUndefined();
    expect((env as unknown as Record<string, unknown>)['CALLBACK_ALLOWLIST_QPAY']).toBeUndefined();
  });

  it('refuse a list that is not a list of ranges', () => {
    expect(() =>
      loadApiEnv({ ...api, CALLBACK_ALLOWLIST_KHAAN: '203.0.113.0/24, nowhere' }),
    ).toThrow(/CALLBACK_ALLOWLIST_KHAAN must be a comma-separated list/);
  });

  it('apply the adapter rules to the API environment as well', () => {
    expect(() =>
      loadApiEnv({ ...production, SCHEDULER_ENABLED: 'false', ADAPTER_GEO: 'simulator' }),
    ).toThrow(/ADAPTER_GEO: geo: the simulator is not permitted/);
    expect(loadApiEnv({ ...api, ...s3 }).adapters.storage?.secretAccessKey).toBeInstanceOf(Secret);
  });
});
