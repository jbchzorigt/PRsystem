import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { RestaurantHarness } from './test-support/restaurant-harness';
import { createRestaurantHarness, key, request } from './test-support/restaurant-harness';
import { newRestaurantRequest } from './services/restaurant-context';

/**
 * The restaurant, end to end, against real PostgreSQL (doc 08; `REST-DEC-001`–
 * `006`, `RC-DEC-019`–`031`).
 *
 * Three of the phase's four gates live here — the food money never reaching a
 * hotel total, the invoice never outliving the day's ordering close, and the
 * sixth device being refused. The fourth, the acceptance race, is in the
 * concurrency suite where two real transactions can contend for the row.
 */

let h: RestaurantHarness;

beforeAll(async () => {
  h = await createRestaurantHarness('restaurant_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  // A test that moved the clock and then threw must not move the next one.
  h?.resetClock();
});

describe('registration, the link and the menu', () => {
  it('registers a restaurant, links it active, and prices a menu item', async () => {
    const fixture = await h.restaurant('Registration');
    const link = await h.admin.query<{ link_state: string; sla_paused: boolean }>(
      `SELECT link_state, sla_paused FROM platform.hotel_restaurant_link WHERE link_id = $1`,
      [fixture.linkId],
    );
    expect(link.rows[0]?.link_state).toBe('ACTIVE');
    expect(link.rows[0]?.sla_paused).toBe(false);
    const item = await h.admin.query<{ price_mnt: string; available: boolean }>(
      `SELECT price_mnt, available FROM platform.restaurant_menu_item WHERE item_id = $1`,
      [fixture.itemId],
    );
    // Integer tögrög, never a float (CLAUDE.md §5).
    expect(item.rows[0]?.price_mnt).toBe('12000');
    expect(item.rows[0]?.available).toBe(true);
  });

  it('refuses a Restaurant Manager another restaurant’s menu (own_restaurant)', async () => {
    const mine = await h.restaurant('Own A');
    const other = await h.restaurant('Own B');
    await expect(
      h.restaurants.addCategory(
        {
          hotelId: other.hotel.hotelId,
          restaurantId: other.restaurantId,
          name: 'Хулгайлсан ангилал',
          idempotencyKey: key('x'),
        },
        mine.manager,
        request(mine.manager),
      ),
    ).rejects.toThrow();
  });

  it('refuses registration on a package below 30,000₮', async () => {
    const hotel = await h.stay.hotel('Too small', 'P25');
    const managerPlus = await h.stay.actorFor(
      await h.stay.seed(hotel.hotelId, `small-mplus-${Date.now()}@rest.test`, ['MANAGER_PLUS']),
    );
    await expect(
      h.restaurants.register(
        {
          hotelId: hotel.hotelId,
          displayName: 'Should not exist',
          cuisineKind: 'MONGOLIAN',
          addressLine: 'Улаанбаатар',
          latitudeMicro: 47_918_000,
          longitudeMicro: 106_917_000,
          contactPhone: '+97699001122',
          idempotencyKey: key('small'),
        },
        managerPlus,
        request(managerPlus),
      ),
    ).rejects.toThrow();
  });
});

describe('the guest’s way in (doc 08 §7)', () => {
  it('needs the QR and a code; the QR alone opens nothing', async () => {
    const fixture = await h.restaurant('Access');
    const stay = await h.stayIn(fixture);
    const qr = await h.access.issueRoomToken(
      { hotelId: fixture.hotel.hotelId, roomId: stay.roomId, idempotencyKey: key('qr') },
      fixture.hotel.manager,
      request(fixture.hotel.manager),
    );
    await expect(h.access.openSession({ roomToken: qr.token, code: '000000' })).rejects.toThrow(
      ApiError,
    );
    const code = await h.access.issueGuestCode(
      { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('code') },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    const opened = await h.access.openSession({ roomToken: qr.token, code: code.code });
    expect(opened.stayId).toBe(stay.stayId);
    // Nothing is stored in plaintext: neither the code nor the session token.
    const stored = await h.admin.query<{ code_hash: string }>(
      `SELECT code_hash FROM platform.guest_access_code WHERE code_id = $1`,
      [code.codeId],
    );
    expect(stored.rows[0]?.code_hash).not.toContain(code.code);
    expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GATE — a code cannot create a sixth concurrent session', async () => {
    const fixture = await h.restaurant('Five devices');
    const stay = await h.stayIn(fixture);
    const qr = await h.access.issueRoomToken(
      { hotelId: fixture.hotel.hotelId, roomId: stay.roomId, idempotencyKey: key('qr') },
      fixture.hotel.manager,
      request(fixture.hotel.manager),
    );
    for (let device = 0; device < 5; device += 1) {
      const code = await h.access.issueGuestCode(
        { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('c') },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      );
      const opened = await h.access.openSession({ roomToken: qr.token, code: code.code });
      expect(opened.guestSessionId).toBeTruthy();
    }
    // The sixth is refused at the issuing end, because the allowance counts
    // live sessions and unused codes together.
    await expect(
      h.access.issueGuestCode(
        { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('c') },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      ),
    ).rejects.toThrow(/GUEST_ACCESS_LIMIT/);
    const counter = await h.admin.query<{ active_sessions: number; pending_codes: number }>(
      `SELECT active_sessions, pending_codes FROM platform.stay_guest_access WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(counter.rows[0]?.active_sessions).toBe(5);
    expect(counter.rows[0]?.pending_codes).toBe(0);
  });

  it('a rotated QR voids the session that reached the room through the old one', async () => {
    const fixture = await h.restaurant('Rotation');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    expect(await h.access.resolveSession(session.token)).toBeDefined();
    await h.access.issueRoomToken(
      { hotelId: fixture.hotel.hotelId, roomId: stay.roomId, idempotencyKey: key('qr2') },
      fixture.hotel.manager,
      request(fixture.hotel.manager),
    );
    expect(await h.access.resolveSession(session.token)).toBeUndefined();
  });

  it('one room’s session never reads another room’s orders', async () => {
    const fixture = await h.restaurant('Confinement');
    const mine = await h.stayIn(fixture);
    const theirs = await h.stayIn(fixture);
    const mySession = await h.session(fixture, mine);
    const theirSession = await h.session(fixture, theirs);
    const theirOrder = await h.paidOrder(fixture, theirs, theirSession);
    const resolved = await h.access.resolveSession(mySession.token);
    expect(resolved).toBeDefined();
    if (resolved === undefined) return;
    const mine_orders = await h.orders.ordersForSession(resolved);
    expect(mine_orders.map((order) => order.orderId)).not.toContain(theirOrder.orderId);
    // And a command naming it is a NOT_FOUND, not a FORBIDDEN: the surface does
    // not disclose that somebody else's order exists.
    await expect(
      h.orders.requestRefundAsGuest(
        { orderId: theirOrder.orderId, idempotencyKey: key('steal') },
        resolved,
      ),
    ).rejects.toThrow(/no such order|not found/i);
  });
});

describe('ordering, payment and the invoice window', () => {
  it('prices the basket on the server and confirms only on the provider’s word', async () => {
    const fixture = await h.restaurant('Ordering');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const placed = await h.orders.placeOrder(
      {
        restaurantId: fixture.restaurantId,
        lines: [{ itemId: fixture.itemId, quantity: 3 }],
        idempotencyKey: key('order'),
      },
      resolved,
    );
    expect(placed.totalAmountMnt).toBe(fixture.priceMnt * 3n);
    const before = await h.admin.query<{ payment_state: string; order_state: string }>(
      `SELECT payment_state, order_state FROM platform.restaurant_order WHERE order_id = $1`,
      [placed.orderId],
    );
    expect(before.rows[0]?.payment_state).toBe('PENDING');
    expect(before.rows[0]?.order_state).toBe('PENDING_PAYMENT');
  });

  it('GATE — the invoice never outlives the day’s ordering close', async () => {
    const fixture = await h.restaurant('Closing');
    // A day that ends soon: the invoice's fifteen minutes must be cut short.
    const now = h.now();
    const inTenMinutes = new Date(now.getTime() + 10 * 60_000);
    const localClose = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ulaanbaatar',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(inTenMinutes);
    await h.restaurants.addScheduleOverride(
      {
        hotelId: fixture.hotel.hotelId,
        restaurantId: fixture.restaurantId,
        localDate: localDate(now),
        closed: false,
        opensAt: '00:00:00',
        closesAt: `${localClose}:00`,
        idempotencyKey: key('override'),
      },
      fixture.manager,
      request(fixture.manager),
    );
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const placed = await h.orders.placeOrder(
      {
        restaurantId: fixture.restaurantId,
        lines: [{ itemId: fixture.itemId, quantity: 1 }],
        idempotencyKey: key('order'),
      },
      resolved,
    );
    // The database says so too — the CHECK is what makes this true of every
    // row, not only of the one this test wrote.
    expect(placed.attempt.expiresAt.getTime()).toBeLessThanOrEqual(
      placed.orderingClosesAt.getTime(),
    );
    const stored = await h.admin.query<{ within: boolean }>(
      `SELECT (a.expires_at <= a.ordering_closes_at) AS within
         FROM platform.restaurant_payment_attempt a WHERE a.attempt_id = $1`,
      [placed.attempt.attemptId],
    );
    expect(stored.rows[0]?.within).toBe(true);
  });

  it('expires a lapsed invoice and cancels the order it was for', async () => {
    const fixture = await h.restaurant('Expiry');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const placed = await h.orders.placeOrder(
      {
        restaurantId: fixture.restaurantId,
        lines: [{ itemId: fixture.itemId, quantity: 1 }],
        idempotencyKey: key('order'),
      },
      resolved,
    );
    h.advance(20);
    const expired = await h.expiry.sweep(50, newRestaurantRequest());
    expect(expired).toBeGreaterThanOrEqual(1);
    const row = await h.admin.query<{ order_state: string; payment_state: string }>(
      `SELECT order_state, payment_state FROM platform.restaurant_order WHERE order_id = $1`,
      [placed.orderId],
    );
    expect(row.rows[0]?.order_state).toBe('CANCELLED');
    expect(row.rows[0]?.payment_state).toBe('EXPIRED');
  });
});

describe('GATE — restaurant money stays out of every hotel total', () => {
  it('a paid order touches no folio, deposit, drawer, shift or minibar line', async () => {
    const fixture = await h.restaurant('Separation');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const order = await h.paidOrder(fixture, stay, session);
    expect(order.totalAmountMnt).toBe(fixture.priceMnt);

    const hotelId = fixture.hotel.hotelId;
    // Every table that carries hotel money. None of them may name the order,
    // and none of them may carry its amount for this stay (doc 08 §13,
    // doc 24 §1).
    // Every table that carries hotel money. None of them may carry the order's
    // amount for this stay, and none of them may have moved at all (doc 08 §13,
    // doc 24 §1).
    const folio = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.folio_line l
         JOIN platform.stay_folio f ON f.folio_id = l.folio_id
        WHERE f.stay_id = $1`,
      [stay.stayId],
    );
    expect(folio.rows[0]?.count).toBe('0');
    const cash = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.cash_movement
        WHERE hotel_id = $1 AND amount_mnt = $2`,
      [hotelId, order.totalAmountMnt.toString()],
    );
    expect(cash.rows[0]?.count).toBe('0');
    const payments = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.payment_transaction
        WHERE hotel_id = $1 AND amount_mnt = $2`,
      [hotelId, order.totalAmountMnt.toString()],
    );
    expect(payments.rows[0]?.count).toBe('0');
    const deposits = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.deposit_aggregate
        WHERE stay_id = $1 AND received_mnt <> 0`,
      [stay.stayId],
    );
    expect(deposits.rows[0]?.count).toBe('0');
    // And the platform's own settlement ledger never learns of it: the
    // restaurant's merchant is the restaurant's (doc 08 §13).
    const payables = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.booking_payable WHERE hotel_id = $1`,
      [hotelId],
    );
    expect(payables.rows[0]?.count).toBe('0');
  });
});

