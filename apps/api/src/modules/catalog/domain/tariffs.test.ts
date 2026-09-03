import { describe, expect, it } from 'vitest';
import type { TariffChain } from './tariffs';
import { precedenceFor, resolveCleaningBuffer, resolveRate } from './tariffs';

/**
 * `STAY-DEC-005` and doc 05 §13.1, table-driven: every combination of set and
 * unset levels, for both stay types and both channels.
 */

const HOTEL = 'hotel-1';
const CATEGORY = 'category-1';
const ROOM = 'room-1';

function chain(input: {
  room?: { hourly?: bigint; nightly?: bigint };
  category?: { hourly?: bigint; nightly?: bigint };
  hotel?: { hourly?: bigint; nightly?: bigint };
  withRoom?: boolean;
}): TariffChain {
  const level = (
    entityId: string,
    rates: { hourly?: bigint; nightly?: bigint } | undefined,
  ): { entityId: string; hourlyRateMnt: bigint | null; nightlyRateMnt: bigint | null } => ({
    entityId,
    hourlyRateMnt: rates?.hourly ?? null,
    nightlyRateMnt: rates?.nightly ?? null,
  });
  return {
    ...(input.withRoom === false ? {} : { room: level(ROOM, input.room) }),
    category: level(CATEGORY, input.category),
    hotel: level(HOTEL, input.hotel),
  };
}

describe('walk-in precedence: room → category → hotel', () => {
  const cases: [string, TariffChain, { price: bigint; level: string; entity: string }][] = [
    [
      'the room override wins over both',
      chain({
        room: { hourly: 30_000n },
        category: { hourly: 25_000n },
        hotel: { hourly: 20_000n },
      }),
      { price: 30_000n, level: 'ROOM', entity: ROOM },
    ],
    [
      'an unset room inherits the category',
      chain({ category: { hourly: 25_000n }, hotel: { hourly: 20_000n } }),
      { price: 25_000n, level: 'CATEGORY', entity: CATEGORY },
    ],
    [
      'unset room and category inherit the hotel default',
      chain({ hotel: { hourly: 20_000n } }),
      { price: 20_000n, level: 'HOTEL', entity: HOTEL },
    ],
    [
      'a room override with no category override still wins',
      chain({ room: { hourly: 30_000n }, hotel: { hourly: 20_000n } }),
      { price: 30_000n, level: 'ROOM', entity: ROOM },
    ],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => {
      expect(resolveRate(input, 'HOURLY', 'WALK_IN')).toEqual({
        kind: 'resolved',
        rate: {
          unitPriceMnt: expected.price,
          sourceLevel: expected.level,
          sourceEntityId: expected.entity,
        },
      });
    });
  }
});

describe('online precedence: category → hotel, and the room level does not exist', () => {
  it('never reads a room override, even when one is set', () => {
    const input = chain({
      room: { nightly: 300_000n },
      category: { nightly: 150_000n },
      hotel: { nightly: 100_000n },
    });
    expect(resolveRate(input, 'NIGHTLY', 'ONLINE')).toEqual({
      kind: 'resolved',
      rate: { unitPriceMnt: 150_000n, sourceLevel: 'CATEGORY', sourceEntityId: CATEGORY },
    });
  });

  it('falls to the hotel default past a room override that would have applied walk-in', () => {
    const input = chain({ room: { nightly: 300_000n }, hotel: { nightly: 100_000n } });
    expect(resolveRate(input, 'NIGHTLY', 'ONLINE')).toEqual({
      kind: 'resolved',
      rate: { unitPriceMnt: 100_000n, sourceLevel: 'HOTEL', sourceEntityId: HOTEL },
    });
    // The same chain, walk-in, is the room price: the two channels differ on
    // structure, not on data.
    expect(resolveRate(input, 'NIGHTLY', 'WALK_IN')).toMatchObject({
      rate: { unitPriceMnt: 300_000n, sourceLevel: 'ROOM' },
    });
  });

  it('the online precedence list has no room entry', () => {
    const input = chain({ room: { nightly: 300_000n }, hotel: { nightly: 100_000n } });
    expect(precedenceFor(input, 'ONLINE').map((entry) => entry.level)).toEqual([
      'CATEGORY',
      'HOTEL',
    ]);
    expect(precedenceFor(input, 'WALK_IN').map((entry) => entry.level)).toEqual([
      'ROOM',
      'CATEGORY',
      'HOTEL',
    ]);
    expect(precedenceFor(chain({ withRoom: false }), 'WALK_IN').map((e) => e.level)).toEqual([
      'CATEGORY',
      'HOTEL',
    ]);
  });
});

