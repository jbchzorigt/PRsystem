import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StayHotel } from '../stay/test-support/stay-harness';
import type { BookingHarness } from '../booking/test-support/booking-harness';
import { createBookingHarness } from '../booking/test-support/booking-harness';
import { newBookingRequest } from '../booking/services/booking-context';
import { RepositoryBookingFulfilment } from '../booking/contracts/booking-reads';
import { RepositorySettlement } from './contracts/booking-settlement';
import { withTenantTransaction } from '@prsystem/db';

/**
 * The money races, against real PostgreSQL (doc 11 §9; `PAY-DEC-006`, `-009`).
 *
 * Each of these is a delivery the requirements say must happen once however
 * many times it arrives. None of them is settled by a check-then-act in
 * application code: a unique cause on the ledger, a terminal state on the
 * refund axis, a row lock on the payable and a partial unique index on the
 * settled payout line are what decide them, and this file is where that is
 * demonstrated rather than asserted.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `settlement-race-${String(keys)}`;
};

const DAY = 86_400_000;

function window(offsetDays: number, nights = 1): { checkInDate: Date; checkOutDate: Date } {
  const start = new Date(Date.now() + offsetDays * DAY);
  const checkInDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  return { checkInDate, checkOutDate: new Date(checkInDate.getTime() + nights * DAY) };
}

beforeAll(async () => {
  h = await createBookingHarness('settlement_race');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h.resetClock();
});

async function paidBooking(
  hotel: StayHotel,
  dates = window(30),
): Promise<{ bookingId: string; totalAmountMnt: bigint; bookingRef: string }> {
  const guest = await h.guest();
  const held = await h.bookingService.hold(
    {
      categoryId: hotel.categoryId,
      ...dates,
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
      idempotencyKey: key(),
    },
    newBookingRequest(guest),
  );
  await h.bookingService.applyCapture(
    {
      attemptId: held.attempt.attemptId,
      hotelId: hotel.hotelId,
      providerInvoiceId: `inv-${held.attempt.attemptId.slice(0, 8)}`,
      providerPaymentId: `pay-${held.attempt.attemptId.slice(0, 8)}`,
      paidAmountMnt: held.totalAmountMnt,
      currency: 'MNT',
      merchantRef: held.bookingRef,
    },
    newBookingRequest(),
  );
  return {
    bookingId: held.bookingId,
    totalAmountMnt: held.totalAmountMnt,
    bookingRef: held.bookingRef,
  };
}

async function bookerOf(bookingId: string): Promise<string> {
  const result = await h.admin.query<{ booker_account_id: string }>(
    `SELECT booker_account_id FROM platform.booking WHERE booking_id = $1`,
    [bookingId],
  );
  return result.rows[0]?.booker_account_id ?? '';
}

async function completeStay(hotel: StayHotel, bookingRef: string): Promise<void> {
  const fulfilment = new RepositoryBookingFulfilment(new RepositorySettlement());
  const stayId = crypto.randomUUID();
  await withTenantTransaction(
    h.api,
    {
      hotelId: hotel.hotelId,
      realm: 'hotel',
      actorRef: 'settlement-race',
      correlationId: `race-${bookingRef}`,
    },
    async (uow) => {
      await fulfilment.consumeAtCheckIn(uow, { bookingRef, stayId, actorRef: 'settlement-race' });
      await fulfilment.completeAtCheckout(uow, { stayId, actorRef: 'settlement-race' });
    },
  );
}

async function count(sql: string, values: readonly unknown[]): Promise<number> {
  const result = await h.admin.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? '0');
}

describe('a refund callback delivered twice (doc 11 §9)', () => {
  it('posts the money back once and settles the axis once', async () => {
    const hotel = await h.bookableHotel('race_refund', 1, 1000);
    const paid = await paidBooking(hotel);
    await h.bookingService.cancelByGuest(
      { bookingId: paid.bookingId },
      newBookingRequest(await bookerOf(paid.bookingId)),
    );
    const open = await h.admin.query<{ refund_id: string }>(
      `SELECT refund_id FROM platform.booking_refund WHERE booking_id = $1`,
      [paid.bookingId],
    );
    const refundId = open.rows[0]?.refund_id ?? '';

    // Two deliveries of the same result, at the same time, on the same row.
    const outcomes = await Promise.allSettled([
      h.refunds.executeOne(refundId, hotel.hotelId),
      h.refunds.executeOne(refundId, hotel.hotelId),
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

    expect(
      await count(
        `SELECT count(*)::text FROM platform.booking_ledger_event
          WHERE booking_id = $1 AND event_type = 'REFUND'`,
        [paid.bookingId],
      ),
    ).toBe(1);
    const settled = await h.admin.query<{ state: string; refunded_mnt: string }>(
      `SELECT r.state, p.refunded_mnt FROM platform.booking_refund r
         JOIN platform.booking_payable p ON p.payable_id = r.payable_id
        WHERE r.refund_id = $1`,
      [refundId],
    );
    expect(settled.rows[0]?.state).toBe('REFUNDED');
    // The base moved by the refund exactly once, not twice.
    expect(BigInt(settled.rows[0]?.refunded_mnt ?? '0')).toBe(paid.totalAmountMnt);
  }, 180_000);

  it('runs the whole sweep twice without refunding anything twice', async () => {
    const hotel = await h.bookableHotel('race_sweep', 2, 1000);
    const first = await paidBooking(hotel, window(31));
    const second = await paidBooking(hotel, window(32));
    for (const booking of [first, second]) {
      await h.bookingService.cancelByGuest(
        { bookingId: booking.bookingId },
        newBookingRequest(await bookerOf(booking.bookingId)),
      );
    }
    await Promise.allSettled([h.refunds.sweep(), h.refunds.sweep()]);

    for (const booking of [first, second]) {
      expect(
        await count(
          `SELECT count(*)::text FROM platform.booking_ledger_event
            WHERE booking_id = $1 AND event_type = 'REFUND'`,
          [booking.bookingId],
        ),
      ).toBe(1);
    }
  }, 180_000);
});

describe('two payout runs at the same moment (PAY-DEC-009)', () => {
  it('opens one batch and pays each payable exactly once', async () => {
    const hotel = await h.bookableHotel('race_payout', 2, 1000);
    const first = await paidBooking(hotel, window(40));
    const second = await paidBooking(hotel, window(41));
    await completeStay(hotel, first.bookingRef);
    await completeStay(hotel, second.bookingRef);

    h.advance((2 * DAY) / 1000);
    const runs = await Promise.allSettled([h.payouts.runDue(), h.payouts.runDue()]);
    expect(runs.every((run) => run.status === 'fulfilled')).toBe(true);

    // One successful `PAYABLE` line per payable — the partial unique index is
    // what refuses the second, so this is the database's answer, not a count
    // this test took and then trusted.
    for (const booking of [first, second]) {
      expect(
        await count(
          `SELECT count(*)::text FROM platform.payout_batch_item i
             JOIN platform.booking_payable p ON p.payable_id = i.payable_id
            WHERE p.booking_id = $1 AND i.settled AND i.kind = 'PAYABLE'`,
          [booking.bookingId],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT count(*)::text FROM platform.booking_ledger_event
            WHERE booking_id = $1 AND event_type = 'PAYOUT'`,
          [booking.bookingId],
        ),
      ).toBe(1);
    }
    const paid = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text FROM platform.payout_batch WHERE hotel_id = $1 AND state = 'PAID'`,
      [hotel.hotelId],
    );
    expect(Number(paid.rows[0]?.count)).toBe(1);
  }, 180_000);
});

describe('two captures of the same booking (PAY-DEC-006)', () => {
  it('opens one payable and owes the second capture back in full', async () => {
    const hotel = await h.bookableHotel('race_capture', 1, 1000);
    const guest = await h.guest();
    const held = await h.bookingService.hold(
      {
        categoryId: hotel.categoryId,
        ...window(45),
        stayingGuestName: 'Синтетик зочин',
        provider: 'QPAY',
        idempotencyKey: key(),
      },
      newBookingRequest(guest),
    );
    const capture = (paymentId: string): Parameters<typeof h.bookingService.applyCapture>[0] => ({
      attemptId: held.attempt.attemptId,
      hotelId: hotel.hotelId,
      providerInvoiceId: `inv-${paymentId}`,
      providerPaymentId: paymentId,
      paidAmountMnt: held.totalAmountMnt,
      currency: 'MNT',
      merchantRef: held.bookingRef,
    });
    await Promise.allSettled([
      h.bookingService.applyCapture(capture('pay-race-1'), newBookingRequest()),
      h.bookingService.applyCapture(capture('pay-race-2'), newBookingRequest()),
    ]);

    // One payable, whatever happened: the unique key on `booking_id` decides.
    expect(
      await count(`SELECT count(*)::text FROM platform.booking_payable WHERE booking_id = $1`, [
        held.bookingId,
      ]),
    ).toBe(1);
    // And the payable was opened from one payment, not two.
    expect(
      await count(
        `SELECT count(*)::text FROM platform.booking_ledger_event
          WHERE booking_id = $1 AND event_type = 'PAYMENT'`,
        [held.bookingId],
      ),
    ).toBe(1);
    const duplicates = await h.admin.query<{ reason: string; amount_mnt: string }>(
      `SELECT reason, amount_mnt FROM platform.booking_refund WHERE booking_id = $1`,
      [held.bookingId],
    );
    // Either both captures were the same delivery — one confirmed, one replayed
    // — or the second was money twice and is owed back whole. Never a second
    // confirmation and never a payable enlarged by it.
    for (const row of duplicates.rows) {
      expect(row.reason).toBe('DUPLICATE_CAPTURE');
      expect(BigInt(row.amount_mnt)).toBe(held.totalAmountMnt);
    }
  }, 180_000);
});

describe('a cancellation racing a no-show', () => {
  it('lets one terminal transition win and raises one obligation', async () => {
    const hotel = await h.bookableHotel('race_terminal', 1, 1000);
    const paid = await paidBooking(hotel, window(1, 2));
    const booker = await bookerOf(paid.bookingId);
    const reception = hotel.reception;

    // Past the arrival date's cutoff, where both commands are admissible.
    h.advance(3 * 86_400);
    await Promise.allSettled([
      h.bookingService.cancelByGuest({ bookingId: paid.bookingId }, newBookingRequest(booker)),
      h.bookingService.confirmNoShow(
        { hotelId: hotel.hotelId, bookingId: paid.bookingId, idempotencyKey: key() },
        reception,
        newBookingRequest(reception.principal.accountId),
      ),
    ]);

    const row = await h.admin.query<{ state: string; refund_state: string }>(
      `SELECT state, refund_state FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    expect(['CANCELLED_GUEST', 'NO_SHOW']).toContain(row.rows[0]?.state);
    expect(row.rows[0]?.refund_state).toBe('REQUIRED');
    // One terminal transition, one obligation, one held payable.
    expect(
      await count(`SELECT count(*)::text FROM platform.booking_refund WHERE booking_id = $1`, [
        paid.bookingId,
      ]),
    ).toBe(1);
    const payable = await h.admin.query<{ payout_state: string }>(
      `SELECT payout_state FROM platform.booking_payable WHERE booking_id = $1`,
      [paid.bookingId],
    );
    expect(payable.rows[0]?.payout_state).toBe('HELD');
    // And the unit went back exactly once.
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(inventory.rows.every((entry) => Number(entry.units_held) === 0)).toBe(true);
  }, 180_000);
});
