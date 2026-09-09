import { ApiError } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';
import {
  RECONCILIATION_OUTCOMES,
  SMS_MAX_CHARACTERS,
  isReasonCode,
  normaliseContactPhone,
} from '../domain/operation';
import type { ContactChallenge, RecoveryDecision } from '../domain/operation';
import { isOperationRoleName } from '../services/access.service';
import type { OperationRoleName } from '../services/access.service';

/**
 * Shape checks that run before any authority is consulted.
 *
 * Everything here refuses rather than coerces, and every refusal is
 * `VALIDATION_FAILED` with the field named. Two rules the module depends on
 * live here as well as deeper down: a server-owned field in a request body is
 * refused rather than ignored, and a phone reaches the services in exactly one
 * normalised shape.
 */

export function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const payload = request.body;
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('VALIDATION_FAILED', 'the request body must be an object');
  }
  return payload as Record<string, unknown>;
}

export function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [{ field, issue }]);
}

export function requireText(
  value: unknown,
  field: string,
  bounds: { min: number; max: number },
): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length < bounds.min || trimmed.length > bounds.max) {
    fail(field, `must be ${String(bounds.min)} to ${String(bounds.max)} characters`);
  }
  return trimmed;
}

export function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) fail(field, `must be at most ${String(max)} characters`);
  return trimmed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(field, 'must be a uuid');
  return value as string;
}

export function optionalUuidValue(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireUuidValue(value, field);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    fail(field, `must be an integer between ${String(bounds.min)} and ${String(bounds.max)}`);
  }
  return parsed;
}

export function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(field, 'must be an ISO-8601 instant');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(field, 'must be an ISO-8601 instant');
  return parsed;
}

export function requireCode(value: unknown, field: string, digits: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9]{${String(digits)}}$`).test(value)) {
    fail(field, `must be ${String(digits)} digits`);
  }
  return value as string;
}

export function requirePhone(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const normalised = normaliseContactPhone(value);
  if (normalised === undefined) fail(field, 'not a Mongolian eight-digit number');
  return normalised;
}

export function requireRole(value: unknown, field: string): OperationRoleName {
  if (typeof value !== 'string' || !isOperationRoleName(value)) {
    fail(field, 'must be OPERATION_ADMIN or PLATFORM_SUPER_ADMIN');
  }
  return value as OperationRoleName;
}

export function requirePermissions(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) fail(field, 'must be an array of permission names');
  const permissions = value as unknown[];
  if (permissions.length > 20) fail(field, 'at most twenty permissions');
  return permissions.map((permission, index) => {
    if (typeof permission !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(permission)) {
      fail(`${field}[${String(index)}]`, 'must be a permission name');
    }
    return permission as string;
  });
}

export function requireOutcome(
  value: unknown,
  field: string,
): (typeof RECONCILIATION_OUTCOMES)[number] {
  if (typeof value !== 'string' || !RECONCILIATION_OUTCOMES.includes(value as never)) {
    fail(field, 'unknown reconciliation outcome');
  }
  return value as (typeof RECONCILIATION_OUTCOMES)[number];
}

export function requireChallenge(value: unknown, field: string): ContactChallenge {
  if (value !== 'OLD_PHONE' && value !== 'NEW_PHONE') fail(field, 'must be OLD_PHONE or NEW_PHONE');
  return value;
}

export function requireDecision(value: unknown, field: string): RecoveryDecision {
  if (value !== 'APPROVED' && value !== 'REFUSED') fail(field, 'must be APPROVED or REFUSED');
  return value;
}

export function requireReasonCode(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isReasonCode(value)) {
    fail(field, 'must be an upper-case reason code of 3 to 40 characters');
  }
  return value;
}

export function requireSmsBody(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(field, 'the message is empty');
  if ([...trimmed].length > SMS_MAX_CHARACTERS) {
    fail(field, `the message is longer than ${String(SMS_MAX_CHARACTERS)} characters`);
  }
  return trimmed;
}

/**
 * Refuses a body that names a field the server owns.
 *
 * doc 05 §6: an account id, a role, a state or a timestamp in a request is a
 * claim, never an input. Ignoring one silently is how a client comes to believe
 * it was honoured, so the request is refused instead.
 */
export function refuseServerOwned(
  payload: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (payload[field] !== undefined) fail(field, 'is decided by the server');
  }
}

export function idempotencyKeyOf(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (typeof key !== 'string' || key.trim().length < 8 || key.trim().length > 200) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'an Idempotency-Key header of 8 to 200 characters is required',
    );
  }
  return key.trim();
}
