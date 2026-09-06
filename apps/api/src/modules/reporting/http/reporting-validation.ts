import { ApiError } from '@prsystem/contracts';
import { PAGE_SIZES, isPageSize } from '../domain/reporting';
import { EXPORT_KINDS } from '../repositories/reporting.repository';
import type { ExportKind } from '../repositories/reporting.repository';

/**
 * What a registry or dashboard request accepts — and what it refuses.
 *
 * The rejected list is short because these are read surfaces, but it matters
 * for the same reason it does on a command: doc 12 §5 and doc 23 §10 decide
 * what a report may contain and in whose scope it runs, and a request that
 * named an age, a row count or another hotel would be asking the server to
 * take its word for one of those.
 */

const REJECTED_FIELDS = ['age', 'rownumber', 'totalrows', 'hotelid', 'rowcount', 'storagekey'];

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

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function optionalLocalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !LOCAL_DATE.test(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  return value;
}

/** doc 12 §4: a size outside the list is refused, never silently replaced. */
export function optionalPageSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !isPageSize(parsed)) {
    throw new ApiError('VALIDATION_FAILED', `pageSize must be one of ${PAGE_SIZES.join(', ')}`);
  }
  return parsed;
}

export function optionalPage(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new ApiError('VALIDATION_FAILED', 'page must be a whole number from 1');
  }
  return parsed;
}

export function optionalStayState(value: unknown): 'ACTIVE' | 'COMPLETED' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'ACTIVE' && value !== 'COMPLETED') {
    throw new ApiError('VALIDATION_FAILED', 'stayState must be ACTIVE or COMPLETED');
  }
  return value;
}

/**
 * The name search, bounded but not otherwise inspected.
 *
 * doc 12 §8 keeps the raw search value out of URLs, analytics and ordinary
 * application logs — which is why every registry route reads it from the body
 * rather than from a query string.
 */
export function optionalSearch(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 120) {
    throw new ApiError('VALIDATION_FAILED', 'nameSearch must be a short string');
  }
  return value;
}

export function requireExportKind(value: unknown): ExportKind {
  if (typeof value !== 'string' || !(EXPORT_KINDS as readonly string[]).includes(value)) {
    throw new ApiError('VALIDATION_FAILED', `kind must be one of ${EXPORT_KINDS.join(', ')}`);
  }
  return value as ExportKind;
}

export function optionalQuickRange(
  value: unknown,
): 'LAST_7_DAYS' | 'THIS_MONTH' | 'CUSTOM' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'LAST_7_DAYS' && value !== 'THIS_MONTH' && value !== 'CUSTOM') {
    throw new ApiError('VALIDATION_FAILED', 'range must be LAST_7_DAYS, THIS_MONTH or CUSTOM');
  }
  return value;
}

export function optionalTopBy(value: unknown): 'DEMAND' | 'REVENUE' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'DEMAND' && value !== 'REVENUE') {
    throw new ApiError('VALIDATION_FAILED', 'topBy must be DEMAND or REVENUE');
  }
  return value;
}

export function requireCategoryKind(value: unknown): 'INVENTORY_PURCHASE' | 'OPERATING' {
  if (value !== 'INVENTORY_PURCHASE' && value !== 'OPERATING') {
    throw new ApiError('VALIDATION_FAILED', 'kind must be INVENTORY_PURCHASE or OPERATING');
  }
  return value;
}

export function requireHoldReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 500) {
    throw new ApiError('VALIDATION_FAILED', 'reason must be 10 to 500 characters');
  }
  return value.trim();
}

export function requireAuthorityReference(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 200) {
    throw new ApiError('VALIDATION_FAILED', 'authorityReference is required');
  }
  return value.trim();
}
