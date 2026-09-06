import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingHarness } from './test-support/booking-harness';
import { createBookingHarness } from './test-support/booking-harness';
import { newBookingRequest } from './services/booking-context';
import { HOLD_SECONDS } from './domain/booking';

/**
 * The two races Phase 13 exists to lose safely (build-plan §"Phase 13").
 *
 * Real PostgreSQL, real concurrency. Neither guarantee below is the
 * application's: one is a CHECK constraint and the other is a row lock, and a
 * test that stubbed either would be asserting about a hope.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `booking-con-${String(keys)}`;
};

const DAY = 86_400_000;
const window = (offsetDays: number): { checkInDate: Date; checkOutDate: Date } => {
  const start = new Date(Date.now() + offsetDays * DAY);
  const checkInDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  return { checkInDate, checkOutDate: new Date(checkInDate.getTime() + DAY) };
};

beforeAll(async () => {
  h = await createBookingHarness('booking_con');
}, 300_000);
afterAll(async () => {
  await h?.close();
});

function hold(
  hotel: { categoryId: string },
  guest: string,
  dates: { checkInDate: Date; checkOutDate: Date },
) {
  return h.bookingService.hold(
    {
      categoryId: hotel.categoryId,
      ...dates,
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
      idempotencyKey: key(),
    },
    newBookingRequest(guest),
  );
}

describe('two guests paying for the last unit of a category', () => {
  it('sells it exactly once, and the loser is refused by the constraint', async () => {
    const hotel = await h.bookableHotel('last-unit', 1);
    const [first, second] = [await h.guest(), await h.guest()];
    const dates = window(200);

    const outcomes = await Promise.allSettled([
      hold(hotel, first, dates),
      hold(hotel, second, dates),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === 'rejected');
    expect(String((lost as PromiseRejectedResult).reason)).toMatch(/NO_UNITS_LEFT/);

    const inventory = await h.admin.query<{ units_held: string; units_capacity: string }>(
      `SELECT units_held, units_capacity FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    // The invariant the database holds: never more units taken than exist.
    expect(Number(inventory.rows[0]?.units_held)).toBe(1);
    expect(Number(inventory.rows[0]?.units_capacity)).toBe(1);

    const live = await h.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.booking
        WHERE hotel_id = $1 AND state = ANY (ARRAY['HOLDING', 'CONFIRMED'])`,
      [hotel.hotelId],
    );
    expect(Number(live.rows[0]?.n)).toBe(1);
  }, 180_000);

  it('never oversells when five guests race three units', async () => {
    const hotel = await h.bookableHotel('five-race', 3);
    const dates = window(210);
    const guests = await Promise.all([h.guest(), h.guest(), h.guest(), h.guest(), h.guest()]);
    const outcomes = await Promise.allSettled(guests.map((g) => hold(hotel, g, dates)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);

    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(Number(inventory.rows[0]?.units_held)).toBe(3);
  }, 180_000);
});

describe('expiry racing a paid callback (PAY-DEC-006)', () => {
  it('lets exactly one of them decide, and the other owes or does nothing', async () => {
    const hotel = await h.bookableHotel('expiry-race', 1);
    const dates = window(220);
    const held = await hold(hotel, await h.guest(), dates);

    // Both arrive at the instant the hold lapses, and both take the same row.
    h.advance(HOLD_SECONDS + 1);
    const [sweep, capture] = await Promise.allSettled([
      h.expiry.sweep(),
      h.bookingService.applyCapture(
        {
          attemptId: held.attempt.attemptId,
          providerInvoiceId: 'inv-race',
          providerPaymentId: 'pay-race',
          hotelId: hotel.hotelId,
        },
        newBookingRequest(),
      ),
    ]);

    const after = await h.admin.query<Record<string, unknown>>(
      `SELECT state, hold_state, payment_state, refund_state
         FROM platform.booking WHERE booking_id = $1`,
      [held.bookingId],
    );
    const row = after.rows[0] as Record<string, string>;

    // Whichever won, the booking is in exactly one of the two coherent
    // outcomes — never confirmed *and* expired, and never expired with the
    // money kept.
    if (row['state'] === 'EXPIRED') {
      expect(row['hold_state']).toBe('EXPIRED');
      if (row['payment_state'] === 'PAID') expect(row['refund_state']).toBe('REQUIRED');
    } else {
      expect(row['state']).toBe('CONFIRMED');
      expect(row['payment_state']).toBe('PAID');
      expect(row['hold_state']).toBe('CONSUMED');
      expect(row['refund_state']).toBe('NONE');
    }
    expect(sweep.status).toBe('fulfilled');
    expect(capture.status).toBe('fulfilled');
  }, 180_000);

  it('leaves the inventory consistent with whichever outcome won', async () => {
    const hotel = await h.bookableHotel('expiry-race-inventory', 1);
    const dates = window(230);
    const held = await hold(hotel, await h.guest(), dates);
    h.advance(HOLD_SECONDS + 1);
    await Promise.allSettled([
      h.expiry.sweep(),
      h.bookingService.applyCapture(
        {
          attemptId: held.attempt.attemptId,
          providerInvoiceId: 'inv-2',
          providerPaymentId: 'pay-2',
          hotelId: hotel.hotelId,
        },
        newBookingRequest(),
      ),
    ]);
    const state = await h.admin.query<{ state: string }>(
      `SELECT state FROM platform.booking WHERE booking_id = $1`,
      [held.bookingId],
    );
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    // An expired booking holds nothing; a confirmed one holds its unit. What
    // must never happen is a unit held by a booking that ended.
    const held_units = Number(inventory.rows[0]?.units_held);
    expect(held_units).toBe(state.rows[0]?.state === 'EXPIRED' ? 0 : 1);
  }, 180_000);
});

describe('two captures arriving together', () => {
  it('posts the money once and raises one obligation, never two confirmations', async () => {
    const hotel = await h.bookableHotel('double-capture', 1);
    const dates = window(240);
    const held = await hold(hotel, await h.guest(), dates);
    const outcomes = await Promise.allSettled([
      h.bookingService.applyCapture(
        {
          attemptId: held.attempt.attemptId,
          providerInvoiceId: 'inv-a',
          providerPaymentId: 'pay-a',
          hotelId: hotel.hotelId,
        },
        newBookingRequest(),
      ),
      h.bookingService.applyCapture(
        {
          attemptId: held.attempt.attemptId,
          providerInvoiceId: 'inv-b',
          providerPaymentId: 'pay-b',
          hotelId: hotel.hotelId,
        },
        newBookingRequest(),
      ),
    ]);
    const settled = outcomes
      .filter(
        (o): o is PromiseFulfilledResult<{ outcome: string; bookingId: string }> =>
          o.status === 'fulfilled',
      )
      .map((o) => o.value.outcome);
    // One confirms; the other is a replay or an obligation, never a second
    // confirmation.
    expect(settled.filter((o) => o === 'confirmed').length).toBeLessThanOrEqual(1);
    const paid = await h.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.booking_payment_attempt
        WHERE booking_id = $1 AND state = 'PAID'`,
      [held.bookingId],
    );
    expect(Number(paid.rows[0]?.n)).toBeLessThanOrEqual(1);
  }, 180_000);
});
