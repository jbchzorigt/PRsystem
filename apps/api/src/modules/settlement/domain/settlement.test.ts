import { describe, expect, it } from 'vitest';
import {
  batchInstant,
  batchIsDue,
  batchLocalDate,
  batchReconciles,
  cancellationRetention,
  freeCancellationDeadline,
  hotelCancellationRetention,
  noShowCutoff,
  noShowRetention,
  outstandingMnt,
  payableFigures,
  payoutStateAfterRetention,
  payoutStateAfterSettlement,
  plannedCheckIn,
  platformNetMnt,
  totalBatch,
} from './settlement';

/**
 * The arithmetic and the calendar of doc 11, without a database.
 *
 * These are the numbers `PAY-DEC-007`, `-008` and `-009` fix, so they are
 * checked at the boundaries where a wrong rule is invisible in an integration
 * test: an exact half rounding, a one-night booking cancelled late, a payout
 * batch one second before noon.
 */

const UB = 'Asia/Ulaanbaatar';

describe('commission and the payable (PAY-DEC-008)', () => {
  it('rounds ROUND_HALF_UP exactly once', () => {
    // 12.5% of 101 is 12.625 -> 13; of 100 is 12.5 -> 13 (half away from zero).
    expect(payableFigures(101n, 0n, 1250).commissionMnt).toBe(13n);
    expect(payableFigures(100n, 0n, 1250).commissionMnt).toBe(13n);
    // 12.5% of 99 is 12.375 -> 12.
    expect(payableFigures(99n, 0n, 1250).commissionMnt).toBe(12n);
  });

  it('agrees with the database CHECK on the exact tie', () => {
    // The constraint computes `(base * bps + 5000) / 10000` on non-negative
    // bigints. Both halves of the contract are checked against each other here.
    for (const base of [0n, 1n, 4n, 5n, 7n, 99n, 100n, 12_345n, 1_000_000n]) {
      for (const bps of [0, 1, 250, 500, 1250, 3333, 10_000]) {
        const database = (base * BigInt(bps) + 5000n) / 10_000n;
        expect(payableFigures(base, 0n, bps).commissionMnt).toBe(database);
      }
    }
  });

  it('makes the base zero on a full refund, with no special case', () => {
    const figures = payableFigures(250_000n, 250_000n, 1500);
    expect(figures).toEqual({ retainedMnt: 0n, commissionMnt: 0n, hotelPayableMnt: 0n });
  });

  it('takes the commission from what was actually retained', () => {
    // 300 000 captured, 200 000 refunded: the base is the 100 000 retained.
    const figures = payableFigures(300_000n, 200_000n, 1500);
    expect(figures.retainedMnt).toBe(100_000n);
    expect(figures.commissionMnt).toBe(15_000n);
    expect(figures.hotelPayableMnt).toBe(85_000n);
  });

  it('refuses to refund more than was captured', () => {
    expect(() => payableFigures(100n, 101n, 500)).toThrow(/more cannot be refunded/);
  });

  it('keeps the gateway fee out of the hotel payout (BK-DEC-011)', () => {
    const figures = payableFigures(200_000n, 0n, 1000);
    // The fee appears in no term of the payable, and only in the platform's own
    // result. There is nowhere in the formula for it to be deducted from.
    expect(figures.hotelPayableMnt).toBe(180_000n);
    expect(platformNetMnt(figures.commissionMnt, 3_000n)).toBe(17_000n);
  });
});

describe('cancellation and no-show (PAY-DEC-007)', () => {
  const freeUntil = new Date('2027-03-09T16:00:00.000Z');

  it('refunds everything at the deadline and up to it', () => {
    expect(cancellationRetention(300_000n, 100_000n, new Date(freeUntil), freeUntil)).toEqual({
      feeMnt: 0n,
      refundMnt: 300_000n,
      free: true,
    });
  });

  it('retains the first-night unit price one millisecond after it', () => {
    const after = new Date(freeUntil.getTime() + 1);
    expect(cancellationRetention(300_000n, 100_000n, after, freeUntil)).toEqual({
      feeMnt: 100_000n,
      refundMnt: 200_000n,
      free: false,
    });
  });

  it('never retains more than the booking was worth', () => {
    // A one-night booking: the fee and the whole booking are the same money,
    // and charging the unit price on top would refund a negative amount.
    const after = new Date(freeUntil.getTime() + 1);
    expect(cancellationRetention(100_000n, 100_000n, after, freeUntil)).toEqual({
      feeMnt: 100_000n,
      refundMnt: 0n,
      free: false,
    });
  });

  it('charges a confirmed no-show the same fee', () => {
    expect(noShowRetention(300_000n, 100_000n)).toEqual({
      feeMnt: 100_000n,
      refundMnt: 200_000n,
      free: false,
    });
  });

  it('keeps nothing when the hotel could not honour the booking (BK-DEC-014)', () => {
    expect(hotelCancellationRetention(300_000n)).toEqual({
      feeMnt: 0n,
      refundMnt: 300_000n,
      free: true,
    });
  });
});

