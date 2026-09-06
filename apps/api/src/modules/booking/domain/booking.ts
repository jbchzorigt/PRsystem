/**
 * The booking's decisions, with nothing around them (doc 09 §§7–10).
 *
 * Everything here is a pure function of values the caller has already read and
 * locked, so the rules that decide which nights a window takes, whether a hold
 * is still alive, what a late payment owes and which remedy a hotel-caused
 * failure has can be tested without a database and cannot drift between the
 * command, the sweep and the callback that apply them.
 */

/** doc 09 §8: the booking axis. Nothing else belongs on it. */
export type BookingState =
  | 'HOLDING'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED_GUEST'
  | 'CANCELLED_HOTEL'
  | 'NO_SHOW';

export type HoldState = 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED';
export type PaymentState = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
export type AttemptState = 'ACTIVE' | 'SUPERSEDED' | 'PAID' | 'FAILED' | 'EXPIRED';
export type RefundState =
  'NONE' | 'REQUIRED' | 'PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED';

export const TERMINAL_STATES: readonly BookingState[] = [
  'EXPIRED',
  'CANCELLED_GUEST',
  'CANCELLED_HOTEL',
  'NO_SHOW',
  'COMPLETED',
];

export function isTerminal(state: BookingState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** `BK-DEC-009` / `PAY-DEC-002`: ten minutes from the moment the server made it. */
export const HOLD_SECONDS = 10 * 60;

/** `BK-DEC-012`: nightly only, and a window a person could actually stay. */
export const MAX_NIGHTS = 90;

const DAY_MS = 86_400_000;

/**
 * A calendar date as `YYYY-MM-DD`, which is the only safe way to bind one.
 *
 * A `Date` bound to a `date` column is converted through the session's
 * timezone, so UTC midnight on the 4th becomes the 3rd wherever the server is
 * east of Greenwich — and the night a booking took would not be the night the
 * availability query asked about. Every date crossing into SQL goes through
 * here, and every one coming back goes through `fromPgDate`.
 */
export function toDateString(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}

/**
 * A `date` read back from PostgreSQL, as UTC midnight.
 *
 * node-postgres parses a `date` into a `Date` at *local* midnight; this rebuilds
 * the same calendar day at UTC midnight, which is the form the rest of the
 * module uses.
 */
export function fromPgDate(value: Date): Date {
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

/** A calendar date at UTC midnight — the form every night key takes. */
export function toNight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The nights `[checkIn, checkOut)` occupies.
 *
 * The list, not the range: releasing a booking means releasing exactly these,
 * and an arithmetic that recomputed the range could release a different set
 * than it took if a boundary ever moved.
 */
export function nightsOf(checkIn: Date, checkOut: Date): readonly Date[] {
  const start = toNight(checkIn);
  const end = toNight(checkOut);
  const nights: Date[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) nights.push(new Date(t));
  return nights;
}

export function nightCount(checkIn: Date, checkOut: Date): number {
  return nightsOf(checkIn, checkOut).length;
}

export type WindowProblem = 'NOT_NIGHTLY' | 'IN_THE_PAST' | 'TOO_LONG' | 'MISALIGNED';

/**
 * Whether a requested window can be booked at all.
 *
 * `today` is the hotel's own calendar day, not the caller's: a guest in another
 * timezone must not be able to book a night the hotel has already begun.
 */
export function windowProblem(
  checkIn: Date,
  checkOut: Date,
  today: Date,
): WindowProblem | undefined {
  const start = toNight(checkIn);
  const end = toNight(checkOut);
  if (start.getTime() !== checkIn.getTime() || end.getTime() !== checkOut.getTime()) {
    return 'MISALIGNED';
  }
  if (end.getTime() <= start.getTime()) return 'NOT_NIGHTLY';
  if (start.getTime() < toNight(today).getTime()) return 'IN_THE_PAST';
  if (nightCount(start, end) > MAX_NIGHTS) return 'TOO_LONG';
  return undefined;
}

export function holdExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + HOLD_SECONDS * 1000);
}

/** doc 09 §10: an invoice or session never outlives the hold that authorized it. */
export function attemptExpiry(holdExpiresAt: Date, now: Date): Date {
  const requested = new Date(now.getTime() + HOLD_SECONDS * 1000);
  return requested.getTime() < holdExpiresAt.getTime() ? requested : holdExpiresAt;
}

export interface BookingFacts {
  readonly state: BookingState;
  readonly holdState: HoldState;
  readonly paymentState: PaymentState;
  readonly holdExpiresAt: Date;
}

