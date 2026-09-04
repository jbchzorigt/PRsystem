import { roundHalfUpDiv } from '@prsystem/money';
import type { Instant, LocalDate } from '@prsystem/time';
import {
  hotelLocalDate,
  instant,
  instantFromHotelLocal,
  startOfHotelLocalDay,
} from '@prsystem/time';

/**
 * The time rules of a stay (doc 05 §§9–12, §§17–24).
 *
 * Pure functions over instants and integers: half-hour units, calendar nights,
 * the exclusive-end interval, the readiness anchor and the backdate bound.
 * Nothing here reads a clock — the caller passes the server's `now`.
 */

export const HALF_HOUR_MINUTES = 30;
/** `STAY-DEC-009`: the furthest a Reception may set the arrival before the server time. */
export const BACKDATE_LIMIT_MINUTES = 120;
export const MINUTE_MS = 60_000;

export type StayType = 'HOURLY' | 'NIGHTLY';

/** `STAY-DEC-014`: `ROUND_HALF_UP(rate × units / 2)`, once, in whole MNT. */
export function hourlyCharge(unitRateMnt: bigint, halfHourUnits: number): bigint {
  if (!Number.isInteger(halfHourUnits) || halfHourUnits < 1) {
    throw new RangeError('half-hour units must be a positive integer');
  }
  return roundHalfUpDiv(unitRateMnt * BigInt(halfHourUnits), 2n);
}

/** `STAY-DEC-007`: `effective nightly rate × N`. */
export function nightlyCharge(unitRateMnt: bigint, nightCount: number): bigint {
  if (!Number.isInteger(nightCount) || nightCount < 1) {
    throw new RangeError('night count must be a positive integer');
  }
  return unitRateMnt * BigInt(nightCount);
}

export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10) as LocalDate;
}

export type PlannedCheckoutInput =
  | { readonly stayType: 'HOURLY'; readonly actualCheckInAt: Date; readonly halfHourUnits: number }
  | {
      readonly stayType: 'NIGHTLY';
      readonly actualCheckInAt: Date;
      readonly nightCount: number;
      readonly fixedCheckoutMinute: number;
      readonly timeZone: string;
    };

/**
 * doc 05 §9 and §24: an hourly stay ends `units × 30` minutes after it starts;
 * a nightly stay ends at the snapshotted fixed check-out time on the hotel-local
 * date of check-in plus `N` calendar days — so a 09:00 check-in with one night
 * still ends tomorrow, never today.
 */
export function plannedCheckout(input: PlannedCheckoutInput): Instant {
  if (input.stayType === 'HOURLY') {
    return instant(
      input.actualCheckInAt.getTime() + input.halfHourUnits * HALF_HOUR_MINUTES * MINUTE_MS,
    );
  }
  const date = addCalendarDays(
    hotelLocalDate(instant(input.actualCheckInAt), input.timeZone),
    input.nightCount,
  );
  return instantFromHotelLocal(date, input.timeZone, {
    hour: Math.floor(input.fixedCheckoutMinute / 60),
    minute: input.fixedCheckoutMinute % 60,
  });
}

export interface BackdateBoundInput {
  readonly serverNow: Date;
  readonly shiftOpenedAt: Date;
  readonly timeZone: string;
  /** The confirmed online booking's planned check-in, when the stay has one. */
  readonly bookingPlannedCheckInAt?: Date;
}

/**
 * doc 05 §19.1: `max(server_now − 120 min, shift start, hotel-local day start,
 * booking planned check-in)`. The same rule, anchored on the original recorded
 * time instead of `now`, is the correction bound of §20.2.
 */
export function earliestAllowedCheckIn(input: BackdateBoundInput): Instant {
  const candidates = [
    input.serverNow.getTime() - BACKDATE_LIMIT_MINUTES * MINUTE_MS,
    input.shiftOpenedAt.getTime(),
    startOfHotelLocalDay(instant(input.serverNow), input.timeZone).getTime(),
    ...(input.bookingPlannedCheckInAt === undefined
      ? []
      : [input.bookingPlannedCheckInAt.getTime()]),
  ];
  return instant(Math.max(...candidates));
}

/**
 * Whole minutes between the chosen arrival and the recorded time, to the
 * nearest minute: the seconds between a form's minute and the server's are
 * not a backdate, and a chosen earlier minute is.
 */
export function backdateMinutes(actualCheckInAt: Date, recordedAt: Date): number {
  const diff = recordedAt.getTime() - actualCheckInAt.getTime();
  if (diff < 0) throw new RangeError('an arrival is never after the time it was recorded');
  return Math.round(diff / MINUTE_MS);
}

/** `STAY-DEC-008`: the readiness anchor — a checkout plus the buffer that stay snapshotted. */
export function readyNotBefore(anchorAt: Date, cleaningBufferMinutes: number): Instant {
  return instant(anchorAt.getTime() + cleaningBufferMinutes * MINUTE_MS);
}

/**
 * doc 05 §6: `[start, end)` occupancy plus the buffer must fit before the next
 * confirmed booking's start. Equality is not an overlap; the buffer is.
 */
export function fitsBeforeNext(
  plannedCheckoutAt: Date,
  cleaningBufferMinutes: number,
  nextStartAt: Date | undefined,
): boolean {
  if (nextStartAt === undefined) return true;
  return (
    readyNotBefore(plannedCheckoutAt, cleaningBufferMinutes).getTime() <= nextStartAt.getTime()
  );
}

export type TimeState = 'UPCOMING' | 'IN_PROGRESS' | 'ENDING_SOON' | 'OVERDUE';

/** doc 06 §2: derived from the timeline and the server's now, never stored. */
export function timeState(
  now: Date,
  startAt: Date,
  plannedEndAt: Date,
  endingSoonMinutes = 30,
): TimeState {
  if (now.getTime() < startAt.getTime()) return 'UPCOMING';
  if (now.getTime() >= plannedEndAt.getTime()) return 'OVERDUE';
  if (plannedEndAt.getTime() - now.getTime() <= endingSoonMinutes * MINUTE_MS) return 'ENDING_SOON';
  return 'IN_PROGRESS';
}

/** Minutes past the planned end, zero while the stay is within its plan. */
export function overdueMinutes(now: Date, plannedEndAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - plannedEndAt.getTime()) / MINUTE_MS));
}
