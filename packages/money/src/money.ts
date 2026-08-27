import { MoneyError, roundHalfUpDiv } from './rounding';

/**
 * MNT amounts (ADR-0007, CLAUDE.md §5).
 *
 * Whole tögrög as `bigint` — never `number`, never a scaled decimal, never a
 * string parsed at the edge. The brand stops an ordinary number reaching a
 * parameter that means money.
 */
declare const mntBrand: unique symbol;
export type Mnt = bigint & { readonly [mntBrand]: 'Mnt' };

/** PostgreSQL `bigint` range. A value outside it is a bug, not a large amount. */
const MIN_MNT = -(2n ** 63n);
const MAX_MNT = 2n ** 63n - 1n;

export const ZERO_MNT = 0n as Mnt;

function brand(value: bigint): Mnt {
  if (value < MIN_MNT || value > MAX_MNT) {
    throw new MoneyError('amount is outside the storable bigint range');
  }
  return value as Mnt;
}

/** Builds an `Mnt` from an integer. Rejects floats, so a rounding bug cannot enter here. */
export function mnt(value: bigint | number): Mnt {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MoneyError('MNT amounts are whole tögrög; a fractional number was supplied');
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError('number exceeds the safe integer range; supply a bigint');
    }
    return brand(BigInt(value));
  }
  return brand(value);
}

/**
 * Parses the wire form. The API serialises money as a JSON **string** so no
 * client parses it as an IEEE-754 double.
 */
export function mntFromJson(value: string): Mnt {
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyError('money must be an integer string');
  }
  return brand(BigInt(value));
}

/** The wire form. Always a string — never a JSON number. */
export function mntToJson(value: Mnt): string {
  return value.toString();
}

export function addMnt(a: Mnt, b: Mnt): Mnt {
  return brand(a + b);
}

export function subMnt(a: Mnt, b: Mnt): Mnt {
  return brand(a - b);
}

export function negateMnt(a: Mnt): Mnt {
  return brand(-a);
}

/** Multiplication by an integer quantity — nights, units, half-hour steps. Exact. */
export function mulMntByQuantity(amount: Mnt, quantity: number): Mnt {
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError('quantity must be a safe integer');
  }
  return brand(amount * BigInt(quantity));
}

export function sumMnt(amounts: readonly Mnt[]): Mnt {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return brand(total);
}

export function compareMnt(a: Mnt, b: Mnt): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isNegativeMnt(a: Mnt): boolean {
  return a < 0n;
}

/**
 * `ROUND_HALF_UP(amount × numerator / denominator)`.
 *
 * The single entry point for any money calculation that is not exact. A pipeline
 * calls it once, at the point the requirements name, and never on an already
 * rounded value.
 */
export function scaleMntRoundHalfUp(amount: Mnt, numerator: bigint, denominator: bigint): Mnt {
  return brand(roundHalfUpDiv(amount * numerator, denominator));
}
