import { describe, expect, it } from 'vitest';
import {
  balanceEffect,
  directionOf,
  expectedCashMnt,
  expenseCashEffect,
  locationBalanceMnt,
  varianceMnt,
} from './cash';

describe('doc 24 §5 — the direction is a property of the movement type', () => {
  it('knows which types add to a drawer and which take from it', () => {
    expect(directionOf('SERVICE_CASH_PAYMENT')).toBe('IN');
    expect(directionOf('DEPOSIT_CASH_RECEIPT')).toBe('IN');
    expect(directionOf('CASH_TOP_UP')).toBe('IN');
    expect(directionOf('DRAWER_TRANSFER_IN')).toBe('IN');
    expect(directionOf('PAID_CASH_EXPENSE')).toBe('OUT');
    expect(directionOf('BANK_DEPOSIT_OUT')).toBe('OUT');
    expect(directionOf('OWNER_OTHER_WITHDRAWAL')).toBe('OUT');
    expect(directionOf('SERVICE_CASH_REFUND')).toBe('OUT');
  });

  it('signs the amount by that direction and refuses a non-positive one', () => {
    expect(balanceEffect('CASH_TOP_UP', 50_000n)).toBe(50_000n);
    expect(balanceEffect('PAID_CASH_EXPENSE', 20_000n)).toBe(-20_000n);
    expect(() => balanceEffect('CASH_TOP_UP', 0n)).toThrow();
  });
});

describe('doc 24 §6 — the expected cash of a shift', () => {
  it('is the counted opening plus every movement posted in the shift', () => {
    expect(
      expectedCashMnt(200_000n, [
        { movementType: 'SERVICE_CASH_PAYMENT', amountMnt: 60_000n },
        { movementType: 'DEPOSIT_CASH_RECEIPT', amountMnt: 50_000n },
        { movementType: 'DEPOSIT_CASH_REFUND', amountMnt: 50_000n },
        { movementType: 'PAID_CASH_EXPENSE', amountMnt: 20_000n },
        { movementType: 'DRAWER_TRANSFER_OUT', amountMnt: 100_000n },
      ]),
    ).toBe(140_000n);
  });

  it('does not count the initial float twice: it is what the opening already is', () => {
    expect(
      expectedCashMnt(190_000n, [{ movementType: 'INITIAL_FLOAT', amountMnt: 190_000n }]),
    ).toBe(190_000n);
  });

  it('doc 03 §4.6: the variance is what is there less what should be', () => {
    expect(varianceMnt(190_000n, 200_000n)).toBe(-10_000n);
    expect(varianceMnt(200_000n, 200_000n)).toBe(0n);
    expect(varianceMnt(210_000n, 200_000n)).toBe(10_000n);
    expect(() => varianceMnt(-1n, 0n)).toThrow();
  });

  it("a location's balance is every movement it holds", () => {
    expect(
      locationBalanceMnt([
        { movementType: 'SAFE_TRANSFER_IN', amountMnt: 100_000n },
        { movementType: 'BANK_DEPOSIT_OUT', amountMnt: 40_000n },
      ]),
    ).toBe(60_000n);
    expect(locationBalanceMnt([])).toBe(0n);
  });
});

describe('FIN-DEC-005 — an approval is not an outflow', () => {
  it('only a paid expense counts, and only a cash one moves a drawer', () => {
    expect(expenseCashEffect({ state: 'APPROVED', method: 'CASH' })).toEqual({
      movesDrawer: false,
      countsAsOutflow: false,
    });
    expect(expenseCashEffect({ state: 'PAID', method: 'CASH' })).toEqual({
      movesDrawer: true,
      countsAsOutflow: true,
    });
    expect(expenseCashEffect({ state: 'PAID', method: 'CARD_POS' })).toEqual({
      movesDrawer: false,
      countsAsOutflow: true,
    });
    expect(expenseCashEffect({ state: 'PAID', method: 'BANK_QPAY' })).toMatchObject({
      movesDrawer: false,
    });
  });
});
