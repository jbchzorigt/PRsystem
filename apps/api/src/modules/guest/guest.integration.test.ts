import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { GuestHarness } from './test-support/guest-harness';
import {
  GUEST_TEST_PASSWORD,
  createGuestHarness,
  syntheticPhone,
} from './test-support/guest-harness';
import { newGuestRequest } from './services/guest-context';

/**
 * Registration, sign-in, recovery and identity linking end to end
 * (doc 09 §6, `BK-DEC-002`), against real PostgreSQL and the real account
 * kernel.
 */

let h: GuestHarness;
let sequence = 0;
const phone = (): string => {
  sequence += 1;
  return syntheticPhone(1_000_000 + sequence);
};

beforeAll(async () => {
  h = await createGuestHarness('guest_int');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** Requests a code and reads back the plaintext the simulator delivered. */
async function code(number: string, purpose: 'REGISTER' | 'PASSWORD_RESET'): Promise<string> {
  // Past the resend interval, so a second code in one test is actually sent
  // rather than silently throttled (doc 09 §6.2).
  h.advance(h.parameters.otpResendSeconds + 1);
  await h.registrations.requestCode({ phone: number, purpose }, newGuestRequest());
  const verificationId = await h.liveVerification(number, purpose);
  expect(verificationId).toBeDefined();
  const delivered = h.codeFor(verificationId as string);
  expect(delivered).toMatch(/^\d{6}$/);
  return delivered as string;
}

async function register(number: string): Promise<string> {
  const registered = await h.registrations.register(
    { phone: number, code: await code(number, 'REGISTER'), password: GUEST_TEST_PASSWORD },
    newGuestRequest(),
  );
  return registered.accountId;
}

describe('registration by phone', () => {
  it('proves the number, creates the account and issues a session', async () => {
    const number = phone();
    const accountId = await register(number);

    const account = await h.iam.admin.query<Record<string, unknown>>(
      `SELECT realm, email_normalized, state FROM platform.user_account WHERE account_id = $1`,
      [accountId],
    );
    // A Guest holds no email at all — not a placeholder that would occupy the
    // realm's unique index and look like a real address (`BK-DEC-002`).
    expect(account.rows[0]).toMatchObject({ realm: 'guest', email_normalized: null });

    const profile = await h.iam.admin.query<Record<string, unknown>>(
      `SELECT registered_via, phone_token, phone_verified_at IS NOT NULL AS verified,
              encode(phone_ciphertext, 'escape') AS readable
         FROM platform.guest_account WHERE account_id = $1`,
      [accountId],
    );
    const row = profile.rows[0] as Record<string, unknown>;
    expect(row['registered_via']).toBe('PHONE_OTP');
    expect(row['verified']).toBe(true);
    // The digits are nowhere: the token is a keyed HMAC, and the ciphertext
    // does not contain them (CLAUDE.md §8).
    expect(String(row['phone_token'])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row['phone_token'])).not.toContain(number.slice(4));
    expect(String(row['readable'])).not.toContain(number.slice(4));
  });

  it('refuses a second account on the same proven number', async () => {
    const number = phone();
    await register(number);
    // A fresh code, correctly redeemed — and still refused, because doc 09 §6.3
    // gives one verified number one primary account.
    await expect(
      h.registrations.register(
        { phone: number, code: await code(number, 'REGISTER'), password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
    ).rejects.toThrow(/already has an account/);
  });

  it('spends the code: the same one cannot register twice', async () => {
    const number = phone();
    const once = await code(number, 'REGISTER');
    await h.registrations.register(
      { phone: number, code: once, password: GUEST_TEST_PASSWORD },
      newGuestRequest(),
    );
    await expect(
      h.registrations.register(
        { phone: phone(), code: once, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
    ).rejects.toThrow(/not usable/);
  });

  it('locks the challenge after the attempt budget, and a later correct code fails', async () => {
    const number = phone();
    const correct = await code(number, 'REGISTER');
    const wrong = correct === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < h.parameters.otpMaxAttempts; attempt += 1) {
      await expect(
        h.registrations.register(
          { phone: number, code: wrong, password: GUEST_TEST_PASSWORD },
          newGuestRequest(),
        ),
      ).rejects.toThrow(/not usable/);
    }
    // Locked, not merely wrong: the right code no longer opens it.
    await expect(
      h.registrations.register(
        { phone: number, code: correct, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
    ).rejects.toThrow(/not usable/);
    const settled = await h.iam.admin.query<{ state: string }>(
      `SELECT state FROM platform.guest_phone_verification
        WHERE phone_token = $1 ORDER BY sent_at DESC LIMIT 1`,
      [(await h.registrations.phoneToken(number)).token],
    );
    expect(settled.rows[0]?.state).toBe('LOCKED');
  });

  it('supersedes rather than stacks a live challenge', async () => {
    const number = phone();
    await code(number, 'REGISTER');
    await code(number, 'REGISTER');
    const live = await h.iam.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.guest_phone_verification
        WHERE phone_token = $1 AND state = 'PENDING'`,
      [(await h.registrations.phoneToken(number)).token],
    );
    expect(Number(live.rows[0]?.n)).toBe(1);
  });
});

describe('sign-in and recovery', () => {
  it('signs in with the number and the password', async () => {
    const number = phone();
    const accountId = await register(number);
    const session = await h.registrations.signIn(
      { phone: number, password: GUEST_TEST_PASSWORD },
      newGuestRequest(),
    );
    expect(session.accountId).toBe(accountId);
    const realm = await h.iam.admin.query<{ realm: string }>(
      `SELECT realm FROM platform.server_session WHERE session_id = $1`,
      [session.sessionId],
    );
    // The session is the Guest realm's, and carries no hotel scope: a guest has
    // no membership to be scoped by (ADR-0005).
    expect(realm.rows[0]?.realm).toBe('guest');
    const grants = await h.iam.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.session_scope_grant WHERE session_id = $1`,
      [session.sessionId],
    );
    expect(Number(grants.rows[0]?.n)).toBe(0);
  });

  it('resets the password against a fresh code and closes every session', async () => {
    const number = phone();
    const accountId = await register(number);
    const first = await h.registrations.signIn(
      { phone: number, password: GUEST_TEST_PASSWORD },
      newGuestRequest(),
    );
    const replacement = [GUEST_TEST_PASSWORD, 'two'].join('-');
    await h.registrations.resetPassword(
      { phone: number, code: await code(number, 'PASSWORD_RESET'), password: replacement },
      newGuestRequest(),
    );

    const revoked = await h.iam.admin.query<{ revoked: Date | null }>(
      `SELECT revoked_at AS revoked FROM platform.server_session WHERE session_id = $1`,
      [first.sessionId],
    );
    expect(revoked.rows[0]?.revoked).not.toBeNull();

    await expect(
      h.registrations.signIn({ phone: number, password: GUEST_TEST_PASSWORD }, newGuestRequest()),
    ).rejects.toThrow(ApiError);
    const again = await h.registrations.signIn(
      { phone: number, password: replacement },
      newGuestRequest(),
    );
    expect(again.accountId).toBe(accountId);
  });
});

describe('e-Mongolia', () => {
  it('registers a new guest who holds no number at all', async () => {
    h.emongolia.register('code-new', {
      providerSubject: 'subject-new',
      claims: { displayName: 'Синтетик Зочин', verified: true },
    });
    const outcome = await h.providers.complete(
      { code: 'code-new', state: 's', redirectUri: 'https://app.invalid/return' },
      newGuestRequest(),
    );
    expect(outcome.outcome).toBe('signed_in');
    const accountId = (outcome as { accountId: string }).accountId;
    const profile = await h.iam.admin.query<Record<string, unknown>>(
      `SELECT registered_via, phone_token FROM platform.guest_account WHERE account_id = $1`,
      [accountId],
    );
    // doc 09 §6.1 is a door of its own: a provider registration proves an
    // identity, not a phone number.
    expect(profile.rows[0]).toMatchObject({ registered_via: 'PROVIDER', phone_token: null });

    const link = await h.iam.admin.query<Record<string, unknown>>(
      `SELECT linked_via, subject_token FROM platform.guest_identity_link WHERE account_id = $1`,
      [accountId],
    );
    expect(link.rows[0]?.['linked_via']).toBe('PROVIDER_REGISTRATION');
    // The provider's subject is tokenized, never stored as it came.
    expect(String(link.rows[0]?.['subject_token'])).not.toContain('subject-new');
  });

  it('signs the same subject back into the same account', async () => {
    h.emongolia.register('code-a', {
      providerSubject: 'subject-repeat',
      claims: { verified: true },
    });
    h.emongolia.register('code-b', {
      providerSubject: 'subject-repeat',
      claims: { verified: true },
    });
    const first = await h.providers.complete(
      { code: 'code-a', state: 's', redirectUri: 'https://app.invalid/return' },
      newGuestRequest(),
    );
    const second = await h.providers.complete(
      { code: 'code-b', state: 's', redirectUri: 'https://app.invalid/return' },
      newGuestRequest(),
    );
    expect((second as { accountId: string }).accountId).toBe(
      (first as { accountId: string }).accountId,
    );
  });

  it('never merges a provider identity into a phone account without both channels', async () => {
    const number = phone();
    const accountId = await register(number);
    h.emongolia.register('code-link', {
      providerSubject: 'subject-link',
      claims: { verified: true },
    });

    const outcome = await h.providers.complete(
      {
        code: 'code-link',
        state: 's',
        redirectUri: 'https://app.invalid/return',
        phone: number,
      },
      newGuestRequest(),
    );
    // Not signed in, and nothing linked: doc 09 §6.3 asks for a second channel.
    expect(outcome.outcome).toBe('link_required');
    const requestId = (outcome as { requestId: string }).requestId;
    const unlinked = await h.iam.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.guest_identity_link WHERE account_id = $1`,
      [accountId],
    );
    expect(Number(unlinked.rows[0]?.n)).toBe(0);

    // The second channel's code goes to the number the account holds; the
    // caller never named it here.
    await h.providers.requestLinkCode({ requestId }, newGuestRequest());
    const verificationId = await h.liveVerification(number, 'ACCOUNT_LINK');
    expect(verificationId).toBeDefined();

    const linked = await h.providers.confirmLink(
      { requestId, code: h.codeFor(verificationId as string) as string },
      newGuestRequest(),
    );
    expect(linked.accountId).toBe(accountId);

    const settled = await h.iam.admin.query<Record<string, unknown>>(
      `SELECT state, provider_channel_verified_at IS NOT NULL AS provider,
              phone_channel_verified_at IS NOT NULL AS phone,
              verification_id IS NOT NULL AS verification, link_id IS NOT NULL AS link
         FROM platform.guest_account_link_request WHERE request_id = $1`,
      [requestId],
    );
    expect(settled.rows[0]).toMatchObject({
      state: 'CONFIRMED',
      provider: true,
      phone: true,
      verification: true,
      link: true,
    });
  });

  it('refuses a link confirmation with a code that is not the account’s', async () => {
    const number = phone();
    await register(number);
    h.emongolia.register('code-wrong', {
      providerSubject: 'subject-wrong',
      claims: { verified: true },
    });
    const outcome = await h.providers.complete(
      { code: 'code-wrong', state: 's', redirectUri: 'https://app.invalid/return', phone: number },
      newGuestRequest(),
    );
    const requestId = (outcome as { requestId: string }).requestId;
    await h.providers.requestLinkCode({ requestId }, newGuestRequest());
    await expect(
      h.providers.confirmLink({ requestId, code: '000000' }, newGuestRequest()),
    ).rejects.toThrow(/not usable/);
  });
});
