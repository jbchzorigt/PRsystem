import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { assertRuntimePrincipal } from '@prsystem/db';
import { KeyManagementError, selectKeyManagement } from '@prsystem/ports';
import { createLogger } from '@prsystem/telemetry';
import { assertApiConnectionPrincipal } from '../observability/connection-guard';

/**
 * Startup security preconditions.
 *
 * The point of these is *ordering*: a refusal must happen before a port is bound
 * and before any queue exists, so a process that fails them never becomes
 * reachable. Each test therefore also proves nothing is listening afterwards.
 */

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';

const logger = createLogger({ level: 'error', serviceName: 'startup-guard-test' });

/** True when something is accepting connections on `port`. */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

let admin: Pool;

beforeAll(() => {
  admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
});

afterAll(async () => {
  await admin.end();
});

describe('database principal', () => {
  it('rejects a superuser credential for the API', async () => {
    await expect(assertApiConnectionPrincipal(admin, logger)).rejects.toMatchObject({
      name: 'PrincipalError',
      reason: 'superuser',
    });
  });

  it('rejects a superuser credential for the worker group too', async () => {
    await expect(assertRuntimePrincipal(admin, 'prsystem_worker')).rejects.toMatchObject({
      reason: 'superuser',
    });
  });

  it('refuses before anything binds a port', async () => {
    const port = 53999;
    expect(await isListening(port)).toBe(false);
    await expect(assertApiConnectionPrincipal(admin, logger)).rejects.toThrow();
    // Still nothing listening: the guard runs before the adapter is created.
    expect(await isListening(port)).toBe(false);
  });
});

describe('key management', () => {
  it('refuses to start when no adapter is configured', () => {
    expect(() => selectKeyManagement({ appEnv: 'local', kmsAdapter: 'none' })).toThrow(
      KeyManagementError,
    );
  });

  it('names the internal control, not an EXT gate', () => {
    try {
      selectKeyManagement({ appEnv: 'local', kmsAdapter: 'none' });
      expect.unreachable('an unconfigured adapter must refuse');
    } catch (error) {
      expect((error as Error).message).toMatch(/INT-KMS-01/);
      expect((error as Error).message).not.toMatch(/EXT-10/);
    }
  });

  it('refuses the local simulator in production and staging', () => {
    for (const appEnv of ['production', 'staging']) {
      expect(() =>
        selectKeyManagement({ appEnv, kmsAdapter: 'local', seed: 'synthetic-seed' }),
      ).toThrow(/not permitted/i);
    }
  });

  it('refuses a named adapter that does not exist', () => {
    expect(() => selectKeyManagement({ appEnv: 'production', kmsAdapter: 'awskms' })).toThrow(
      /not implemented|INT-KMS-01/,
    );
  });

  it('refuses the simulator without an explicit seed', () => {
    expect(() => selectKeyManagement({ appEnv: 'local', kmsAdapter: 'local' })).toThrow(/seed/i);
  });
});

describe('unavailable key management', () => {
  it('reports INT-KMS-01 rather than the stale EXT-10 reference', async () => {
    const { UnavailableKeyManagement } = await import('@prsystem/ports');
    try {
      await new UnavailableKeyManagement().currentVersion('pii.hotel_guest');
      expect.unreachable('an unavailable adapter must reject');
    } catch (error) {
      expect((error as Error).message).toMatch(/INT-KMS-01/);
      expect((error as Error).message).not.toMatch(/EXT-10/);
    }
  });
});