describe('checkout (doc 08 §§17–19)', () => {
  it('refuses the checkout until every unfinished order is acknowledged, then closes access', async () => {
    const fixture = await h.restaurant('Checkout');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const order = await h.paidOrder(fixture, stay, session);
    await h.orders.accept(
      {
        hotelId: fixture.hotel.hotelId,
        orderId: order.orderId,
        etaMinutes: 30,
        idempotencyKey: key('accept'),
      },
      fixture.manager,
      request(fixture.manager),
    );

    const stayRow = await h.admin.query<{ revision: number }>(
      `SELECT revision FROM platform.stay WHERE stay_id = $1`,
      [stay.stayId],
    );
    const revision = stayRow.rows[0]?.revision ?? 0;
    await h.stay.checkouts.start(
      {
        hotelId: fixture.hotel.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co-start'),
        expectedRevision: revision,
      },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );

    const afterStart = await h.admin.query<{ revision: number }>(
      `SELECT revision FROM platform.stay WHERE stay_id = $1`,
      [stay.stayId],
    );
    const started = afterStart.rows[0]?.revision ?? 0;
    // The unfinished order does not cancel the checkout — it asks Reception to
    // acknowledge it first (doc 08 §18).
    await expect(
      h.stay.stays.recordActualCheckout(
        {
          hotelId: fixture.hotel.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('co-1'),
          expectedRevision: started,
        },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      ),
    ).rejects.toThrow(/RESTAURANT_ORDERS_UNACKNOWLEDGED/);

    await h.orders.recordHandoff(
      {
        hotelId: fixture.hotel.hotelId,
        orderId: order.orderId,
        mode: 'RECEPTION',
        idempotencyKey: key('handoff'),
      },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    await h.stay.stays.recordActualCheckout(
      {
        hotelId: fixture.hotel.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co-2'),
        expectedRevision: started,
      },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );

    // doc 08 §7: the stay's access dies with the stay.
    expect(await h.access.resolveSession(session.token)).toBeUndefined();
    const counter = await h.admin.query<{ active_sessions: number; pending_codes: number }>(
      `SELECT active_sessions, pending_codes FROM platform.stay_guest_access WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(counter.rows[0]?.active_sessions).toBe(0);
    expect(counter.rows[0]?.pending_codes).toBe(0);
    // And the order itself is untouched: a checkout cancels nothing and
    // refunds nothing (doc 08 §18).
    const untouched = await h.admin.query<{ order_state: string; payment_state: string }>(
      `SELECT order_state, payment_state FROM platform.restaurant_order WHERE order_id = $1`,
      [order.orderId],
    );
    expect(untouched.rows[0]?.order_state).toBe('CONFIRMED');
    expect(untouched.rows[0]?.payment_state).toBe('PAID');
  });

  it('a checked-out stay places no new order', async () => {
    const fixture = await h.restaurant('No new orders');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const stayRow = await h.admin.query<{ revision: number }>(
      `SELECT revision FROM platform.stay WHERE stay_id = $1`,
      [stay.stayId],
    );
    await h.stay.checkouts.start(
      {
        hotelId: fixture.hotel.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co-start'),
        expectedRevision: stayRow.rows[0]?.revision ?? 0,
      },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    await expect(
      h.orders.placeOrder(
        {
          restaurantId: fixture.restaurantId,
          lines: [{ itemId: fixture.itemId, quantity: 1 }],
          idempotencyKey: key('late'),
        },
        resolved,
      ),
    ).rejects.toThrow(/STAY_NOT_ACTIVE/);
  });
});

function localDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(at);
}
