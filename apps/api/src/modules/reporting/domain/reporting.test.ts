import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RANGE_DAYS,
  EXPORT_ROW_CAP,
  addLocalDays,
  ageOn,
  cogsMnt,
  defaultRange,
  fileExpiry,
  firstRowNumber,
  formatMargin,
  isPageSize,
  lastSevenDays,
  localDateOf,
  localDatesOf,
  marginBps,
  netSalesMnt,
  normalizeSearch,
  operatingResultMnt,
  rangeOfLocalDates,
  receivableMnt,
  receivedMnt,
  refuseRange,
  retentionExpiry,
  startOfLocalDay,
  thisMonth,
  topByDemand,
  topByRevenue,
  totalPages,
  urlExpiry,
} from './reporting';

const UB = 'Asia/Ulaanbaatar';
/** 2026-03-15 09:00 in Ulaanbaatar (UTC+8). */
const NOW = new Date('2026-03-15T01:00:00.000Z');

describe('pagination (GUEST-DEC-005)', () => {
  it('accepts twenty, fifty and a hundred, and nothing else', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    for (const size of [20, 50, 100]) expect(isPageSize(size)).toBe(true);
    for (const size of [1, 19, 21, 200, 0, -20]) expect(isPageSize(size)).toBe(false);
  });

  it('continues the row number across pages rather than restarting it', () => {
    expect(firstRowNumber(1, 20)).toBe(1);
    expect(firstRowNumber(2, 20)).toBe(21);
    expect(firstRowNumber(3, 50)).toBe(101);
  });

  it('counts pages, and reports none for an empty result', () => {
    expect(totalPages(0, 20)).toBe(0);
    expect(totalPages(1, 20)).toBe(1);
    expect(totalPages(20, 20)).toBe(1);
    expect(totalPages(21, 20)).toBe(2);
    expect(totalPages(10_000, 100)).toBe(100);
  });
});

describe('the mandatory date range (doc 12 §8)', () => {
  it('defaults to the last thirty local days, ending at the end of today', () => {
    const range = defaultRange(NOW, UB);
    expect(localDateOf(range.from, UB)).toBe('2026-02-14');
    // Half-open: the interval ends at the first instant of tomorrow.
    expect(localDateOf(range.to, UB)).toBe('2026-03-16');
    expect(range.to.getTime() - range.from.getTime()).toBe(DEFAULT_RANGE_DAYS * 86_400_000);
  });

  it('refuses an inverted range and one longer than retention', () => {
    const ok = rangeOfLocalDates('2026-01-01', '2026-01-31', UB);
    expect(refuseRange(ok)).toBeUndefined();
    expect(refuseRange({ from: ok.to, to: ok.from })).toBe('INVERTED');
    expect(refuseRange(rangeOfLocalDates('2024-01-01', '2026-01-01', UB))).toBe('TOO_LONG');
    // Exactly the retention period is allowed; one day more is not.
    expect(refuseRange(rangeOfLocalDates('2026-01-01', '2026-12-31', UB), 365)).toBeUndefined();
    expect(refuseRange(rangeOfLocalDates('2026-01-01', '2027-01-01', UB), 365)).toBe('TOO_LONG');
  });

  it('reads a local date pair as a half-open interval of instants', () => {
    const range = rangeOfLocalDates('2026-03-01', '2026-03-01', UB);
    expect(range.to.getTime() - range.from.getTime()).toBe(86_400_000);
    expect(localDateOf(range.from, UB)).toBe('2026-03-01');
  });
});

describe('the age snapshot (GUEST-DEC-003)', () => {
  it('counts whole years completed on the local check-in date', () => {
    expect(ageOn('1990-03-14', '2026-03-15')).toBe(36);
    // The birthday itself counts.
    expect(ageOn('1990-03-15', '2026-03-15')).toBe(36);
    // The day before it does not.
    expect(ageOn('1990-03-16', '2026-03-15')).toBe(35);
    expect(ageOn('2000-12-31', '2026-01-01')).toBe(25);
  });

  it('never guesses: a missing or unusable date of birth is Тодорхойгүй', () => {
    expect(ageOn(null, '2026-03-15')).toBeUndefined();
    expect(ageOn('not-a-date', '2026-03-15')).toBeUndefined();
    expect(ageOn('1990-13-01', '2026-03-15')).toBeUndefined();
    // A date of birth after the check-in is not an age of minus one.
    expect(ageOn('2027-01-01', '2026-03-15')).toBeUndefined();
  });
});

describe('the name search (doc 12 §8)', () => {
  it('trims, and treats a search of only spaces as no search at all', () => {
    expect(normalizeSearch('  Болор  ')).toBe('Болор');
    expect(normalizeSearch('   ')).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
  });
});

describe('the export limits (GUEST-DEC-006, -007)', () => {
  it('caps a job at ten thousand rows', () => {
    expect(EXPORT_ROW_CAP).toBe(10_000);
  });

  it('gives the file an hour and the URL five minutes, from different instants', () => {
    const ready = new Date('2026-03-15T01:00:00.000Z');
    expect(fileExpiry(ready).toISOString()).toBe('2026-03-15T02:00:00.000Z');
    const issued = new Date('2026-03-15T01:40:00.000Z');
    expect(urlExpiry(issued).toISOString()).toBe('2026-03-15T01:45:00.000Z');
    // A URL issued late still expires before the file does, and never after.
    expect(urlExpiry(issued).getTime()).toBeLessThan(fileExpiry(ready).getTime());
  });

  it('takes the retention deadline from the checkout and the snapshotted days', () => {
    const checkout = new Date('2026-03-15T01:00:00.000Z');
    expect(retentionExpiry(checkout, 365).toISOString()).toBe('2027-03-15T01:00:00.000Z');
  });
});

