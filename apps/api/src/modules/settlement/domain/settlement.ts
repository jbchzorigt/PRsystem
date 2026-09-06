import { applyRate, basisPoints, mnt } from '@prsystem/money';
import type { Mnt } from '@prsystem/money';
import { instantFromHotelLocal, localDate } from '@prsystem/time';

/**
 * The money rules of doc 11, with nothing around them.
 *
 * Every number Phase 14 settles is decided here, as a pure function of values a
 * caller has already read and locked — so the commission a confirmation
 * computes, the commission a refund recomputes and the commission a payout
 * batch reconciles are the same arithmetic rather than three that happen to
 * agree. The database repeats each of them as a CHECK; this is where they are
 * written once.
 */

/** doc 11 §9: the payout axis, and nothing else on it. */
export type PayoutState =
  'NOT_ELIGIBLE' | 'ELIGIBLE' | 'HELD' | 'BATCHED' | 'PAID' | 'FAILED' | 'ADJUSTMENT_DUE';

export type RefundState = 'REQUIRED' | 'PENDING' | 'REFUNDED' | 'FAILED';

export type RefundReason =
  | 'GUEST_CANCELLATION'
  | 'LATE_CANCELLATION_BALANCE'
  | 'NO_SHOW_BALANCE'
  | 'HOTEL_CANCELLATION'
  | 'LATE_PAYMENT_AFTER_HOLD'
  | 'DUPLICATE_CAPTURE';

export type LedgerEventType =
  'PAYMENT' | 'COMMISSION' | 'HOTEL_PAYABLE' | 'PROVIDER_FEE' | 'REFUND' | 'ADJUSTMENT' | 'PAYOUT';

/** `PAY-DEC-003` / `PAY-DEC-007`: the free-cancellation window, in hours. */
export const FREE_CANCELLATION_HOURS = 24;

/** doc 11 §8: `D+1 12:00`, hotel-local. */
export const PAYOUT_HOUR = 12;

/**
 * What one booking owes and earns, from the two facts that can change.
 *
 * `retained` is doc 11 §3's commission base: the VAT-inclusive room charge the
 * guest was *actually* left paying. Nothing else is a special case — a full
 * refund makes `refunded = gross`, which makes the base zero, which makes the
 * commission zero. `PAY-DEC-008`'s "commission base 0 on full refund and
 * hotel-caused cancellation" needs no branch, and cannot be forgotten in one.
 *
 * The gateway fee is not a term (`PAY-DEC-004`, `BK-DEC-011`). It is the
 * platform's cost, and the only place it appears is the platform's own revenue.
 */
export interface PayableFigures {
  readonly retainedMnt: bigint;
  readonly commissionMnt: bigint;
  readonly hotelPayableMnt: bigint;
}

export function payableFigures(
  grossPaidMnt: bigint,
  refundedMnt: bigint,
  commissionRateBps: number,
): PayableFigures {
  if (grossPaidMnt < 0n || refundedMnt < 0n) {
    throw new Error('a captured or refunded amount is never negative');
  }
  if (refundedMnt > grossPaidMnt) {
    throw new Error('more cannot be refunded than was captured');
  }
  const retained = grossPaidMnt - refundedMnt;
  // `ROUND_HALF_UP`, once, in integer basis points (`PAY-DEC-008`). The single
  // division in the system lives in `@prsystem/money`; nothing here divides.
  const commission: Mnt = applyRate(mnt(retained), basisPoints(commissionRateBps));
  return {
    retainedMnt: retained,
    commissionMnt: commission,
    hotelPayableMnt: retained - commission,
  };
}

/** The platform's own result on a booking: commission less what the gateway took. */
export function platformNetMnt(commissionMnt: bigint, providerFeeMnt: bigint): bigint {
  return commissionMnt - providerFeeMnt;
}

/**
 * The instant a booking's stay may begin, hotel-local.
 *
 * doc 09 §12 refers to a confirmed booking's `planned_checkin_at`, and no
 * document configures a standard check-in hour. The one instant the platform
 * actually knows is the start of the arrival date in the hotel's own timezone —
 * the earliest moment the booked night exists — and every date rule here is
 * measured from it (`A-P14-2`).
 */
