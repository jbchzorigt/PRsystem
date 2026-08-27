import { describe, expect, it } from 'vitest';
import {
  KeyManagementError,
  LocalKeyManagement,
  UnavailableKeyManagement,
  decryptValue,
  deriveLookupToken,
  encryptValue,
  rewrapValue,
} from './index';
import type { EnvelopeAad } from './index';

/**
 * GATE-UNIT and the kernel GATE-SEC checks for ADR-0020.
 *
 * Synthetic data only. The seed below is a test fixture, not a credential, and
 * the identifiers use the reserved `99` synthetic range (CLAUDE.md §8).
 */

const SEED = 'synthetic-local-development-seed';
const SYNTHETIC_REGISTRATION = '9901154321';

function kms(currentVersions?: Record<string, string>): LocalKeyManagement {
  return new LocalKeyManagement({
    seed: SEED,
    appEnv: 'test',
    ...(currentVersions ? { currentVersions } : {}),
  });
}

const AAD: EnvelopeAad = {
  table: 'guest_identity',
  column: 'registration_number',
  rowRef: 'row-1',
};

describe('production fail-closed (ADR-0020 §7, §8)', () => {
  it('refuses to construct the simulator outside local, ci or test', () => {
    for (const appEnv of ['production', 'staging']) {
      expect(() => new LocalKeyManagement({ seed: SEED, appEnv })).toThrow(KeyManagementError);
    }
  });

  it('reports why, without naming a key', () => {
    try {
      new LocalKeyManagement({ seed: SEED, appEnv: 'production' });
      expect.unreachable('constructing the simulator in production must throw');
    } catch (error) {
      const failure = error as KeyManagementError;
      expect(failure.reason).toBe('not_permitted_in_production');
      expect(failure.message).not.toContain(SEED);
    }
  });

  it('fails every operation when no adapter is configured', async () => {
    const unavailable = new UnavailableKeyManagement();
    await expect(unavailable.currentVersion('pii.hotel_guest')).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(
      encryptValue(unavailable, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('envelope encryption (ADR-0020 §2–§3)', () => {
  it('round-trips a value and stores its key version', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    expect(stored.keyVersion).toBe('v1');
    expect(await decryptValue(port, 'pii.hotel_guest', stored, AAD)).toBe(SYNTHETIC_REGISTRATION);
  });

  it('never stores the plaintext in the ciphertext', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    expect(Buffer.from(stored.ciphertext).toString('utf8')).not.toContain(SYNTHETIC_REGISTRATION);
    expect(Buffer.from(stored.ciphertext).toString('hex')).not.toContain(
      Buffer.from(SYNTHETIC_REGISTRATION).toString('hex'),
    );
  });

  it('produces a different ciphertext each time', async () => {
    const port = kms();
    const first = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);
    const second = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it('detects a tampered ciphertext instead of returning plaintext', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);
    const tampered = Uint8Array.from(stored.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    await expect(
      decryptValue(port, 'pii.hotel_guest', { ...stored, ciphertext: tampered }, AAD),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });
  });

  it('detects a tampered wrapped key', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);
    const tampered = Uint8Array.from(stored.wrappedDek);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    await expect(
      decryptValue(port, 'pii.hotel_guest', { ...stored, wrappedDek: tampered }, AAD),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });
  });

  it('binds a ciphertext to its row through the AAD', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    // Moving the blob to another row, column or table must not decrypt.
    for (const moved of [
      { ...AAD, rowRef: 'row-2' },
      { ...AAD, column: 'passport_number' },
      { ...AAD, table: 'wanted_identity_revision' },
    ]) {
      await expect(decryptValue(port, 'pii.hotel_guest', stored, moved)).rejects.toMatchObject({
        reason: 'integrity_failure',
      });
    }
  });

  it('refuses to unwrap a Hotel-scope blob under the Police scope', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    await expect(decryptValue(port, 'pii.police', stored, AAD)).rejects.toMatchObject({
      reason: 'integrity_failure',
    });
  });
});

