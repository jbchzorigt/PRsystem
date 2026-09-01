import { describe, expect, it } from 'vitest';
import { mnt } from '@prsystem/money';
import {
  PricingError,
  isTermMonths,
  packageRank,
  quoteTerm,
  quoteUpgrade,
  renewalFloor,
  vatInsideInclusive,
} from './pricing';

/**
 * doc 16 §2's approved price table, transcribed as assertions, plus the upgrade
 * arithmetic of doc 17 §4.2.
 */

const CONFIG = {
  vatRateBp: 1000,
  priceBookVersion: 'pb-test',
  taxConfigVersion: 'tax-test',
  packageFeatureVersion: 'pkg-test',
};

describe('SUB-DEC-001/002 — the approved price table', () => {
  // Exactly the table in doc 16 §2. Every cell, not a formula that happens to
  // agree with three of them.
  const TABLE = [
    ['P20', 1, 20_000],
    ['P20', 3, 60_000],
    ['P20', 7, 140_000],
    ['P20', 12, 240_000],
    ['P25', 1, 25_000],
    ['P25', 3, 75_000],
    ['P25', 7, 175_000],
    ['P25', 12, 300_000],
    ['P30', 1, 30_000],
    ['P30', 3, 90_000],
    ['P30', 7, 210_000],
    ['P30', 12, 360_000],
  ] as const;

  for (const [code, term, total] of TABLE) {
    it(`${code} × ${String(term)} months is ${String(total)}₮`, () => {
      const quote = quoteTerm(code, term, CONFIG);
      expect(quote.totalAmountMnt).toBe(BigInt(total));
      expect(quote.discountMnt).toBe(0n);
      expect(quote.currency).toBe('MNT');
      expect(quote.vatInclusive).toBe(true);
    });
  }

  it('refuses a term the document does not allow', () => {
    for (const term of [0, 2, 6, 13, 24]) {
      expect(isTermMonths(term)).toBe(false);
      expect(() => quoteTerm('P20', term, CONFIG)).toThrow(PricingError);
    }
  });

  it('stamps the price book, tax and feature versions onto every quote', () => {
    const quote = quoteTerm('P25', 7, CONFIG);
    expect({
      price: quote.priceBookVersion,
      tax: quote.taxConfigVersion,
      features: quote.packageFeatureVersion,
    }).toEqual({ price: 'pb-test', tax: 'tax-test', features: 'pkg-test' });
  });
});

describe('SUB-DEC-006 — the published price is VAT-inclusive', () => {
  it('takes the tax out of the price rather than adding it on top', () => {
    // 10% VAT inside 20,000₮ is 1,818₮ — not 2,000₮, which is what adding on top
    // would give, and not 1,819₮, which is what rounding the other way gives.
    expect(vatInsideInclusive(mnt(20_000), 1000)).toBe(1818n);
    expect(vatInsideInclusive(mnt(175_000), 1000)).toBe(15_909n);
    expect(vatInsideInclusive(mnt(360_000), 1000)).toBe(32_727n);
  });

  it('is zero at a zero rate, and refuses an implausible one', () => {
    expect(vatInsideInclusive(mnt(20_000), 0)).toBe(0n);
    expect(() => vatInsideInclusive(mnt(20_000), -1)).toThrow(PricingError);
    expect(() => vatInsideInclusive(mnt(20_000), 10_001)).toThrow(PricingError);
    expect(() => vatInsideInclusive(mnt(20_000), 10.5)).toThrow(PricingError);
  });

  it('never exceeds the gross it was taken from', () => {
    for (const gross of [1, 7, 999, 20_000, 360_000]) {
      expect(vatInsideInclusive(mnt(gross), 1000)).toBeLessThanOrEqual(BigInt(gross));
    }
  });
});

describe('LIFE-DEC-002 — the upgrade difference', () => {
  it('is the per-month difference times the remaining whole service months', () => {
    // The worked example in doc 17 §4.2: (25,000 − 20,000) × 8 = 40,000₮.
    const quote = quoteUpgrade('P20', 'P25', 8, CONFIG);
    expect(quote?.totalAmountMnt).toBe(40_000n);
    expect(quote?.priceDeltaMnt).toBe(5_000n);
  });

  it('is incremental on a paid pending target, never a re-charge', () => {
    // §4.3: on a paid 20→25, a second upgrade to 30 costs (30−25) × the same
    // months — not (30−20), which would charge the first upgrade twice.
    const quote = quoteUpgrade('P25', 'P30', 8, CONFIG);
    expect(quote?.totalAmountMnt).toBe(40_000n);
    expect(quote?.priceDeltaMnt).toBe(5_000n);
  });

  it('produces no invoice when no whole service month remains', () => {
    expect(quoteUpgrade('P20', 'P30', 0, CONFIG)).toBeUndefined();
  });

  it('refuses a downgrade and refuses an equal target', () => {
    expect(() => quoteUpgrade('P30', 'P20', 5, CONFIG)).toThrow(PricingError);
    expect(() => quoteUpgrade('P25', 'P20', 5, CONFIG)).toThrow(PricingError);
    expect(() => quoteUpgrade('P25', 'P25', 5, CONFIG)).toThrow(PricingError);
  });
});

describe('LIFE-DEC-001 — the renewal floor', () => {
  it('is the package in force when there is no pending upgrade', () => {
    expect(renewalFloor('P25', undefined)).toBe('P25');
  });

  it('rises to a paid pending target before the entitlement opens', () => {
    // The rule that stops a renewal quietly undoing an upgrade somebody paid for.
    expect(renewalFloor('P20', 'P30')).toBe('P30');
  });

  it('never falls below the package in force', () => {
    expect(renewalFloor('P30', 'P25')).toBe('P30');
  });

  it('orders the three packages the document does', () => {
    expect([packageRank('P20'), packageRank('P25'), packageRank('P30')]).toEqual([1, 2, 3]);
  });
});
