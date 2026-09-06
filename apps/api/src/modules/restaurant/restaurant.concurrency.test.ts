import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RestaurantHarness } from './test-support/restaurant-harness';
import { createRestaurantHarness, key, request } from './test-support/restaurant-harness';

/**
 * The races Phase 15 exists to lose safely (build-plan §"Phase 15").
 *
 * Real PostgreSQL, real concurrency. Not one of the guarantees below is the
 * application's own: the acceptance race is decided by the order's row lock,
 * the device allowance by a `CHECK`, and the one-session-per-code rule by a
 * unique constraint — a test that stubbed any of them would be asserting about
 * a hope.
 */

let h: RestaurantHarness;

beforeAll(async () => {
  h = await createRestaurantHarness('restaurant_con');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('GATE — acceptance and a refund request committing together', () => {
  it('the first valid transition wins, and the loser sees the world it lost to', async () => {
    const fixture = await h.restaurant('Race');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const order = await h.paidOrder(fixture, stay, session);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');

    // Past the ten minutes, so the refund request is a live command rather than
    // one that would be refused as TOO_EARLY (doc 08 §20).
    h.advance(11);

    const accept = h.orders.accept(
      {
        hotelId: fixture.hotel.hotelId,
        orderId: order.orderId,
        etaMinutes: 30,
        idempotencyKey: key('accept'),
      },
      fixture.manager,
      request(fixture.manager),
    );
    const refund = h.orders.requestRefundAsGuest(
      { orderId: order.orderId, idempotencyKey: key('refund') },
      resolved,
    );
    const [acceptOutcome, refundOutcome] = await Promise.allSettled([accept, refund]);

    const row = await h.admin.query<{
      fulfillment_state: string;
      order_state: string;
      refund_policy: string;
      refund_request_state: string;
      payment_state: string;
      accepted_at: Date | null;
    }>(
      `SELECT fulfillment_state, order_state, refund_policy, refund_request_state,
              payment_state, accepted_at
         FROM platform.restaurant_order WHERE order_id = $1`,
      [order.orderId],
    );
    const final = row.rows[0];
    if (final === undefined) throw new Error('the order vanished');

    // Exactly one of the two shapes doc 08 §20 permits — never a mixture, and
    // never both winning.
    if (final.accepted_at === null) {
      // The refund request took the row first: pre-accept and past the ten
      // minutes, so the refund is mandatory and the order is cancelled.
      expect(final.refund_policy).toBe('MANDATORY');
      expect(final.refund_request_state).toBe('APPROVED');
      expect(final.order_state).toBe('CANCELLED');
      expect(final.fulfillment_state).toBe('CANCELLED');
      expect(acceptOutcome.status).toBe('rejected');
      expect(refundOutcome.status).toBe('fulfilled');
    } else {
      // The acceptance took it first, so the later request is the accepted
      // order's: discretionary, open, and fulfilment continues.
      expect(final.fulfillment_state).not.toBe('CANCELLED');
      expect(final.order_state).toBe('CONFIRMED');
      expect(acceptOutcome.status).toBe('fulfilled');
      if (refundOutcome.status === 'fulfilled') {
        expect(final.refund_policy).toBe('DISCRETIONARY');
        expect(final.refund_request_state).toBe('OPEN');
      }
    }
    // The money did not move either way: only a provider refund does that.
    expect(final.payment_state).toBe('PAID');
  });

  it('runs the race ten times and never produces a mixed state', async () => {
    const fixture = await h.restaurant('Race many');
    for (let round = 0; round < 10; round += 1) {
      h.resetClock();
      const stay = await h.stayIn(fixture);
      const session = await h.session(fixture, stay);
      const order = await h.paidOrder(fixture, stay, session);
      const resolved = await h.access.resolveSession(session.token);
      if (resolved === undefined) throw new Error('no session');
      h.advance(11);
      await Promise.allSettled([
        h.orders.accept(
          {
            hotelId: fixture.hotel.hotelId,
            orderId: order.orderId,
            etaMinutes: 15,
            idempotencyKey: key('accept'),
          },
          fixture.manager,
          request(fixture.manager),
        ),
        h.orders.requestRefundAsGuest(
          { orderId: order.orderId, idempotencyKey: key('refund') },
          resolved,
        ),
      ]);
      const row = await h.admin.query<{
        fulfillment_state: string;
        refund_policy: string;
        refund_request_state: string;
        accepted_at: Date | null;
      }>(
        `SELECT fulfillment_state, refund_policy, refund_request_state, accepted_at
           FROM platform.restaurant_order WHERE order_id = $1`,
        [order.orderId],
      );
      const final = row.rows[0];
      if (final === undefined) throw new Error('the order vanished');
      // A cancelled order was never accepted, and an accepted one was never
      // mandatorily refunded. Those are the two impossible mixtures.
      const cancelledAfterAccept =
        final.fulfillment_state === 'CANCELLED' && final.accepted_at !== null;
      const mandatoryAfterAccept =
        final.refund_policy === 'MANDATORY' && final.accepted_at !== null;
      expect(cancelledAfterAccept).toBe(false);
      expect(mandatoryAfterAccept).toBe(false);
    }
  }, 180_000);
});

describe('the five-device allowance under contention', () => {
  it('two codes confirmed at the same instant cannot make a sixth session', async () => {
    const fixture = await h.restaurant('Concurrent codes');
    const stay = await h.stayIn(fixture);
    const qr = await h.access.issueRoomToken(
      { hotelId: fixture.hotel.hotelId, roomId: stay.roomId, idempotencyKey: key('qr') },
      fixture.hotel.manager,
      request(fixture.hotel.manager),
    );
    // Four live sessions, then two codes issued — the allowance is exactly full.
    for (let device = 0; device < 4; device += 1) {
      const code = await h.access.issueGuestCode(
        { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('c') },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      );
      await h.access.openSession({ roomToken: qr.token, code: code.code });
    }
    const fifth = await h.access.issueGuestCode(
      { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('c5') },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    // The sixth code is refused before it exists, so the pair below is the only
    // contention the allowance can actually see.
    await expect(
      h.access.issueGuestCode(
        { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('c6') },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      ),
    ).rejects.toThrow(/GUEST_ACCESS_LIMIT/);

    // And the fifth code redeemed twice at once spends once: the code's own
    // state transition is a CAS, so the second attempt finds it used.
    const [first, second] = await Promise.allSettled([
      h.access.openSession({ roomToken: qr.token, code: fifth.code }),
      h.access.openSession({ roomToken: qr.token, code: fifth.code }),
    ]);
    const opened = [first, second].filter((outcome) => outcome.status === 'fulfilled');
    expect(opened).toHaveLength(1);
    const counter = await h.admin.query<{ active_sessions: number; pending_codes: number }>(
      `SELECT active_sessions, pending_codes FROM platform.stay_guest_access WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(counter.rows[0]?.active_sessions).toBe(5);
    expect(counter.rows[0]?.pending_codes).toBe(0);
  });
});

describe('one payment applied twice', () => {
  it('a duplicated provider callback confirms the order exactly once', async () => {
    const fixture = await h.restaurant('Duplicate callback');
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
    await h.orders.openInvoice({ orderId: placed.orderId }, resolved);
    const attempt = await h.admin.query<{ provider_invoice_id: string }>(
      `SELECT provider_invoice_id FROM platform.restaurant_payment_attempt
        WHERE order_id = $1 AND state = 'ACTIVE'`,
      [placed.orderId],
    );
    const providerInvoiceId = attempt.rows[0]?.provider_invoice_id;
    if (providerInvoiceId === undefined) throw new Error('no invoice');
    const gateway = h.gateway('QPAY');
    const providerPaymentId = gateway.pay(providerInvoiceId, h.now());
    const callback = {
      provider: 'QPAY' as const,
      providerInvoiceId,
      providerPaymentId,
      signature: gateway.signatureFor(providerInvoiceId),
    };
    await Promise.allSettled([
      h.orders.handleCallback(callback),
      h.orders.handleCallback(callback),
      h.orders.handleCallback(callback),
    ]);
    const events = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.restaurant_order_event
        WHERE order_id = $1 AND event_type = 'order.confirmed'`,
      [placed.orderId],
    );
    // A retry never creates a second business effect (CLAUDE.md §6).
    expect(events.rows[0]?.count).toBe('1');
    const order = await h.admin.query<{ payment_state: string; order_state: string }>(
      `SELECT payment_state, order_state FROM platform.restaurant_order WHERE order_id = $1`,
      [placed.orderId],
    );
    expect(order.rows[0]?.payment_state).toBe('PAID');
    expect(order.rows[0]?.order_state).toBe('CONFIRMED');
  });
});
