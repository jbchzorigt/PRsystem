import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addMnt,
  applyRate,
  basisPoints,
  mnt,
  mntFromJson,
  mntToJson,
  mulMntByQuantity,
  negateMnt,
  percentToBasisPoints,
  roundHalfUpDiv,
  scaleMntRoundHalfUp,
  subMnt,
  sumMnt,
} from './index';

/** GATE-UNIT: `ROUND_HALF_UP` at `.5` boundaries, basis-point arithmetic, no float leakage. */

describe('roundHalfUpDiv', () => {
  it('rounds an exact tie away from zero', () => {
    expect(roundHalfUpDiv(5n, 2n)).toBe(3n);
    expect(roundHalfUpDiv(-5n, 2n)).toBe(-3n);
    expect(roundHalfUpDiv(1n, 2n)).toBe(1n);
    expect(roundHalfUpDiv(3n, 2n)).toBe(2n);
  });

  it('rounds below a tie toward zero', () => {
    expect(roundHalfUpDiv(4n, 3n)).toBe(1n);
    expect(roundHalfUpDiv(-4n, 3n)).toBe(-1n);
  });

  it('rounds above a tie away from zero', () => {
    expect(roundHalfUpDiv(5n, 3n)).toBe(2n);
    expect(roundHalfUpDiv(-5n, 3n)).toBe(-2n);
  });

  it('is exact when the division is exact', () => {
    expect(roundHalfUpDiv(10n, 5n)).toBe(2n);
    expect(roundHalfUpDiv(0n, 7n)).toBe(0n);
  });

  it('handles a negative denominator symmetrically', () => {
    expect(roundHalfUpDiv(5n, -2n)).toBe(-3n);
    expect(roundHalfUpDiv(-5n, -2n)).toBe(3n);
  });

  it('refuses division by zero rather than returning a wrong number', () => {
    expect(() => roundHalfUpDiv(1n, 0n)).toThrow(MoneyError);
  });

  it('stays exact far beyond the safe-integer range', () => {
    // A float would have lost precision several digits ago.
    expect(roundHalfUpDiv(90_071_992_547_409_931n, 2n)).toBe(45_035_996_273_704_966n);
  });
});

describe('Mnt', () => {
  it('rejects a fractional number', () => {
    expect(() => mnt(1000.5)).toThrow(MoneyError);
  });

  it('rejects a number beyond the safe integer range', () => {
    expect(() => mnt(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('adds, subtracts and sums exactly', () => {
    expect(addMnt(mnt(1000), mnt(2500))).toBe(3500n);
    expect(subMnt(mnt(1000), mnt(2500))).toBe(-1500n);
    expect(sumMnt([mnt(1), mnt(2), mnt(3)])).toBe(6n);
  });

  it('makes a reversal the exact negative of its amount', () => {
    const amount = mnt(123_457);
    expect(addMnt(amount, negateMnt(amount))).toBe(0n);
  });

  it('multiplies only by an integer quantity', () => {
    expect(mulMntByQuantity(mnt(45_000), 3)).toBe(135_000n);
    expect(() => mulMntByQuantity(mnt(45_000), 1.5)).toThrow(MoneyError);
  });

  it('crosses the wire as a string, never a JSON number', () => {
    expect(mntToJson(mnt(9_007_199_254_740_993n))).toBe('9007199254740993');
    expect(mntFromJson('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(() => mntFromJson('1000.5')).toThrow(MoneyError);
    expect(() => mntFromJson('1e3')).toThrow(MoneyError);
  });

  it('survives a JSON round trip without losing a tögrög', () => {
    const original = mnt(9_007_199_254_740_993n);
    expect(mntFromJson(mntToJson(original))).toBe(original);
  });
});

describe('basis points', () => {
  it('reads a percentage as an integer rate', () => {
    expect(basisPoints(500)).toBe(500);
    expect(percentToBasisPoints(5)).toBe(500);
    expect(percentToBasisPoints(12.5)).toBe(1250);
  });

  it('rejects a fractional or out-of-range rate', () => {
    expect(() => basisPoints(500.5)).toThrow(MoneyError);
    expect(() => basisPoints(-1)).toThrow(MoneyError);
    expect(() => basisPoints(10_001)).toThrow(MoneyError);
  });

  it('applies commission with a single ROUND_HALF_UP', () => {
    // 10 005 × 5% = 500.25 -> 500
    expect(applyRate(mnt(10_005), basisPoints(500))).toBe(500n);
    // 10 010 × 5% = 500.50 -> 501 (exact tie, away from zero)
    expect(applyRate(mnt(10_010), basisPoints(500))).toBe(501n);
  });

  it('never rounds twice in a pipeline', () => {
    const base = mnt(10_010);
    const once = applyRate(base, basisPoints(1000));
    const twiceRounded = applyRate(applyRate(base, basisPoints(10_000)), basisPoints(1000));
    expect(once).toBe(twiceRounded);
  });

  it('leaves a zero rate at zero and a full rate at the base', () => {
    expect(applyRate(mnt(7_777), basisPoints(0))).toBe(0n);
    expect(applyRate(mnt(7_777), basisPoints(10_000))).toBe(7_777n);
  });
});

describe('hourly total (STAY-DEC-014)', () => {
  it('rounds the half-hour formula exactly once', () => {
    // ROUND_HALF_UP(rate × half_hour_units / 2)
    const hourly = (rate: number, units: number): bigint =>
      scaleMntRoundHalfUp(mnt(rate), BigInt(units), 2n);

    expect(hourly(15_000, 3)).toBe(22_500n);
    expect(hourly(15_001, 3)).toBe(22_502n); // 22 501.5 -> 22 502
    expect(hourly(15_000, 2)).toBe(15_000n);
  });
});
