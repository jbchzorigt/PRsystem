import { describe, expect, it } from 'vitest';
import {
  EXPIRING_SOON_MILLISECONDS,
  GRACE_MILLISECONDS,
  deriveState,
  expiryFrom,
  graceExpiryFrom,
  higherRenewalEffectiveAt,
  listingEligible,
  nextServiceMonthBoundary,
  remainingWholeServiceMonths,
  renewFrom,
  snapshotFrom,
} from './lifecycle';

/**
 * The calendar and boundary rules of `OPS-DEC-006`, `OPS-DEC-007` and
 * `LIFE-DEC-003`…`007`, asserted **at** the boundary rather than near it.
 *
 * Every instant below is UTC. Ulaanbaatar is UTC+8 with no daylight saving, so
 * a local 15:00 is 07:00Z — which is why the expected values look shifted.
 */

const UB = 8 * 60 * 60 * 1000;
/** A local wall-clock instant in `Asia/Ulaanbaatar`, as a UTC `Date`. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - UB);
}

describe('OPS-DEC-006 — calendar-month expiry with end-of-month clamping', () => {
  it('adds whole calendar months in the hotel timezone', () => {
    expect(expiryFrom(local(2026, 8, 21, 15), 1)).toEqual(local(2026, 9, 21, 15));
    expect(expiryFrom(local(2026, 8, 21, 15), 3)).toEqual(local(2026, 11, 21, 15));
    expect(expiryFrom(local(2026, 8, 21, 15), 12)).toEqual(local(2027, 8, 21, 15));
  });

  it('clamps 31 January to the last day of February, keeping the time of day', () => {
    // Not 3 March. Overflowing would hand the customer three extra days on a
    // one-month term and take them back on the next.
    expect(expiryFrom(local(2026, 1, 31, 15, 30), 1)).toEqual(local(2026, 2, 28, 15, 30));
  });

  it('clamps to 29 February in a leap year', () => {
    expect(expiryFrom(local(2028, 1, 31, 9), 1)).toEqual(local(2028, 2, 29, 9));
    expect(expiryFrom(local(2028, 1, 29, 9), 1)).toEqual(local(2028, 2, 29, 9));
  });

  it('clamps a 31st into every 30-day month', () => {
    expect(expiryFrom(local(2026, 3, 31, 12), 1)).toEqual(local(2026, 4, 30, 12));
    expect(expiryFrom(local(2026, 5, 31, 12), 1)).toEqual(local(2026, 6, 30, 12));
  });

  it('does not carry a clamp forward: 31 January plus three months is 30 April', () => {
    // The clamp applies to the target month, not to an already-clamped date. A
    // month-by-month walk would give 28 April here, losing two days for good.
    expect(expiryFrom(local(2026, 1, 31, 12), 3)).toEqual(local(2026, 4, 30, 12));
  });
});

describe('LIFE-DEC-003 — expiring soon, grace and the hard lock', () => {
  const expiresAt = local(2026, 9, 21, 15);
  const facts = {
    hotelId: '00000000-0000-0000-0000-000000000001',
    effectivePackage: 'P20' as const,
    expiresAt,
    suspendedAt: null,
  };

  it('is ACTIVE until exactly 168 hours before expiry', () => {
    const boundary = new Date(expiresAt.getTime() - EXPIRING_SOON_MILLISECONDS);
    expect(deriveState(facts, new Date(boundary.getTime() - 1))).toBe('ACTIVE');
    // At exactly 168 hours it is already the warning state, not still ACTIVE.
    expect(deriveState(facts, boundary)).toBe('EXPIRING_SOON');
  });

  it('is EXPIRING_SOON up to the instant before expiry', () => {
    expect(deriveState(facts, new Date(expiresAt.getTime() - 1))).toBe('EXPIRING_SOON');
  });

  it('is in GRACE at exactly expires_at, not expired', () => {
    // doc 17 §5.1: the rights do not close *at* expiry.
    expect(deriveState(facts, expiresAt)).toBe('GRACE');
  });

  it('is in GRACE up to the instant before expiry plus 48 hours', () => {
    const graceEnd = new Date(expiresAt.getTime() + GRACE_MILLISECONDS);
    expect(deriveState(facts, new Date(graceEnd.getTime() - 1))).toBe('GRACE');
    // And EXPIRED at exactly +48h: grace is 48 hours, not 48 hours and an instant.
    expect(deriveState(facts, graceEnd)).toBe('EXPIRED');
  });

  it('reports the grace boundary only while inside it', () => {
    expect(snapshotFrom(facts, expiresAt).graceExpiresAt).toEqual(graceExpiryFrom(expiresAt));
    expect(snapshotFrom(facts, new Date(expiresAt.getTime() - 1)).graceExpiresAt).toBeUndefined();
  });

  it('is SUSPENDED regardless of the clock', () => {
    const suspended = { ...facts, suspendedAt: local(2026, 8, 1) };
    expect(deriveState(suspended, local(2026, 8, 15))).toBe('SUSPENDED');
    expect(deriveState(suspended, local(2027, 1, 1))).toBe('SUSPENDED');
  });
});

describe('LIFE-DEC-004 — public listing follows grace, not expiry', () => {
  const expiresAt = local(2026, 9, 21, 15);
  const facts = {
    hotelId: '00000000-0000-0000-0000-000000000001',
    effectivePackage: 'P20' as const,
    expiresAt,
    suspendedAt: null,
  };

  it('stays listable through the whole grace window', () => {
    expect(listingEligible(facts, expiresAt)).toBe(true);
    expect(listingEligible(facts, new Date(expiresAt.getTime() + GRACE_MILLISECONDS - 1))).toBe(
      true,
    );
  });

  it('is hidden the moment grace ends, and while suspended', () => {
    expect(listingEligible(facts, new Date(expiresAt.getTime() + GRACE_MILLISECONDS))).toBe(false);
    expect(listingEligible({ ...facts, suspendedAt: expiresAt }, expiresAt)).toBe(false);
  });
});

describe('OPS-DEC-007 / LIFE-DEC-005 — where a renewal counts from', () => {
  const expiresAt = local(2026, 9, 21, 15);

  it('continues from the existing expiry when paid before it', () => {
    const outcome = renewFrom(expiresAt, local(2026, 9, 1, 10), 1);
    expect(outcome.expiresAt).toEqual(local(2026, 10, 21, 15));
    expect(outcome.restarted).toBe(false);
  });

  it('still continues from the existing expiry when paid inside grace', () => {
    // The rule that stops every renewal accumulating two free days.
    const outcome = renewFrom(expiresAt, new Date(expiresAt.getTime() + 60_000), 1);
    expect(outcome.expiresAt).toEqual(local(2026, 10, 21, 15));
    expect(outcome.restarted).toBe(false);
  });

  it('continues from the expiry at the last instant of grace', () => {
    const lastInstant = new Date(expiresAt.getTime() + GRACE_MILLISECONDS - 1);
    expect(renewFrom(expiresAt, lastInstant, 1).restarted).toBe(false);
  });

  it('restarts at the confirmation exactly when grace has ended', () => {
    const graceEnd = new Date(expiresAt.getTime() + GRACE_MILLISECONDS);
    const outcome = renewFrom(expiresAt, graceEnd, 1);
    expect(outcome.restarted).toBe(true);
    expect(outcome.startsAt).toEqual(graceEnd);
    expect(outcome.expiresAt).toEqual(expiryFrom(graceEnd, 1));
  });
});

describe('doc 17 §4.1 — service months and the upgrade boundary', () => {
  const startsAt = local(2026, 8, 21, 15);

  it('recurs on the anniversary of the start instant, not the calendar month', () => {
    expect(nextServiceMonthBoundary(startsAt, local(2026, 8, 22))).toEqual(local(2026, 9, 21, 15));
    expect(nextServiceMonthBoundary(startsAt, local(2026, 9, 20))).toEqual(local(2026, 9, 21, 15));
  });

  it('moves to the following month once a boundary has passed', () => {
    expect(nextServiceMonthBoundary(startsAt, local(2026, 9, 21, 15))).toEqual(
      local(2026, 10, 21, 15),
    );
  });

  it('counts only whole service months between the boundary and expiry', () => {
    // A 12-month term whose upgrade opens at the first boundary has 11 whole
    // months left — the month being used up at the old package is not one of them.
    const expiresAt = expiryFrom(startsAt, 12);
    const effectiveAt = nextServiceMonthBoundary(startsAt, local(2026, 8, 25));
    expect(remainingWholeServiceMonths(startsAt, effectiveAt, expiresAt)).toBe(11);
  });

  it('is zero in the last service month of the term', () => {
    // `LIFE-DEC-002`: no whole month left means no upgrade invoice at all.
    const expiresAt = expiryFrom(startsAt, 1);
    const effectiveAt = nextServiceMonthBoundary(startsAt, local(2026, 9, 1));
    expect(remainingWholeServiceMonths(startsAt, effectiveAt, expiresAt)).toBe(0);
  });
});

describe('LIFE-DEC-007 — when a higher-package renewal opens', () => {
  const expiresAt = local(2026, 9, 21, 15);

  it('waits for the new term when paid mid-term', () => {
    expect(higherRenewalEffectiveAt(expiresAt, local(2026, 9, 1))).toEqual(expiresAt);
  });

  it('opens at confirmation when paid in grace or after it', () => {
    const inGrace = new Date(expiresAt.getTime() + 60_000);
    expect(higherRenewalEffectiveAt(expiresAt, inGrace)).toEqual(inGrace);
    const afterGrace = new Date(expiresAt.getTime() + GRACE_MILLISECONDS + 60_000);
    expect(higherRenewalEffectiveAt(expiresAt, afterGrace)).toEqual(afterGrace);
  });
});