export function plannedCheckIn(checkInDate: string, timeZone: string): Date {
  return new Date(instantFromHotelLocal(localDate(checkInDate), timeZone).getTime());
}

/**
 * `PAY-DEC-007`: cancelling 24 hours or more before check-in is free.
 *
 * Snapshotted onto the booking when the hold is created, because doc 11 §5
 * requires the guest to have been shown it before paying. A deadline that could
 * be recomputed later is not a deadline.
 */
export function freeCancellationDeadline(checkInDate: string, timeZone: string): Date {
  const start = plannedCheckIn(checkInDate, timeZone);
  return new Date(start.getTime() - FREE_CANCELLATION_HOURS * 3_600_000);
}

/**
 * `PAY-DEC-007`: no-show may not be confirmed before the arrival date's
 * `23:59:59`, hotel-local — and never automatically, whatever the clock says.
 */
export function noShowCutoff(checkInDate: string, timeZone: string): Date {
  const cutoff = instantFromHotelLocal(localDate(checkInDate), timeZone, {
    hour: 23,
    minute: 59,
    second: 59,
  });
  return new Date(cutoff.getTime());
}

export interface RetentionOutcome {
  /** What the hotel keeps. The commission base of what follows. */
  readonly feeMnt: bigint;
  /** What goes back to the guest. */
  readonly refundMnt: bigint;
  readonly free: boolean;
}

/**
 * `PAY-DEC-007`: the numbers a guest cancellation produces.
 *
 * Before the deadline, everything comes back. After it, the hotel retains
 * `min(total, first-night unit price)` — the `min` matters for a one-night
 * booking, where a "first-night fee" and "the whole booking" are the same
 * money and charging the unit price on top would refund a negative amount.
 */
export function cancellationRetention(
  totalAmountMnt: bigint,
  unitRateMnt: bigint,
  now: Date,
  freeUntil: Date,
): RetentionOutcome {
  if (now.getTime() <= freeUntil.getTime()) {
    return { feeMnt: 0n, refundMnt: totalAmountMnt, free: true };
  }
  return { ...lateRetention(totalAmountMnt, unitRateMnt), free: false };
}

/** `PAY-DEC-007`: a confirmed no-show retains the same first-night fee. */
export function noShowRetention(totalAmountMnt: bigint, unitRateMnt: bigint): RetentionOutcome {
  return { ...lateRetention(totalAmountMnt, unitRateMnt), free: false };
}

function lateRetention(
  totalAmountMnt: bigint,
  unitRateMnt: bigint,
): { feeMnt: bigint; refundMnt: bigint } {
  const fee = totalAmountMnt < unitRateMnt ? totalAmountMnt : unitRateMnt;
  return { feeMnt: fee, refundMnt: totalAmountMnt - fee };
}

/**
 * `BK-DEC-014` / `PAY-DEC-008`: a hotel that cannot honour a booking keeps
 * nothing. The guest is refunded in full and the commission base is zero.
 */
export function hotelCancellationRetention(totalAmountMnt: bigint): RetentionOutcome {
  return { feeMnt: 0n, refundMnt: totalAmountMnt, free: true };
}

/**
 * Where a payable stands once a terminal outcome is known.
 *
 * doc 11 §8: a retained amount is payable when nothing about it is still open.
 * A refund that has not reached the provider is exactly such an opening, so the
 * payable is `HELD` until it terminates — and a retention of nothing is never
 * eligible for a payout, because there is no payout to make.
 */
export function payoutStateAfterRetention(
  hotelPayableMnt: bigint,
  refundOutstanding: boolean,
): PayoutState {
  if (refundOutstanding) return 'HELD';
  return hotelPayableMnt > 0n ? 'ELIGIBLE' : 'NOT_ELIGIBLE';
}

