import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The Platform Operation rules that are decidable without a database (doc 14).
 *
 * Everything here is a pure function of its arguments, which is what lets the
 * boundary cases be asserted directly: the 168-hour threshold, the 48-hour
 * grace, the ceiling on remaining days, what a masked address may still reveal,
 * how many SMS segments a body costs, and whether a one-time code is the one
 * the authenticator would have shown. The services below apply them; none of
 * them re-derives a rule.
 */

// ---------------------------------------------------------------- time status

/** `OPS-DEC-005`: seven days, expressed as the hours the server actually compares. */
export const EXPIRING_SOON_HOURS = 168;
/** `LIFE-DEC-003` / doc 14 §4: grace is exactly 48 hours past expiry. */
export const GRACE_HOURS = 48;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The four time statuses, which are a function of `expires_at` and the server's
 * now and of nothing else.
 *
 * `OPS-DEC-016` is explicit that there is no `Inactive` state and that nothing
 * is stored: a status column would be a second place the boundary lives, and
 * the only thing a writer could do with it is disagree with the rule.
 */
export type SubscriptionTimeStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'GRACE' | 'EXPIRED';

/** What the dashboard shows. Suspension is an access override laid over the time status. */
export type SubscriptionDisplayStatus = SubscriptionTimeStatus | 'SUSPENDED';

export function timeStatus(expiresAt: Date, asOf: Date): SubscriptionTimeStatus {
  const remainingMs = expiresAt.getTime() - asOf.getTime();
  if (remainingMs > EXPIRING_SOON_HOURS * HOUR_MS) return 'ACTIVE';
  if (remainingMs > 0) return 'EXPIRING_SOON';
  if (asOf.getTime() < expiresAt.getTime() + GRACE_HOURS * HOUR_MS) return 'GRACE';
  return 'EXPIRED';
}

/**
 * The card a provisioned hotel falls under.
 *
 * `Түдгэлзсэн` absorbs every suspended hotel whatever its dates, which is what
 * makes the five cards a partition rather than five overlapping filters. The
 * underlying time status is still computed — doc 14 §3.1 shows it in the
 * detail — but it is not what the hotel is counted as.
 */
export function displayStatus(
  expiresAt: Date,
  asOf: Date,
  suspended: boolean,
): SubscriptionDisplayStatus {
  return suspended ? 'SUSPENDED' : timeStatus(expiresAt, asOf);
}

/**
 * doc 14 §4: `max(0, ceil((expires_at - now) / 24h))`.
 *
 * The ceiling is what makes a subscription with eleven hours left read as one
 * day rather than zero, and the floor at zero is why grace and expiry both show
 * `0 хоног` with the grace hours reported separately.
 */
export function remainingDays(expiresAt: Date, asOf: Date): number {
  const remainingMs = expiresAt.getTime() - asOf.getTime();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / DAY_MS);
}

/** The hours left of grace, or `undefined` outside it. Shown beside `0 хоног`. */
export function graceHoursRemaining(expiresAt: Date, asOf: Date): number | undefined {
  if (timeStatus(expiresAt, asOf) !== 'GRACE') return undefined;
  const endsAt = expiresAt.getTime() + GRACE_HOURS * HOUR_MS;
  return Math.ceil((endsAt - asOf.getTime()) / HOUR_MS);
}

// -------------------------------------------------------------------- masking

/**
 * `a****@example.test`.
 *
 * doc 14 §3.2 and §8: the registered address is masked in the list, in the
 * detail and in the result of a password reset alike. An operator may confirm
 * an address they already hold by searching for it exactly; they may never read
 * one they do not.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '*'.repeat(Math.max(1, email.length));
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

/** `****3344` — the four digits a recipient recognises, and nothing before them. */
export function maskPhone(phone: string): string {
  const tail = phone.slice(-4);
  return `${'*'.repeat(4)}${tail}`;
}

const PHONE_DIGITS = /^[0-9]{8}$/;

/**
 * The one stored shape of a Mongolian subscription contact: `+976` and eight
 * digits.
 *
 * doc 14 §3.3 makes the phone an *exact* search, which only works if every row
 * and every query term normalise the same way. Anything that is not eight
 * national digits — with or without the country code, with or without spaces
 * and dashes — is refused rather than stored in a second shape.
 */
export function normaliseContactPhone(raw: string): string | undefined {
  const compact = raw.replace(/[\s()-]/g, '');
  const national = compact.startsWith('+976')
    ? compact.slice(4)
    : compact.startsWith('976') && compact.length === 11
      ? compact.slice(3)
      : compact;
  if (!PHONE_DIGITS.test(national)) return undefined;
  return `+976${national}`;
}

/** doc 14 §3.3: whitespace-trimmed, case-folded, and matched exactly. */
export function normaliseEmailTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

// ------------------------------------------------------------------------ SMS

/** doc 14 §5.3: the body is between one and three hundred characters. */
export const SMS_MIN_CHARACTERS = 1;
export const SMS_MAX_CHARACTERS = 300;

