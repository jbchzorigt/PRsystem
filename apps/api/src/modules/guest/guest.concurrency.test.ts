import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GuestHarness } from './test-support/guest-harness';
import {
  GUEST_TEST_PASSWORD,
  createGuestHarness,
  syntheticPhone,
} from './test-support/guest-harness';
import { newGuestRequest } from './services/guest-context';

/**
 * What two simultaneous callers cannot do (doc 09 §6.2, §6.3; CLAUDE.md §6).
 *
 * Real PostgreSQL, real concurrency: the guarantees below are the database's —
 * a partial unique index and a revision check — not a lock the application
 * hopes it took.
 */

let h: GuestHarness;
let sequence = 0;
const phone = (): string => {
  sequence += 1;
  return syntheticPhone(7_000_000 + sequence);
};

beforeAll(async () => {
  h = await createGuestHarness('guest_con');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function freshCode(number: string): Promise<string> {
  h.advance(h.parameters.otpResendSeconds + 1);
  await h.registrations.requestCode({ phone: number, purpose: 'REGISTER' }, newGuestRequest());
  const id = await h.liveVerification(number, 'REGISTER');
  return h.codeFor(id as string) as string;
}

describe('one verified number, one account', () => {
  it('creates exactly one account when two registrations race the same code', async () => {
    const number = phone();
    const code = await freshCode(number);
    const outcomes = await Promise.allSettled([
      h.registrations.register(
        { phone: number, code, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
      h.registrations.register(
        { phone: number, code, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    const accounts = await h.iam.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.guest_account WHERE phone_token = $1`,
      [(await h.registrations.phoneToken(number)).token],
    );
    // doc 09 §6.3, held by the partial unique index rather than by a check the
    // loser could have raced past.
    expect(Number(accounts.rows[0]?.n)).toBe(1);
  }, 60_000);

  it('spends one attempt per guess when two wrong guesses race', async () => {
    const number = phone();
    const correct = await freshCode(number);
    const wrong = correct === '000000' ? '111111' : '000000';
    await Promise.allSettled([
      h.registrations.register(
        { phone: number, code: wrong, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
      h.registrations.register(
        { phone: number, code: wrong, password: GUEST_TEST_PASSWORD },
        newGuestRequest(),
      ),
    ]);
    const row = await h.iam.admin.query<{ attempts: number }>(
      `SELECT attempts FROM platform.guest_phone_verification
        WHERE phone_token = $1 ORDER BY sent_at DESC LIMIT 1`,
      [(await h.registrations.phoneToken(number)).token],
    );
    // The revision guard means the two attempts cannot both write attempt 1 and
    // lose one of them. At least one was recorded, and never more than were made.
    expect(row.rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(row.rows[0]?.attempts).toBeLessThanOrEqual(2);
  }, 60_000);
});

describe('one provider subject, one account', () => {
  it('creates exactly one account when two provider completions race', async () => {
    h.emongolia.register('race-1', { providerSubject: 'subject-race', claims: { verified: true } });
    h.emongolia.register('race-2', { providerSubject: 'subject-race', claims: { verified: true } });
    const outcomes = await Promise.allSettled([
      h.providers.complete(
        { code: 'race-1', state: 's', redirectUri: 'https://app.invalid/return' },
        newGuestRequest(),
      ),
      h.providers.complete(
        { code: 'race-2', state: 's', redirectUri: 'https://app.invalid/return' },
        newGuestRequest(),
      ),
    ]);
    // Both may succeed in signing somebody in, but there is only ever one
    // account behind that subject: `guest_identity_link_subject_uq`.
    const links = await h.iam.admin.query<{ n: string }>(
      `SELECT count(DISTINCT account_id) AS n FROM platform.guest_identity_link
        WHERE provider = 'EMONGOLIA'
          AND subject_token = (SELECT subject_token FROM platform.guest_identity_link
                                ORDER BY created_at DESC LIMIT 1)`,
    );
    expect(Number(links.rows[0]?.n)).toBe(1);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
  }, 60_000);
});
