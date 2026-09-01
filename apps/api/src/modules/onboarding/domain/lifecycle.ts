import type { PackageCode, SubscriptionSnapshot, SubscriptionState } from '@prsystem/authz';
import { GRACE_HOURS } from '@prsystem/authz';
import type { Instant } from '@prsystem/time';
import { addServiceMonths, instant } from '@prsystem/time';

/**
 * Subscription lifecycle arithmetic (doc 17, `LIFE-DEC-003`…`007`; doc 14,
 * `OPS-DEC-006`, `OPS-DEC-007`).
 *
 * Pure, and deliberately separate from the repository: every boundary in this
 * file is a rule from an approved decision, and a rule that can be unit-tested
 * against a supplied instant is one that can be tested *at* the boundary rather
 * than near it.
 */

/** The hotel timezone every calendar rule is evaluated in (`OPS-DEC-006`). */
export const HOTEL_TIMEZONE = 'Asia/Ulaanbaatar';

/** doc 17 §5.1: grace runs 48 hours past expiry, and never longer. */
export const GRACE_MILLISECONDS = GRACE_HOURS * 60 * 60 * 1000;

/**
 * doc 18 §7: a subscription inside its last 168 hours is `EXPIRING_SOON`.
 *
 * A warning state, not a degraded one — the operational matrix is unchanged.
 * It exists so the renew prompt appears before anything stops working.
 */
export const EXPIRING_SOON_HOURS = 168;
export const EXPIRING_SOON_MILLISECONDS = EXPIRING_SOON_HOURS * 60 * 60 * 1000;

/**
 * `OPS-DEC-006`: expiry is `starts_at` plus the chosen calendar months in the
 * hotel's own timezone, clamping to the last day of a shorter target month while
 * preserving the time of day.
 *
 * 31 January + 1 month is 28 or 29 February, not 3 March. Overflowing into the
 * next month would silently give away or take back a billing period.
 */
export function expiryFrom(startsAt: Date, termMonths: number): Date {
  return addServiceMonths(instant(startsAt), termMonths, HOTEL_TIMEZONE);
}

export function graceExpiryFrom(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + GRACE_MILLISECONDS);
}

export interface SubscriptionRowFacts {
  readonly hotelId: string;
  readonly effectivePackage: PackageCode;
  readonly expiresAt: Date;
  /** Set while an operator has suspended the subscription (doc 14 §5). */
  readonly suspendedAt: Date | null;
}

/**
 * The derived state, from the authoritative row and the server clock.
 *
 * Derived at read time and never stored: `OPS-DEC-016` requires exactly that,
 * and a stored state column would be a flag that drifts the moment the clock
 * passes a boundary nobody ran a job for.
 *
 * The boundaries are inclusive-of-the-earlier-state on purpose. At exactly
 * `expires_at` the hotel is in grace, not expired — doc 17 §5.1 says the rights
 * do not close *at* expiry — and at exactly `expires_at + 48h` the hard lock is
 * in force, because grace is 48 hours and not 48 hours plus an instant.
 */
export function deriveState(facts: SubscriptionRowFacts, now: Date): SubscriptionState {
  if (facts.suspendedAt !== null) return 'SUSPENDED';
  const expiry = facts.expiresAt.getTime();
  const millis = now.getTime();
  if (millis < expiry - EXPIRING_SOON_MILLISECONDS) return 'ACTIVE';
  if (millis < expiry) return 'EXPIRING_SOON';
  if (millis < expiry + GRACE_MILLISECONDS) return 'GRACE';
  return 'EXPIRED';
}

export function snapshotFrom(facts: SubscriptionRowFacts, now: Date): SubscriptionSnapshot {
  const state = deriveState(facts, now);
  return {
    hotelId: facts.hotelId,
    state,
    effectivePackage: facts.effectivePackage,
    ...(state === 'GRACE' ? { graceExpiresAt: graceExpiryFrom(facts.expiresAt) } : {}),
    asOf: now,
  };
}

/**
 * doc 17 §5.1 / `LIFE-DEC-004`: whether the public portal may show this hotel.
 *
 * Subscription truth only. Phase 12 owns the portal and the rest of the publish
 * gate — the room, price, photo and contact completeness of doc 15 §6 — and this
 * says nothing about those. It answers the one question Phase 05 can answer:
 * has the paid window, grace included, run out?
 */