describe('key versioning and rotation (ADR-0020 §3–§4)', () => {
  it('keeps data written under version N readable after N+1 becomes current', async () => {
    const v1 = kms();
    const stored = await encryptValue(v1, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    const v2 = kms({ 'pii.hotel_guest': 'v2' });
    expect(await v2.currentVersion('pii.hotel_guest')).toBe('v2');
    // The stored key version, not the current one, is what decrypts it.
    expect(await decryptValue(v2, 'pii.hotel_guest', stored, AAD)).toBe(SYNTHETIC_REGISTRATION);
  });

  it('rewraps to the current version without changing the plaintext', async () => {
    const v1 = kms();
    const stored = await encryptValue(v1, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    const v2 = kms({ 'pii.hotel_guest': 'v2' });
    const rewrapped = await rewrapValue(v2, 'pii.hotel_guest', stored, AAD);

    expect(rewrapped?.keyVersion).toBe('v2');
    expect(await decryptValue(v2, 'pii.hotel_guest', rewrapped!, AAD)).toBe(SYNTHETIC_REGISTRATION);
  });

  it('is a resumable no-op for a value already on the current version', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    expect(await rewrapValue(port, 'pii.hotel_guest', stored, AAD)).toBeNull();
  });

  it('rejects an unknown key version rather than guessing', async () => {
    const port = kms();
    const stored = await encryptValue(port, 'pii.hotel_guest', SYNTHETIC_REGISTRATION, AAD);

    await expect(
      decryptValue(port, 'pii.hotel_guest', { ...stored, keyVersion: 'v99' }, AAD),
    ).rejects.toMatchObject({ reason: 'integrity_failure' });
  });
});

describe('keyed lookup tokens (ADR-0020 §6)', () => {
  const registration = { identityType: 'registration_number', countryCode: 'MN' } as const;

  it('is stable for the same input, namespace and key version', async () => {
    const port = kms();
    const first = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );
    const second = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );

    expect(first.token).toBe(second.token);
    expect(first.keyVersion).toBe('v1');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across identity type for the same digits', async () => {
    const port = kms();
    const asRegistration = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );
    const asPassport = await deriveLookupToken(
      port,
      'lookup.identity',
      { identityType: 'passport', countryCode: 'MN' },
      SYNTHETIC_REGISTRATION,
    );

    expect(asRegistration.token).not.toBe(asPassport.token);
  });

  it('differs across country for the same digits', async () => {
    const port = kms();
    const mn = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );
    const kz = await deriveLookupToken(
      port,
      'lookup.identity',
      { identityType: 'registration_number', countryCode: 'KZ' },
      SYNTHETIC_REGISTRATION,
    );

    expect(mn.token).not.toBe(kz.token);
  });

  it('cannot be confused by a namespace boundary shift', async () => {
    const port = kms();
    // ('MN', 'G12') and ('MNG', '12') must not collide — the encoding is length-prefixed.
    const a = await deriveLookupToken(port, 'lookup.identity', registration, 'G12');
    const b = await deriveLookupToken(
      port,
      'lookup.identity',
      { identityType: 'registration_number', countryCode: 'MNG' },
      '12',
    );

    expect(a.token).not.toBe(b.token);
  });

  it('keeps the Police lookup scope separate from the Hotel one', async () => {
    const port = kms();
    const hotel = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );
    const police = await deriveLookupToken(
      port,
      'lookup.police_identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );

    expect(hotel.token).not.toBe(police.token);
  });

  it('does not reveal the identifier in the token', async () => {
    const port = kms();
    const { token } = await deriveLookupToken(
      port,
      'lookup.identity',
      registration,
      SYNTHETIC_REGISTRATION,
    );

    expect(token).not.toContain(SYNTHETIC_REGISTRATION);
    expect(Buffer.from(token, 'hex').toString('utf8')).not.toContain(SYNTHETIC_REGISTRATION);
  });
});