/**
 * Where a payable stands once its refund has settled or its stay completed.
 *
 * `paidOut` is what has already reached the hotel: a refund that lands after a
 * payout leaves the booking earning less than it was paid, and that difference
 * is `PAY-DEC-009`'s negative adjustment rather than a rewritten payout.
 */
export function payoutStateAfterSettlement(
  hotelPayableMnt: bigint,
  paidOutMnt: bigint,
): PayoutState {
  if (hotelPayableMnt > paidOutMnt) return 'ELIGIBLE';
  if (hotelPayableMnt < paidOutMnt) return 'ADJUSTMENT_DUE';
  return hotelPayableMnt === 0n ? 'NOT_ELIGIBLE' : 'PAID';
}

/** What a batch would move for this payable: positive to pay, negative to claw back. */
export function outstandingMnt(hotelPayableMnt: bigint, paidOutMnt: bigint): bigint {
  return hotelPayableMnt - paidOutMnt;
}

/**
 * `PAY-DEC-009`: what became eligible on the hotel-local day `D` is paid in the
 * batch of `D+1 12:00`, in the hotel's own timezone.
 *
 * A bank holiday delays the transfer and changes nothing about the batch a row
 * belongs to: the date is derived from eligibility, never from when a payment
 * happened to succeed.
 */
export function batchLocalDate(eligibleLocalDate: string): string {
  const [year, month, day] = eligibleLocalDate.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export function batchInstant(batchDate: string, timeZone: string): Date {
  const at = instantFromHotelLocal(localDate(batchDate), timeZone, {
    hour: PAYOUT_HOUR,
    minute: 0,
  });
  return new Date(at.getTime());
}

export function batchIsDue(batchDate: string, timeZone: string, now: Date): boolean {
  return batchInstant(batchDate, timeZone).getTime() <= now.getTime();
}

/** The six totals doc 11 §8 requires every batch to reconcile. */
export interface BatchTotals {
  readonly grossPaidMnt: bigint;
  readonly refundedMnt: bigint;
  readonly retainedMnt: bigint;
  readonly commissionMnt: bigint;
  readonly adjustmentMnt: bigint;
  readonly hotelPayableMnt: bigint;
}

export interface BatchLine {
  readonly grossPaidMnt: bigint;
  readonly refundedMnt: bigint;
  readonly retainedMnt: bigint;
  readonly commissionMnt: bigint;
  /** What this line moves: positive for a payable, negative for an adjustment. */
  readonly outstandingMnt: bigint;
}

/**
 * The batch's totals from its lines.
 *
 * A negative line contributes only its adjustment: the gross, refund, retained
 * and commission of a booking already accounted for in an earlier batch are not
 * counted a second time, or the batch would reconcile against a number that
 * includes the same payment twice.
 */
export function totalBatch(lines: readonly BatchLine[]): BatchTotals {
  let gross = 0n;
  let refunded = 0n;
  let retained = 0n;
  let commission = 0n;
  let adjustment = 0n;
  let payable = 0n;
  for (const line of lines) {
    if (line.outstandingMnt < 0n) {
      adjustment += line.outstandingMnt;
      payable += line.outstandingMnt;
      continue;
    }
    gross += line.grossPaidMnt;
    refunded += line.refundedMnt;
    retained += line.retainedMnt;
    commission += line.commissionMnt;
    payable += line.outstandingMnt;
  }
  return {
    grossPaidMnt: gross,
    refundedMnt: refunded,
    retainedMnt: retained,
    commissionMnt: commission,
    adjustmentMnt: adjustment,
    hotelPayableMnt: payable,
  };
}

/**
 * Whether the batch's own arithmetic holds, checked before it is written.
 *
 * The database repeats this as a CHECK; asserting it here means a wrong total
 * is a refusal with a readable reason rather than a constraint violation on a
 * row nobody can explain.
 */
export function batchReconciles(totals: BatchTotals): boolean {
  return (
    totals.retainedMnt === totals.grossPaidMnt - totals.refundedMnt &&
    totals.hotelPayableMnt === totals.retainedMnt - totals.commissionMnt + totals.adjustmentMnt
  );
}
