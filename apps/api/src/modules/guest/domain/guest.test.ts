import { describe, expect, it } from 'vitest';
import {
  SIGN_IN_REFUSAL,
  isVerificationPurpose,
  linkDecision,
  mayResend,
  normalisePhone,
  settledState,
  verificationOutcome,
} from './guest';

/**
 * The Guest realm's decisions, tested without a database (doc 09 §6).
 */

const at = (iso: string): Date => new Date(iso);

describe('normalisePhone', () => {
  it('accepts the three shapes a person actually types, and refuses the rest', () => {
    expect(normalisePhone('99112233')).toBe('+97699112233');
    expect(normalisePhone('976 99112233')).toBe('+97699112233');
    expect(normalisePhone('+976-9911-2233')).toBe('+97699112233');
    // The same number typed three ways is one number, which is what makes
    // "one verified number, one primary account" true (doc 09 §6.3).
    expect(new Set(['99112233', '976 99112233', '+976 9911 2233'].map(normalisePhone)).size).toBe(
      1,
    );

    expect(normalisePhone('9911223')).toBeUndefined();
    expect(normalisePhone('991122334')).toBeUndefined();
    expect(normalisePhone('+7 999 1122333')).toBeUndefined();
    expect(normalisePhone('')).toBeUndefined();
    // A landline cannot receive the code, so an account made from one could
    // never be signed in to.
    expect(normalisePhone('11223344')).toBeUndefined();
  });
});

describe('verificationOutcome', () => {
  const row = {
    verificationId: 'v-1',
    purpose: 'REGISTER' as const,
    state: 'PENDING' as const,
    attempts: 0,
    maxAttempts: 3,
    expiresAt: at('2026-09-05T10:10:00.000Z'),
  };
  const now = at('2026-09-05T10:00:00.000Z');

  it('accepts a correct code inside the window', () => {
    expect(verificationOutcome(row, true, now)).toEqual({ kind: 'accepted' });
    expect(settledState({ kind: 'accepted' })).toBe('CONSUMED');
  });

  it('counts a wrong code, and locks on the last one', () => {
    expect(verificationOutcome({ ...row, attempts: 0 }, false, now)).toEqual({
      kind: 'wrong',
      attempts: 1,
      exhausted: false,
    });
    const last = verificationOutcome({ ...row, attempts: 2 }, false, now);
    expect(last).toEqual({ kind: 'wrong', attempts: 3, exhausted: true });
    expect(settledState(last)).toBe('LOCKED');
  });

  it('settles an expired challenge rather than letting it be retried', () => {
    // The expiry is terminal, not a refusal to try again: otherwise an attacker
    // could spend unlimited guesses by racing the clock.
    const outcome = verificationOutcome(row, true, at('2026-09-05T10:10:00.000Z'));
    expect(outcome).toEqual({ kind: 'expired' });
    expect(settledState(outcome)).toBe('EXPIRED');
  });

  it('refuses a challenge that is already settled, or already out of attempts', () => {
    expect(verificationOutcome({ ...row, state: 'CONSUMED' }, true, now)).toEqual({
      kind: 'locked',
    });
    expect(verificationOutcome({ ...row, attempts: 3 }, true, now)).toEqual({ kind: 'locked' });
    expect(settledState({ kind: 'locked' })).toBeUndefined();
  });
});

describe('mayResend', () => {
  it('allows the first message and holds the interval afterwards', () => {
    const now = at('2026-09-05T10:00:00.000Z');
    expect(mayResend(undefined, now, 60)).toBe(true);
    expect(mayResend(at('2026-09-05T09:59:30.000Z'), now, 60)).toBe(false);
    expect(mayResend(at('2026-09-05T09:59:00.000Z'), now, 60)).toBe(true);
  });
});

describe('linkDecision', () => {
  const base = {
    state: 'PENDING' as const,
    providerChannelVerifiedAt: null,
    phoneChannelVerifiedAt: null,
    expiresAt: at('2026-09-05T10:15:00.000Z'),
  };
  const now = at('2026-09-05T10:00:00.000Z');

  it('requires both channels before a link exists (doc 09 §6.3)', () => {
    expect(linkDecision(base, now)).toEqual({ kind: 'await', missing: 'provider' });
    expect(linkDecision({ ...base, providerChannelVerifiedAt: now }, now)).toEqual({
      kind: 'await',
      missing: 'phone',
    });
    expect(
      linkDecision({ ...base, providerChannelVerifiedAt: now, phoneChannelVerifiedAt: now }, now),
    ).toEqual({ kind: 'confirm' });
  });

  it('closes an expired or already decided request', () => {
    expect(linkDecision(base, at('2026-09-05T10:15:00.000Z'))).toEqual({ kind: 'expired' });
    expect(linkDecision({ ...base, state: 'CONFIRMED' }, now)).toEqual({ kind: 'settled' });
    expect(linkDecision({ ...base, state: 'REJECTED' }, now)).toEqual({ kind: 'settled' });
  });
});

describe('purposes and the sign-in refusal', () => {
  it('knows the four purposes and nothing else', () => {
    expect(isVerificationPurpose('REGISTER')).toBe(true);
    expect(isVerificationPurpose('ACCOUNT_LINK')).toBe(true);
    expect(isVerificationPurpose('ANYTHING')).toBe(false);
  });

  it('says nothing about whether a number is registered', () => {
    expect(SIGN_IN_REFUSAL).not.toMatch(/registered|unknown|no account|exists/i);
  });
});
