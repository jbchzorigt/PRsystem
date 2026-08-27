import type { Instant, LocalDate } from './instant';
import {
  TimeError,
  hotelLocalDate,
  instantFromHotelLocal,
  localDate,
  wallClockIn,
} from './instant';

/**
 * Calendar-month and service-month arithmetic with end-of-month clamping.
 *
 * A subscription started on the 31st recurs on the 30th in a 30-day month and on
 * the 28th or 29th in February. Clamping, not overflow into the next month, is
 * what keeps a service month from silently skipping a billing period.
 */

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Adds calendar months to a local date, clamping the day to the target month's length. */
export function addCalendarMonths(date: LocalDate, count: number): LocalDate {
  if (!Number.isInteger(count)) {
    throw new TimeError('month count must be an integer');
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];

  const zeroBased = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));

  return localDate(`${pad(targetYear, 4)}-${pad(targetMonth)}-${pad(clampedDay)}`);
}

/**
 * The instant a service month starting at `anchor` reaches its `count`-th
 * recurrence, in the hotel's own timezone and preserving the anchor's local time.
 */
export function addServiceMonths(anchor: Instant, count: number, timeZone: string): Instant {
  const wall = wallClockIn(anchor, timeZone);
  const next = addCalendarMonths(hotelLocalDate(anchor, timeZone), count);
  return instantFromHotelLocal(next, timeZone, {
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  });
}

export function endOfCalendarMonth(date: LocalDate): LocalDate {
  const [year, month] = date.split('-').map(Number) as [number, number, number];
  return localDate(`${pad(year, 4)}-${pad(month)}-${pad(daysInMonth(year, month))}`);
}

/** `YYYY-MM` — the partition and reporting key for a hotel-local month. */
export function monthKey(date: LocalDate): string {
  return date.slice(0, 7);
}
