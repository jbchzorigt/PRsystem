import { ApiError } from '@prsystem/contracts';

/**
 * What a booking request accepts — and what it refuses to be told.
 *
 * The hotel is not among the fields. A Guest names a room category and the
 * server resolves the hotel from it, so a request can never choose the tenant
 * its command runs in. Neither is the booker: that comes from the session.
 */

const REJECTED_FIELDS = [
  'hotelid',
  'bookeraccountid',
  'accountid',
  'unitratemnt',
  'totalamountmnt',
];

export function rejectServerOwnedFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (REJECTED_FIELDS.includes(key.toLowerCase())) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `${key} is determined by the server and is not accepted from the client`,
      );
    }
  }
}

/** A calendar date, `YYYY-MM-DD`, read as midnight UTC — a whole night. */
export function requireDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  return parsed;
}

export function requireProvider(value: unknown): 'QPAY' | 'KHAAN' {
  if (value !== 'QPAY' && value !== 'KHAAN') {
    throw new ApiError('VALIDATION_FAILED', 'provider must be QPAY or KHAAN');
  }
  return value;
}

export function requireGuestName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new ApiError('VALIDATION_FAILED', 'stayingGuestName must be a name');
  }
  return value.trim();
}

export function optionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 300) {
    throw new ApiError('VALIDATION_FAILED', 'reason must be a short string');
  }
  return value;
}

/** A mandatory reason, for the actions doc 18 §3.3 requires one of. */
export function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 300) {
    throw new ApiError('VALIDATION_FAILED', 'reason is required and must be a short string');
  }
  return value.trim();
}
