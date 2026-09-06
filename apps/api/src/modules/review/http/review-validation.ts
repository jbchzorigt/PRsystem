import { ApiError } from '@prsystem/contracts';
import type { ReportReason, ReportResolution } from '../domain/review';
import { isReportReason } from '../domain/review';

/**
 * What a review request accepts — and what it refuses to be told.
 *
 * The hotel is not among the fields, and neither is the status. doc 10 §3 is
 * explicit that eligibility is decided from the server's own booking and stay
 * rows; a request that names a hotel, an account or a booking status is refused
 * rather than quietly ignored, so a field dropped today cannot become a field
 * honoured tomorrow.
 */

const REJECTED_FIELDS = [
  'hotelid',
  'accountid',
  'status',
  'bookingstate',
  'reviewdeadlineat',
  'actualcheckoutat',
  'displayname',
  'displaynamesnapshot',
  'edited',
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

/** doc 10 §5: whole stars only. A fraction is a validation failure, not a round. */
export function requireRating(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new ApiError('VALIDATION_FAILED', 'rating must be a whole number of stars, 1 to 5');
  }
  return value;
}

/**
 * The raw comment.
 *
 * Length is *not* checked here: doc 10 §5 measures it after trimming, and the
 * domain does the trimming. Refusing a padded 1000-character comment at the
 * edge would refuse one that is legal once trimmed.
 */
export function requireComment(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('VALIDATION_FAILED', 'comment must be a string');
  }
  if (value.length > 4000) {
    throw new ApiError('VALIDATION_FAILED', 'comment is far longer than 1000 characters');
  }
  return value;
}

export function requireReplyBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('VALIDATION_FAILED', 'body must be a string');
  }
  if (value.length > 4000) {
    throw new ApiError('VALIDATION_FAILED', 'body is far longer than 1000 characters');
  }
  return value;
}

export function requireReportReason(value: unknown): ReportReason {
  if (typeof value !== 'string' || !isReportReason(value)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'reason must be PERSONAL_DATA, ABUSE_ILLEGAL, SPAM_FRAUD or OTHER',
    );
  }
  return value;
}

export function requireResolution(value: unknown): ReportResolution {
  if (value !== 'UPHELD' && value !== 'DISMISSED') {
    throw new ApiError('VALIDATION_FAILED', 'resolution must be UPHELD or DISMISSED');
  }
  return value;
}

export function requireNote(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('VALIDATION_FAILED', 'note must be a string');
  }
  if (value.length > 2000) {
    throw new ApiError('VALIDATION_FAILED', 'note is far longer than 500 characters');
  }
  return value;
}

export function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireNote(value);
}

export function requireReplyState(value: unknown): 'ACTIVE' | 'DELETED' {
  if (value !== 'ACTIVE' && value !== 'DELETED') {
    throw new ApiError('VALIDATION_FAILED', 'state must be ACTIVE or DELETED');
  }
  return value;
}

export function optionalLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `limit must be a whole number from 1 to ${String(max)}`,
    );
  }
  return parsed;
}
