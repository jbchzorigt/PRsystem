import { TimeError } from './instant';

/**
 * Durations are integer minutes and integer half-hour units — never fractional
 * hours (`STAY-DEC-014`, ADR-0007, CLAUDE.md §5).
 */
declare const minutesBrand: unique symbol;
export type Minutes = number & { readonly [minutesBrand]: 'Minutes' };

declare const halfHourBrand: unique symbol;
export type HalfHourUnits = number & { readonly [halfHourBrand]: 'HalfHourUnits' };

export function minutes(value: number): Minutes {
  if (!Number.isInteger(value) || value < 0) {
    throw new TimeError('minutes must be a non-negative integer');
  }
  return value as Minutes;
}

export function halfHourUnits(value: number): HalfHourUnits {
  if (!Number.isInteger(value) || value < 1) {
    throw new TimeError('half-hour units must be a positive integer');
  }
  return value as HalfHourUnits;
}

export function halfHourUnitsToMinutes(units: HalfHourUnits): Minutes {
  return minutes(units * 30);
}

/** Rejects a duration that is not an exact multiple of 30 minutes rather than rounding it. */
export function minutesToHalfHourUnits(value: Minutes): HalfHourUnits {
  if (value % 30 !== 0) {
    throw new TimeError('duration is not a whole number of half-hour units');
  }
  return halfHourUnits(value / 30);
}
