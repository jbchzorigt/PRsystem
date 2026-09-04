/**
 * The arithmetic of a folio and a deposit, as pure functions.
 *
 * doc 02 §3.3 states the bill as `charged − paid = balance`; doc 20 §3.1
 * states the deposit's available balance as five totals; doc 20 §7 states what
 * a provider answer does to a reserved refund. Each is written here once and
 * repeated by the database as a CHECK where it is an invariant of a stored row
 * (`RC-DEC-001`, `DEP-DEC-007`).
 */

export type Channel = 'CASH' | 'QPAY' | 'CARD_GATEWAY' | 'MANUAL_POS';
export type RefundOutcome = 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'VOIDED';

export interface DepositTotals {
  readonly receivedMnt: bigint;
  readonly reversedMnt: bigint;
  readonly allocatedMnt: bigint;
  readonly refundReservedMnt: bigint;
  readonly refundedMnt: bigint;
}

function nonNegative(name: string, value: bigint): bigint {
  if (value < 0n) throw new Error(`${name} is never negative`);
  return value;
}

/**
 * doc 20 §3.1: what the deposit can still be used for. A pending, unknown or
 * retryable-failed refund keeps its amount out of this number, which is why the
 * same money cannot be promised to a charge and to a guest at once.
 */
export function availableDepositMnt(totals: DepositTotals): bigint {
  const available =
    nonNegative('receivedMnt', totals.receivedMnt) -
    nonNegative('reversedMnt', totals.reversedMnt) -
    nonNegative('allocatedMnt', totals.allocatedMnt) -
    nonNegative('refundReservedMnt', totals.refundReservedMnt) -
    nonNegative('refundedMnt', totals.refundedMnt);
  if (available < 0n) throw new Error('a deposit balance can never be negative');
  return available;
}

export interface FolioTotals {
  readonly chargedMnt: bigint;
  readonly paidMnt: bigint;
  readonly depositAppliedMnt: bigint;
}

/** doc 02 §3.3: what the guest still owes. */
export function folioBalanceMnt(totals: FolioTotals): bigint {
  const balance =
    nonNegative('chargedMnt', totals.chargedMnt) -
    nonNegative('paidMnt', totals.paidMnt) -
    nonNegative('depositAppliedMnt', totals.depositAppliedMnt);
  if (balance < 0n) throw new Error('a folio is never paid beyond what it charged');
  return balance;
}

/**
 * doc 20 §3: what the deposit may cover of an outstanding charge —
 * `min(available deposit, folio balance)`, and never more than the line asks.
 */
export function allocatableMnt(input: {
  readonly availableMnt: bigint;
  readonly balanceMnt: bigint;
  readonly lineMnt: bigint;
}): bigint {
  const bound = [input.availableMnt, input.balanceMnt, input.lineMnt].reduce((min, value) =>
    value < min ? value : min,
  );
  return bound < 0n ? 0n : bound;
}

/**
 * doc 20 §7, `DEP-DEC-009`: a provider answer does not release a reservation.
 * Only a success ends it as money paid out; a failure leaves it reserved for a
 * retry, and only an authoritative void — cash never handed, or the provider
 * saying it never processed the request — lets a Manager release it.
 */
export function refundEffect(outcome: RefundOutcome): {
  readonly state: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  readonly releasesReservation: boolean;
  readonly paysOut: boolean;
} {
  switch (outcome) {
    case 'SUCCEEDED':
      return { state: 'SUCCEEDED', releasesReservation: true, paysOut: true };
    case 'FAILED':
      return { state: 'FAILED', releasesReservation: false, paysOut: false };
    case 'VOIDED':
      // The provider says it never processed the request. It is still the
      // Manager's decision to release; this only makes the release legal.
      return { state: 'FAILED', releasesReservation: false, paysOut: false };
    case 'PENDING':
      return { state: 'PENDING', releasesReservation: false, paysOut: false };
  }
}

/**
 * `DEP-DEC-010`: a late success is paid out of what the deposit still has, and
 * whatever is missing is the hotel's loss — never a negative balance.
 */
export function lateRefundPosting(input: {
  readonly availableMnt: bigint;
  readonly providerRefundedMnt: bigint;
}): { readonly coveredMnt: bigint; readonly shortfallMnt: bigint } {
  const provider = nonNegative('providerRefundedMnt', input.providerRefundedMnt);
  const available = nonNegative('availableMnt', input.availableMnt);
  const covered = provider < available ? provider : available;
  return { coveredMnt: covered, shortfallMnt: provider - covered };
}

/** doc 20 §6, `DEP-DEC-005`: what a movement on each channel must carry. */
export function referenceRequirements(channel: Channel): {
  readonly providerReference: boolean;
  readonly approvalCode: boolean;
  readonly shift: boolean;
} {
  switch (channel) {
    case 'MANUAL_POS':
      return { providerReference: true, approvalCode: true, shift: false };
    case 'QPAY':
    case 'CARD_GATEWAY':
      return { providerReference: true, approvalCode: false, shift: false };
    case 'CASH':
      return { providerReference: false, approvalCode: false, shift: true };
  }
}

/**
 * `RC-DEC-003`, `DEP-DEC-001`: a walk-in owes the configured deposit; a stay
 * that came from a confirmed online booking owes none, and its prepayment is a
 * room payment rather than a deposit.
 */
export function depositRequirement(input: {
  readonly source: 'WALK_IN' | 'ONLINE';
  readonly categoryAmountMnt: bigint | null;
  readonly hotelAmountMnt: bigint | null;
}):
  | { readonly required: false }
  | {
      readonly required: true;
      readonly amountMnt: bigint;
      readonly scope: 'HOTEL' | 'CATEGORY';
    } {
  if (input.source !== 'WALK_IN') return { required: false };
  if (input.categoryAmountMnt !== null) {
    return { required: true, amountMnt: input.categoryAmountMnt, scope: 'CATEGORY' };
  }
  if (input.hotelAmountMnt !== null) {
    return { required: true, amountMnt: input.hotelAmountMnt, scope: 'HOTEL' };
  }
  throw new Error('DEPOSIT_NOT_CONFIGURED');
}
