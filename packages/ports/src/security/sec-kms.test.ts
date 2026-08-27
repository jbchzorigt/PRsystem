import { describe, expect, it } from 'vitest';
import {
  HMAC_SCOPES,
  KEY_SCOPES,
  KeyManagementError,
  LocalKeyManagement,
  UnavailableKeyManagement,
  decryptValue,
  deriveLookupToken,
  encryptValue,
  selectKeyManagement,
} from '../index';
import type { EnvelopeAad } from '../index';

/**
 * SEC-KMS — key management fails closed, and the two realms never share key
 * material (ADR-0020). Synthetic fixtures only.
 */

const SEED = 'synthetic-local-development-seed';
const SYNTHETIC_REGISTRATION = '9902284455';
const AAD: EnvelopeAad = { table: 'guest_identity', column: 'registration_number', rowRef: 'r1' };

describe('production startup fails closed', () => {
  for (const appEnv of ['production', 'staging']) {
    it(`refuses the local simulator in ${appEnv}`, () => {
      expect(() => new LocalKeyManagement({ seed: SEED, appEnv })).toThrow(KeyManagementError);
    });

    it(`refuses to select the simulator in ${appEnv}`, () => {
      expect(() => selectKeyManagement({ appEnv, kmsAdapter: 'local', seed: SEED })).toThrow(
        /not permitted/i,
      );
    });

    it(`fails startup in ${appEnv} when no KMS is configured`, () => {
      expect(() => selectKeyManagement({ appEnv, kmsAdapter: 'none' })).toThrow(
        /INT-KMS-01|no approved key management/i,
      );
    });

    it(`fails startup in ${appEnv} when the KMS configuration is invalid`, () => {
      expect(() => selectKeyManagement({ appEnv, kmsAdapter: 'awskms' })).toThrow(
        /not implemented|INT-KMS-01/i,
      );
    });
  }

  it('selects the simulator in local and ci', () => {
    for (const appEnv of ['local', 'ci', 'test']) {
      expect(selectKeyManagement({ appEnv, kmsAdapter: 'local', seed: SEED })).toBeInstanceOf(
        LocalKeyManagement,
      );
    }
  });

  it('requires a seed even locally rather than inventing one', () => {
    expect(() => selectKeyManagement({ appEnv: 'local', kmsAdapter: 'local' })).toThrow(/seed/i);
  });

  it('rejects every operation when no adapter is available', async () => {
    const port = new UnavailableKeyManagement();
    await expect(port.currentVersion('pii.hotel_guest')).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
});

describe('encryption and lookup keys are separate', () => {
  it('derives a different key for each scope', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });

    const macs = await Promise.all(
      HMAC_SCOPES.map((scope) => port.hmac(scope, Buffer.from('same-input'))),
    );
    expect(Buffer.from(macs[0]!.mac).toString('hex')).not.toBe(
      Buffer.from(macs[1]!.mac).toString('hex'),
    );

    // A wrap under one key scope must not unwrap under the other.
    const wrapped = await port.wrap(KEY_SCOPES[0]!, new Uint8Array(32).fill(7));
    await expect(
      port.unwrap(KEY_SCOPES[1]!, wrapped.wrapped, wrapped.keyVersion),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });
  });

  it('never lets an encryption key double as a lookup key', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });
    const wrapped = await port.wrap('pii.hotel_guest', new Uint8Array(32).fill(1));
    const mac = await port.hmac('lookup.identity', new Uint8Array(32).fill(1));

    expect(Buffer.from(wrapped.wrapped).toString('hex')).not.toContain(
      Buffer.from(mac.mac).toString('hex'),
    );
  });
});

describe('ciphertext structure', () => {
  it('carries a nonce, an authentication tag and a key version', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    // 12-byte GCM nonce + 16-byte tag + body.
    expect(stored.ciphertext.length).toBeGreaterThan(12 + 16);
    expect(stored.keyVersion).toMatch(/^v\d+$/);

    const nonce = Buffer.from(stored.ciphertext.subarray(0, 12));
    const second = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);
    // A repeated nonce under the same key would break GCM outright.
    expect(nonce.equals(Buffer.from(second.ciphertext.subarray(0, 12)))).toBe(false);
  });

  it('fails on a tampered tag and on the wrong AAD', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    const tamperedTag = Uint8Array.from(stored.ciphertext);
    tamperedTag[13] = (tamperedTag[13] ?? 0) ^ 0xff;
    await expect(
      decryptValue(port, 'pii.hotel_guest', { ...stored, ciphertext: tamperedTag }, AAD),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });

    await expect(
      decryptValue(port, 'pii.hotel_guest', stored, { ...AAD, rowRef: 'r2' }),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });
  });
});

describe('no plaintext canary escapes', () => {
  it('appears in neither the ciphertext, the wrapped key, nor an error', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    const surfaces = [
      Buffer.from(stored.ciphertext).toString('utf8'),
      Buffer.from(stored.ciphertext).toString('hex'),
      Buffer.from(stored.wrappedDek).toString('utf8'),
      JSON.stringify({ keyVersion: stored.keyVersion }),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SYNTHETIC_REGISTRATION);
      expect(surface).not.toContain(SEED);
    }

    try {
      await decryptValue(port, 'pii.police', stored, AAD);
      expect.unreachable('cross-scope decryption must fail');
    } catch (error) {
      const failure = error as KeyManagementError;
      expect(failure.message).not.toContain(SEED);
      expect(failure.message).not.toContain(SYNTHETIC_REGISTRATION);
      expect(JSON.stringify(failure)).not.toContain(SEED);
    }
  });

  it('keeps the lookup token free of the identifier', async () => {
    const port = new LocalKeyManagement({ seed: SEED, appEnv: 'test' });
    const { token } = await deriveLookupToken(
      port,
      'lookup.identity',
      { identityType: 'registration_number', countryCode: 'MN' },
      SYNTHETIC_REGISTRATION,
    );
    expect(token).not.toContain(SYNTHETIC_REGISTRATION);
    expect(Buffer.from(token, 'hex').toString('latin1')).not.toContain(SYNTHETIC_REGISTRATION);
  });
});
