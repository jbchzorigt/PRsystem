import { describe, expect, it } from 'vitest';
import { LocalKeyManagement } from '@prsystem/ports';
import {
  AUTH_PARAMETER_HISTORY,
  AUTH_SECURITY_PARAMETERS,
  parametersAreProvisional,
} from '../contracts/security-parameters';
import {
  PasswordPolicyError,
  assertPasswordAcceptable,
  derivePassword,
  parameterVersionIsKnown,
  verifyPassword,
} from './password.service';
import { TokenService } from './token.service';

/**
 * The two credential primitives, without a database.
 *
 * Both are pure given their inputs, and both are places where a mistake is
 * invisible at runtime: a password that verifies against the wrong parameters,
 * or a token digest that is the same across two purposes, would look like
 * working code.
 */

describe('password derivation (STAFF-DEC-001)', () => {
  it('derives a value the database CHECK constraint accepts, and never the password', async () => {
    const derived = await derivePassword('a-perfectly-fine-password');
    expect(derived.secretHash).toMatch(
      /^scrypt\$v=\d+\$n=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
    expect(derived.secretHash).not.toContain('a-perfectly-fine-password');
    expect(derived.paramsVersion).toBe(AUTH_SECURITY_PARAMETERS.version);
  });

  it('produces a different value every time, so two identical passwords do not match', async () => {
    const a = await derivePassword('the-same-password-twice');
    const b = await derivePassword('the-same-password-twice');
    expect(a.secretHash).not.toBe(b.secretHash);
    await expect(verifyPassword('the-same-password-twice', a.secretHash)).resolves.toBe(true);
    await expect(verifyPassword('the-same-password-twice', b.secretHash)).resolves.toBe(true);
  });

  it('verifies against the parameters the stored value names, not the current ones', async () => {
    // A cheaper historical parameter set. Raising the cost later must not lock
    // anybody out, so verification reads the cost from the stored string.
    const legacy = { ...AUTH_SECURITY_PARAMETERS.password, n: 1024 };
    const derived = await derivePassword('legacy-parameters-password', legacy, 'legacy-2026-01');
    expect(derived.secretHash).toContain('n=1024');
    await expect(verifyPassword('legacy-parameters-password', derived.secretHash)).resolves.toBe(
      true,
    );
  });

  it('rejects a wrong password and a malformed stored value alike', async () => {
    const derived = await derivePassword('the-right-password-here');
    await expect(verifyPassword('the-wrong-password-here', derived.secretHash)).resolves.toBe(
      false,
    );
    await expect(verifyPassword('anything', 'hunter2')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });

  it('enforces both length bounds', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(PasswordPolicyError);
    expect(() =>
      assertPasswordAcceptable('x'.repeat(AUTH_SECURITY_PARAMETERS.passwordMaximumLength + 1)),
    ).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('x'.repeat(20))).not.toThrow();
  });

  it('says plainly that the active parameter set is an unapproved P1 placeholder', () => {
    // doc 19 §14 leaves the numbers open; nothing here claims otherwise.
    expect(parametersAreProvisional()).toBe(true);
    expect(parameterVersionIsKnown(AUTH_SECURITY_PARAMETERS.version)).toBe(true);
    expect(parameterVersionIsKnown('never-issued')).toBe(false);
    expect(Object.keys(AUTH_PARAMETER_HISTORY)).toContain(AUTH_SECURITY_PARAMETERS.version);
  });
});

describe('one-time tokens (ADR-0020 §6)', () => {
  const keys = new LocalKeyManagement({ seed: 'synthetic-token-seed', appEnv: 'test' });
  const tokens = new TokenService(keys);

  it('returns a plaintext token once and a hex digest to store', async () => {
    const issued = await tokens.issue('invitation', 'membership-1');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.keyVersion).toBe('v1');
  });

  it('binds the digest to the purpose, so one token cannot be replayed as another', async () => {
    const issued = await tokens.issue('invitation', 'subject-1');
    const asReset = await tokens.digest('password_reset', 'subject-1', issued.token);
    const asSession = await tokens.digest('session', 'subject-1', issued.token);
    expect(asReset.tokenHash).not.toBe(issued.tokenHash);
    expect(asSession.tokenHash).not.toBe(issued.tokenHash);
  });

  it('binds the digest to the subject, so one token cannot be redeemed elsewhere', async () => {
    const issued = await tokens.issue('invitation', 'membership-a');
    const elsewhere = await tokens.digest('invitation', 'membership-b', issued.token);
    expect(elsewhere.tokenHash).not.toBe(issued.tokenHash);
    await expect(
      tokens.matches('invitation', 'membership-b', issued.token, issued.tokenHash),
    ).resolves.toBe(false);
    await expect(
      tokens.matches('invitation', 'membership-a', issued.token, issued.tokenHash),
    ).resolves.toBe(true);
  });

  it('cannot collide by concatenation across subjects', async () => {
    // Length-prefixed inputs: ('ab', 'c') and ('a', 'bc') must not be the same.
    const first = await tokens.digest('invitation', 'ab', 'c');
    const second = await tokens.digest('invitation', 'a', 'bc');
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('refuses a digest of the wrong length rather than comparing a prefix', async () => {
    const issued = await tokens.issue('session', 'session');
    await expect(tokens.matches('session', 'session', issued.token, 'abcd')).resolves.toBe(false);
    await expect(tokens.matches('session', 'session', issued.token, '')).resolves.toBe(false);
  });
});
