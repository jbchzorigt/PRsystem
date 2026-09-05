import { ApiError } from '@prsystem/contracts';
import type { GeoPoint } from '@prsystem/ports';
import { isGeoPoint } from '@prsystem/ports';

/**
 * What a public search accepts — and, more importantly, what it refuses.
 *
 * doc 09 §4: a client-supplied distance is never trusted. The refusal here is
 * explicit rather than silent, so a client that sends `distanceMetres` is told
 * the server computes it; a field quietly ignored is a field somebody will
 * eventually assume was honoured.
 */

const REJECTED_FIELDS = ['distancemetres', 'distance', 'distancekm', 'sortdistance'];

export function rejectClientDistance(query: Record<string, unknown>): void {
  for (const key of Object.keys(query)) {
    if (REJECTED_FIELDS.includes(key.toLowerCase())) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'distance is computed by the server and is not accepted from the client',
      );
    }
  }
}

/** A calendar date, `YYYY-MM-DD`, read as midnight UTC. */
export function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  return parsed;
}

export function optionalText(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a short string`);
  }
  return value;
}

/**
 * The consented current position, in integer micro-degrees.
 *
 * Integers rather than decimals for the reason every other stored coordinate is
 * one: a float here and a float in the row would not compare equal, and the
 * distance an ordering depends on would wobble.
 */
export function optionalPoint(query: Record<string, unknown>): GeoPoint | undefined {
  const lat = query['latitudeMicro'];
  const lng = query['longitudeMicro'];
  if (lat === undefined && lng === undefined) return undefined;
  if (lat === undefined || lng === undefined) {
    throw new ApiError('VALIDATION_FAILED', 'give both latitudeMicro and longitudeMicro');
  }
  const point = { latitudeMicro: Number(lat), longitudeMicro: Number(lng) };
  if (!isGeoPoint(point)) {
    throw new ApiError('VALIDATION_FAILED', 'the position must be integer micro-degrees');
  }
  return point;
}

export function optionalRadius(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const radius = Number(value);
  if (!Number.isInteger(radius) || radius <= 0 || radius > 100_000) {
    throw new ApiError('VALIDATION_FAILED', 'radiusMetres must be whole metres up to 100000');
  }
  return radius;
}
