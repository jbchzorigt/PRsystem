import type { PackageCode } from '@prsystem/authz';
import { PACKAGE_PRICE_MNT, PACKAGES } from '@prsystem/authz';
import type { Mnt } from '@prsystem/money';
import { mnt, mulMntByQuantity, subMnt } from '@prsystem/money';

/**
 * Subscription pricing (doc 16, `SUB-DEC-001`…`007`; doc 17 §4.2,
 * `LIFE-DEC-002`).
 *
 * Pure functions over integer MNT. Nothing here reads a request body: the
 * caller supplies a package and a term and gets the server's own figure back,
 * which is the whole point of doc 16 §3's "the backend recomputes the total".
 */

/** `SUB-DEC-002`: the only four terms. Anything else is not a shorter contract. */
export const TERM_MONTHS = [1, 3, 7, 12] as const;
export type TermMonths = (typeof TERM_MONTHS)[number];

export function isTermMonths(value: number): value is TermMonths {
  return (TERM_MONTHS as readonly number[]).includes(value);
}

/** The package lattice as a total order. `LIFE-DEC-001` is an ordering rule. */
export function packageRank(code: PackageCode): number {
  return PACKAGES.indexOf(code) + 1;
}

export function isUpgrade(from: PackageCode, to: PackageCode): boolean {
  return packageRank(to) > packageRank(from);
}

export function monthlyPrice(code: PackageCode): Mnt {
  return mnt(PACKAGE_PRICE_MNT[code]);
}

export class PricingError extends Error {
  override readonly name = 'PricingError';
}

export interface PriceSnapshot {
  readonly packageCode: PackageCode;
  readonly termMonths: TermMonths;
  readonly monthlyPriceMnt: Mnt;
  /** `SUB-DEC-003`: always zero in the MVP, and stated rather than omitted. */
  readonly discountMnt: Mnt;
  readonly totalAmountMnt: Mnt;
  readonly currency: 'MNT';
  readonly vatInclusive: true;
  readonly vatRateBp: number;
  readonly vatAmountMnt: Mnt;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
}

export interface PricingConfiguration {
  readonly vatRateBp: number;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
}

/**
 * The tax inside a VAT-inclusive amount, rounded half up.
 *
 * `SUB-DEC-006`: 20,000₮ is the final price the customer pays, so the VAT is a
 * share *of* it — `gross × rate / (10000 + rate)` — not an addition to it. The
 * arithmetic is integer throughout: `(2ar + d) / 2d` is the half-up rounding of
 * `ar / d` with no floating point anywhere near money (CLAUDE.md §5).
 */
export function vatInsideInclusive(gross: Mnt, vatRateBp: number): Mnt {
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) {
    throw new PricingError('the VAT rate must be integer basis points between 0 and 10000');
  }
  if (vatRateBp === 0) return mnt(0);
  const denominator = BigInt(10_000 + vatRateBp);
  return mnt((2n * (gross as bigint) * BigInt(vatRateBp) + denominator) / (2n * denominator));
}

/** `SUB-DEC-002`: total = monthly price × months, discount always zero. */
export function quoteTerm(
  packageCode: PackageCode,
  termMonths: number,
  configuration: PricingConfiguration,
): PriceSnapshot {
  if (!isTermMonths(termMonths)) {
    throw new PricingError('the term must be 1, 3, 7 or 12 calendar months');
  }
  const monthly = monthlyPrice(packageCode);
  const discount = mnt(0);
  const total = subMnt(mulMntByQuantity(monthly, termMonths), discount);
  return {
    packageCode,
    termMonths,
    monthlyPriceMnt: monthly,
    discountMnt: discount,
    totalAmountMnt: total,
    currency: 'MNT',
    vatInclusive: true,
    vatRateBp: configuration.vatRateBp,
    vatAmountMnt: vatInsideInclusive(total, configuration.vatRateBp),
    priceBookVersion: configuration.priceBookVersion,
    taxConfigVersion: configuration.taxConfigVersion,
    packageFeatureVersion: configuration.packageFeatureVersion,
  };
}

export interface UpgradeQuote {
  readonly currentPackage: PackageCode;
  readonly targetPackage: PackageCode;
  /** The per-month difference. Never negative: there is no downgrade. */
  readonly priceDeltaMnt: Mnt;
  readonly remainingServiceMonths: number;
  readonly totalAmountMnt: Mnt;
  readonly vatAmountMnt: Mnt;
  readonly vatRateBp: number;
  readonly monthlyPriceMnt: Mnt;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
}

/**
 * doc 17 §4.2 / §4.3: the upgrade difference.
 *
 * `(target monthly − basis monthly) × remaining whole service months`. The basis
 * is the *committed* package — the effective one ordinarily, and a paid pending
 * target when there is one, which is what makes a second upgrade incremental
 * rather than a re-charge of the first.
 *
 * Zero remaining whole months means no invoice at all (`LIFE-DEC-002`); the
 * caller offers a higher-package renewal instead. That is returned as
 * `undefined` rather than a zero quote, because a zero-amount invoice is a
 * payment nobody can make.
 */
export function quoteUpgrade(
  basisPackage: PackageCode,
  targetPackage: PackageCode,
  remainingServiceMonths: number,
  configuration: PricingConfiguration,
): UpgradeQuote | undefined {
  if (!isUpgrade(basisPackage, targetPackage)) {
    throw new PricingError('a subscription package is only ever raised (LIFE-DEC-001)');
  }
  if (!Number.isInteger(remainingServiceMonths) || remainingServiceMonths < 0) {
    throw new PricingError('the remaining whole service months must be a non-negative integer');
  }
  if (remainingServiceMonths === 0) return undefined;

  const delta = subMnt(monthlyPrice(targetPackage), monthlyPrice(basisPackage));
  const total = mulMntByQuantity(delta, remainingServiceMonths);
  return {
    currentPackage: basisPackage,
    targetPackage,
    priceDeltaMnt: delta,
    remainingServiceMonths,
    totalAmountMnt: total,
    vatAmountMnt: vatInsideInclusive(total, configuration.vatRateBp),
    vatRateBp: configuration.vatRateBp,
    monthlyPriceMnt: monthlyPrice(targetPackage),
    priceBookVersion: configuration.priceBookVersion,
    taxConfigVersion: configuration.taxConfigVersion,
    packageFeatureVersion: configuration.packageFeatureVersion,
  };
}

/**
 * `LIFE-DEC-001` and doc 17 §3: the floor a renewal may not quote below.
 *
 * The higher of the package in force and any paid pending upgrade target — so a
 * renewal cannot undo an upgrade somebody has already paid for by simply
 * arriving before the service-month boundary.
 */
export function renewalFloor(
  effectivePackage: PackageCode,
  pendingUpgradePackage: PackageCode | undefined,
): PackageCode {
  if (pendingUpgradePackage === undefined) return effectivePackage;
  return packageRank(pendingUpgradePackage) > packageRank(effectivePackage)
    ? pendingUpgradePackage
    : effectivePackage;
}
