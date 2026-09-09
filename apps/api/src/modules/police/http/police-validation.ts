import { ApiError } from '@prsystem/contracts';
import { FALSE_MATCH_REASONS } from '../domain/police';
import type { CaseState, FalseMatchReason } from '../domain/police';

/**
 * What a Police request may say, and what it may not.
 *
 * The rejected list is what doc 13 keeps on the server: a match's workflow and
 * outcome, who acknowledged it, the detection times, and the account acting —
 * a request that named any of them would be asking the server to take its word
 * for a fact the server owns.
 */

const REJECTED_FIELDS = [
  'workflowstate',
  'outcome',
  'detectedat',
  'checkinrecordedat',
  'firstacknowledgedby',
  'foundbyaccountid',
  'accountid',
  'personid',
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

export function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${field} must be ${String(min)} to ${String(max)} characters`,
    );
  }
  return value.trim();
}

export function optionalText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireText(value, field, min, max);
}

export function requireRegistrationNumber(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'a registration number is required');
  }
  return value.trim();
}

const CASE_STATES: readonly CaseState[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
  'CANCELLED',
];

export function requireCaseState(value: unknown): CaseState {
  if (typeof value !== 'string' || !(CASE_STATES as readonly string[]).includes(value)) {
    throw new ApiError('VALIDATION_FAILED', `state must be one of ${CASE_STATES.join(', ')}`);
  }
  return value as CaseState;
}

export function requireFalseMatchReason(value: unknown): FalseMatchReason {
  if (typeof value !== 'string' || !(FALSE_MATCH_REASONS as readonly string[]).includes(value)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `reasonCode must be one of ${FALSE_MATCH_REASONS.join(', ')}`,
    );
  }
  return value as FalseMatchReason;
}

export function requireLocationKind(value: unknown): 'AT_MATCH_HOTEL' | 'OTHER_LOCATION' {
  if (value !== 'AT_MATCH_HOTEL' && value !== 'OTHER_LOCATION') {
    throw new ApiError(
      'VALIDATION_FAILED',
      'locationKind must be AT_MATCH_HOTEL or OTHER_LOCATION',
    );
  }
  return value;
}

export function requireRevision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError('VALIDATION_FAILED', 'expectedRevision must be a non-negative integer');
  }
  return parsed;
}

export function optionalInstant(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be an ISO instant`);
  }
  return parsed;
}