describe('hourly and nightly resolve independently', () => {
  it('a category nightly override leaves the hourly rate to the hotel', () => {
    const input = chain({
      category: { nightly: 150_000n },
      hotel: { hourly: 20_000n, nightly: 100_000n },
    });
    expect(resolveRate(input, 'HOURLY', 'WALK_IN')).toMatchObject({
      rate: { unitPriceMnt: 20_000n, sourceLevel: 'HOTEL' },
    });
    expect(resolveRate(input, 'NIGHTLY', 'WALK_IN')).toMatchObject({
      rate: { unitPriceMnt: 150_000n, sourceLevel: 'CATEGORY' },
    });
  });

  it('a room hourly override does not touch the nightly resolution', () => {
    const input = chain({
      room: { hourly: 30_000n },
      category: { nightly: 150_000n },
      hotel: { hourly: 20_000n, nightly: 100_000n },
    });
    expect(resolveRate(input, 'NIGHTLY', 'WALK_IN')).toMatchObject({
      rate: { unitPriceMnt: 150_000n, sourceLevel: 'CATEGORY' },
    });
  });
});

describe('unset is an answer, not a zero', () => {
  it('refuses when no level prices the stay type', () => {
    const input = chain({ room: { hourly: 30_000n }, category: { hourly: 25_000n } });
    expect(resolveRate(input, 'NIGHTLY', 'WALK_IN')).toEqual({
      kind: 'unset',
      stayType: 'NIGHTLY',
    });
    expect(resolveRate(input, 'NIGHTLY', 'ONLINE')).toEqual({ kind: 'unset', stayType: 'NIGHTLY' });
  });

  it('a configured zero is a price, distinct from unset', () => {
    const input = chain({ hotel: { hourly: 0n } });
    expect(resolveRate(input, 'HOURLY', 'WALK_IN')).toMatchObject({
      kind: 'resolved',
      rate: { unitPriceMnt: 0n, sourceLevel: 'HOTEL' },
    });
  });
});

describe('STAY-DEC-004 — cleaning buffer: hotel default, category override, no room level', () => {
  it('prefers the category override, falls back to the hotel, and reports unset', () => {
    expect(resolveCleaningBuffer(30, 45)).toEqual({ kind: 'resolved', minutes: 45 });
    expect(resolveCleaningBuffer(30, null)).toEqual({ kind: 'resolved', minutes: 30 });
    expect(resolveCleaningBuffer(null, null)).toEqual({ kind: 'unset' });
  });

  it('treats a configured zero as a value', () => {
    expect(resolveCleaningBuffer(30, 0)).toEqual({ kind: 'resolved', minutes: 0 });
    expect(resolveCleaningBuffer(0, null)).toEqual({ kind: 'resolved', minutes: 0 });
  });
});

describe('STAY-DEC-014 compatibility — the resolved rate feeds the half-hour formula without floats', () => {
  /** `ROUND_HALF_UP(rate × units / 2)` in integer arithmetic, as Phase 08 will compute it. */
  function hourlyTotal(rateMnt: bigint, halfHourUnits: bigint): bigint {
    return (rateMnt * halfHourUnits + 1n) / 2n;
  }

  it('prices 1.5 hours at 20,000₮ as exactly 30,000₮ and 0.5 hours as 10,000₮', () => {
    const resolved = resolveRate(chain({ hotel: { hourly: 20_000n } }), 'HOURLY', 'WALK_IN');
    if (resolved.kind !== 'resolved') throw new Error('expected a rate');
    expect(hourlyTotal(resolved.rate.unitPriceMnt, 3n)).toBe(30_000n);
    expect(hourlyTotal(resolved.rate.unitPriceMnt, 1n)).toBe(10_000n);
  });

  it('rounds a half-tugrik up, once', () => {
    // 20,001 × 1 / 2 = 10,000.5 → 10,001
    expect(hourlyTotal(20_001n, 1n)).toBe(10_001n);
    // 20,001 × 2 / 2 = 20,001 exactly
    expect(hourlyTotal(20_001n, 2n)).toBe(20_001n);
  });
});
