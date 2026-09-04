import { describe, expect, it } from 'vitest';
import {
  balanceEffect,
  countVariances,
  locationOf,
  reconciliationBounds,
  statusAgainstTarget,
  weightedAverageCost,
} from './inventory';

describe('INV-DEC-004 — the continuous weighted average, in integer MNT', () => {
  it("reproduces the document's worked example: 10 at 1,000 then 10 at 1,200 is 1,100", () => {
    expect(
      weightedAverageCost({ totalBefore: 10, averageBefore: 1000n, quantity: 10, unitCost: 1200n }),
    ).toBe(1100n);
  });

  it('takes the incoming cost when nothing was held or no cost had been established', () => {
    expect(
      weightedAverageCost({ totalBefore: 0, averageBefore: null, quantity: 5, unitCost: 900n }),
    ).toBe(900n);
    expect(
      weightedAverageCost({ totalBefore: 0, averageBefore: 1000n, quantity: 5, unitCost: 900n }),
    ).toBe(900n);
    expect(
      weightedAverageCost({ totalBefore: 3, averageBefore: null, quantity: 5, unitCost: 900n }),
    ).toBe(900n);
  });

  it('rounds half up once, never through a float', () => {
    // (1 × 1000 + 2 × 1001) / 3 = 1000.666… → 1001
    expect(
      weightedAverageCost({ totalBefore: 1, averageBefore: 1000n, quantity: 2, unitCost: 1001n }),
    ).toBe(1001n);
    // (1 × 1000 + 1 × 1001) / 2 = 1000.5 → 1001
    expect(
      weightedAverageCost({ totalBefore: 1, averageBefore: 1000n, quantity: 1, unitCost: 1001n }),
    ).toBe(1001n);
  });
});

describe('INV-DEC-002 — the balance effect of each movement type', () => {
  it('a transfer moves quantity between locations and leaves the hotel total alone', () => {
    expect(balanceEffect('TRANSFER_TO_ROOM', 'TRANSFER', 2)).toEqual({
      warehouse: -2,
      room: 2,
      total: 0,
    });
    expect(balanceEffect('RETURN_TO_WAREHOUSE', 'TRANSFER', 2)).toEqual({
      warehouse: 2,
      room: -2,
      total: 0,
    });
  });

  it('receipts add to the warehouse and the total; consumption and waste reduce the total', () => {
    expect(balanceEffect('PURCHASE', 'WAREHOUSE', 5)).toEqual({ warehouse: 5, room: 0, total: 5 });
    expect(balanceEffect('GUEST_CONSUMPTION', 'ROOM', 1)).toEqual({
      warehouse: 0,
      room: -1,
      total: -1,
    });
    expect(balanceEffect('WASTE', 'WAREHOUSE', 1)).toEqual({ warehouse: -1, room: 0, total: -1 });
    expect(balanceEffect('ADJUST_MINUS', 'ROOM', 1)).toEqual({ warehouse: 0, room: -1, total: -1 });
    expect(balanceEffect('ADJUST_PLUS', 'ROOM', 1)).toEqual({ warehouse: 0, room: 1, total: 1 });
  });

  it('derives the location from the type and the presence of a room', () => {
    expect(locationOf('PURCHASE', undefined)).toBe('WAREHOUSE');
    expect(locationOf('TRANSFER_TO_ROOM', 'r')).toBe('TRANSFER');
    expect(locationOf('WASTE', undefined)).toBe('WAREHOUSE');
    expect(locationOf('WASTE', 'r')).toBe('ROOM');
  });
});

describe('RML-DEC-011 — the delta between what a room holds and the pinned target', () => {
  const water = 'a',
    cola = 'b',
    beer = 'c';

  it('returns excess and removed products, refills short and added ones, leaves matches alone', () => {
    const bounds = reconciliationBounds(
      [
        { productId: water, quantity: 3 },
        { productId: cola, quantity: 2 },
        { productId: beer, quantity: 1 },
      ],
      [
        { productId: water, targetQuantity: 2 },
        { productId: cola, targetQuantity: 2 },
      ],
    );
    expect(bounds).toEqual([
      { productId: water, direction: 'TO_WAREHOUSE', maxQuantity: 1, targetQuantity: 2 },
      { productId: beer, direction: 'TO_WAREHOUSE', maxQuantity: 1, targetQuantity: 0 },
    ]);
  });

  it('an empty target — ON → OFF — returns everything', () => {
    expect(reconciliationBounds([{ productId: water, quantity: 3 }], [])).toEqual([
      { productId: water, direction: 'TO_WAREHOUSE', maxQuantity: 3, targetQuantity: 0 },
    ]);
  });

  it('an empty room — OFF → ON — refills every target', () => {
    expect(reconciliationBounds([], [{ productId: water, targetQuantity: 2 }])).toEqual([
      { productId: water, direction: 'TO_ROOM', maxQuantity: 2, targetQuantity: 2 },
    ]);
  });

  it('a count that differs from the ledger is a variance, product by product', () => {
    expect(
      countVariances([{ productId: water, quantity: 3 }], [{ productId: water, quantity: 2 }]),
    ).toEqual([{ productId: water, held: 3, counted: 2 }]);
    expect(
      countVariances([{ productId: water, quantity: 3 }], [{ productId: water, quantity: 3 }]),
    ).toEqual([]);
    expect(countVariances([], [{ productId: cola, quantity: 1 }])).toEqual([
      { productId: cola, held: 0, counted: 1 },
    ]);
  });

  it('a room is FULL at or above every target and SHORT below any', () => {
    expect(
      statusAgainstTarget(
        [{ productId: water, quantity: 2 }],
        [{ productId: water, targetQuantity: 2 }],
      ),
    ).toBe('FULL');
    expect(
      statusAgainstTarget(
        [{ productId: water, quantity: 1 }],
        [{ productId: water, targetQuantity: 2 }],
      ),
    ).toBe('SHORT');
    expect(statusAgainstTarget([], [{ productId: water, targetQuantity: 1 }])).toBe('SHORT');
  });
});