/** doc 14 §5.3: one Cyrillic segment carries 70 characters, one Latin segment 160. */
export const SMS_UNICODE_SEGMENT = 70;
export const SMS_LATIN_SEGMENT = 160;

export type SmsAlphabet = 'LATIN' | 'UNICODE';

/**
 * The counted body.
 *
 * doc 14 §5.3: leading and trailing whitespace is stripped *before* counting,
 * and interior spaces, newlines and punctuation all count. Counting is by code
 * point rather than by UTF-16 unit, so an emoji or a surrogate pair is one
 * character to the operator typing it.
 */
export function smsBody(raw: string): string {
  return raw.trim();
}

export function smsCharacterCount(raw: string): number {
  return [...smsBody(raw)].length;
}

/** Latin capacity applies only when every character is ASCII. */
export function smsAlphabet(raw: string): SmsAlphabet {
  for (const character of smsBody(raw)) {
    if ((character.codePointAt(0) ?? 0) > 127) return 'UNICODE';
  }
  return 'LATIN';
}

/**
 * How many provider segments one recipient's copy costs.
 *
 * `A-P19-8`: doc 14 §5.3 publishes the two single-segment capacities and then
 * says in the same section that the final algorithm follows CallPro's contract,
 * which `EXT-05` has not produced. So this divides by the published capacity
 * and rounds up, and the number is presented as an estimate everywhere it is
 * shown — never as a figure anyone is billed against.
 */
export function smsSegments(raw: string): number {
  const characters = smsCharacterCount(raw);
  if (characters === 0) return 0;
  const capacity = smsAlphabet(raw) === 'LATIN' ? SMS_LATIN_SEGMENT : SMS_UNICODE_SEGMENT;
  return Math.ceil(characters / capacity);
}

/**
 * The estimated cost of a send, in integer MNT, or `undefined`.
 *
 * doc 14 §5.4 step 5 says the cost is shown "боломжтой бол" — where possible.
 * A tariff is a term of the CallPro agreement, so where no tariff row has been
 * configured there is no number to show, and a made-up one would be worse than
 * none.
 */
export function estimatedCostMnt(
  totalSegments: number,
  tariffPerSegmentMnt: number | undefined,
): number | undefined {
  if (tariffPerSegmentMnt === undefined) return undefined;
  return totalSegments * tariffPerSegmentMnt;
}

/** The delivery states doc 14 §5.4 step 8 shows, per recipient message. */
export const SMS_MESSAGE_STATES = ['PENDING', 'SENT', 'DELIVERED', 'FAILED'] as const;
export type SmsMessageState = (typeof SMS_MESSAGE_STATES)[number];

/**
 * Which of the four a provider status maps to.
 *
 * `QUEUED` is still `PENDING`: the provider has the message and has not yet
 * said anything about it, and calling that `Илгээсэн` would overstate what is
 * known. `UNKNOWN` leaves the message where it is rather than inventing a
 * transition, which is what keeps a repeated status query from rewriting a
 * message's history (doc 14 §5.5).
 */
export function smsStateFor(
  providerStatus: 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'UNKNOWN',
): SmsMessageState | undefined {
  switch (providerStatus) {
    case 'QUEUED':
      return 'PENDING';
    case 'SENT':
      return 'SENT';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'FAILED':
      return 'FAILED';
    case 'UNKNOWN':
      return undefined;
  }
}

/**
 * Whether a delivery state may move to another.
 *
 * Forward only, and `DELIVERED` and `FAILED` are terminal. doc 14 §5.5: a
 * repeated provider callback must not break one message's history, and the
 * cheapest way to guarantee that is to make going backwards unrepresentable.
 */
export function smsStateAdvances(from: SmsMessageState, to: SmsMessageState): boolean {
  const rank: Record<SmsMessageState, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, FAILED: 2 };
  return rank[to] > rank[from];
}

// ------------------------------------------------------------- reconciliation

