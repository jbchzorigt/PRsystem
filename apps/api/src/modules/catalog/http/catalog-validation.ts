import { ApiError } from '@prsystem/contracts';
import type { EntityKind, EntityState } from '../domain/lifecycle';
import { isCreatableState } from '../domain/lifecycle';
import type { Channel, StayType } from '../domain/tariffs';
import { CHANNELS, STAY_TYPES } from '../domain/tariffs';
import type { SubjectType } from '../services/tariff.service';
import { isSubjectType } from '../services/tariff.service';

/**
 * Request validation for the catalog surface.
 *
 * Money arrives as an integer number of tugrik or as a string of digits, and
 * leaves as a `bigint`; nothing here accepts a fraction or a float
 * (CLAUDE.md §5). Three answers are kept distinct for every clearable field:
 * absent leaves the value alone, `null` clears it back to inherited, and a
 * value sets it. Collapsing "absent" into "clear" is how an unrelated edit
 * would silently drop an override.
 */

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [{ field, issue }]);
}

const DIGITS = /^[0-9]{1,18}$/;

export function requireMnt(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(field, 'must be a non-negative integer');
    return BigInt(value);
  }
  if (typeof value === 'string' && DIGITS.test(value)) return BigInt(value);
  fail(field, 'must be a non-negative integer amount in MNT');
}

/** absent → `undefined`, `null` → `null`, otherwise a validated amount. */
export function assignableMnt(value: unknown, field: string): bigint | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireMnt(value, field);
}

export function requireMinutes(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    fail(field, `must be an integer between 0 and ${String(max)}`);
  }
  return value;
}

export function assignableMinutes(
  value: unknown,
  field: string,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireMinutes(value, field, max);
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(field, 'must be a non-empty string');
  }
  if (value.length > max) fail(field, `must be at most ${String(max)} characters`);
  return value;
}

export function assignableString(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === null) return null;
  return optionalString(value, field, max);
}

export function requireCreatableState(value: unknown): EntityState {
  if (value === undefined) return 'ACTIVE';
  if (typeof value !== 'string' || !isCreatableState(value)) {
    fail('state', 'must be ACTIVE or INACTIVE');
  }
  return value;
}

export function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('expectedRevision', 'must be the non-negative integer revision that was read');
  }
  return value;
}

export function requireStayType(value: unknown): StayType {
  if (typeof value !== 'string' || !(STAY_TYPES as readonly string[]).includes(value)) {
    fail('stayType', 'must be HOURLY or NIGHTLY');
  }
  return value as StayType;
}

export function requireChannel(value: unknown): Channel {
  if (typeof value !== 'string' || !(CHANNELS as readonly string[]).includes(value)) {
    fail('channel', 'must be WALK_IN or ONLINE');
  }
  return value as Channel;
}

export function requireSubjectType(value: unknown): SubjectType {
  if (typeof value !== 'string' || !isSubjectType(value)) {
    fail('subjectType', 'must be WALK_IN_STAY or ONLINE_BOOKING');
  }
  return value;
}

/** The path segments of the lifecycle surface, mapped to the entity kinds. */
const KIND_BY_SEGMENT: Readonly<Record<string, EntityKind>> = {
  rooms: 'ROOM',
  categories: 'ROOM_CATEGORY',
  'minibar-products': 'MINIBAR_PRODUCT',
  'minibar-templates': 'MINIBAR_TEMPLATE',
};

export function requireEntityKind(segment: string): EntityKind {
  const kind = KIND_BY_SEGMENT[segment];
  if (kind === undefined) fail('entityKind', 'unknown catalog entity kind');
  return kind;
}
