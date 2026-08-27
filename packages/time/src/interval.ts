import type { Instant } from './instant';
import { TimeError } from './instant';

/**
 * Occupancy intervals are `[start_at, end_at)` — end-exclusive (`STAY-DEC-008`,
 * CLAUDE.md §5). A checkout at 12:00 and a check-in at 12:00 do not overlap.
 */
export interface HalfOpenInterval {
  readonly startAt: Instant;
  readonly endAt: Instant;
}

export function halfOpenInterval(startAt: Instant, endAt: Instant): HalfOpenInterval {
  if (endAt.getTime() <= startAt.getTime()) {
    throw new TimeError('an interval must end strictly after it starts');
  }
  return { startAt, endAt };
}

export function intervalContains(interval: HalfOpenInterval, at: Instant): boolean {
  const t = at.getTime();
  return t >= interval.startAt.getTime() && t < interval.endAt.getTime();
}

/** End-exclusive overlap: touching intervals do not overlap. */
export function intervalsOverlap(a: HalfOpenInterval, b: HalfOpenInterval): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

export function intervalMinutes(interval: HalfOpenInterval): number {
  const ms = interval.endAt.getTime() - interval.startAt.getTime();
  if (ms % 60_000 !== 0) {
    throw new TimeError('interval is not a whole number of minutes');
  }
  return ms / 60_000;
}