describe('the hotel calendar', () => {
  it('starts the booking at the arrival date in the hotel timezone', () => {
    // Ulaanbaatar is UTC+8, so its midnight is 16:00 the previous day.
    expect(plannedCheckIn('2027-03-10', UB).toISOString()).toBe('2027-03-09T16:00:00.000Z');
  });

  it('puts free cancellation exactly 24 hours before it', () => {
    expect(freeCancellationDeadline('2027-03-10', UB).toISOString()).toBe(
      '2027-03-08T16:00:00.000Z',
    );
  });

  it('puts the no-show cutoff at 23:59:59 hotel-local on the arrival date', () => {
    expect(noShowCutoff('2027-03-10', UB).toISOString()).toBe('2027-03-10T15:59:59.000Z');
  });
});

describe('the D+1 12:00 batch (PAY-DEC-009)', () => {
  it('pays what became eligible on D in the batch of D+1', () => {
    expect(batchLocalDate('2027-03-10')).toBe('2027-03-11');
    // Across a month boundary, and across a year's.
    expect(batchLocalDate('2027-03-31')).toBe('2027-04-01');
    expect(batchLocalDate('2027-12-31')).toBe('2028-01-01');
  });

  it('schedules it at noon in the hotel timezone', () => {
    expect(batchInstant('2027-03-11', UB).toISOString()).toBe('2027-03-11T04:00:00.000Z');
  });

  it('is not due one second early and is due at noon exactly', () => {
    const noon = batchInstant('2027-03-11', UB);
    expect(batchIsDue('2027-03-11', UB, new Date(noon.getTime() - 1000))).toBe(false);
    expect(batchIsDue('2027-03-11', UB, noon)).toBe(true);
  });
});

describe('the payout axis', () => {
  it('holds while a refund is open, whatever the stay did', () => {
    expect(payoutStateAfterRetention(85_000n, true)).toBe('HELD');
  });

  it('is never eligible for nothing', () => {
    expect(payoutStateAfterRetention(0n, false)).toBe('NOT_ELIGIBLE');
    expect(payoutStateAfterRetention(1n, false)).toBe('ELIGIBLE');
  });

  it('turns a post-payout refund into a negative adjustment', () => {
    // Paid 85 000, then refunded down to 40 000: the hotel owes 45 000 back.
    expect(payoutStateAfterSettlement(40_000n, 85_000n)).toBe('ADJUSTMENT_DUE');
    expect(outstandingMnt(40_000n, 85_000n)).toBe(-45_000n);
  });

  it('settles when what is owed equals what was paid', () => {
    expect(payoutStateAfterSettlement(85_000n, 85_000n)).toBe('PAID');
    expect(payoutStateAfterSettlement(0n, 0n)).toBe('NOT_ELIGIBLE');
  });
});

describe('a batch reconciles (doc 11 §8)', () => {
  it('totals gross, refund, retained, commission, adjustment and payable', () => {
    const totals = totalBatch([
      {
        grossPaidMnt: 200_000n,
        refundedMnt: 0n,
        retainedMnt: 200_000n,
        commissionMnt: 20_000n,
        outstandingMnt: 180_000n,
      },
      {
        grossPaidMnt: 300_000n,
        refundedMnt: 200_000n,
        retainedMnt: 100_000n,
        commissionMnt: 10_000n,
        outstandingMnt: 90_000n,
      },
    ]);
    expect(totals).toEqual({
      grossPaidMnt: 500_000n,
      refundedMnt: 200_000n,
      retainedMnt: 300_000n,
      commissionMnt: 30_000n,
      adjustmentMnt: 0n,
      hotelPayableMnt: 270_000n,
    });
    expect(batchReconciles(totals)).toBe(true);
  });

  it('counts a claw-back only as an adjustment, never as a second payment', () => {
    const totals = totalBatch([
      {
        grossPaidMnt: 200_000n,
        refundedMnt: 0n,
        retainedMnt: 200_000n,
        commissionMnt: 20_000n,
        outstandingMnt: 180_000n,
      },
      // A payable already accounted for in an earlier batch, now owing back.
      {
        grossPaidMnt: 900_000n,
        refundedMnt: 900_000n,
        retainedMnt: 0n,
        commissionMnt: 0n,
        outstandingMnt: -50_000n,
      },
    ]);
    expect(totals.grossPaidMnt).toBe(200_000n);
    expect(totals.adjustmentMnt).toBe(-50_000n);
    expect(totals.hotelPayableMnt).toBe(130_000n);
    expect(batchReconciles(totals)).toBe(true);
  });

  it('refuses totals that do not balance', () => {
    expect(
      batchReconciles({
        grossPaidMnt: 100n,
        refundedMnt: 0n,
        retainedMnt: 100n,
        commissionMnt: 10n,
        adjustmentMnt: 0n,
        hotelPayableMnt: 95n,
      }),
    ).toBe(false);
  });
});