export function listingEligible(facts: SubscriptionRowFacts, now: Date): boolean {
  const state = deriveState(facts, now);
  return state === 'ACTIVE' || state === 'EXPIRING_SOON' || state === 'GRACE';
}

/**
 * `OPS-DEC-007` / `LIFE-DEC-005`: where a renewal's new months are added from.
 *
 * Before expiry and inside grace the months continue from the existing expiry,
 * so renewing never costs the customer the unused tail and never hands them the
 * grace period as free time. After grace the paid window restarts at the
 * confirmed payment instant, because there is no live window left to continue.
 */
export function renewalAnchor(expiresAt: Date, paymentConfirmedAt: Date): Date {
  const graceEnd = expiresAt.getTime() + GRACE_MILLISECONDS;
  return paymentConfirmedAt.getTime() < graceEnd ? expiresAt : paymentConfirmedAt;
}

export interface RenewalOutcome {
  readonly startsAt: Date | undefined;
  readonly expiresAt: Date;
  /** True when the renewal restarted the window rather than extending it. */
  readonly restarted: boolean;
}

export function renewFrom(
  expiresAt: Date,
  paymentConfirmedAt: Date,
  termMonths: number,
): RenewalOutcome {
  const anchor = renewalAnchor(expiresAt, paymentConfirmedAt);
  const restarted = anchor.getTime() !== expiresAt.getTime();
  return {
    startsAt: restarted ? anchor : undefined,
    expiresAt: expiryFrom(anchor, termMonths),
    restarted,
  };
}

/**
 * doc 17 §4.1: the next service-month boundary strictly after `now`.
 *
 * A service month is the monthly recurrence of the *original* start instant, not
 * the calendar month: a subscription that began 2026-08-21 15:00 recurs on
 * 2026-09-21 15:00. An upgrade requested after a service month has begun uses
 * that month up at the old package, so the boundary is the next recurrence.
 */
export function nextServiceMonthBoundary(startsAt: Date, now: Date): Date {
  const anchor = instant(startsAt);
  for (let months = 1; months <= 1200; months += 1) {
    const candidate = addServiceMonths(anchor, months, HOTEL_TIMEZONE);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error('no service-month boundary within a century of the subscription start');
}

/**
 * doc 17 §4.2: the whole service months left between `effectiveAt` and expiry.
 *
 * Whole ones only. A partial month at the end is not charged for at the higher
 * package because the upgrade does not extend the term — `LIFE-DEC-002` is
 * explicit that `expires_at` is untouched — so a fraction of a month would be
 * charging for time the customer already owns.
 */
export function remainingWholeServiceMonths(
  startsAt: Date,
  effectiveAt: Date,
  expiresAt: Date,
): number {
  if (effectiveAt.getTime() >= expiresAt.getTime()) return 0;
  const anchor = instant(startsAt);
  let count = 0;
  for (let months = 1; months <= 1200; months += 1) {
    const boundary = addServiceMonths(anchor, months, HOTEL_TIMEZONE);
    if (boundary.getTime() <= effectiveAt.getTime()) continue;
    if (boundary.getTime() > expiresAt.getTime()) break;
    count += 1;
  }
  // The window from `effectiveAt` to the first boundary after it is the month
  // the upgrade opens in; the boundaries counted above are its ends. A term that
  // ends exactly on a boundary therefore has that month counted, and one that
  // ends between boundaries does not have the stub counted.
  return count;
}

/**
 * `LIFE-DEC-007`: when a higher-package renewal's entitlement actually opens.
 *
 * Paid while the current term is still running, the higher package waits for the
 * new term to begin — the customer has already been served this month at the old
 * one. Paid in grace or after it, the new term begins at confirmation, so the
 * entitlement opens with it.
 */
export function higherRenewalEffectiveAt(previousExpiresAt: Date, paymentConfirmedAt: Date): Date {
  return previousExpiresAt.getTime() > paymentConfirmedAt.getTime()
    ? previousExpiresAt
    : paymentConfirmedAt;
}

/** True when a paid pending upgrade's boundary has arrived (doc 17 §4.4). */
export function upgradeIsDue(effectiveAt: Date, now: Date): boolean {
  return effectiveAt.getTime() <= now.getTime();
}

export type { Instant };
