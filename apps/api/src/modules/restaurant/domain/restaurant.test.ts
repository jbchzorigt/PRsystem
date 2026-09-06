import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ESCALATE_MINUTES,
  accessAllowance,
  advancesFulfillment,
  basketTotalMnt,
  captureOutcome,
  dayFor,
  formatOrderNo,
  invoiceExpiry,
  isEtaChoice,
  isFulfillmentTerminal,
  orderStateFor,
  orderingWindowAt,
  requestOutcome,
  requestResolved,
  requestSla,
  terminalFor,
  windowOf,
} from './restaurant';
import type { DayOverride, DaySchedule, OrderFacts } from './restaurant';

/**
 * The Restaurant's rules, without a database (doc 08 §§5, 8, 20–22).
 *
 * The cases here are the ones an integration test cannot see: an overnight
 * window at one in the morning, a request committing on the exact tenth minute,
 * and an invoice that would outlive the day's close.
 */

const UB = 'Asia/Ulaanbaatar';
const MINUTE = 60_000;

/** Ulaanbaatar is UTC+8, so its wall clock is the UTC one plus eight hours. */
const at = (iso: string): Date => new Date(iso);

const weekly = (rows: Partial<DaySchedule>[]): DaySchedule[] =>
  Array.from({ length: 7 }, (_unused, weekday) => ({
    weekday,
    closed: false,
    opensAt: '09:00:00',
    closesAt: '22:00:00',
    ...rows.find((row) => row.weekday === weekday),
  }));

describe('the ordering window (RC-DEC-022, doc 08 §5)', () => {
  it('is open inside the day’s hours and shut outside them', () => {
    const schedule = weekly([]);
    // 2027-03-10 is a Wednesday. 12:00 local is 04:00 UTC.
    expect(orderingWindowAt(at('2027-03-10T04:00:00Z'), UB, schedule, []).open).toBe(true);
    // 08:00 local, an hour before opening.
    const shut = orderingWindowAt(at('2027-03-10T00:00:00Z'), UB, schedule, []);
    expect(shut.open).toBe(false);
    expect(shut.nextOpensAt?.toISOString()).toBe('2027-03-10T01:00:00.000Z');
  });

  it('closes exactly at the closing instant, not a moment after', () => {
    const schedule = weekly([]);
    // 22:00 local is 14:00 UTC.
    expect(orderingWindowAt(at('2027-03-10T13:59:59Z'), UB, schedule, []).open).toBe(true);
    expect(orderingWindowAt(at('2027-03-10T14:00:00Z'), UB, schedule, []).open).toBe(false);
  });

  it('carries an overnight window past midnight (18:00–02:00)', () => {
    const schedule = weekly(
      Array.from({ length: 7 }, (_unused, weekday) => ({
        weekday,
        closed: false,
        opensAt: '18:00:00',
        closesAt: '02:00:00',
      })),
    );
    // 01:00 local on the 11th — inside the window that opened on the 10th.
    const overnight = orderingWindowAt(at('2027-03-10T17:00:00Z'), UB, schedule, []);
    expect(overnight.open).toBe(true);
    expect(overnight.closesAt?.toISOString()).toBe('2027-03-10T18:00:00.000Z');
    // 03:00 local on the 11th — the window has closed and the next is that evening.
    const after = orderingWindowAt(at('2027-03-10T19:00:00Z'), UB, schedule, []);
    expect(after.open).toBe(false);
    expect(after.nextOpensAt?.toISOString()).toBe('2027-03-11T10:00:00.000Z');
  });

  it('lets an override outrank the weekday it falls on', () => {
    const schedule = weekly([]);
    const holiday: DayOverride[] = [
      { localDate: '2027-03-10', closed: true, opensAt: null, closesAt: null },
    ];
    expect(dayFor('2027-03-10', schedule, holiday).closed).toBe(true);
    expect(orderingWindowAt(at('2027-03-10T04:00:00Z'), UB, schedule, holiday).open).toBe(false);
    // And an override can open a day the weekly row closes.
    const closedWeekday = weekly([{ weekday: 3, closed: true, opensAt: null, closesAt: null }]);
    const opened: DayOverride[] = [
      { localDate: '2027-03-10', closed: false, opensAt: '10:00:00', closesAt: '14:00:00' },
    ];
    expect(orderingWindowAt(at('2027-03-10T04:00:00Z'), UB, closedWeekday, opened).open).toBe(true);
  });

  it('treats a weekday with no row at all as closed', () => {
    expect(dayFor('2027-03-10', [], []).closed).toBe(true);
    expect(windowOf('2027-03-10', UB, dayFor('2027-03-10', [], []))).toBeUndefined();
  });
});

describe('the invoice window (RC-DEC-023)', () => {
  it('is fifteen minutes when the close is further away', () => {
    const now = at('2027-03-10T04:00:00Z');
    const closes = at('2027-03-10T14:00:00Z');
    expect(invoiceExpiry(now, closes).toISOString()).toBe('2027-03-10T04:15:00.000Z');
  });

  it('never outlives the ordering close, however close it is', () => {
    const now = at('2027-03-10T13:55:00Z');
    const closes = at('2027-03-10T14:00:00Z');
    // Five minutes, not fifteen: the guest who starts paying just before the
    // close gets what is left of it.
    expect(invoiceExpiry(now, closes).toISOString()).toBe(closes.toISOString());
  });
});

