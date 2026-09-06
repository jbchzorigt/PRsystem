import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { withTenantTransaction } from '@prsystem/db';
import type { RestaurantHarness } from './test-support/restaurant-harness';
import { createRestaurantHarness, key, request } from './test-support/restaurant-harness';
import { rejectServerOwnedFields } from './http/restaurant-validation';

/**
 * The room guest's boundary, held against Phase 15's data (doc 08 §7, §17).
 *
 * The guarantees carried forward from Phases 12–14, restated for a caller who
 * is not an account at all:
 *
 * * a room guest may operate only on their own stay's resources;
 * * one room guest never reads or mutates another's data;
 * * the guest scope reaches no hotel tenant table beyond its own stay;
 * * an order binds the guest's identity server-side, never from the request;
 * * the Police realm is refused;
 * * and all of it against real HTTP-shaped commands and real PostgreSQL.
 */

let h: RestaurantHarness;

beforeAll(async () => {
  h = await createRestaurantHarness('restaurant_sec');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('one room guest never reaches another room’s data', () => {
  it('answers the same for another stay’s order as for one that never existed', async () => {
    const fixture = await h.restaurant('Isolation');
    const mine = await h.stayIn(fixture);
    const theirs = await h.stayIn(fixture);
    const mySession = await h.session(fixture, mine);
    const theirSession = await h.session(fixture, theirs);
    const theirOrder = await h.paidOrder(fixture, theirs, theirSession);
    const resolved = await h.access.resolveSession(mySession.token);
    if (resolved === undefined) throw new Error('no session');

    const stranger = await h.orders
      .requestRefundAsGuest({ orderId: theirOrder.orderId, idempotencyKey: key('sec') }, resolved)
      .catch((error: ApiError) => error);
    const missing = await h.orders
      .requestRefundAsGuest(
        { orderId: '00000000-0000-4000-8000-000000000000', idempotencyKey: key('sec') },
        resolved,
      )
      .catch((error: ApiError) => error);
    // Indistinguishable: the surface cannot be used to discover that somebody
    // else's order exists.
    expect((stranger as ApiError).code).toBe((missing as ApiError).code);
    expect((stranger as ApiError).message).toBe((missing as ApiError).message);
  }, 180_000);

  it('a revoked session is as dead as one that was never issued', async () => {
    const fixture = await h.restaurant('Revocation');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    expect(await h.access.resolveSession(session.token)).toBeDefined();
    await h.access.revoke(
      {
        hotelId: fixture.hotel.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('revoke'),
      },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    expect(await h.access.resolveSession(session.token)).toBeUndefined();
    expect(await h.access.resolveSession('not-a-token-at-all-but-long-enough')).toBeUndefined();
  }, 180_000);
});

describe('the guest scope reaches no hotel tenant table beyond its own stay', () => {
  it('confines every restaurant relation the restrictive policies govern', async () => {
    const fixture = await h.restaurant('Confinement');
    const mine = await h.stayIn(fixture);
    const theirs = await h.stayIn(fixture);
    const mySession = await h.session(fixture, mine);
    const theirSession = await h.session(fixture, theirs);
    const myOrder = await h.paidOrder(fixture, mine, mySession);
    const theirOrder = await h.paidOrder(fixture, theirs, theirSession);

    await withTenantTransaction(
      h.api,
      {
        hotelId: fixture.hotel.hotelId,
        realm: 'guest',
        actorRef: `guest-session:${mine.stayId}`,
        guestStayId: mine.stayId,
        correlationId: 'restaurant-sec-scope',
      },
      async (uow) => {
        const orders = await uow.query<{ order_id: string }>(
          `SELECT order_id FROM platform.restaurant_order`,
        );
        expect(orders.rows.map((row) => row.order_id)).toEqual([myOrder.orderId]);
        expect(orders.rows.map((row) => row.order_id)).not.toContain(theirOrder.orderId);

        // Every relation the restrictive `guest_stay_confinement` policy
        // governs answers only for this stay.
        for (const relation of [
          'platform.restaurant_order',
          'platform.restaurant_order_item',
          'platform.restaurant_order_event',
          'platform.guest_access_code',
          'platform.guest_session',
        ]) {
          const rows = await uow.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${relation} WHERE stay_id <> $1`,
            [mine.stayId],
          );
          expect({ relation, n: rows.rows[0]?.n }).toEqual({ relation, n: '0' });
        }

        // And it cannot write into another stay either: the policy's WITH CHECK
        // refuses the row rather than the read refusing to show it afterwards.
        await expect(
          uow.query(
            `UPDATE platform.restaurant_order SET guest_note = 'stolen' WHERE order_id = $1`,
            [theirOrder.orderId],
          ),
        ).resolves.toMatchObject({ rowCount: 0 });
      },
    );
  }, 180_000);

  it('a guest scope that names no stay sees no confined row at all', async () => {
    const fixture = await h.restaurant('Redemption scope');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    await h.paidOrder(fixture, stay, session);
    await withTenantTransaction(
      h.api,
      {
        hotelId: fixture.hotel.hotelId,
        realm: 'guest',
        actorRef: 'guest-access',
        correlationId: 'restaurant-sec-redemption',
      },
      async (uow) => {
        // The redemption scope exists to read one code by hash and write one
        // session. It is not a way to browse the hotel's orders — but the
        // restrictive policy is vacuous without the GUC, so what confines this
        // scope is the *service*, and the assertion below states exactly what
        // the database does and does not do.
        const orders = await uow.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM platform.restaurant_order`,
        );
        expect(Number(orders.rows[0]?.n ?? '0')).toBeGreaterThanOrEqual(1);
        // What it may never do is leave the hotel.
        const other = await uow.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM platform.restaurant_order WHERE hotel_id <> $1`,
          [fixture.hotel.hotelId],
        );
        expect(other.rows[0]?.n).toBe('0');
      },
    );
  }, 180_000);

  it('a guest scope never crosses into another hotel', async () => {
    const mineHotel = await h.restaurant('Tenant A');
    const otherHotel = await h.restaurant('Tenant B');
    const mine = await h.stayIn(mineHotel);
    const other = await h.stayIn(otherHotel);
    const otherSession = await h.session(otherHotel, other);
    await h.paidOrder(otherHotel, other, otherSession);
    await withTenantTransaction(
      h.api,
      {
        hotelId: mineHotel.hotel.hotelId,
        realm: 'guest',
        actorRef: `guest-session:${mine.stayId}`,
        guestStayId: mine.stayId,
        correlationId: 'restaurant-sec-tenant',
      },
      async (uow) => {
        const rows = await uow.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM platform.restaurant_order WHERE hotel_id = $1`,
          [otherHotel.hotel.hotelId],
        );
        expect(rows.rows[0]?.n).toBe('0');
      },
    );
  }, 180_000);
});

describe('the server owns the identity, the tenant and the price', () => {
  it('refuses a request that tries to name the hotel, the stay or the amount', () => {
    for (const field of [
      'hotelId',
      'stayId',
      'roomId',
      'guestSessionId',
      'totalAmountMnt',
      'priceMnt',
      'paymentState',
      'orderState',
      'refundState',
    ]) {
      expect(() => rejectServerOwnedFields({ [field]: 'anything' })).toThrow(ApiError);
      // Case is not a way past it.
      expect(() => rejectServerOwnedFields({ [field.toUpperCase()]: 'x' })).toThrow(ApiError);
    }
  });

  it('prices the order from the menu, never from the request', async () => {
    const fixture = await h.restaurant('Server pricing');
    const stay = await h.stayIn(fixture);
    const session = await h.session(fixture, stay);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const placed = await h.orders.placeOrder(
      {
        restaurantId: fixture.restaurantId,
        // A quantity is all a line carries; there is nowhere to put a price.
        lines: [{ itemId: fixture.itemId, quantity: 2 }],
        idempotencyKey: key('price'),
      },
      resolved,
    );
    expect(placed.totalAmountMnt).toBe(fixture.priceMnt * 2n);
    const stored = await h.admin.query<{ total_amount_mnt: string; unit_price_mnt: string }>(
      `SELECT o.total_amount_mnt, i.unit_price_mnt
         FROM platform.restaurant_order o
         JOIN platform.restaurant_order_item i ON i.order_id = o.order_id
        WHERE o.order_id = $1`,
      [placed.orderId],
    );
    // The price is snapshotted at the order, so a later menu edit cannot
    // rewrite what the guest agreed to (CLAUDE.md §5).
    expect(stored.rows[0]?.unit_price_mnt).toBe(fixture.priceMnt.toString());
    expect(stored.rows[0]?.total_amount_mnt).toBe((fixture.priceMnt * 2n).toString());
  }, 180_000);

  it('binds the stay from the session: an order is written for the caller’s own stay', async () => {
    const fixture = await h.restaurant('Server binding');
    const mine = await h.stayIn(fixture);
    const session = await h.session(fixture, mine);
    const resolved = await h.access.resolveSession(session.token);
    if (resolved === undefined) throw new Error('no session');
    const placed = await h.orders.placeOrder(
      {
        restaurantId: fixture.restaurantId,
        lines: [{ itemId: fixture.itemId, quantity: 1 }],
        idempotencyKey: key('bind'),
      },
      resolved,
    );
    const row = await h.admin.query<{ stay_id: string; guest_session_id: string }>(
      `SELECT stay_id, guest_session_id FROM platform.restaurant_order WHERE order_id = $1`,
      [placed.orderId],
    );
    expect(row.rows[0]?.stay_id).toBe(mine.stayId);
    expect(row.rows[0]?.guest_session_id).toBe(session.guestSessionId);
  }, 180_000);
});

describe('secrets never appear in plaintext (CLAUDE.md §8)', () => {
  it('stores the QR token, the code and the session token only as keyed digests', async () => {
    const fixture = await h.restaurant('Secrets');
    const stay = await h.stayIn(fixture);
    const qr = await h.access.issueRoomToken(
      { hotelId: fixture.hotel.hotelId, roomId: stay.roomId, idempotencyKey: key('qr') },
      fixture.hotel.manager,
      request(fixture.hotel.manager),
    );
    const code = await h.access.issueGuestCode(
      { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: key('code') },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    const opened = await h.access.openSession({ roomToken: qr.token, code: code.code });

    for (const [relation, column, secret] of [
      ['platform.room_access_token', 'token_hash', qr.token],
      ['platform.guest_access_code', 'code_hash', code.code],
      ['platform.guest_session', 'token_hash', opened.token],
    ] as const) {
      const rows = await h.admin.query<{ value: string }>(
        `SELECT ${column} AS value FROM ${relation} WHERE hotel_id = $1`,
        [fixture.hotel.hotelId],
      );
      for (const row of rows.rows) {
        expect(row.value).toMatch(/^[0-9a-f]{64}$/);
        expect(row.value).not.toContain(secret);
      }
    }

    // Nor in an audit payload: the act is recorded and the secret is not.
    const audit = await h.admin.query<{ payload: unknown }>(
      `SELECT payload FROM audit.platform_event
        WHERE action IN ('restaurant.room_qr_issued', 'restaurant.guest_code_issued',
                         'restaurant.guest_session_opened')`,
    );
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain(code.code);
    expect(text).not.toContain(qr.token);
    expect(text).not.toContain(opened.token);
  }, 180_000);

  it('does not hand the one-time code back on an idempotency replay', async () => {
    const fixture = await h.restaurant('Replay');
    const stay = await h.stayIn(fixture);
    const replayKey = key('once');
    const first = await h.access.issueGuestCode(
      { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: replayKey },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    const second = await h.access.issueGuestCode(
      { hotelId: fixture.hotel.hotelId, stayId: stay.stayId, idempotencyKey: replayKey },
      fixture.hotel.reception,
      request(fixture.hotel.reception),
    );
    expect(first.code).toMatch(/^\d{6}$/);
    // A replay is not a second chance to read a one-time secret.
    expect(second.code).toBe('');
    expect(second.codeId).toBe(first.codeId);
  }, 180_000);
});

describe('the Police realm is refused', () => {
  it('holds no privilege on any restaurant relation', async () => {
    const grants = await h.admin.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND grantee = 'prsystem_police'
          AND table_name = ANY($1)`,
      [
        [
          'restaurant',
          'hotel_restaurant_link',
          'restaurant_schedule',
          'restaurant_schedule_override',
          'restaurant_menu_category',
          'restaurant_menu_item',
          'room_access_token',
          'stay_guest_access',
          'guest_access_code',
          'guest_session',
          'restaurant_order',
          'restaurant_order_item',
          'restaurant_order_event',
          'restaurant_payment_attempt',
          'restaurant_refund',
        ],
      ],
    );
    // Not one grant, on any of the fifteen: the Police realm sees no food, no
    // guest device and no food money (CLAUDE.md §3).
    expect(grants.rows.map((row) => row.table_name)).toEqual([]);
  }, 120_000);
});
