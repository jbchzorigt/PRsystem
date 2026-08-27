import { describe, expect, it } from 'vitest';
import {
  TimeError,
  addCalendarMonths,
  addServiceMonths,
  endOfCalendarMonth,
  halfHourUnits,
  halfHourUnitsToMinutes,
  halfOpenInterval,
  hotelLocalDate,
  instant,
  instantFromHotelLocal,
  intervalContains,
  intervalMinutes,
  intervalsOverlap,
  localDate,
  minutes,
  minutesToHalfHourUnits,
  monthKey,
  startOfHotelLocalDay,
} from './index';

/** GATE-UNIT: end-of-month clamping, service-month recurrence, `[start,end)` semantics. */

const ULAANBAATAR = 'Asia/Ulaanbaatar';

describe('hotel-local dates (ADR-0008)', () => {
  it('derives the hotel-local business date from a UTC instant', () => {
    // 2026-03-01T22:30Z is already 2026-03-02 in Ulaanbaatar (UTC+8).
    expect(hotelLocalDate(instant('2026-03-01T22:30:00Z'), ULAANBAATAR)).toBe('2026-03-02');
    expect(hotelLocalDate(instant('2026-03-01T22:30:00Z'), 'UTC')).toBe('2026-03-01');
  });

  it('resolves hotel-local midnight to the right instant', () => {
    expect(startOfHotelLocalDay(instant('2026-03-02T05:00:00Z'), ULAANBAATAR).toISOString()).toBe(
      '2026-03-01T16:00:00.000Z',
    );
  });

  it('round-trips a local date through its instant', () => {
    const date = localDate('2026-07-15');
    const at = instantFromHotelLocal(date, ULAANBAATAR, { hour: 12, minute: 0 });
    expect(hotelLocalDate(at, ULAANBAATAR)).toBe(date);
  });

  it('resolves a local time correctly on both sides of a DST change', () => {
    // Europe/Berlin moves to summer time on 2026-03-29.
    const before = instantFromHotelLocal(localDate('2026-03-28'), 'Europe/Berlin', {
      hour: 12,
      minute: 0,
    });
    const after = instantFromHotelLocal(localDate('2026-03-30'), 'Europe/Berlin', {
      hour: 12,
      minute: 0,
    });
    expect(before.toISOString()).toBe('2026-03-28T11:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-30T10:00:00.000Z');
  });

  it('rejects an unknown timezone rather than silently using UTC', () => {
    expect(() => hotelLocalDate(instant('2026-01-01T00:00:00Z'), 'Mars/Olympus')).toThrow(
      TimeError,
    );
  });

  it('rejects a malformed local date', () => {
    expect(() => localDate('2026-7-15')).toThrow(TimeError);
  });
});

describe('half-open occupancy intervals (STAY-DEC-008)', () => {
  const a = halfOpenInterval(instant('2026-04-01T06:00:00Z'), instant('2026-04-01T12:00:00Z'));

  it('treats the end as exclusive', () => {
    expect(intervalContains(a, instant('2026-04-01T06:00:00Z'))).toBe(true);
    expect(intervalContains(a, instant('2026-04-01T11:59:59Z'))).toBe(true);
    expect(intervalContains(a, instant('2026-04-01T12:00:00Z'))).toBe(false);
  });

  it('does not treat touching intervals as overlapping', () => {
    const b = halfOpenInterval(instant('2026-04-01T12:00:00Z'), instant('2026-04-01T18:00:00Z'));
    expect(intervalsOverlap(a, b)).toBe(false);
    expect(intervalsOverlap(b, a)).toBe(false);
  });

  it('detects a genuine overlap in both directions', () => {
    const b = halfOpenInterval(instant('2026-04-01T11:59:59Z'), instant('2026-04-01T18:00:00Z'));
    expect(intervalsOverlap(a, b)).toBe(true);
    expect(intervalsOverlap(b, a)).toBe(true);
  });

  it('refuses a zero-length or inverted interval', () => {
    const at = instant('2026-04-01T06:00:00Z');
    expect(() => halfOpenInterval(at, at)).toThrow(TimeError);
    expect(() => halfOpenInterval(instant('2026-04-02T00:00:00Z'), at)).toThrow(TimeError);
  });

  it('measures duration in whole minutes', () => {
    expect(intervalMinutes(a)).toBe(360);
  });
});

describe('durations (STAY-DEC-014)', () => {
  it('converts between minutes and half-hour units', () => {
    expect(halfHourUnitsToMinutes(halfHourUnits(3))).toBe(90);
    expect(minutesToHalfHourUnits(minutes(90))).toBe(3);
  });

  it('rejects a duration that is not a whole number of half-hour units', () => {
    expect(() => minutesToHalfHourUnits(minutes(95))).toThrow(TimeError);
  });

  it('rejects a fractional duration outright', () => {
    expect(() => minutes(90.5)).toThrow(TimeError);
    expect(() => halfHourUnits(0)).toThrow(TimeError);
  });
});

describe('calendar and service months', () => {
  it('clamps the day to the length of the target month', () => {
    expect(addCalendarMonths(localDate('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addCalendarMonths(localDate('2028-01-31'), 1)).toBe('2028-02-29');
    expect(addCalendarMonths(localDate('2026-03-31'), 1)).toBe('2026-04-30');
  });

  it('never overflows into the following month', () => {
    expect(addCalendarMonths(localDate('2026-01-31'), 1).slice(5, 7)).toBe('02');
  });

  it('crosses a year boundary in both directions', () => {
    expect(addCalendarMonths(localDate('2026-11-15'), 3)).toBe('2027-02-15');
    expect(addCalendarMonths(localDate('2026-02-15'), -3)).toBe('2025-11-15');
  });

  it('clamps only for the month it lands in, not permanently', () => {
    // A subscription anchored on the 31st recurs on the 31st whenever the month
    // has one; clamping in February must not shorten every later period.
    const anchor = localDate('2026-01-31');
    expect(addCalendarMonths(anchor, 1)).toBe('2026-02-28');
    expect(addCalendarMonths(anchor, 2)).toBe('2026-03-31');
  });

  it('advances a service month in the hotel timezone, preserving local time', () => {
    const anchor = instant('2026-01-31T02:00:00Z'); // 10:00 local in Ulaanbaatar
    const next = addServiceMonths(anchor, 1, ULAANBAATAR);
    expect(hotelLocalDate(next, ULAANBAATAR)).toBe('2026-02-28');
    expect(next.toISOString()).toBe('2026-02-28T02:00:00.000Z');
  });

  it('reports the end of a month and its key', () => {
    expect(endOfCalendarMonth(localDate('2026-02-10'))).toBe('2026-02-28');
    expect(monthKey(localDate('2026-02-10'))).toBe('2026-02');
  });
});
