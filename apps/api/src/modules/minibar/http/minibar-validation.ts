import { ApiError } from '@prsystem/contracts';
import type { StockLine, TargetLine } from '../domain/inventory';
import { isCorrectionType } from '../domain/inventory';
import type { CorrectionType } from '../domain/inventory';
import type { ChangeKind } from '../repositories/configuration.repository';
import { requireUuid } from '../../iam/http/validation';

/**
 * Request validation for the minibar surface. Quantities are integers,
 * money is integer MNT, and a list of lines is bounded and free of duplicates
 * before any command sees it. Nothing here decides authority.
 */

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [{ field, issue }]);
}

export function requireQuantity(value: unknown, field: string, min = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 1_000_000) {
    fail(field, `must be an integer of at least ${String(min)}`);
  }
  return value;
}

export function requireTargetLines(value: unknown, field: string): readonly TargetLine[] {
  if (!Array.isArray(value)) fail(field, 'must be an array of { productId, targetQuantity }');
  if (value.length > 200) fail(field, 'at most 200 lines');
  const lines: TargetLine[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) fail(`${field}[${String(index)}]`, 'object');
    const line = entry as Record<string, unknown>;
    const productId = requireUuid(line['productId'], `${field}[${String(index)}].productId`);
    if (seen.has(productId)) fail(`${field}[${String(index)}].productId`, 'duplicate product');
    seen.add(productId);
    lines.push({
      productId,
      targetQuantity: requireQuantity(
        line['targetQuantity'],
        `${field}[${String(index)}].targetQuantity`,
      ),
    });
  }
  return lines;
}

export function requireStockLines(value: unknown, field: string, min = 0): readonly StockLine[] {
  if (!Array.isArray(value)) fail(field, 'must be an array of { productId, quantity }');
  if (value.length > 200) fail(field, 'at most 200 lines');
  const lines: StockLine[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) fail(`${field}[${String(index)}]`, 'object');
    const line = entry as Record<string, unknown>;
    const productId = requireUuid(line['productId'], `${field}[${String(index)}].productId`);
    if (seen.has(productId)) fail(`${field}[${String(index)}].productId`, 'duplicate product');
    seen.add(productId);
    lines.push({
      productId,
      quantity: requireQuantity(line['quantity'], `${field}[${String(index)}].quantity`, min),
    });
  }
  return lines;
}

export function requireCorrectionType(value: unknown): CorrectionType {
  if (typeof value !== 'string' || !isCorrectionType(value)) {
    fail('type', 'must be WASTE, ADJUST_PLUS or ADJUST_MINUS');
  }
  return value;
}

const CHANGE_KINDS: readonly ChangeKind[] = [
  'ON_TO_OFF',
  'OFF_TO_ON',
  'TEMPLATE_SWITCH',
  'VERSION_ROLLOUT',
];

export function requireChangeKind(value: unknown): ChangeKind {
  if (typeof value !== 'string' || !(CHANGE_KINDS as readonly string[]).includes(value)) {
    fail('kind', 'must be ON_TO_OFF, OFF_TO_ON, TEMPLATE_SWITCH or VERSION_ROLLOUT');
  }
  return value as ChangeKind;
}

export function requireUuidList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(field, 'must be a non-empty array of UUIDs');
  if (value.length > 500) fail(field, 'at most 500 entries');
  return (value as unknown[]).map((entry, index) =>
    requireUuid(entry, `${field}[${String(index)}]`),
  );
}
