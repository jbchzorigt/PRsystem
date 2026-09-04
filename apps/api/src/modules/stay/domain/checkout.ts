/**
 * The arithmetic and the decisions of a checkout, as pure functions.
 *
 * doc 22 §8 states the billable quantity as a formula, doc 25 states that the
 * price is the stay's own snapshot, and doc 21 §5 states exactly which provider
 * answers release a locked report. Each is written here once, tested on its own,
 * and used by the services; the database repeats the two that are invariants of
 * a stored row (`CHK-DEC-004`, `PRICE-DEC-005`, `-007`).
 */

export type ProviderStatus = 'PENDING' | 'UNKNOWN' | 'FAILED_NO_FUNDS' | 'SUCCEEDED';

export interface BillableInput {
  /** The quantity the price book recorded in the room at check-in. */
  readonly openingQuantity: number;
  /** What confirmed active-stay refill tasks added during the stay. */
  readonly refillQuantity: number;
  /** What left the room without a guest consuming it: return, waste, negative adjustment. */
  readonly nonGuestOutQuantity: number;
  /** What the Cleaner counted at the checkout. */
  readonly countedQuantity: number;
}

function whole(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of units, not ${String(value)}`);
  }
  return value;
}

/**
 * doc 22 §8: what the guest can be charged for.
 *
 * `max(0, opening + refill − non-guest stock-out − counted)`. A generic positive
 * adjustment is not in it: only a confirmed refill task adds billable stock
 * (`PRICE-DEC-005`).
 */
export function billableQuantity(input: BillableInput): number {
  const available =
    whole('openingQuantity', input.openingQuantity) +
    whole('refillQuantity', input.refillQuantity) -
    whole('nonGuestOutQuantity', input.nonGuestOutQuantity);
  return Math.max(0, available - whole('countedQuantity', input.countedQuantity));
}

/** The quantity a guest could have taken, before what the Cleaner counted. */
export function availableToGuest(input: Omit<BillableInput, 'countedQuantity'>): number {
  return Math.max(
    0,
    whole('openingQuantity', input.openingQuantity) +
      whole('refillQuantity', input.refillQuantity) -
      whole('nonGuestOutQuantity', input.nonGuestOutQuantity),
  );
}

/** `PRICE-DEC-007`: the line amount is the server's, from the snapshot price. */
export function lineTotalMnt(unitPriceMnt: bigint, quantity: number): bigint {
  if (unitPriceMnt < 0n) throw new Error('a snapshot price is never negative');
  return unitPriceMnt * BigInt(whole('quantity', quantity));
}

export function versionTotalMnt(lines: readonly { readonly lineTotalMnt: bigint }[]): bigint {
  return lines.reduce((total, line) => total + line.lineTotalMnt, 0n);
}

/**
 * `CHK-DEC-006`: a waiver never edits the report; it reduces what is payable.
 * The payable amount never falls below zero.
 */
export function payableMnt(totalMnt: bigint, waivedMnt: readonly bigint[]): bigint {
  const waived = waivedMnt.reduce((sum, amount) => sum + amount, 0n);
  return totalMnt > waived ? totalMnt - waived : 0n;
}

/**
 * `CHK-DEC-004`: what an attempt's provider status does to the version it
 * locked. Only a confirmed failure without funds releases it; pending and
 * unknown keep the hold until reconciliation answers.
 */
export function lockOutcome(status: ProviderStatus): 'HOLD' | 'RELEASE' | 'SETTLE' {
  switch (status) {
    case 'SUCCEEDED':
      return 'SETTLE';
    case 'FAILED_NO_FUNDS':
      return 'RELEASE';
    case 'PENDING':
    case 'UNKNOWN':
      return 'HOLD';
  }
}

export interface CheckoutStartFacts {
  readonly stayState: 'ACTIVE' | 'CHECKOUT_IN_PROGRESS' | 'COMPLETED';
  readonly correctionPending: boolean;
  readonly openRefillTasks: number;
}

/**
 * doc 21 §2.1 and doc 25 §6.1: what refuses the start of a checkout. A pending
 * actual-time correction must be decided first, and an active-stay refill task
 * must be finished or called off before the room's minibar is counted.
 */
export function checkoutStartBlockers(facts: CheckoutStartFacts): readonly string[] {
  const blockers: string[] = [];
  if (facts.stayState !== 'ACTIVE') blockers.push('CHECKOUT_ALREADY_STARTED');
  if (facts.correctionPending) blockers.push('CORRECTION_PENDING');
  if (facts.openRefillTasks > 0) blockers.push('REFILL_TASK_OPEN');
  return blockers;
}

export interface SettlementFacts {
  readonly reportState: 'PENDING' | 'IN_INSPECTION' | 'SUBMITTED' | 'RETURNED' | 'LOCKED';
  readonly openDisputes: number;
}

/**
 * doc 21 §§2, 7: a payment attempt needs a submitted version and no dispute
 * still waiting on a Manager (`CHK-DEC-001`, `CHK-DEC-006`).
 */
export function paymentBlockers(facts: SettlementFacts): readonly string[] {
  const blockers: string[] = [];
  if (facts.reportState !== 'SUBMITTED') blockers.push('REPORT_NOT_SUBMITTED');
  if (facts.openDisputes > 0) blockers.push('DISPUTE_OPEN');
  return blockers;
}
