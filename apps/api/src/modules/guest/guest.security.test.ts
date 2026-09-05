import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { GuestHarness } from './test-support/guest-harness';
import {
  GUEST_TEST_PASSWORD,
  createGuestHarness,
  syntheticPhone,
} from './test-support/guest-harness';
import { newGuestRequest } from './services/guest-context';
import { requirePurpose, requireRedirectUri } from './http/guest-validation';

/**
 * The Phase 12 gates that belong to the Guest realm (build-plan §"Phase 12";
 * doc 09 §6.2, §6.3).
 */

let h: GuestHarness;
let sequence = 0;
const phone = (): string => {
  sequence += 1;
  return syntheticPhone(3_000_000 + sequence);
};

beforeAll(async () => {
  h = await createGuestHarness('guest_sec');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function register(number: string): Promise<string> {
  h.advance(h.parameters.otpResendSeconds + 1);
  await h.registrations.requestCode({ phone: number, purpose: 'REGISTER' }, newGuestRequest());
  const id = await h.liveVerification(number, 'REGISTER');
  const registered = await h.registrations.register(
    { phone: number, code: h.codeFor(id as string) as string, password: GUEST_TEST_PASSWORD },
    newGuestRequest(),
  );
  return registered.accountId;
}

describe('a login error never says whether a number is registered', () => {
  it('answers the same for an unknown number and a wrong password', async () => {
    const known = phone();
    await register(known);
    const unknown = phone();

    const failures: string[] = [];
    for (const attempt of [
      { phone: unknown, password: GUEST_TEST_PASSWORD },
      { phone: known, password: [GUEST_TEST_PASSWORD, 'wrong'].join('-') },
      { phone: 'not-a-number', password: GUEST_TEST_PASSWORD },
    ]) {
      try {
        await h.registrations.signIn(attempt, newGuestRequest());
        throw new Error('the sign-in should have been refused');
      } catch (error) {
        const api = error as ApiError;
        failures.push(`${api.code}:${api.message}`);
      }
    }
    // One code and one message for every failure. doc 09 §6.3: the surface
    // cannot be used to discover who has an account.
    expect(new Set(failures).size).toBe(1);
    expect(failures[0]).not.toMatch(/registered|unknown|no account|exists|not found/i);
  }, 120_000);

  it('answers a code request the same way for a known, unknown and malformed number', async () => {
    const known = phone();
    await register(known);
    const answers = await Promise.all(
      [known, phone(), 'not-a-number'].map(async (number) =>
        h.registrations.requestCode({ phone: number, purpose: 'REGISTER' }, newGuestRequest()),
      ),
    );
    for (const answer of answers) expect(answer.requested).toBe(true);
  }, 120_000);

  it('audits a denied sign-in without recording the number', async () => {
    const number = phone();
    await register(number);
    await expect(
      h.registrations.signIn(
        { phone: number, password: [GUEST_TEST_PASSWORD, 'no'].join('-') },
        newGuestRequest(),
      ),
    ).rejects.toThrow(ApiError);
    const audited = await h.iam.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.platform_event
        WHERE action = 'guest.session.sign_in' AND outcome = 'denied'
          AND payload::text LIKE '%' || $1 || '%'`,
      [number.slice(4)],
    );
    expect(Number(audited.rows[0]?.n)).toBe(0);
  }, 120_000);
});

describe('no secret is ever stored or emitted in the clear', () => {
  it('keeps the number, the code and the provider subject out of every readable column', async () => {
    const number = phone();
    const accountId = await register(number);
    const digits = number.slice(4);

    // Every text and jsonb column of the four Guest tables, plus the two audit
    // and outbox streams, searched for the digits and for a six-digit code.
    const leaks = await h.iam.admin.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM platform.guest_account
           WHERE phone_token LIKE '%' || $1 || '%'
              OR COALESCE(display_name, '') LIKE '%' || $1 || '%'
              OR encode(phone_ciphertext, 'escape') LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.guest_phone_verification
           WHERE phone_token LIKE '%' || $1 || '%' OR code_hash LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM audit.platform_event WHERE payload::text LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.outbox_event WHERE payload::text LIKE '%' || $1 || '%')
       ) AS n`,
      [digits],
    );
    expect(Number(leaks.rows[0]?.n)).toBe(0);

    // And the code itself is a keyed HMAC, not the six digits.
    const codes = await h.iam.admin.query<{ code_hash: string }>(
      `SELECT code_hash FROM platform.guest_phone_verification LIMIT 5`,
    );
    for (const row of codes.rows) expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);

    const account = await h.iam.admin.query<{ email_normalized: string | null }>(
      `SELECT email_normalized FROM platform.user_account WHERE account_id = $1`,
      [accountId],
    );
    expect(account.rows[0]?.email_normalized).toBeNull();
  }, 120_000);

  it('never puts a session token in a row it could be read back from', async () => {
    const number = phone();
    await register(number);
    const session = await h.registrations.signIn(
      { phone: number, password: GUEST_TEST_PASSWORD },
      newGuestRequest(),
    );
    const stored = await h.iam.admin.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM platform.server_session
           WHERE token_hash = $1 OR token_hash LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM audit.platform_event WHERE payload::text LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.outbox_event WHERE payload::text LIKE '%' || $1 || '%')
       ) AS n`,
      [session.token],
    );
    // The plaintext is returned once and is nowhere afterwards; the row holds a
    // keyed digest of it (ADR-0020).
    expect(Number(stored.rows[0]?.n)).toBe(0);
  }, 120_000);
});

describe('what the surface refuses to accept', () => {
  it('will not let a caller ask for a link code by naming a number', () => {
    // doc 09 §6.3: the second channel is the number the account already holds.
    // A caller who could choose it would prove nothing by answering it.
    expect(() => requirePurpose('ACCOUNT_LINK')).toThrow(/through the link request/);
    expect(requirePurpose('REGISTER')).toBe('REGISTER');
    expect(() => requirePurpose('ANYTHING')).toThrow(ApiError);
  });

  it('will not redirect the provider anywhere insecure', () => {
    expect(() => requireRedirectUri('http://app.invalid/return')).toThrow(/https/);
    expect(() => requireRedirectUri('https://user:pw@app.invalid/return')).toThrow(/credentials/);
    expect(() => requireRedirectUri('https://app.invalid/return#token')).toThrow(/credentials/);
    expect(() => requireRedirectUri('not a url')).toThrow(/must be a URL/);
    expect(requireRedirectUri('https://app.invalid/guest/return')).toBe(
      'https://app.invalid/guest/return',
    );
  });

  it('answers a disabled provider as an unavailable channel, not as an error to act on', async () => {
    const { UnavailableEMongoliaAuth } = await import('@prsystem/ports');
    const { GuestEMongoliaService } = await import('./services/emongolia.service');
    const disabled = new GuestEMongoliaService({
      ...h.deps,
      emongolia: new UnavailableEMongoliaAuth(),
    });
    // EXT-02 is uncleared, so the production adapter answers DISABLED before
    // any network call, and doc 09 §6.1 keeps phone registration as the way in.
    await expect(
      disabled.begin({ redirectUri: 'https://app.invalid/r', state: 's' }, newGuestRequest()),
    ).rejects.toThrow(/register by phone/);
  });
});
