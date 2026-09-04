import { describe, expect, it } from 'vitest';
import type { BatchChild, PublishCandidateItem } from './versions';
import {
  canTransitionVersion,
  deriveBatchState,
  isTerminalChange,
  publishRefusals,
  rolloutEligibility,
} from './versions';

describe('RML-DEC-016 — the version edges', () => {
  it('draws DRAFT → PUBLISHED → ARCHIVED and nothing back', () => {
    expect(canTransitionVersion('DRAFT', 'PUBLISHED')).toBe(true);
    expect(canTransitionVersion('PUBLISHED', 'ARCHIVED')).toBe(true);
    expect(canTransitionVersion('ARCHIVED', 'PUBLISHED')).toBe(false);
    expect(canTransitionVersion('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransitionVersion('DRAFT', 'ARCHIVED')).toBe(false);
  });
});

describe('RML-DEC-018 — publish validation reports every failing rule', () => {
  const ok = (id: string): PublishCandidateItem => ({
    productId: id,
    targetQuantity: 2,
    productState: 'ACTIVE',
    productHotelId: 'h',
    priced: true,
  });

  it('passes a well-formed draft', () => {
    expect(
      publishRefusals({ parentState: 'ACTIVE', hotelId: 'h', items: [ok('a'), ok('b')] }),
    ).toEqual([]);
  });

  it('lists a retiring parent, an empty list, a foreign, inactive, duplicated, unpriced or zero-target product', () => {
    const refusals = publishRefusals({
      parentState: 'RETIRING',
      hotelId: 'h',
      items: [
        { ...ok('a'), productHotelId: 'other' },
        { ...ok('b'), productState: 'RETIRING' },
        { ...ok('b') },
        { ...ok('c'), targetQuantity: 0 },
        { ...ok('d'), priced: false },
      ],
    });
    expect(refusals.map((r) => r.code)).toEqual([
      'PARENT_NOT_ACTIVE',
      'PRODUCT_FOREIGN',
      'PRODUCT_NOT_ACTIVE',
      'PRODUCT_DUPLICATE',
      'TARGET_NOT_POSITIVE',
      'PRODUCT_UNPRICED',
    ]);
    expect(publishRefusals({ parentState: 'ACTIVE', hotelId: 'h', items: [] })).toEqual([
      { code: 'NO_ITEMS' },
    ]);
  });
});

describe('RML-DEC-026 — batch state is derived from the children, mutually exclusively', () => {
  const accepted = (
    changeState: NonNullable<BatchChild['changeState']>,
    movementStarted = false,
  ): BatchChild => ({
    result: 'ACCEPTED',
    changeState,
    movementStarted,
  });
  const skipped: BatchChild = { result: 'SKIPPED' };

  const table: [string, BatchChild[], string][] = [
    ['no room accepted', [skipped, skipped], 'FAILED_VALIDATION'],
    ['an accepted child still open', [accepted('APPLIED'), accepted('IN_PROGRESS')], 'IN_PROGRESS'],
    ['a scheduled child still open', [accepted('SCHEDULED_AFTER_STAY'), skipped], 'IN_PROGRESS'],
    ['every room accepted and applied', [accepted('APPLIED'), accepted('APPLIED')], 'COMPLETED'],
    [
      'every accepted child cancelled before movement',
      [accepted('CANCELLED'), accepted('CANCELLED'), skipped],
      'CANCELLED',
    ],
    ['applied and skipped mixed', [accepted('APPLIED'), skipped], 'PARTIALLY_COMPLETED'],
    [
      'applied and cancelled mixed',
      [accepted('APPLIED'), accepted('CANCELLED')],
      'PARTIALLY_COMPLETED',
    ],
    [
      'rolled back after movement',
      [accepted('ROLLED_BACK', true), accepted('APPLIED')],
      'PARTIALLY_COMPLETED',
    ],
    [
      'cancelled, but one had moved and was rolled back',
      [accepted('CANCELLED'), accepted('ROLLED_BACK', true)],
      'PARTIALLY_COMPLETED',
    ],
  ];
  for (const [label, children, expected] of table) {
    it(`${label} → ${expected}`, () => {
      expect(deriveBatchState(children)).toBe(expected);
    });
  }

  it('names exactly the three terminal change states', () => {
    expect(['APPLIED', 'CANCELLED', 'ROLLED_BACK'].every((s) => isTerminalChange(s as never))).toBe(
      true,
    );
    expect(
      [
        'SCHEDULED_AFTER_STAY',
        'READY_FOR_RECONCILIATION',
        'IN_PROGRESS',
        'BLOCKED_STOCK',
        'BLOCKED_VARIANCE',
        'ROLLBACK_REQUIRED',
      ].some((s) => isTerminalChange(s as never)),
    ).toBe(false);
  });
});

describe('RML-DEC-022 — room eligibility for a Rollout', () => {
  const room = {
    roomState: 'ACTIVE' as const,
    mode: 'ON' as const,
    currentTemplateId: 't',
    currentVersionId: 'v1',
    hasPendingChange: false,
    safePoint: true,
  };
  const target = {
    templateId: 't',
    versionId: 'v2',
    versionState: 'PUBLISHED' as const,
    templateState: 'ACTIVE' as const,
    everyProductActive: true,
  };

  it('is READY_NOW for an active, ON room on the same template and another version at a safe point', () => {
    expect(rolloutEligibility(room, target)).toEqual({ kind: 'READY_NOW' });
    expect(rolloutEligibility({ ...room, safePoint: false }, target)).toEqual({
      kind: 'SCHEDULE_AFTER_STAY',
    });
  });

  it('names the reason for every ineligible case', () => {
    expect(rolloutEligibility(room, { ...target, versionState: 'DRAFT' })).toEqual({
      kind: 'INELIGIBLE',
      code: 'TARGET_NOT_PUBLISHED',
    });
    expect(rolloutEligibility(room, { ...target, templateState: 'RETIRING' })).toEqual({
      kind: 'INELIGIBLE',
      code: 'TARGET_TEMPLATE_NOT_ACTIVE',
    });
    expect(rolloutEligibility(room, { ...target, everyProductActive: false })).toEqual({
      kind: 'INELIGIBLE',
      code: 'TARGET_PRODUCT_NOT_ACTIVE',
    });
    expect(rolloutEligibility({ ...room, roomState: 'RETIRING' }, target)).toEqual({
      kind: 'INELIGIBLE',
      code: 'ROOM_NOT_ACTIVE',
    });
    expect(
      rolloutEligibility(
        { ...room, mode: 'OFF', currentTemplateId: null, currentVersionId: null },
        target,
      ),
    ).toEqual({ kind: 'INELIGIBLE', code: 'MINIBAR_OFF' });
    expect(rolloutEligibility({ ...room, currentTemplateId: 'other' }, target)).toEqual({
      kind: 'INELIGIBLE',
      code: 'DIFFERENT_TEMPLATE',
    });
    expect(rolloutEligibility({ ...room, currentVersionId: 'v2' }, target)).toEqual({
      kind: 'INELIGIBLE',
      code: 'ALREADY_ON_TARGET',
    });
    expect(rolloutEligibility({ ...room, hasPendingChange: true }, target)).toEqual({
      kind: 'INELIGIBLE',
      code: 'PENDING_CHANGE',
    });
  });
});
