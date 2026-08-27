/**
 * Instants and hotel-local dates (ADR-0008, 10-money-and-time-invariants §2).
 *
 * Every instant is UTC. A hotel-local date is *derived* from an instant plus the
 * hotel's IANA timezone at the point of use, and is never stored as an instant.
 */

export class TimeError extends Error {
  override readonly name = 'TimeError';
}

/** A UTC instant. Branded so a hotel-local date cannot be passed where one is expected. */
declare const instantBrand: unique symbol;
export type Instant = Date & { readonly [instantBrand]: 'Instant' };

/** A hotel-local calendar date, `YYYY-MM-DD`. Carries no time and no zone. */
declare const localDateBrand: unique symbol;
export type LocalDate = string & { readonly [localDateBrand]: 'LocalDate' };

export function instant(value: Date | string | number): Instant {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TimeError('not a valid instant');
  }
  return date as Instant;
}

export function toUtcIso(value: Instant): string {
  return value.toISOString();
}

export function localDate(value: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TimeError('a local date must be YYYY-MM-DD');
  }
  return value as LocalDate;
}

const ZONE_PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_PART_FORMATTERS.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new TimeError('unknown IANA timezone');
  }
  ZONE_PART_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock reading a hotel would see on its own wall at this instant. */
export function wallClockIn(value: Instant, timeZone: string): WallClock {
  const parts = zoneFormatter(timeZone).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new TimeError(`timezone formatting produced no ${type}`);
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The hotel-local business date of an instant. */
export function hotelLocalDate(value: Instant, timeZone: string): LocalDate {
  const wall = wallClockIn(value, timeZone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return localDate(`${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`);
}

function offsetMsAt(utcMillis: number, timeZone: string): number {
  const wall = wallClockIn(instant(utcMillis), timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(utcMillis / 1000) * 1000;
}

/**
 * The instant at which a hotel-local wall-clock time occurs.
 *
 * Two passes: guess with the offset at the naive instant, then re-derive with the
 * offset actually in force there. That converges for every real zone, including
 * across a DST transition.
 */
export function instantFromHotelLocal(
  date: LocalDate,
  timeZone: string,
  time: { hour: number; minute: number; second?: number } = { hour: 0, minute: 0 },
): Instant {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const second = time.second ?? 0;
  if (
    !Number.isInteger(time.hour) ||
    time.hour < 0 ||
    time.hour > 23 ||
    !Number.isInteger(time.minute) ||
    time.minute < 0 ||
    time.minute > 59
  ) {
    throw new TimeError('hotel-local time is out of range');
  }

  const naive = Date.UTC(year, month - 1, day, time.hour, time.minute, second);
  let guess = naive - offsetMsAt(naive, timeZone);
  guess = naive - offsetMsAt(guess, timeZone);
  return instant(guess);
}

/** Start of the hotel-local business day containing `value`. */
export function startOfHotelLocalDay(value: Instant, timeZone: string): Instant {
  return instantFromHotelLocal(hotelLocalDate(value, timeZone), timeZone);
}
