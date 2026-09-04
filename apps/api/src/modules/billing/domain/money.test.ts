import { describe, expect, it } from 'vitest';
import {
  allocatableMnt,
  availableDepositMnt,
  depositRequirement,
  folioBalanceMnt,
  lateRefundPosting,
  referenceRequirements,
  refundEffect,
} from './money';

const totals = (over: Partial<Parameters<typeof availableDepositMnt>[0]> = {}) => ({
  receivedMnt: 100_000n,
  reversedMnt: 0n,
  allocatedMnt: 0n,
  refundReservedMnt: 0n,
  refundedMnt: 0n,
  ...over,
});

describe('DEP-DEC-007 — the available deposit', () => {
  it('is the receipt less what was reversed, allocated, reserved and paid out', () => {
    expect(availableDepositMnt(totals())).toBe(100_000n);
    expect(availableDepositMnt(totals({ allocatedMnt: 60_000n, refundReservedMnt: 20_000n }))).toBe(
      20_000n,
    );
    expect(availableDepositMnt(totals({ refundedMnt: 100_000n }))).toBe(0n);
  });

  it('a reserved refund keeps its money out of reach until it resolves', () => {
    const reserved = totals({ refundReservedMnt: 40_000n });
    expect(availableDepositMnt(reserved)).toBe(60_000n);
    expect(
      allocatableMnt({
        availableMnt: availableDepositMnt(reserved),
        balanceMnt: 80_000n,
        lineMnt: 80_000n,
      }),
    ).toBe(60_000n);
  });

  it('refuses a set of totals that would make it negative', () => {
    expect(() => availableDepositMnt(totals({ allocatedMnt: 120_000n }))).toThrow();
    expect(() => availableDepositMnt(totals({ receivedMnt: -1n }))).toThrow();
  });
});

describe('RC-DEC-001 — the folio balance', () => {
  it('is what was charged less what was paid and what the deposit covered', () => {
    expect(folioBalanceMnt({ chargedMnt: 80_000n, paidMnt: 0n, depositAppliedMnt: 0n })).toBe(
      80_000n,
    );
    expect(
      folioBalanceMnt({ chargedMnt: 80_000n, paidMnt: 20_000n, depositAppliedMnt: 60_000n }),
    ).toBe(0n);
  });

  it('refuses to be paid beyond what it charged', () => {
    expect(() =>
      folioBalanceMnt({ chargedMnt: 10_000n, paidMnt: 20_000n, depositAppliedMnt: 0n }),
    ).toThrow();
  });

  it('doc 20 §3: the deposit covers the smaller of what it has and what is owed', () => {
    expect(allocatableMnt({ availableMnt: 100_000n, balanceMnt: 80_000n, lineMnt: 80_000n })).toBe(
      80_000n,
    );
    expect(allocatableMnt({ availableMnt: 50_000n, balanceMnt: 80_000n, lineMnt: 80_000n })).toBe(
      50_000n,
    );
    expect(allocatableMnt({ availableMnt: 50_000n, balanceMnt: 80_000n, lineMnt: 20_000n })).toBe(
      20_000n,
    );
  });
});

describe('DEP-DEC-009 — what a provider answer does to a reservation', () => {
  it('only a success pays out; a failure and a void keep the money reserved', () => {
    expect(refundEffect('SUCCEEDED')).toEqual({
      state: 'SUCCEEDED',
      releasesReservation: true,
      paysOut: true,
    });
    expect(refundEffect('FAILED')).toMatchObject({ state: 'FAILED', paysOut: false });
    expect(refundEffect('VOIDED')).toMatchObject({ releasesReservation: false, paysOut: false });
    expect(refundEffect('PENDING')).toMatchObject({ state: 'PENDING', paysOut: false });
  });
});

describe('DEP-DEC-010 — a late success is covered as far as the deposit reaches', () => {
  it('pays what it can and books the rest as the hotel’s loss', () => {
    expect(lateRefundPosting({ availableMnt: 100_000n, providerRefundedMnt: 60_000n })).toEqual({
      coveredMnt: 60_000n,
      shortfallMnt: 0n,
    });
    expect(lateRefundPosting({ availableMnt: 20_000n, providerRefundedMnt: 60_000n })).toEqual({
      coveredMnt: 20_000n,
      shortfallMnt: 40_000n,
    });
    expect(lateRefundPosting({ availableMnt: 0n, providerRefundedMnt: 60_000n })).toEqual({
      coveredMnt: 0n,
      shortfallMnt: 60_000n,
    });
  });
});

describe('DEP-DEC-005 / RC-DEC-003 — what each channel and each source needs', () => {
  it('a manual POS movement carries a reference and an approval code; cash belongs to a shift', () => {
    expect(referenceRequirements('MANUAL_POS')).toEqual({
      providerReference: true,
      approvalCode: true,
      shift: false,
    });
    expect(referenceRequirements('QPAY')).toMatchObject({ providerReference: true, shift: false });
    expect(referenceRequirements('CASH')).toMatchObject({ providerReference: false, shift: true });
  });

  it('a walk-in owes the configured deposit, category over hotel; an online stay owes none', () => {
    expect(
      depositRequirement({ source: 'ONLINE', categoryAmountMnt: 60_000n, hotelAmountMnt: 50_000n }),
    ).toEqual({ required: false });
    expect(
      depositRequirement({
        source: 'WALK_IN',
        categoryAmountMnt: 60_000n,
        hotelAmountMnt: 50_000n,
      }),
    ).toEqual({ required: true, amountMnt: 60_000n, scope: 'CATEGORY' });
    expect(
      depositRequirement({ source: 'WALK_IN', categoryAmountMnt: null, hotelAmountMnt: 50_000n }),
    ).toEqual({ required: true, amountMnt: 50_000n, scope: 'HOTEL' });
    expect(() =>
      depositRequirement({ source: 'WALK_IN', categoryAmountMnt: null, hotelAmountMnt: null }),
    ).toThrow(/DEPOSIT_NOT_CONFIGURED/);
  });
});