/** doc 14 §4.2: the four terminal outcomes a paid reconciliation may close with. */
export const RECONCILIATION_OUTCOMES = [
  'PROVIDER_STATUS_CORRECTED_NOT_PAID',
  'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL',
  'CHARGEBACK_LINKED',
  'FINANCE_EXCEPTION_CLOSED',
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

export function isReconciliationOutcome(value: string): value is ReconciliationOutcome {
  return (RECONCILIATION_OUTCOMES as readonly string[]).includes(value);
}

// ----------------------------------------------------------------- suspension

export const SUSPENSION_ACTIONS = ['SUSPEND', 'REACTIVATE'] as const;
export type SuspensionAction = (typeof SUSPENSION_ACTIONS)[number];

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * Whether a suspension reason code is well formed.
 *
 * `A-P19-9`: doc 14 §4.1 requires a reason code and a mandatory note and does
 * not enumerate the codes. Enumerating them here would be inventing a business
 * vocabulary, so the shape is checked, the code is recorded verbatim on the
 * append-only event, and the approved list is a P1 configuration item.
 */
export function isReasonCode(value: string): boolean {
  return REASON_CODE.test(value);
}

// ----------------------------------------------------------------- one-time codes

/** doc 14 §2.3: six digits, five minutes, five attempts, sixty seconds between sends. */
export const CONTACT_OTP_DIGITS = 6;
export const CONTACT_OTP_TTL_SECONDS = 300;
export const CONTACT_OTP_MAX_ATTEMPTS = 5;
export const CONTACT_OTP_RESEND_SECONDS = 60;

/** The two challenges one contact change must pass. */
export const CONTACT_CHALLENGES = ['OLD_PHONE', 'NEW_PHONE'] as const;
export type ContactChallenge = (typeof CONTACT_CHALLENGES)[number];

/**
 * The change request's states.
 *
 * `AWAITING_OLD_PHONE` is where an ordinary request starts and where an
 * approved offline exception never goes: `SUBSCRIPTION_CONTACT_CHANGE_APPROVE`
 * waives the old number's challenge and nothing else, so an exception still
 * has to pass `AWAITING_NEW_PHONE` before it can be applied (doc 14 §2.3).
 */
export const CONTACT_REQUEST_STATES = [
  'AWAITING_OLD_PHONE',
  'AWAITING_NEW_PHONE',
  'APPLIED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ContactRequestState = (typeof CONTACT_REQUEST_STATES)[number];

export function isTerminalContactState(state: ContactRequestState): boolean {
  return state === 'APPLIED' || state === 'CANCELLED' || state === 'EXPIRED';
}

// ------------------------------------------------------------------ recovery

/** doc 14 §2.2: what the Platform Super Admin's offline decision may be. */
export const RECOVERY_DECISIONS = ['APPROVED', 'REFUSED'] as const;
export type RecoveryDecision = (typeof RECOVERY_DECISIONS)[number];

// ---------------------------------------------------------------------- TOTP

/** RFC 6238 with the parameters doc 14 §2's `password + TOTP` implies. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** One step either side, which is the usual allowance for a slow hand and a slow clock. */
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The shared secret as an authenticator app expects to be given it. */
export function base32Encode(secret: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The counter step an instant falls in. */
export function totpStep(at: Date, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / periodSeconds);
}

/** The code RFC 6238 says the authenticator shows for one step. */
export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifies a code, and says which step it was.
 *
 * Two things beyond the arithmetic. The comparison is constant time, so a
 * wrong code says nothing about how nearly right it was. And a step at or below
 * `lastAcceptedStep` is refused however correct the digits are: the whole point
 * of a second factor is that a code observed once cannot be used twice, and
 * without this a replayed request inside the same thirty seconds would pass.
 */
export function verifyTotp(input: {
  readonly secret: Buffer;
  readonly code: string;
  readonly at: Date;
  readonly lastAcceptedStep: number | null;
  readonly digits?: number;
  readonly periodSeconds?: number;
  readonly driftSteps?: number;
}): { readonly ok: boolean; readonly step?: number } {
  const digits = input.digits ?? TOTP_DIGITS;
  if (!new RegExp(`^[0-9]{${String(digits)}}$`).test(input.code)) return { ok: false };
  const current = totpStep(input.at, input.periodSeconds ?? TOTP_PERIOD_SECONDS);
  const drift = input.driftSteps ?? TOTP_DRIFT_STEPS;
  const offered = Buffer.from(input.code, 'utf8');
  for (let step = current - drift; step <= current + drift; step += 1) {
    if (input.lastAcceptedStep !== null && step <= input.lastAcceptedStep) continue;
    const expected = Buffer.from(totpCode(input.secret, step, digits), 'utf8');
    if (expected.length === offered.length && timingSafeEqual(expected, offered)) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}

// ------------------------------------------------------- onboarding queue

/**
 * doc 14 §3.4: the application states that are *not* a hotel.
 *
 * The first group is every application whose payment is not confirmed. It is
 * not a Hotel, not a Subscription, and appears in no KPI and no public listing.
 * The second is paid and not yet provisioned, which is the only thing
 * `Идэвхжээгүй` means — a grouping in one queue, never a subscription state and
 * never a sixth KPI card (`OPS-DEC-013`).
 */
export const UNPAID_APPLICATION_STATES = [
  'DRAFT',
  'OWNER_VERIFICATION_REQUIRED',
  'PENDING_PAYMENT',
  'PAYMENT_UNCERTAIN',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
] as const;

export const INACTIVE_APPLICATION_STATES = [
  'PAID_PENDING_PROVISIONING',
  'PROVISIONING',
  'PROVISIONING_FAILED',
  'PAID_OWNER_VERIFICATION_REQUIRED',
] as const;

export type ApplicationQueueGroup = 'UNPAID' | 'INACTIVE';

export function applicationGroup(state: string): ApplicationQueueGroup | undefined {
  if ((UNPAID_APPLICATION_STATES as readonly string[]).includes(state)) return 'UNPAID';
  if ((INACTIVE_APPLICATION_STATES as readonly string[]).includes(state)) return 'INACTIVE';
  // `PROVISIONED` is a Hotel from that moment and belongs to neither queue.
  return undefined;
}
