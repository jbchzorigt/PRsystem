import { ApiError } from '@prsystem/contracts';
import { requireString, requireUuid } from '../../iam/http/validation';
import type { Channel } from '../domain/money';

/** Request validation for the billing routes. Shape only; the rules are the services'. */

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
}

export function requireChannel(value: unknown): Channel {
  if (value === 'CASH' || value === 'QPAY' || value === 'CARD_GATEWAY' || value === 'MANUAL_POS') {
    return value;
  }
  return fail('channel', 'must be CASH, QPAY, CARD_GATEWAY or MANUAL_POS');
}

/** Whole MNT, never a float and never a client-computed total (CLAUDE.md §5). */
export function requireAmountMnt(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1)
      return fail(field, 'must be a whole positive amount');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/u.test(value)) {
    return fail(field, 'must be a whole positive amount in MNT');
  }
  return BigInt(value);
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, max);
}

export function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireUuid(value, field);
}