describe('sales, money received and receivables (FIN-DEC-001)', () => {
  it('keeps the three apart, and computes each from its own inputs', () => {
    const sales = { grossSalesMnt: 1_000_000n, discountMnt: 50_000n, reversalMnt: 20_000n };
    expect(netSalesMnt(sales)).toBe(930_000n);
    expect(receivedMnt({ successfulPaymentsMnt: 700_000n, successfulRefundsMnt: 30_000n })).toBe(
      670_000n,
    );
    expect(
      receivableMnt({
        netSalesMnt: 930_000n,
        paymentAllocationMnt: 600_000n,
        depositAllocationMnt: 100_000n,
      }),
    ).toBe(230_000n);
  });

  it('never reports a negative receivable (doc 23 §2.3)', () => {
    expect(
      receivableMnt({
        netSalesMnt: 100_000n,
        paymentAllocationMnt: 150_000n,
        depositAllocationMnt: 0n,
      }),
    ).toBe(0n);
  });
});

describe('minibar profit and the operating result (FIN-DEC-003, -004)', () => {
  it('costs what was sold at its snapshotted weighted average', () => {
    expect(
      cogsMnt([
        { quantity: 10, unitCostMnt: 1_000n },
        { quantity: 3, unitCostMnt: 2_500n },
      ]),
    ).toBe(17_500n);
    expect(cogsMnt([])).toBe(0n);
  });

  it('subtracts COGS and paid operating expense, and never the purchase itself', () => {
    // doc 23 §3.3's own example: 100,000₮ of water bought, 10 sold at 1,000₮
    // cost. The result deducts 10,000₮, not 110,000₮ and not 100,000₮.
    const result = operatingResultMnt({
      netSalesMnt: 500_000n,
      minibarCogsMnt: 10_000n,
      paidOperatingExpenseMnt: 80_000n,
    });
    expect(result).toBe(410_000n);
  });
});

describe('margins (doc 23 §3)', () => {
  it('reports basis points, rounded half-up, and never a float', () => {
    expect(marginBps(50n, 100n)).toBe(5000);
    expect(marginBps(1n, 3n)).toBe(3333);
    expect(marginBps(2n, 3n)).toBe(6667);
    // A loss is a negative margin, rounded away from zero the same way.
    expect(marginBps(-1n, 3n)).toBe(-3333);
  });

  it('is N/A when there were no sales to have a margin of', () => {
    expect(marginBps(100n, 0n)).toBeUndefined();
    expect(marginBps(100n, -5n)).toBeUndefined();
    expect(formatMargin(undefined)).toBe('N/A');
    expect(formatMargin(3333)).toBe('33.33%');
    expect(formatMargin(-3333)).toBe('-33.33%');
    expect(formatMargin(5000)).toBe('50.00%');
  });
});

describe('the top five rooms (FIN-DEC-007)', () => {
  const rooms = [
    { roomId: 'a', roomNumber: '101', completedStays: 3, roomNetSalesMnt: 300_000n },
    { roomId: 'b', roomNumber: '102', completedStays: 5, roomNetSalesMnt: 100_000n },
    { roomId: 'c', roomNumber: '103', completedStays: 3, roomNetSalesMnt: 900_000n },
    { roomId: 'd', roomNumber: '104', completedStays: 3, roomNetSalesMnt: 300_000n },
    { roomId: 'e', roomNumber: '105', completedStays: 1, roomNetSalesMnt: 999_000n },
    { roomId: 'f', roomNumber: '106', completedStays: 0, roomNetSalesMnt: 0n },
  ];

  it('orders by demand, breaking ties on revenue and then on the room number', () => {
    const top = topByDemand(rooms);
    expect(top.map((room) => room.roomNumber)).toEqual(['102', '103', '101', '104', '105']);
  });

  it('orders by revenue on the toggle', () => {
    const top = topByRevenue(rooms);
    expect(top.map((room) => room.roomNumber)).toEqual(['105', '103', '101', '104', '102']);
  });

  it('is stable: the same rows in a different order give the same five', () => {
    const shuffled = [...rooms].reverse();
    expect(topByDemand(shuffled).map((r) => r.roomId)).toEqual(
      topByDemand(rooms).map((r) => r.roomId),
    );
  });
});

describe('the hotel-local calendar (doc 23 §6)', () => {
  it('starts a local day at the right instant in a +08:00 zone', () => {
    expect(startOfLocalDay('2026-03-15', UB).toISOString()).toBe('2026-03-14T16:00:00.000Z');
    expect(localDateOf(startOfLocalDay('2026-03-15', UB), UB)).toBe('2026-03-15');
  });

  it('handles a zone that changes offset inside the range', () => {
    // Europe/London moves to +01:00 on 2026-03-29.
    const before = startOfLocalDay('2026-03-28', 'Europe/London');
    const after = startOfLocalDay('2026-03-30', 'Europe/London');
    expect(before.toISOString()).toBe('2026-03-28T00:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-29T23:00:00.000Z');
    expect(localDateOf(after, 'Europe/London')).toBe('2026-03-30');
  });

  it('adds calendar days across a month and a year boundary', () => {
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists every local day of a range, so a quiet day still appears', () => {
    const days = localDatesOf(rangeOfLocalDates('2026-03-13', '2026-03-15', UB), UB);
    expect(days).toEqual(['2026-03-13', '2026-03-14', '2026-03-15']);
    expect(localDatesOf(lastSevenDays(NOW, UB), UB)).toHaveLength(7);
  });

  it('reads this month as the first to the end of today', () => {
    const month = thisMonth(NOW, UB);
    expect(localDateOf(month.from, UB)).toBe('2026-03-01');
    expect(localDatesOf(month, UB)).toHaveLength(15);
  });
});
