/**
 * The arithmetic of a cash drawer, as pure functions.
 *
 * doc 24 §6 states the expected cash as a signed sum over typed movements and
 * the variance as the counted cash less that expectation; doc 03 §6 states
 * which review a close needs. Each is written here once, tested on its own, and
 * used by the services (`CASH-DEC-004`, `SHIFT-DEC-001`…`-004`).
 */

export const CASH_MOVEMENT_TYPES = [
  'INITIAL_FLOAT',
  'SERVICE_CASH_PAYMENT',
  'DEPOSIT_CASH_RECEIPT',
  'SERVICE_CASH_REFUND',
  'DEPOSIT_CASH_REFUND',
  'PAID_CASH_EXPENSE',
  'CASH_TOP_UP',
  'DRAWER_TRANSFER_IN',
  'DRAWER_TRANSFER_OUT',
  'SAFE_TRANSFER_IN',
  'SAFE_TRANSFER_OUT',
  'BANK_DEPOSIT_OUT',
  'OWNER_OTHER_WITHDRAWAL',
  'CASH_CORRECTION_IN',
  'CASH_CORRECTION_OUT',
] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

const INFLOWS = new Set<CashMovementType>([
  'INITIAL_FLOAT',
  'SERVICE_CASH_PAYMENT',
  'DEPOSIT_CASH_RECEIPT',
  'CASH_TOP_UP',
  'DRAWER_TRANSFER_IN',
  'SAFE_TRANSFER_IN',
  'CASH_CORRECTION_IN',
]);

/** doc 24 §5: the direction is a property of the type, never of the caller. */
export function directionOf(type: CashMovementType): 'IN' | 'OUT' {
  return INFLOWS.has(type) ? 'IN' : 'OUT';
}

/** doc 24 §5: what a movement does to the balance of the location it names. */
export function balanceEffect(type: CashMovementType, amountMnt: bigint): bigint {
  if (amountMnt <= 0n) throw new Error('a cash movement is a positive amount');
  return directionOf(type) === 'IN' ? amountMnt : -amountMnt;
}

export interface LedgerLine {
  readonly movementType: CashMovementType;
  readonly amountMnt: bigint;
}

/**
 * doc 24 §6: the expected cash of a shift — the amount actually counted at its
 * opening, plus every movement posted in it. The opening is a snapshot, not an
 * inflow, so it is added once and the `INITIAL_FLOAT` that established the
 * drawer is not counted again inside the shift.
 */
export function expectedCashMnt(openingBalanceMnt: bigint, lines: readonly LedgerLine[]): bigint {
  if (openingBalanceMnt < 0n) throw new Error('an opening balance is never negative');
  return lines.reduce(
    (total, line) =>
      line.movementType === 'INITIAL_FLOAT'
        ? total
        : total + balanceEffect(line.movementType, line.amountMnt),
    openingBalanceMnt,
  );
}

/** doc 03 §4.6: what the drawer actually holds, less what it should. */
export function varianceMnt(countedCashMnt: bigint, expectedMnt: bigint): bigint {
  if (countedCashMnt < 0n) throw new Error('a counted amount is never negative');
  return countedCashMnt - expectedMnt;
}

/** The balance of a location: every posted movement, in or out. */
export function locationBalanceMnt(lines: readonly LedgerLine[]): bigint {
  return lines.reduce(
    (total, line) => total + balanceEffect(line.movementType, line.amountMnt),
    0n,
  );
}

export type ExpenseState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PAID' | 'REJECTED';

/**
 * `FIN-DEC-005`, `CASH-DEC-005`: an approval is not an outflow. Only a paid
 * expense counts, and only a cash one moves a drawer.
 */
export function expenseCashEffect(input: {
  readonly state: ExpenseState;
  readonly method: 'CASH' | 'CARD_POS' | 'BANK_QPAY';
}): { readonly movesDrawer: boolean; readonly countsAsOutflow: boolean } {
  const paid = input.state === 'PAID';
  return { movesDrawer: paid && input.method === 'CASH', countsAsOutflow: paid };
}
