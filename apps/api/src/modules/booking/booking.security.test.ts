import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import type { BookingHarness } from './test-support/booking-harness';
import { createBookingHarness } from './test-support/booking-harness';
import { newBookingRequest } from './services/booking-context';
import { rejectServerOwnedFields } from './http/booking-validation';

/**
 * The Guest boundary Phase 12 established, held against Phase 13's data
 * (doc 09 §§6, 11; `BK-DEC-012`).
 *
 * A Guest may act on their own booking and on nothing else; the platform scope
 * a Guest runs in reaches no hotel tenant table; a booking command binds the
 * booker on the server; and the Police realm is still refused everywhere.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `booking-sec-${String(keys)}`;
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
  h = await createBookingHarness('booking_sec');
}, 300_000);
afterAll(async () => {
  await h?.close();
});

async function hold(hotel: { categoryId: string }, guest: string, offset: number) {
  return h.bookingService.hold(
    {
      categoryId: hotel.categoryId,
      ...window(offset),
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
      idempotencyKey: key(),
    },
    newBookingRequest(guest),
  );
}

describe('one guest never reaches another guest’s booking', () => {
  it('answers NOT_FOUND — the same answer a booking that does not exist gets', async () => {
    const hotel = await h.bookableHotel('isolation', 3);
    const mine = await h.guest();
    const theirs = await h.guest();
    const booking = await hold(hotel, mine, 300);

    // The owner sees it.
    expect(
      (await h.bookingService.byId(booking.bookingId, newBookingRequest(mine))).bookingId,
    ).toBe(booking.bookingId);
    // Another guest gets exactly what they would get for a booking id that was
    // never issued: no hint that this one exists.
    const stranger = await h.bookingService
      .byId(booking.bookingId, newBookingRequest(theirs))
      .catch((error: ApiError) => error);
    const missing = await h.bookingService
      .byId('00000000-0000-4000-8000-000000000000', newBookingRequest(theirs))
      .catch((error: ApiError) => error);
    expect((stranger as ApiError).code).toBe((missing as ApiError).code);
    expect((stranger as ApiError).message).toBe((missing as ApiError).message);
  }, 180_000);

  it('refuses to cancel, or to switch the provider on, a booking that is not theirs', async () => {
    const hotel = await h.bookableHotel('isolation-write', 3);
    const mine = await h.guest();
    const theirs = await h.guest();
    const booking = await hold(hotel, mine, 310);

    await expect(
      h.bookingService.cancelByGuest({ bookingId: booking.bookingId }, newBookingRequest(theirs)),
    ).rejects.toThrow(/no such booking/);
    await expect(
      h.bookingService.switchProvider(
        { bookingId: booking.bookingId, provider: 'KHAAN' },
        newBookingRequest(theirs),
      ),
    ).rejects.toThrow(/no such booking/);

    // And the booking is untouched.
    const after = await h.bookingService.byId(booking.bookingId, newBookingRequest(mine));
    expect(after.state).toBe('HOLDING');
  }, 180_000);

  it('lists only the caller’s own bookings', async () => {
    const hotel = await h.bookableHotel('my-list', 3);
    const mine = await h.guest();
    const theirs = await h.guest();
    const own = await hold(hotel, mine, 320);
    await hold(hotel, theirs, 330);

    const list = await h.bookingService.mine(newBookingRequest(mine));
    expect(list.map((b) => b.bookingId)).toEqual([own.bookingId]);
  }, 180_000);
});

describe('the Guest platform scope reaches no hotel tenant table', () => {
  it('shows a guest their own booking and nothing else of the hotel’s', async () => {
    const hotel = await h.bookableHotel('scope', 2);
    const mine = await h.guest();
    const theirs = await h.guest();
    const booking = await hold(hotel, mine, 340);
    await hold(hotel, theirs, 350);

    await withTenantTransaction(
      h.api,
      {
        hotelId: PLATFORM_SCOPE,
        realm: 'guest',
        actorRef: mine,
        accountId: mine,
        correlationId: 'booking-sec-scope',
      },
      async (uow) => {
        // `own_booking_read` and nothing else: the caller's own booking rows.
        const bookings = await uow.query<{ booking_id: string }>(
          `SELECT booking_id FROM platform.booking`,
        );
        expect(bookings.rows.map((r) => r.booking_id)).toEqual([booking.bookingId]);

        // Every other table of the hotel is invisible in this scope, because no
        // hotel carries the platform sentinel as its id.
        for (const relation of [
          'platform.booking_night',
          'platform.category_night_inventory',
          'platform.booking_payment_attempt',
          'platform.booking_event',
          'platform.room',
          'platform.room_category',
          'platform.stay',
          'platform.hotel_photo',
        ]) {
          const rows = await uow.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${relation}`,
          );
          expect({ relation, n: rows.rows[0]?.n }).toEqual({ relation, n: '0' });
        }
      },
    );
  }, 180_000);

  it('shows a guest nothing at all when the scope names no account', async () => {
    const hotel = await h.bookableHotel('anonymous', 1);
    await hold(hotel, await h.guest(), 360);
    await withTenantTransaction(
      h.api,
      {
        hotelId: PLATFORM_SCOPE,
        realm: 'guest',
        actorRef: 'anonymous',
        correlationId: 'booking-sec-anon',
      },
      async (uow) => {
        const rows = await uow.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM platform.booking`,
        );
        // No account, no rows: the policy compares against a NULL and matches
        // nothing, rather than falling back to "everything".
        expect(rows.rows[0]?.n).toBe('0');
      },
    );
  }, 180_000);
});

describe('the server owns the identity and the tenant', () => {
  it('refuses a request that tries to name the hotel, the booker or the price', () => {
    for (const field of [
      'hotelId',
      'bookerAccountId',
      'accountId',
      'unitRateMnt',
      'totalAmountMnt',
    ]) {
      expect(() => rejectServerOwnedFields({ [field]: 'x' })).toThrow(ApiError);
      expect(() => rejectServerOwnedFields({ [field.toUpperCase()]: 'x' })).toThrow(
        /determined by the server/,
      );
    }
    expect(() => rejectServerOwnedFields({ categoryId: 'x', provider: 'QPAY' })).not.toThrow();
  });

  it('refuses a booking command with no signed-in guest at all', async () => {
    const hotel = await h.bookableHotel('unauthenticated', 1);
    await expect(
      h.bookingService.hold(
        {
          categoryId: hotel.categoryId,
          ...window(370),
          stayingGuestName: 'Синтетик зочин',
          provider: 'QPAY',
          idempotencyKey: key(),
        },
        newBookingRequest(),
      ),
    ).rejects.toThrow(/signed-in guest/);
    await expect(h.bookingService.mine(newBookingRequest())).rejects.toThrow(/sign in first/);
  }, 180_000);

  it('resolves the hotel from the category, so a booking cannot be aimed elsewhere', async () => {
    const a = await h.bookableHotel('tenant-a', 1);
    const b = await h.bookableHotel('tenant-b', 1);
    const guest = await h.guest();
    const booking = await hold(a, guest, 380);
    const row = await h.bookingService.byId(booking.bookingId, newBookingRequest(guest));
    // The booking landed in the category's hotel, and there is no input that
    // could have sent it to the other one.
    expect(row.hotelId).toBe(a.hotelId);
    expect(row.hotelId).not.toBe(b.hotelId);
  }, 180_000);
});