describe('the basket total (doc 08 §6)', () => {
  it('is recomputed from unit price and quantity, never taken from the device', () => {
    expect(
      basketTotalMnt([
        { itemId: 'a', name: 'Цуйван', unitPriceMnt: 12_000n, quantity: 2 },
        { itemId: 'b', name: 'Сүүтэй цай', unitPriceMnt: 2_500n, quantity: 3 },
      ]),
    ).toBe(31_500n);
    expect(basketTotalMnt([])).toBe(0n);
  });
});

const paid = (overrides: Partial<OrderFacts> = {}): OrderFacts => ({
  orderState: 'CONFIRMED',
  fulfillmentState: 'AWAITING_ACCEPTANCE',
  paymentState: 'PAID',
  refundPolicy: 'NONE',
  refundRequestState: 'NONE',
  paymentConfirmedAt: at('2027-03-10T04:00:00Z'),
  acceptedAt: null,
  promisedReadyAt: null,
  refundRequestedAt: null,
  ...overrides,
});

describe('the acceptance race (REST-DEC-002, RC-DEC-030)', () => {
  const confirmed = at('2027-03-10T04:00:00Z');
  const tenMinutes = new Date(confirmed.getTime() + ACCEPT_ESCALATE_MINUTES * MINUTE);

  it('refuses a request before the tenth minute, for everyone', () => {
    for (const source of ['GUEST', 'RECEPTION', 'CHECKOUT'] as const) {
      const outcome = requestOutcome(paid(), source, new Date(tenMinutes.getTime() - 1));
      expect({ source, outcome }).toEqual({
        source,
        outcome: { kind: 'refused', reason: 'TOO_EARLY' },
      });
    }
  });

  it('makes it mandatory and approved at the tenth minute exactly', () => {
    expect(requestOutcome(paid(), 'GUEST', tenMinutes)).toEqual({
      kind: 'mandatory',
      reason: 'PRE_ACCEPT_SLA',
    });
  });

  it('is discretionary once the restaurant accepted, however late the request', () => {
    const accepted = paid({
      fulfillmentState: 'ACCEPTED',
      acceptedAt: new Date(confirmed.getTime() + 9 * MINUTE),
      promisedReadyAt: new Date(confirmed.getTime() + 39 * MINUTE),
    });
    // An hour later — the acceptance committed first, so the policy is the
    // discretionary one and the restaurant may still state a reason.
    expect(requestOutcome(accepted, 'GUEST', new Date(confirmed.getTime() + 60 * MINUTE))).toEqual({
      kind: 'discretionary',
      reason: 'ETA_OVERDUE',
    });
    // But not before the promise plus its grace.
    expect(requestOutcome(accepted, 'GUEST', new Date(confirmed.getTime() + 40 * MINUTE))).toEqual({
      kind: 'refused',
      reason: 'TOO_EARLY',
    });
  });

  it('always admits the checkout request on an accepted order (doc 08 §19)', () => {
    const accepted = paid({
      fulfillmentState: 'PREPARING',
      acceptedAt: confirmed,
      promisedReadyAt: new Date(confirmed.getTime() + 30 * MINUTE),
    });
    expect(requestOutcome(accepted, 'CHECKOUT', new Date(confirmed.getTime() + MINUTE))).toEqual({
      kind: 'discretionary',
      reason: 'CHECKOUT_REFUND_REQUEST',
    });
  });

  it('owes the whole amount when the restaurant says it cannot fulfil', () => {
    const accepted = paid({ fulfillmentState: 'PREPARING', acceptedAt: confirmed });
    expect(requestOutcome(accepted, 'RESTAURANT_CANCEL', confirmed)).toEqual({
      kind: 'mandatory',
      reason: 'RESTAURANT_CANCELLED',
    });
  });

  it('refuses a second request and one against a finished order', () => {
    expect(requestOutcome(paid({ refundRequestState: 'OPEN' }), 'GUEST', tenMinutes)).toEqual({
      kind: 'refused',
      reason: 'ALREADY_OPEN',
    });
    expect(
      requestOutcome(paid({ fulfillmentState: 'DELIVERED_TO_ROOM' }), 'GUEST', tenMinutes),
    ).toEqual({ kind: 'refused', reason: 'TERMINAL' });
    expect(requestOutcome(paid({ paymentState: 'PENDING' }), 'GUEST', tenMinutes)).toEqual({
      kind: 'refused',
      reason: 'TERMINAL',
    });
  });
});