/**
 * What a payment confirmation does to the booking it arrives for.
 *
 * `PAY-DEC-006`: expiry and the callback compete on one row, and whichever
 * arrives second sees a settled one. Every outcome below is a decision about a
 * booking the caller has already locked.
 *
 * - `confirm` — the hold is still alive and the money is good.
 * - `refund_obligation` — the booking has ended, or was already paid, and the
 *   money arrived anyway. It is not reopened and inventory is not retaken; the
 *   guest is owed their money back in full.
 * - `already_confirmed` — the same capture arriving twice for the same attempt,
 *   which is a replay and changes nothing.
 * - `stale` — the attempt is not the live one, so it decides nothing.
 */
export type CaptureOutcome =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'refund_obligation'; readonly reason: 'expired' | 'duplicate' | 'terminal' }
  | { readonly kind: 'already_confirmed' }
  | { readonly kind: 'stale' };

export function captureOutcome(
  booking: BookingFacts,
  attempt: { readonly state: AttemptState },
  now: Date,
): CaptureOutcome {
  if (attempt.state === 'SUPERSEDED' || attempt.state === 'FAILED') return { kind: 'stale' };
  // A second capture of the attempt that already paid is the provider
  // repeating itself; a second capture of the *booking* is money twice.
  if (attempt.state === 'PAID' && booking.paymentState === 'PAID') {
    return { kind: 'already_confirmed' };
  }
  if (booking.paymentState === 'PAID') {
    return { kind: 'refund_obligation', reason: 'duplicate' };
  }
  if (isTerminal(booking.state)) {
    return {
      kind: 'refund_obligation',
      reason: booking.state === 'EXPIRED' ? 'expired' : 'terminal',
    };
  }
  // The hold is what authorizes the confirmation, and it is measured against
  // the server's clock — not the provider's, and not the caller's.
  if (booking.holdState !== 'ACTIVE' || booking.holdExpiresAt.getTime() <= now.getTime()) {
    return { kind: 'refund_obligation', reason: 'expired' };
  }
  return { kind: 'confirm' };
}

/** Whether the sweep should settle this booking now. */
export function hasLapsed(booking: BookingFacts, now: Date): boolean {
  return (
    booking.state === 'HOLDING' &&
    booking.holdState === 'ACTIVE' &&
    booking.holdExpiresAt.getTime() <= now.getTime()
  );
}

/**
 * Whether a terminal transition still holds inventory.
 *
 * doc 09 §10: inventory is released on the terminal transaction. A booking that
 * was never confirmed and one that a hotel cancelled both stop occupying a unit
 * at the moment they end — the difference between them is the money, not the
 * inventory.
 */
export function releasesInventory(from: BookingState, to: BookingState): boolean {
  return !isTerminal(from) && isTerminal(to) && to !== 'COMPLETED';
}

/** `BK-DEC-014`: what a hotel that cannot fulfil a booking owes. */
export type FulfilmentRemedy =
  | { readonly kind: 'same_category'; readonly roomId: string }
  | { readonly kind: 'upgrade'; readonly roomId: string; readonly categoryId: string }
  | { readonly kind: 'cancel_hotel' };

export interface RoomOffer {
  readonly roomId: string;
  readonly categoryId: string;
  /** Higher is better; a category the guest did not pay for must not be worse. */
  readonly rankMnt: bigint;
}

/**
 * The remedy ladder, in the order `BK-DEC-014` fixes.
 *
 * A room of the booked category first. Then a *higher* category at no extra
 * charge — never a lower one, which would be a downgrade sold as a remedy.
 * Only if neither exists does the hotel cancel and owe the money back in full.
 * Relocation to another hotel and compensation are not in the MVP, and nothing
 * here invents them.
 */
export function chooseRemedy(
  bookedCategoryId: string,
  bookedRankMnt: bigint,
  offers: readonly RoomOffer[],
): FulfilmentRemedy {
  const same = offers.find((offer) => offer.categoryId === bookedCategoryId);
  if (same !== undefined) return { kind: 'same_category', roomId: same.roomId };
  const higher = offers
    .filter((offer) => offer.rankMnt > bookedRankMnt)
    .sort((a, b) => (a.rankMnt < b.rankMnt ? -1 : a.rankMnt > b.rankMnt ? 1 : 0))[0];
  if (higher !== undefined) {
    return { kind: 'upgrade', roomId: higher.roomId, categoryId: higher.categoryId };
  }
  return { kind: 'cancel_hotel' };
}

/**
 * What a hotel cancellation owes, given what has been paid.
 *
 * `BK-DEC-014`: a paid booking is refunded in full. Commission is zero and the
 * gateway fee is the platform's cost — both of which Phase 14 settles; what
 * Phase 13 records is that the obligation exists.
 */
export function refundOnHotelCancellation(payment: PaymentState): RefundState {
  return payment === 'PAID' ? 'REQUIRED' : 'NONE';
}

/** A short, human-quotable reference. Unambiguous letters and digits only. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function formatReference(bytes: Uint8Array, length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += REFERENCE_ALPHABET[(bytes[i] ?? 0) % REFERENCE_ALPHABET.length];
  }
  return out;
}
