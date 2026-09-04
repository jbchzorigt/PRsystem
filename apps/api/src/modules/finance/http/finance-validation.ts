import { ApiError } from '@prsystem/contracts';
import type { ExpenseMethod, LocationKind, RequestKind } from '../repositories/finance.repository';

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [{ field, issue }]);
}

export function requireLocationKind(value: unknown): LocationKind {
  if (value === 'DRAWER' || value === 'SAFE') return value;
  fail('kind', 'must be DRAWER or SAFE');
}

export function requireRequestKind(value: unknown): RequestKind {
  if (value === 'BANK_DEPOSIT' || value === 'OWNER_WITHDRAWAL') return value;
  fail('kind', 'must be BANK_DEPOSIT or OWNER_WITHDRAWAL');
}

export function requireExpenseMethod(value: unknown): ExpenseMethod {
  if (value === 'CASH' || value === 'CARD_POS' || value === 'BANK_QPAY') return value;
  fail('method', 'must be CASH, CARD_POS or BANK_QPAY');
}

export function requireDecision(value: unknown): 'APPROVE' | 'REJECT' {
  if (value === 'APPROVE' || value === 'REJECT') return value;
  fail('decision', 'must be APPROVE or REJECT');
}

export function requireDirection(value: unknown): 'IN' | 'OUT' {
  if (value === 'IN' || value === 'OUT') return value;
  fail('direction', 'must be IN or OUT');
}

export function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail(field, `must be a string of 1 to ${String(max)} characters`);
  }
  return value.trim();
}