describe('a payment that lands too late (REST-DEC-005)', () => {
  const live = { linkActive: true, itemsActive: true, expired: false };

  it('confirms only while everything it depends on is still live', () => {
    expect(captureOutcome(paid({ paymentState: 'PENDING' }), live)).toEqual({ kind: 'confirm' });
  });

  it('owes the money back when the window has closed', () => {
    expect(captureOutcome(paid({ paymentState: 'PENDING' }), { ...live, expired: true })).toEqual({
      kind: 'mandatory_refund',
      reason: 'PAID_AFTER_INVOICE_EXPIRY',
    });
  });

  it('owes it back when the link or the item went inactive first', () => {
    expect(
      captureOutcome(paid({ paymentState: 'PENDING' }), { ...live, linkActive: false }),
    ).toEqual({ kind: 'mandatory_refund', reason: 'RESTAURANT_INACTIVE_AT_PAYMENT' });
    expect(
      captureOutcome(paid({ paymentState: 'PENDING' }), { ...live, itemsActive: false }),
    ).toEqual({ kind: 'mandatory_refund', reason: 'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT' });
  });

  it('treats a repeated delivery as a replay', () => {
    expect(captureOutcome(paid(), live)).toEqual({ kind: 'already_confirmed' });
  });
});

describe('the request SLA (RC-DEC-031)', () => {
  const requested = at('2027-03-10T04:00:00Z');
  const after = (minutes: number): Date => new Date(requested.getTime() + minutes * MINUTE);

  it('reminds at five, escalates at ten and pauses the link at thirty', () => {
    expect(requestSla(requested, after(4))).toEqual({
      remindRestaurant: false,
      escalateToHotel: false,
      pauseLink: false,
    });
    expect(requestSla(requested, after(5)).remindRestaurant).toBe(true);
    expect(requestSla(requested, after(10)).escalateToHotel).toBe(true);
    expect(requestSla(requested, after(29)).pauseLink).toBe(false);
    expect(requestSla(requested, after(30)).pauseLink).toBe(true);
  });

  it('counts a refunded or refused request as resolved, and nothing else', () => {
    expect(requestResolved(paid({ refundRequestState: 'RESOLVED' }))).toBe(true);
    expect(requestResolved(paid({ refundRequestState: 'REJECTED' }))).toBe(true);
    // A refund still trying, or one that failed, has resolved nothing.
    expect(requestResolved(paid({ refundRequestState: 'APPROVED' }))).toBe(false);
    expect(requestResolved(paid({ refundRequestState: 'OPEN' }))).toBe(false);
  });
});

describe('the fulfilment axis (doc 08 §10)', () => {
  it('advances forward and never backwards', () => {
    expect(advancesFulfillment('AWAITING_ACCEPTANCE', 'ACCEPTED')).toBe(true);
    expect(advancesFulfillment('PREPARING', 'READY')).toBe(true);
    expect(advancesFulfillment('READY', 'PREPARING')).toBe(false);
    expect(advancesFulfillment('ACCEPTED', 'ACCEPTED')).toBe(false);
  });

  it('lets a handover happen from any live state, and none from a terminal one', () => {
    expect(advancesFulfillment('ACCEPTED', 'HANDED_TO_RECEPTION')).toBe(true);
    expect(advancesFulfillment('AWAITING_ACCEPTANCE', 'CANCELLED')).toBe(true);
    expect(advancesFulfillment('CANCELLED', 'ACCEPTED')).toBe(false);
    expect(advancesFulfillment('DELIVERED_TO_ROOM', 'CANCELLED')).toBe(false);
  });

  it('derives the order axis from fulfilment and payment', () => {
    expect(orderStateFor('CANCELLED', 'PAID')).toBe('CANCELLED');
    expect(orderStateFor('HANDED_TO_RECEPTION', 'PAID')).toBe('COMPLETED');
    expect(orderStateFor('PREPARING', 'PAID')).toBe('CONFIRMED');
    expect(orderStateFor('NOT_STARTED', 'PENDING')).toBe('PENDING_PAYMENT');
  });

  it('knows which handovers are terminal, and that a refund request is not one', () => {
    expect(terminalFor('RECEPTION')).toBe('HANDED_TO_RECEPTION');
    expect(terminalFor('GUEST_PICKUP')).toBe('PICKED_UP_BY_GUEST');
    expect(terminalFor('ROOM')).toBe('DELIVERED_TO_ROOM');
    expect(terminalFor('REFUND_REQUEST')).toBeUndefined();
    expect(isFulfillmentTerminal('CANCELLED')).toBe(true);
    expect(isFulfillmentTerminal('READY')).toBe(false);
  });
});

describe('the small rules', () => {
  it('admits exactly the four ETAs', () => {
    for (const minutes of [15, 30, 45, 60]) expect(isEtaChoice(minutes)).toBe(true);
    for (const minutes of [0, 10, 20, 90]) expect(isEtaChoice(minutes)).toBe(false);
  });

  it('shares one allowance of five between sessions and unused codes', () => {
    expect(accessAllowance(0, 0)).toBe(5);
    expect(accessAllowance(3, 2)).toBe(0);
    expect(accessAllowance(5, 0)).toBe(0);
  });

  it('formats an order number from unambiguous characters only', () => {
    const bytes = new Uint8Array(Array.from({ length: 10 }, (_unused, i) => i * 7));
    expect(formatOrderNo(bytes)).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  });
});
