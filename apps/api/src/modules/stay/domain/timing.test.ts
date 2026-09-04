import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  backdateMinutes,
  earliestAllowedCheckIn,
  fitsBeforeNext,
  hourlyCharge,
  nightlyCharge,
  overdueMinutes,
  plannedCheckout,
  readyNotBefore,
  timeState,
} from './timing';

const TZ = 'Asia/Ulaanbaatar';
const at = (iso: string): Date => new Date(iso);

describe('STAY-DEC-014 — half-hour units and the once-rounded hourly charge', () => {
  it('reproduces doc 05 §10: 20,000 × 3 hours is 60,000', () => {
    expect(hourlyCharge(20_000n, 6)).toBe(60_000n);
  });

  it('rounds half up once, in whole MNT, never through a float', () => {
    // 1 unit at 20,001: 10,000.5 → 10,001
    expect(hourlyCharge(20_001n, 1)).toBe(10_001n);
    // 3 units at 20,001: 30,001.5 → 30,002
    expect(hourlyCharge(20_001n, 3)).toBe(30_002n);
    expect(hourlyCharge(20_000n, 1)).toBe(10_000n);
  });

  it('refuses a zero or fractional unit count', () => {
    expect(() => hourlyCharge(20_000n, 0)).toThrow();
    expect(() => hourlyCharge(20_000n, 1.5)).toThrow();
  });

  it('an hourly stay ends units × 30 minutes after it starts, end-exclusive', () => {
    expect(
      plannedCheckout({
        stayType: 'HOURLY',
        actualCheckInAt: at('2026-08-14T06:00:00Z'),
        halfHourUnits: 3,
      }),
    ).toEqual(at('2026-08-14T07:30:00Z'));
  });
});

describe('STAY-DEC-007 — the nightly calendar rule', () => {
  const fixed = 12 * 60; // 12:00 hotel-local

  it("reproduces doc 05 §9's table: 8/14 18:00, 09:00 and three nights", () => {
    // 18:00 local on 8/14 is 10:00Z.
    expect(
      plannedCheckout({
        stayType: 'NIGHTLY',
        actualCheckInAt: at('2026-08-14T10:00:00Z'),
        nightCount: 1,
        fixedCheckoutMinute: fixed,
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-15T04:00:00Z'));
    // 09:00 local, before that day's checkout: still tomorrow 12:00.
    expect(
      plannedCheckout({
        stayType: 'NIGHTLY',
        actualCheckInAt: at('2026-08-14T01:00:00Z'),
        nightCount: 1,
        fixedCheckoutMinute: fixed,
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-15T04:00:00Z'));
    expect(
      plannedCheckout({
        stayType: 'NIGHTLY',
        actualCheckInAt: at('2026-08-14T10:00:00Z'),
        nightCount: 3,
        fixedCheckoutMinute: fixed,
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-17T04:00:00Z'));
  });

  it('a check-in at 23:30 local belongs to that local date, not the UTC one', () => {
    // 2026-08-14 23:30 local = 15:30Z on 8/14; one night ends 8/15 12:00 local.
    expect(
      plannedCheckout({
        stayType: 'NIGHTLY',
        actualCheckInAt: at('2026-08-14T15:30:00Z'),
        nightCount: 1,
        fixedCheckoutMinute: fixed,
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-15T04:00:00Z'));
  });

  it('charges effective nightly rate × N', () => {
    expect(nightlyCharge(100_000n, 3)).toBe(300_000n);
    expect(() => nightlyCharge(100_000n, 0)).toThrow();
  });

  it('adds calendar days across a month end', () => {
    expect(addCalendarDays('2026-08-31' as never, 1)).toBe('2026-09-01');
  });
});

describe('STAY-DEC-009 — the backdate bound', () => {
  it('is the latest of 120 minutes ago, the shift start, the local day start and the booking start', () => {
    const now = at('2026-08-14T10:00:00Z'); // 18:00 local
    const shift = at('2026-08-14T09:00:00Z');
    expect(earliestAllowedCheckIn({ serverNow: now, shiftOpenedAt: shift, timeZone: TZ })).toEqual(
      shift,
    );
    expect(
      earliestAllowedCheckIn({
        serverNow: now,
        shiftOpenedAt: at('2026-08-14T00:00:00Z'),
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-14T08:00:00Z'));
    // Just after local midnight: the day start wins over the 120 minutes.
    const early = at('2026-08-14T16:30:00Z'); // 00:30 local on 8/15
    expect(
      earliestAllowedCheckIn({
        serverNow: early,
        shiftOpenedAt: at('2026-08-14T12:00:00Z'),
        timeZone: TZ,
      }),
    ).toEqual(at('2026-08-14T16:00:00Z'));
    expect(
      earliestAllowedCheckIn({
        serverNow: now,
        shiftOpenedAt: shift,
        timeZone: TZ,
        bookingPlannedCheckInAt: at('2026-08-14T09:30:00Z'),
      }),
    ).toEqual(at('2026-08-14T09:30:00Z'));
  });

  it('counts whole minutes and refuses an arrival after the recorded time', () => {
    expect(backdateMinutes(at('2026-08-14T09:30:00Z'), at('2026-08-14T10:00:00Z'))).toBe(30);
    expect(backdateMinutes(at('2026-08-14T09:59:30Z'), at('2026-08-14T10:00:00Z'))).toBe(1);
    expect(backdateMinutes(at('2026-08-14T10:00:00Z'), at('2026-08-14T10:00:00Z'))).toBe(0);
    expect(() => backdateMinutes(at('2026-08-14T10:00:01Z'), at('2026-08-14T10:00:00Z'))).toThrow();
  });
});

describe('STAY-DEC-008 — the readiness anchor and the exclusive end', () => {
  it('a stay ending exactly when the next starts is not an overlap, but a buffer is', () => {
    const end = at('2026-08-14T12:00:00Z');
    expect(fitsBeforeNext(end, 0, end)).toBe(true);
    expect(fitsBeforeNext(end, 30, end)).toBe(false);
    expect(fitsBeforeNext(end, 30, at('2026-08-14T12:30:00Z'))).toBe(true);
    expect(fitsBeforeNext(end, 30, undefined)).toBe(true);
    expect(readyNotBefore(end, 30)).toEqual(at('2026-08-14T12:30:00Z'));
  });
});

describe('STAY-DEC-003 / doc 06 §2 — the derived time state', () => {
  const start = at('2026-08-14T06:00:00Z');
  const end = at('2026-08-14T09:00:00Z');
  it('is upcoming, in progress, ending soon or overdue, never stored', () => {
    expect(timeState(at('2026-08-14T05:00:00Z'), start, end)).toBe('UPCOMING');
    expect(timeState(at('2026-08-14T07:00:00Z'), start, end)).toBe('IN_PROGRESS');
    expect(timeState(at('2026-08-14T08:45:00Z'), start, end)).toBe('ENDING_SOON');
    expect(timeState(at('2026-08-14T09:00:00Z'), start, end)).toBe('OVERDUE');
    expect(overdueMinutes(at('2026-08-14T09:42:00Z'), end)).toBe(42);
    expect(overdueMinutes(at('2026-08-14T08:00:00Z'), end)).toBe(0);
  });
});
