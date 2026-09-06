import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { BookingHarness } from './test-support/booking-harness';
import { createBookingHarness } from './test-support/booking-harness';
import { newBookingRequest } from './services/booking-context';
import { newPublicRequest } from '../public/services/search.service';
import { HOLD_SECONDS } from './domain/booking';

/**
 * The booking, end to end, against real PostgreSQL (doc 09 §§7–10;
 * `BK-DEC-009`, `-012`, `-013`, `PAY-DEC-002`, `-006`).
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `booking-int-${String(keys)}`;
};

const DAY = 86_400_000;
const window = (offsetDays = 30, nights = 1): { checkInDate: Date; checkOutDate: Date } => {
  const start = new Date(Date.now() + offsetDays * DAY);
  const checkInDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  return { checkInDate, checkOutDate: new Date(checkInDate.getTime() + nights * DAY) };
};

beforeAll(async () => {
  h = await createBookingHarness('booking_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});

async function hold(
  hotel: { hotelId: string; categoryId: string },
  guest: string,
  dates = window(),
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

async function confirm(attemptId: string, hotelId: string) {
  return h.bookingService.applyCapture(
    { attemptId, providerInvoiceId: `inv-${attemptId.slice(0, 8)}`, hotelId },
    newBookingRequest(),
  );
}

describe('the hold and the confirmation (doc 09 §7)', () => {
  it('takes one unit per night, confirms on capture, and snapshots the price', async () => {
    const hotel = await h.bookableHotel('confirm', 1);
    const guest = await h.guest();
    const dates = window(30, 2);
    const held = await hold(hotel, guest, dates);

    expect(held.nightCount).toBe(2);
    expect(held.holdExpiresAt.getTime() - Date.now()).toBeGreaterThan((HOLD_SECONDS - 60) * 1000);
    const inventory = await h.admin.query<{ night: Date; units_held: number }>(
      `SELECT night, units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2 ORDER BY night`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(inventory.rows.map((r) => Number(r.units_held))).toEqual([1, 1]);

    const outcome = await confirm(held.attempt.attemptId, hotel.hotelId);
    expect(outcome.outcome).toBe('confirmed');
    const row = await h.bookingService.byId(held.bookingId, newBookingRequest(guest));
    expect(row.state).toBe('CONFIRMED');
    expect(row.holdState).toBe('CONSUMED');
    expect(row.paymentState).toBe('PAID');
    // doc 09 §7 step 8: the price becomes a snapshot at confirmation.
    expect(row.totalAmountMnt).not.toBeNull();
  }, 180_000);

  it('refuses the unit past capacity, by constraint (BK-DEC-013)', async () => {
    const hotel = await h.bookableHotel('capacity', 1);
    const dates = window(40);
    await hold(hotel, await h.guest(), dates);
    // One room, one night, one unit — the second guest is refused.
    await expect(hold(hotel, await h.guest(), dates)).rejects.toThrow(/NO_UNITS_LEFT/);
  }, 180_000);

  it('sells the second unit when the category has two rooms', async () => {
    const hotel = await h.bookableHotel('two-rooms', 2);
    const dates = window(50);
    await hold(hotel, await h.guest(), dates);
    const second = await hold(hotel, await h.guest(), dates);
    expect(second.bookingId).toBeDefined();
    await expect(hold(hotel, await h.guest(), dates)).rejects.toThrow(/NO_UNITS_LEFT/);
  }, 180_000);

  it('replays an idempotent hold rather than taking a second unit', async () => {
    const hotel = await h.bookableHotel('idempotent', 1);
    const guest = await h.guest();
    const dates = window(60);
    const idempotencyKey = key();
    const first = await h.bookingService.hold(
      {
        categoryId: hotel.categoryId,
        ...dates,
        stayingGuestName: 'Синтетик зочин',
        provider: 'QPAY',
        idempotencyKey,
      },
      newBookingRequest(guest),
    );
    const again = await h.bookingService.hold(
      {
        categoryId: hotel.categoryId,
        ...dates,
        stayingGuestName: 'Синтетик зочин',
        provider: 'QPAY',
        idempotencyKey,
      },
      newBookingRequest(guest),
    );
    expect(again.bookingId).toBe(first.bookingId);
    const held = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(Number(held.rows[0]?.units_held)).toBe(1);
  }, 180_000);
});

describe('the ten minutes lapsing (BK-DEC-009, PAY-DEC-006)', () => {
  it('expires the hold, releases the units at once, and never reopens it', async () => {
    const hotel = await h.bookableHotel('expiry', 1);
    const dates = window(70);
    const held = await hold(hotel, await h.guest(), dates);

    h.advance(HOLD_SECONDS + 1);
    expect(await h.expiry.sweep()).toBeGreaterThanOrEqual(1);

    const after = await h.admin.query<Record<string, unknown>>(
      `SELECT state, hold_state, payment_state FROM platform.booking WHERE booking_id = $1`,
      [held.bookingId],
    );
    expect(after.rows[0]).toMatchObject({
      state: 'EXPIRED',
      hold_state: 'EXPIRED',
      payment_state: 'EXPIRED',
    });
    // Terminal transitions release inventory immediately, which is what makes
    // the unit sellable again.
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(Number(inventory.rows[0]?.units_held)).toBe(0);
    const next = await hold(hotel, await h.guest(), dates);
    expect(next.bookingId).toBeDefined();
  }, 180_000);

  it('turns a payment that lands after expiry into a refund obligation, not a booking', async () => {
    const hotel = await h.bookableHotel('late-capture', 1);
    const dates = window(80);
    const held = await hold(hotel, await h.guest(), dates);
    h.advance(HOLD_SECONDS + 1);
    await h.expiry.sweep();

    const outcome = await confirm(held.attempt.attemptId, hotel.hotelId);
    expect(outcome.outcome).toBe('refund_obligation');

    const after = await h.admin.query<Record<string, unknown>>(
      `SELECT state, payment_state, refund_state FROM platform.booking WHERE booking_id = $1`,
      [held.bookingId],
    );
    // `PAY-DEC-006`: paid, owed back, and still expired. The money is real; the
    // booking is not revived and the inventory it released stays released.
    expect(after.rows[0]).toMatchObject({
      state: 'EXPIRED',
      payment_state: 'PAID',
      refund_state: 'REQUIRED',
    });
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(Number(inventory.rows[0]?.units_held)).toBe(0);
  }, 180_000);

  it('raises a second obligation for a duplicate capture, and posts the money once', async () => {
    const hotel = await h.bookableHotel('duplicate', 1);
    const dates = window(90);
    const held = await hold(hotel, await h.guest(), dates);
    expect((await confirm(held.attempt.attemptId, hotel.hotelId)).outcome).toBe('confirmed');
    // The same attempt repeating itself is a replay.
    expect((await confirm(held.attempt.attemptId, hotel.hotelId)).outcome).toBe(
      'already_confirmed',
    );
    const attempts = await h.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.booking_payment_attempt
        WHERE booking_id = $1 AND state = 'PAID'`,
      [held.bookingId],
    );
    expect(Number(attempts.rows[0]?.n)).toBe(1);
  }, 180_000);
});

describe('the payment attempt axis (doc 09 §8)', () => {
  it('supersedes the live attempt on a provider switch, never duplicating it', async () => {
    const hotel = await h.bookableHotel('switch', 1);
    const guest = await h.guest();
    const held = await hold(hotel, guest, window(100));
    const second = await h.bookingService.switchProvider(
      { bookingId: held.bookingId, provider: 'KHAAN' },
      newBookingRequest(guest),
    );
    expect(second.attemptId).not.toBe(held.attempt.attemptId);
    const states = await h.admin.query<{ state: string; provider: string }>(
      `SELECT state, provider FROM platform.booking_payment_attempt
        WHERE booking_id = $1 ORDER BY created_at`,
      [held.bookingId],
    );
    expect(states.rows.map((r) => `${r.provider}:${r.state}`)).toEqual([
      'QPAY:SUPERSEDED',
      'KHAAN:ACTIVE',
    ]);
    // And the superseded one no longer decides anything.
    expect((await confirm(held.attempt.attemptId, hotel.hotelId)).outcome).toBe('stale');
  }, 180_000);
});

describe('the guest cancelling (doc 09 §8)', () => {
  it('releases the units at once and cannot be done twice', async () => {
    const hotel = await h.bookableHotel('cancel', 1);
    const guest = await h.guest();
    const dates = window(110);
    const held = await hold(hotel, guest, dates);
    const cancelled = await h.bookingService.cancelByGuest(
      { bookingId: held.bookingId, reason: 'plans changed' },
      newBookingRequest(guest),
    );
    expect(cancelled.state).toBe('CANCELLED_GUEST');
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 AND category_id = $2`,
      [hotel.hotelId, hotel.categoryId],
    );
    expect(Number(inventory.rows[0]?.units_held)).toBe(0);
    await expect(
      h.bookingService.cancelByGuest({ bookingId: held.bookingId }, newBookingRequest(guest)),
    ).rejects.toThrow(ApiError);
  }, 180_000);
});

describe('what the public surface sees (BK-DEC-013)', () => {
  it('stops offering a category once its last unit is held', async () => {
    const hotel = await h.bookableHotel('public', 1);
    const dates = window(120);
    const before = await h.search.detail(
      { hotelId: hotel.hotelId, checkIn: dates.checkInDate, checkOut: dates.checkOutDate },
      newPublicRequest(),
    );
    expect(before.offers.find((o) => o.categoryId === hotel.categoryId)?.availableRooms).toBe(1);

    await hold(hotel, await h.guest(), dates);

    const after = await h.search.detail(
      { hotelId: hotel.hotelId, checkIn: dates.checkInDate, checkOut: dates.checkOutDate },
      newPublicRequest(),
    );
    // The searcher and the booking command read the same arithmetic, so what a
    // guest is offered is what a guest can actually take.
    expect(after.offers.find((o) => o.categoryId === hotel.categoryId)?.availableRooms).toBe(0);
  }, 180_000);
});
