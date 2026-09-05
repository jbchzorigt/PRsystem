/**
 * The Guest realm's decisions, with nothing around them (doc 09 §6).
 *
 * Everything here is a pure function of values the caller has already read, so
 * the rules that decide whether a code is still usable, whether a link may be
 * confirmed and what a failed sign-in is allowed to reveal can be tested
 * without a database and cannot drift between the three surfaces that apply
 * them.
 */

/** doc 09 §6.2: the four things a one-time code is ever sent for. */
export type VerificationPurpose = 'REGISTER' | 'SIGN_IN' | 'PASSWORD_RESET' | 'ACCOUNT_LINK';

export type VerificationState = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'LOCKED';

export const VERIFICATION_PURPOSES: readonly VerificationPurpose[] = [
  'REGISTER',
  'SIGN_IN',
  'PASSWORD_RESET',
  'ACCOUNT_LINK',
];

export function isVerificationPurpose(value: string): value is VerificationPurpose {
  return (VERIFICATION_PURPOSES as readonly string[]).includes(value);
}

/**
 * A Mongolian mobile number, normalized to E.164.
 *
 * Accepts the three shapes a person actually types — `99112233`, `976 99112233`
 * and `+976-9911-2233` — and refuses everything else. Normalization happens
 * before tokenization, so the same number typed two ways is one account
 * (doc 09 §6.3: one verified number, one primary account).
 */
export function normalisePhone(raw: string): string | undefined {
  const digits = raw.replace(/[\s()-]/g, '');
  const body = digits.startsWith('+976')
    ? digits.slice(4)
    : digits.startsWith('976') && digits.length === 11
      ? digits.slice(3)
      : digits;
  if (!/^\d{8}$/.test(body)) return undefined;
  // Mongolian mobile ranges. A landline cannot receive the code, so accepting
  // one would produce an account nobody can ever sign in to.
  if (!/^[5-9]/.test(body)) return undefined;
  return `+976${body}`;
}

/** doc 09 §6.2: six digits. Short enough to read out, so the budget matters. */
export const OTP_DIGITS = 6;

export interface VerificationRow {
  readonly verificationId: string;
  readonly purpose: VerificationPurpose;
  readonly state: VerificationState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
}

/**
 * What a presented code does to the challenge it was presented against.
 *
 * `expired` and `locked` are settled states rather than refusals to retry: the
 * row is terminal afterwards, which is what stops an attacker from spending an
 * unbounded number of guesses by racing the expiry.
 */
export type VerificationOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'wrong'; readonly attempts: number; readonly exhausted: boolean };

export function verificationOutcome(
  row: VerificationRow,
  correct: boolean,
  now: Date,
): VerificationOutcome {
  if (row.state !== 'PENDING') return { kind: 'locked' };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  if (row.attempts >= row.maxAttempts) return { kind: 'locked' };
  if (correct) return { kind: 'accepted' };
  const attempts = row.attempts + 1;
  return { kind: 'wrong', attempts, exhausted: attempts >= row.maxAttempts };
}

/** The state a wrong or stale attempt leaves the challenge in. */
export function settledState(outcome: VerificationOutcome): VerificationState | undefined {
  switch (outcome.kind) {
    case 'accepted':
      return 'CONSUMED';
    case 'expired':
      return 'EXPIRED';
    case 'locked':
      return undefined;
    case 'wrong':
      return outcome.exhausted ? 'LOCKED' : undefined;
  }
}

/**
 * Whether a resend is allowed yet.
 *
 * The interval is a parameter rather than a constant because doc 09 §6.2 leaves
 * the exact numbers to a later decision (P1); what is not left open is that
 * there *is* an interval.
 */
export function mayResend(
  lastSentAt: Date | undefined,
  now: Date,
  intervalSeconds: number,
): boolean {
  if (lastSentAt === undefined) return true;
  return now.getTime() - lastSentAt.getTime() >= intervalSeconds * 1000;
}

export type LinkState = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED';

export interface LinkRequestRow {
  readonly state: LinkState;
  readonly providerChannelVerifiedAt: Date | null;
  readonly phoneChannelVerifiedAt: Date | null;
  readonly expiresAt: Date;
}

/**
 * doc 09 §6.3: two accounts are never merged on a guess.
 *
 * Both channels have to be proven before a link exists — the provider's own
 * authentication, and a fresh code on the number the account already holds.
 * The database refuses `CONFIRMED` without both; this is the same rule stated
 * where the caller can act on it, so the refusal is a message rather than a
 * constraint violation.
 */
export type LinkDecision =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'await'; readonly missing: 'provider' | 'phone' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'settled' };

export function linkDecision(row: LinkRequestRow, now: Date): LinkDecision {
  if (row.state !== 'PENDING') return { kind: 'settled' };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  if (row.providerChannelVerifiedAt === null) return { kind: 'await', missing: 'provider' };
  if (row.phoneChannelVerifiedAt === null) return { kind: 'await', missing: 'phone' };
  return { kind: 'confirm' };
}

/**
 * The one message every failed guest sign-in returns.
 *
 * doc 09 §6.3 forbids a login error from disclosing whether a number is
 * registered, so an unknown number, a wrong password, a suspended account and a
 * missing credential all produce this — and the caller derives no branch from
 * which of them happened.
 */
export const SIGN_IN_REFUSAL = 'the phone number or password is incorrect';
