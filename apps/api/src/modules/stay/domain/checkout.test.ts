import { describe, expect, it } from 'vitest';
import {
  availableToGuest,
  billableQuantity,
  checkoutStartBlockers,
  lineTotalMnt,
  lockOutcome,
  payableMnt,
  paymentBlockers,
  versionTotalMnt,
} from './checkout';

describe('doc 22 §8 — the billable quantity is a formula, not a judgement', () => {
  it('is what was there, plus what was refilled, less what left without a guest, less what is left', () => {
    expect(
      billableQuantity({
        openingQuantity: 5,
        refillQuantity: 2,
        nonGuestOutQuantity: 1,
        countedQuantity: 3,
      }),
    ).toBe(3);
    expect(
      availableToGuest({ openingQuantity: 5, refillQuantity: 2, nonGuestOutQuantity: 1 }),
    ).toBe(6);
  });

  it('never goes below zero, whatever the count says', () => {
    expect(
      billableQuantity({
        openingQuantity: 2,
        refillQuantity: 0,
        nonGuestOutQuantity: 0,
        countedQuantity: 5,
      }),
    ).toBe(0);
    expect(
      billableQuantity({
        openingQuantity: 1,
        refillQuantity: 0,
        nonGuestOutQuantity: 4,
        countedQuantity: 0,
      }),
    ).toBe(0);
  });

  it('an opening quantity of zero charges nothing until a refill is confirmed (PRICE-DEC-005)', () => {
    expect(
      billableQuantity({
        openingQuantity: 0,
        refillQuantity: 0,
        nonGuestOutQuantity: 0,
        countedQuantity: 0,
      }),
    ).toBe(0);
    expect(
      billableQuantity({
        openingQuantity: 0,
        refillQuantity: 2,
        nonGuestOutQuantity: 0,
        countedQuantity: 0,
      }),
    ).toBe(2);
  });

  it('refuses a fractional or negative quantity rather than rounding one', () => {
    expect(() =>
      billableQuantity({
        openingQuantity: 1.5,
        refillQuantity: 0,
        nonGuestOutQuantity: 0,
        countedQuantity: 0,
      }),
    ).toThrow();
    expect(() =>
      billableQuantity({
        openingQuantity: 1,
        refillQuantity: -1,
        nonGuestOutQuantity: 0,
        countedQuantity: 0,
      }),
    ).toThrow();
  });
});

describe('PRICE-DEC-007 — the amount is the server’s, in whole MNT', () => {
  it('multiplies the snapshot price by the billable quantity', () => {
    expect(lineTotalMnt(5_000n, 3)).toBe(15_000n);
    expect(lineTotalMnt(5_000n, 0)).toBe(0n);
    expect(versionTotalMnt([{ lineTotalMnt: 15_000n }, { lineTotalMnt: 5_000n }])).toBe(20_000n);
    expect(versionTotalMnt([])).toBe(0n);
  });

  it('refuses a negative price', () => {
    expect(() => lineTotalMnt(-1n, 1)).toThrow();
  });
});

describe('CHK-DEC-006 — a waiver reduces what is payable and edits nothing', () => {
  it('subtracts the waived amounts and stops at zero', () => {
    expect(payableMnt(20_000n, [5_000n])).toBe(15_000n);
    expect(payableMnt(20_000n, [15_000n, 5_000n])).toBe(0n);
    expect(payableMnt(20_000n, [25_000n])).toBe(0n);
    expect(payableMnt(20_000n, [])).toBe(20_000n);
  });
});

describe('CHK-DEC-004 — what a provider answer does to a locked version', () => {
  it('settles on success, releases only on a confirmed failure without funds, and otherwise holds', () => {
    expect(lockOutcome('SUCCEEDED')).toBe('SETTLE');
    expect(lockOutcome('FAILED_NO_FUNDS')).toBe('RELEASE');
    expect(lockOutcome('PENDING')).toBe('HOLD');
    expect(lockOutcome('UNKNOWN')).toBe('HOLD');
  });
});

describe('what refuses a checkout and what refuses a payment', () => {
  it('a pending correction and an open refill task both block the start', () => {
    expect(
      checkoutStartBlockers({ stayState: 'ACTIVE', correctionPending: false, openRefillTasks: 0 }),
    ).toEqual([]);
    expect(
      checkoutStartBlockers({ stayState: 'ACTIVE', correctionPending: true, openRefillTasks: 1 }),
    ).toEqual(['CORRECTION_PENDING', 'REFILL_TASK_OPEN']);
    expect(
      checkoutStartBlockers({
        stayState: 'CHECKOUT_IN_PROGRESS',
        correctionPending: false,
        openRefillTasks: 0,
      }),
    ).toEqual(['CHECKOUT_ALREADY_STARTED']);
  });

  it('a payment needs a submitted version and no open dispute', () => {
    expect(paymentBlockers({ reportState: 'SUBMITTED', openDisputes: 0 })).toEqual([]);
    expect(paymentBlockers({ reportState: 'RETURNED', openDisputes: 0 })).toEqual([
      'REPORT_NOT_SUBMITTED',
    ]);
    expect(paymentBlockers({ reportState: 'SUBMITTED', openDisputes: 2 })).toEqual([
      'DISPUTE_OPEN',
    ]);
  });
});
