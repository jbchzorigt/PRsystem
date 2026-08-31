import type { HotelRole } from '@prsystem/authz';
import { isHotelRole } from '@prsystem/authz';
import { ApiError, IDEMPOTENCY_HEADER } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';

/**
 * Request validation for the IAM surface.
 *
 * Hand-written and small on purpose: every value that reaches a command is
 * either a well-formed identifier, a known role, or a bounded string. Nothing
 * here decides authority — a `hotelId` that parses is still only a request
 * target until pipeline stage 4 has compared it against the actor's memberships
 * (doc 06 §2).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [{ field, issue }]);
}

export function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('body', 'a JSON object is required');
  }
  return value as Record<string, unknown>;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(field, 'must be a UUID');
  return value.toLowerCase();
}

export function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireUuid(value, field);
}

export function requireString(value: unknown, field: string, max = 320): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(field, 'must be a non-empty string');
  if (value.length > max) fail(field, `must be at most ${String(max)} characters`);
  return value;
}

export function requireRoles(value: unknown, field: string): readonly HotelRole[] {
  if (!Array.isArray(value) || value.length === 0) fail(field, 'at least one role is required');
  const roles: HotelRole[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isHotelRole(entry))
      fail(field, `unknown role: ${String(entry)}`);
    if (!roles.includes(entry)) roles.push(entry);
  }
  return roles;
}

export function requireRole(value: unknown, field: string): HotelRole {
  if (typeof value !== 'string' || !isHotelRole(value)) fail(field, 'unknown role');
  return value;
}

/**
 * The client-supplied idempotency key (CLAUDE.md §6).
 *
 * Required on every money-changing or lifecycle-changing command, and required
 * from the client rather than generated here: a key the server invents makes
 * every retry a new operation, which is the opposite of what it is for.
 */
export function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim().length < 8) {
    fail(IDEMPOTENCY_HEADER, 'an idempotency key of at least 8 characters is required');
  }
  if (value.length > 200) fail(IDEMPOTENCY_HEADER, 'must be at most 200 characters');
  return value;
}

export function requireMembershipState(value: unknown): 'SUSPENDED' | 'TERMINATED' | 'ACTIVE' {
  if (value === 'SUSPENDED' || value === 'TERMINATED' || value === 'ACTIVE') return value;
  fail('state', 'must be ACTIVE, SUSPENDED or TERMINATED');
}

export interface OpenWorkInput {
  readonly kind: 'reception_shift' | 'cleaner_task' | 'restaurant_order';
  readonly ref: string;
  readonly movementStarted?: boolean;
  readonly restaurantId?: string;
}

/**
 * Open work reported by the module that owns it.
 *
 * The reference is opaque and unvalidated beyond its shape: Phases 11, 09 and 15
 * own those aggregates, and IAM deliberately holds no foreign key into them.
 */
export function optionalOpenWork(value: unknown): readonly OpenWorkInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail('openWork', 'must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      fail(`openWork[${String(index)}]`, 'must be an object');
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    if (kind !== 'reception_shift' && kind !== 'cleaner_task' && kind !== 'restaurant_order') {
      fail(`openWork[${String(index)}].kind`, 'unknown subject kind');
    }
    const restaurantId = optionalUuid(
      record['restaurantId'],
      `openWork[${String(index)}].restaurantId`,
    );
    return {
      kind,
      ref: requireUuid(record['ref'], `openWork[${String(index)}].ref`),
      ...(record['movementStarted'] === true ? { movementStarted: true } : {}),
      ...(restaurantId === undefined ? {} : { restaurantId }),
    };
  });
}
