/**
 * The only division in the system (ADR-0007, 10-money-and-time-invariants §1.2).
 *
 * Every other money operation is addition, subtraction, or multiplication by an
 * integer quantity or basis-point rate. Confining division here is what makes
 * "rounding happens exactly once, at the point the requirements name" auditable
 * rather than aspirational.
 */

/** Thrown instead of returning a wrong number. */
export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/**
 * `ROUND_HALF_UP` on exact integer arithmetic: exact ties round **away from
 * zero**, which is the accounting reading of "half up" and keeps a reversal the
 * exact negative of the amount it reverses.
 */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyError('division by zero');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  // remainder/denominator >= 1/2  <=>  remainder*2 >= denominator
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}
