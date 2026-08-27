import type { Mnt } from './money';
import { scaleMntRoundHalfUp } from './money';
import { MoneyError } from './rounding';

/**
 * Percentage rates as integer basis points (ADR-0007, `PAY-DEC-008`).
 *
 * `5% = 500 bps`. A decimal fraction is never used, so a rate can never carry a
 * binary-floating-point error into a money calculation.
 */
declare const bpsBrand: unique symbol;
export type BasisPoints = number & { readonly [bpsBrand]: 'BasisPoints' };

export const BPS_DENOMINATOR = 10_000n;

/** 0 bps … 10 000 bps. A rate above 100% is rejected rather than silently applied. */
export function basisPoints(value: number): BasisPoints {
  if (!Number.isInteger(value)) {
    throw new MoneyError('basis points must be an integer');
  }
  if (value < 0 || value > 10_000) {
    throw new MoneyError('basis points must be between 0 and 10000');
  }
  return value as BasisPoints;
}

export function percentToBasisPoints(percent: number): BasisPoints {
  if (!Number.isInteger(percent * 100)) {
    throw new MoneyError('percent must resolve to a whole number of basis points');
  }
  return basisPoints(Math.round(percent * 100));
}

/**
 * `ROUND_HALF_UP(base × rate_bps / 10 000)` — the commission and fee formula of
 * 10-money-and-time-invariants §1.2. Rounds exactly once.
 */
export function applyRate(base: Mnt, rate: BasisPoints): Mnt {
  return scaleMntRoundHalfUp(base, BigInt(rate), BPS_DENOMINATOR);
}
