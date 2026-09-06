import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { withTenantTransaction } from '@prsystem/db';
import type { StayHotel } from '../stay/test-support/stay-harness';
import type { BookingHarness } from '../booking/test-support/booking-harness';
import { createBookingHarness } from '../booking/test-support/booking-harness';
import { newBookingRequest } from '../booking/services/booking-context';
import { RepositoryBookingFulfilment } from '../booking/contracts/booking-reads';
import { RepositorySettlement } from './contracts/booking-settlement';
import type { SettlementPort } from '../booking/contracts/settlement';

/**
 * Payment, commission, refund and settlement against real PostgreSQL
 * (`BK-DEC-003`, `-008`, `-010`, `-011`; `PAY-DEC-001`, `-003`, `-004`, `-005`,
 * `-007`, `-008`, `-009`).
 *
 * Everything here is measured from the rows the commands actually wrote — the
 * payable, the immutable ledger, the refund axis and the payout batch — rather
 * than from what a service returned, because the requirements are about what
 * the platform *records*, not about what it answers.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `settlement-${String(keys)}`;
};

const DAY = 86_400_000;
const UB = 'Asia/Ulaanbaatar';

function window(offsetDays: number, nights = 1): { checkInDate: Date; checkOutDate: Date } {
  const start = new Date(Date.now() + offsetDays * DAY);
  const checkInDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  return { checkInDate, checkOutDate: new Date(checkInDate.getTime() + nights * DAY) };
}

beforeAll(async () => {
  h = await createBookingHarness('settlement_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
// A test that moved the clock and then failed must not move the next one's.
beforeEach(() => {
  h.resetClock();
});

async function hold(
  hotel: StayHotel,
  guest: string,
  dates = window(30),
): Promise<Awaited<ReturnType<BookingHarness['bookingService']['hold']>>> {
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

/** A confirmed booking, paid through the gateway the way a callback would. */
async function paidBooking(
  hotel: StayHotel,
  dates = window(30),
  providerFeeMnt?: bigint,
): Promise<{ bookingId: string; totalAmountMnt: bigint; paymentId: string }> {
  const guest = await h.guest();
  const held = await hold(hotel, guest, dates);
  const paymentId = `pay-${held.attempt.attemptId.slice(0, 8)}`;
  const outcome = await h.bookingService.applyCapture(
    {
      attemptId: held.attempt.attemptId,
      hotelId: hotel.hotelId,
      providerInvoiceId: `inv-${held.attempt.attemptId.slice(0, 8)}`,
      providerPaymentId: paymentId,
      paidAmountMnt: held.totalAmountMnt,
      currency: 'MNT',
      merchantRef: held.bookingRef,
      ...(providerFeeMnt === undefined ? {} : { providerFeeMnt }),
    },
    newBookingRequest(),
  );
  expect(outcome.outcome).toBe('confirmed');
  return { bookingId: held.bookingId, totalAmountMnt: held.totalAmountMnt, paymentId };
}

interface PayableRow {
  gross_paid_mnt: string;
  refunded_mnt: string;
  retained_mnt: string;
  commission_mnt: string;
  hotel_payable_mnt: string;
  provider_fee_mnt: string;
  paid_out_mnt: string;
  payout_state: string;
  commission_rate_bps: number;
  contract_version: number;
}

async function payable(bookingId: string): Promise<PayableRow> {
  const result = await h.admin.query<PayableRow>(
    `SELECT gross_paid_mnt, refunded_mnt, retained_mnt, commission_mnt, hotel_payable_mnt,
            provider_fee_mnt, paid_out_mnt, payout_state, commission_rate_bps, contract_version
       FROM platform.booking_payable WHERE booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no payable for ${bookingId}`);
  return row;
}

async function ledger(bookingId: string): Promise<Record<string, bigint>> {
  const result = await h.admin.query<{ event_type: string; total: string }>(
    `SELECT event_type, sum(amount_mnt)::text AS total FROM platform.booking_ledger_event
      WHERE booking_id = $1 GROUP BY event_type`,
    [bookingId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.event_type, BigInt(row.total)]));
}

async function refundRow(
  bookingId: string,
): Promise<{ state: string; amount_mnt: string; reason: string }> {
  const result = await h.admin.query<{ state: string; amount_mnt: string; reason: string }>(
    `SELECT state, amount_mnt, reason FROM platform.booking_refund
      WHERE booking_id = $1 ORDER BY requested_at LIMIT 1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no refund for ${bookingId}`);
  return row;
}

/** Runs the refund job until it stops finding work. */
async function settleRefunds(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    if ((await h.refunds.sweep()) === 0) return;
  }
}

/** Completes the stay a booking was checked into, the way a checkout does. */
async function completeStay(hotel: StayHotel, bookingRef: string, stayId: string): Promise<void> {
  const fulfilment = new RepositoryBookingFulfilment(new RepositorySettlement());
  await withTenantTransaction(
    h.api,
    {
      hotelId: hotel.hotelId,
      realm: 'hotel',
      actorRef: 'settlement-test',
      correlationId: `settlement-${bookingRef}`,
    },
    async (uow) => {
      await fulfilment.consumeAtCheckIn(uow, { bookingRef, stayId, actorRef: 'settlement-test' });
      await fulfilment.completeAtCheckout(uow, { stayId, actorRef: 'settlement-test' });
    },
  );
}

async function bookingRefOf(bookingId: string): Promise<string> {
  const result = await h.admin.query<{ booking_ref: string }>(
    `SELECT booking_ref FROM platform.booking WHERE booking_id = $1`,
    [bookingId],
  );
  return result.rows[0]?.booking_ref ?? '';
}

describe('the contract that fixes the rate (PAY-DEC-001, BK-DEC-008)', () => {
  it('refuses to take a payment for a hotel with no active contract', async () => {
    const hotel = await h.bookableHotel('no_contract', 1, null);
    const guest = await h.guest();
    await expect(hold(hotel, guest)).rejects.toThrow(/NO_COMMISSION_CONTRACT/);
    // Nothing was held either: a hold nobody may pay for is a unit withheld
    // from a guest who could.
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(inventory.rows.every((row) => Number(row.units_held) === 0)).toBe(true);
  }, 120_000);

  it('snapshots the rate at confirmation, and a later contract does not reprice it', async () => {
    const hotel = await h.bookableHotel('rate_snapshot', 2, 1500);
    const paid = await paidBooking(hotel);
    const before = await payable(paid.bookingId);
    expect(before.commission_rate_bps).toBe(1500);
    expect(before.contract_version).toBe(1);

    // The contract is renegotiated: the old one is superseded and a new version
    // takes effect. The booking already settled keeps its own snapshot.
    await h.admin.query(
      `UPDATE platform.hotel_commission_contract
          SET state = 'SUPERSEDED', revision = revision + 1
        WHERE hotel_id = $1 AND state = 'ACTIVE'`,
      [hotel.hotelId],
    );
    await h.commissionContract(hotel.hotelId, 500, 2);
    expect((await payable(paid.bookingId)).commission_rate_bps).toBe(1500);

    // And the next booking is settled at the new rate.
    const next = await paidBooking(hotel, window(40));
    expect((await payable(next.bookingId)).commission_rate_bps).toBe(500);
  }, 120_000);
});

describe('the confirmation opens the payable (doc 11 §§3, 9)', () => {
  it('posts payment, commission, hotel payable and the gateway fee, once each', async () => {
    const hotel = await h.bookableHotel('payable_open', 1, 1000);
    const paid = await paidBooking(hotel, window(31), 4_500n);
    const row = await payable(paid.bookingId);

    const gross = paid.totalAmountMnt;
    const commission = (gross * 1000n + 5000n) / 10_000n;
    expect(BigInt(row.gross_paid_mnt)).toBe(gross);
    expect(BigInt(row.retained_mnt)).toBe(gross);
    expect(BigInt(row.commission_mnt)).toBe(commission);
    expect(BigInt(row.hotel_payable_mnt)).toBe(gross - commission);
    // `BK-DEC-011`: the fee is recorded and is a term of nothing above it.
    expect(BigInt(row.provider_fee_mnt)).toBe(4_500n);
    expect(row.payout_state).toBe('NOT_ELIGIBLE');

    expect(await ledger(paid.bookingId)).toEqual({
      PAYMENT: gross,
      COMMISSION: commission,
      HOTEL_PAYABLE: gross - commission,
      PROVIDER_FEE: 4_500n,
    });
  }, 120_000);

  it('posts one captured transaction once, however often it is delivered', async () => {
    const hotel = await h.bookableHotel('capture_once', 1, 1000);
    const guest = await h.guest();
    const held = await hold(hotel, guest, window(32));
    const capture = {
      attemptId: held.attempt.attemptId,
      hotelId: hotel.hotelId,
      providerInvoiceId: 'inv-repeat',
      providerPaymentId: 'pay-repeat',
      paidAmountMnt: held.totalAmountMnt,
      currency: 'MNT',
      merchantRef: held.bookingRef,
    };
    expect((await h.bookingService.applyCapture(capture, newBookingRequest())).outcome).toBe(
      'confirmed',
    );
    // The same transaction again: a replay, not a second payment.
    expect((await h.bookingService.applyCapture(capture, newBookingRequest())).outcome).toBe(
      'already_confirmed',
    );
    const rows = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text FROM platform.booking_ledger_event
        WHERE booking_id = $1 AND event_type = 'PAYMENT'`,
      [held.bookingId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  }, 120_000);

  it('refuses a capture whose amount disagrees with the attempt', async () => {
    const hotel = await h.bookableHotel('capture_mismatch', 1, 1000);
    const guest = await h.guest();
    const held = await hold(hotel, guest, window(33));
    const outcome = await h.bookingService.applyCapture(
      {
        attemptId: held.attempt.attemptId,
        hotelId: hotel.hotelId,
        providerInvoiceId: 'inv-wrong',
        providerPaymentId: 'pay-wrong',
        paidAmountMnt: held.totalAmountMnt + 1n,
        currency: 'MNT',
        merchantRef: held.bookingRef,
      },
      newBookingRequest(),
    );
    expect(outcome.outcome).toBe('mismatch');
    const state = await h.admin.query<{ state: string; payment_state: string }>(
      `SELECT state, payment_state FROM platform.booking WHERE booking_id = $1`,
      [held.bookingId],
    );
    expect(state.rows[0]).toEqual({ state: 'HOLDING', payment_state: 'PENDING' });
    await expect(payable(held.bookingId)).rejects.toThrow(/no payable/);
  }, 120_000);
});

describe('cancellation and the commission base (PAY-DEC-007, -008)', () => {
  it('refunds in full before the deadline and leaves the base at zero', async () => {
    const hotel = await h.bookableHotel('cancel_free', 1, 1000);
    const paid = await paidBooking(hotel, window(35));
    const guest = await h.admin.query<{ booker_account_id: string }>(
      `SELECT booker_account_id FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    await h.bookingService.cancelByGuest(
      { bookingId: paid.bookingId },
      newBookingRequest(guest.rows[0]?.booker_account_id),
    );

    // The obligation exists and the payout is held; nothing has been reduced
    // yet, because the guest has not had the money back (doc 11 §5).
    const held = await payable(paid.bookingId);
    expect(held.payout_state).toBe('HELD');
    expect(BigInt(held.refunded_mnt)).toBe(0n);
    const raised = await refundRow(paid.bookingId);
    expect(raised).toMatchObject({ state: 'REQUIRED', reason: 'GUEST_CANCELLATION' });
    expect(BigInt(raised.amount_mnt)).toBe(paid.totalAmountMnt);

    await settleRefunds();

    const after = await payable(paid.bookingId);
    expect(BigInt(after.refunded_mnt)).toBe(paid.totalAmountMnt);
    expect(BigInt(after.retained_mnt)).toBe(0n);
    expect(BigInt(after.commission_mnt)).toBe(0n);
    expect(BigInt(after.hotel_payable_mnt)).toBe(0n);
    // Nothing to pay: it never becomes eligible for a batch.
    expect(after.payout_state).toBe('NOT_ELIGIBLE');
    const events = await ledger(paid.bookingId);
    expect(events['REFUND']).toBe(-paid.totalAmountMnt);
    expect(events['COMMISSION']).toBe(0n);
    expect(events['HOTEL_PAYABLE']).toBe(0n);
  }, 120_000);

  it('retains the first night inside 24 hours and takes commission on the fee', async () => {
    const hotel = await h.bookableHotel('cancel_late', 1, 1000);
    const dates = window(2, 3);
    const paid = await paidBooking(hotel, dates);
    const booking = await h.admin.query<{ booker_account_id: string; unit_rate_mnt: string }>(
      `SELECT booker_account_id, unit_rate_mnt FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    const unit = BigInt(booking.rows[0]?.unit_rate_mnt ?? '0');

    // Past the free-cancellation deadline: the arrival day begins in less than
    // 24 hours, hotel-local.
    h.advance(86_400 + 3600);
    await h.bookingService.cancelByGuest(
      { bookingId: paid.bookingId },
      newBookingRequest(booking.rows[0]?.booker_account_id),
    );
    const raised = await refundRow(paid.bookingId);
    expect(raised.reason).toBe('LATE_CANCELLATION_BALANCE');
    expect(BigInt(raised.amount_mnt)).toBe(paid.totalAmountMnt - unit);

    await settleRefunds();
    const after = await payable(paid.bookingId);
    // The commission base is the retained first-night fee, and nothing else.
    expect(BigInt(after.retained_mnt)).toBe(unit);
    expect(BigInt(after.commission_mnt)).toBe((unit * 1000n + 5000n) / 10_000n);
    expect(after.payout_state).toBe('ELIGIBLE');
  }, 120_000);

  it('keeps nothing when the hotel cancels, whatever the deadline said', async () => {
    const hotel = await h.bookableHotel('cancel_hotel', 1, 1000);
    const dates = window(2, 2);
    const paid = await paidBooking(hotel, dates);
    const manager = await h.actorFor(
      await h.seed(hotel.hotelId, 'manager@example.test', ['MANAGER']),
    );

    // Inside 24 hours, where a *guest* cancellation would retain a fee.
    h.advance(86_400 + 3600);
    await h.bookingService.cancelByHotel(
      {
        hotelId: hotel.hotelId,
        bookingId: paid.bookingId,
        idempotencyKey: key(),
        reason: 'no eligible room',
      },
      manager,
      newBookingRequest(manager.principal.accountId),
    );
    const raised = await refundRow(paid.bookingId);
    expect(raised.reason).toBe('HOTEL_CANCELLATION');
    expect(BigInt(raised.amount_mnt)).toBe(paid.totalAmountMnt);

    await settleRefunds();
    const after = await payable(paid.bookingId);
    expect(BigInt(after.retained_mnt)).toBe(0n);
    expect(BigInt(after.commission_mnt)).toBe(0n);
  }, 120_000);
});

describe('the no-show cutoff (PAY-DEC-007)', () => {
  it('refuses before the arrival date has ended, hotel-local', async () => {
    const hotel = await h.bookableHotel('no_show_early', 1, 1000);
    const paid = await paidBooking(hotel, window(1, 1));
    const reception = hotel.reception;
    await expect(
      h.bookingService.confirmNoShow(
        { hotelId: hotel.hotelId, bookingId: paid.bookingId, idempotencyKey: key() },
        reception,
        newBookingRequest(reception.principal.accountId),
      ),
    ).rejects.toThrow(/BEFORE_NO_SHOW_CUTOFF/);
    const state = await h.admin.query<{ state: string }>(
      `SELECT state FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    expect(state.rows[0]?.state).toBe('CONFIRMED');
  }, 120_000);

  it('retains the first-night fee once the cutoff has passed', async () => {
    const hotel = await h.bookableHotel('no_show_late', 1, 1000);
    const paid = await paidBooking(hotel, window(1, 2));
    const booking = await h.admin.query<{ unit_rate_mnt: string }>(
      `SELECT unit_rate_mnt FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    const unit = BigInt(booking.rows[0]?.unit_rate_mnt ?? '0');

    // Past the arrival date's 23:59:59 in Asia/Ulaanbaatar.
    h.advance(3 * 86_400);
    const reception = hotel.reception;
    const view = await h.bookingService.confirmNoShow(
      { hotelId: hotel.hotelId, bookingId: paid.bookingId, idempotencyKey: key() },
      reception,
      newBookingRequest(reception.principal.accountId),
    );
    expect(view.state).toBe('NO_SHOW');
    const raised = await refundRow(paid.bookingId);
    expect(raised.reason).toBe('NO_SHOW_BALANCE');
    expect(BigInt(raised.amount_mnt)).toBe(paid.totalAmountMnt - unit);

    // The unit went back at the terminal transaction, not when the money did.
    const inventory = await h.admin.query<{ units_held: string }>(
      `SELECT units_held FROM platform.category_night_inventory
        WHERE hotel_id = $1 ORDER BY night`,
      [hotel.hotelId],
    );
    expect(inventory.rows.every((row) => Number(row.units_held) === 0)).toBe(true);
  }, 120_000);
});

describe('the D+1 12:00 payout (PAY-DEC-009, doc 11 §8)', () => {
  it('pays a completed stay, reconciles the batch, and pays a payable once', async () => {
    const hotel = await h.bookableHotel('payout', 1, 1000);
    const paid = await paidBooking(hotel, window(50));
    const ref = await bookingRefOf(paid.bookingId);
    await completeStay(hotel, ref, crypto.randomUUID());

    const eligible = await payable(paid.bookingId);
    expect(eligible.payout_state).toBe('ELIGIBLE');

    // Before `D+1 12:00` there is nothing of this hotel's to run.
    expect((await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId).length).toBe(
      0,
    );

    h.advance(2 * 86_400);
    // Filtered to this hotel: the job is global by design, and other suites in
    // this file leave their own hotels' payables eligible.
    const batches = (await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId);
    expect(batches.length).toBe(1);
    const batch = batches[0];
    if (batch === undefined) throw new Error('no batch');
    expect(batch.state).toBe('PAID');
    expect(batch.bankReference).not.toBeNull();

    // doc 11 §8: the six totals reconcile, and the payable's own figures are
    // what they were computed from.
    const commission = (paid.totalAmountMnt * 1000n + 5000n) / 10_000n;
    expect(batch.grossPaidMnt).toBe(paid.totalAmountMnt);
    expect(batch.refundedMnt).toBe(0n);
    expect(batch.retainedMnt).toBe(paid.totalAmountMnt);
    expect(batch.commissionMnt).toBe(commission);
    expect(batch.adjustmentMnt).toBe(0n);
    expect(batch.hotelPayableMnt).toBe(paid.totalAmountMnt - commission);

    const settled = await payable(paid.bookingId);
    expect(settled.payout_state).toBe('PAID');
    expect(BigInt(settled.paid_out_mnt)).toBe(paid.totalAmountMnt - commission);

    // A second run finds nothing for it: one booking payable, one successful
    // payout.
    expect((await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId).length).toBe(
      0,
    );
    const items = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text FROM platform.payout_batch_item i
         JOIN platform.booking_payable p ON p.payable_id = i.payable_id
        WHERE p.booking_id = $1 AND i.settled AND i.kind = 'PAYABLE'`,
      [paid.bookingId],
    );
    expect(items.rows[0]?.count).toBe('1');
  }, 180_000);

  it('retries a failed payout as a new attempt, never as an overwrite', async () => {
    const hotel = await h.bookableHotel('payout_retry', 1, 1000);
    const paid = await paidBooking(hotel, window(55));
    await completeStay(hotel, await bookingRefOf(paid.bookingId), crypto.randomUUID());

    h.advance(2 * 86_400);
    h.payoutPort.declineNext('BANK_CLOSED');
    const failed = (await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId);
    expect(failed[0]?.state).toBe('FAILED');
    expect(failed[0]?.attemptNo).toBe(1);
    // Eligibility did not move: a bank holiday changes when the money arrives,
    // not what the hotel earned or which day earned it.
    expect((await payable(paid.bookingId)).payout_state).toBe('ELIGIBLE');

    const retried = (await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId);
    expect(retried[0]?.state).toBe('PAID');
    expect(retried[0]?.attemptNo).toBe(2);

    const attempts = await h.admin.query<{ attempt_no: number; state: string }>(
      `SELECT attempt_no, state FROM platform.payout_batch WHERE hotel_id = $1
        ORDER BY attempt_no`,
      [hotel.hotelId],
    );
    expect(attempts.rows).toEqual([
      { attempt_no: 1, state: 'FAILED' },
      { attempt_no: 2, state: 'PAID' },
    ]);
  }, 180_000);

  it('deducts a post-payout refund from the next batch (ADJUSTMENT_DUE)', async () => {
    const hotel = await h.bookableHotel('payout_adjust', 2, 1000);
    const first = await paidBooking(hotel, window(60));
    await completeStay(hotel, await bookingRefOf(first.bookingId), crypto.randomUUID());
    h.advance(2 * 86_400);
    await h.payouts.runDue();
    const paidOut = BigInt((await payable(first.bookingId)).paid_out_mnt);
    expect(paidOut).toBeGreaterThan(0n);
    // Back to the server's own day, which is the day a checkout stamps: the two
    // amounts below have to fall due together to show the deduction at all.
    h.resetClock();

    // A refund arrives after the hotel has already been paid. The earlier
    // payout is not rewritten; the difference becomes a negative adjustment.
    await h.admin.query(
      `INSERT INTO platform.booking_refund
         (hotel_id, booking_id, payable_id, reason, amount_mnt, provider, provider_payment_id,
          source_ref)
       SELECT p.hotel_id, p.booking_id, p.payable_id, 'HOTEL_CANCELLATION', p.gross_paid_mnt,
              'QPAY', $2, 'post-payout'
         FROM platform.booking_payable p WHERE p.booking_id = $1`,
      [first.bookingId, first.paymentId],
    );
    await settleRefunds();

    const owing = await payable(first.bookingId);
    expect(owing.payout_state).toBe('ADJUSTMENT_DUE');
    expect(BigInt(owing.hotel_payable_mnt)).toBe(0n);

    // A later booking, large enough that the batch still pays something: an
    // adjustment is *deducted from* the next payout, and a batch that would
    // move no money to the hotel is not opened at all.
    const second = await paidBooking(hotel, window(61, 2));
    await completeStay(hotel, await bookingRefOf(second.bookingId), crypto.randomUUID());
    h.advance(2 * 86_400);
    const batches = (await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId);
    const batch = batches.find((row) => row.adjustmentMnt !== 0n);
    if (batch === undefined) throw new Error('no adjustment batch');
    expect(batch.adjustmentMnt).toBe(-paidOut);
    expect(batch.hotelPayableMnt).toBe(batch.retainedMnt - batch.commissionMnt - paidOut);
    expect((await payable(first.bookingId)).payout_state).toBe('NOT_ELIGIBLE');
  }, 180_000);

  it('holds a payout while a refund is still open', async () => {
    const hotel = await h.bookableHotel('payout_hold', 1, 1000);
    const paid = await paidBooking(hotel, window(65, 2));
    const booking = await h.admin.query<{ booker_account_id: string }>(
      `SELECT booker_account_id FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    await h.bookingService.cancelByGuest(
      { bookingId: paid.bookingId },
      newBookingRequest(booking.rows[0]?.booker_account_id),
    );
    expect((await payable(paid.bookingId)).payout_state).toBe('HELD');

    h.advance(2 * 86_400);
    // Nothing of *this hotel's* is batched while the refund has not terminated
    // (doc 11 §8).
    expect((await h.payouts.runDue()).filter((row) => row.hotelId === hotel.hotelId).length).toBe(
      0,
    );
  }, 180_000);
});

describe('a refund the provider declines (doc 11 §5)', () => {
  it('marks the axis FAILED and does not restore the booking', async () => {
    const hotel = await h.bookableHotel('refund_failed', 1, 1000);
    const paid = await paidBooking(hotel, window(70));
    const booking = await h.admin.query<{ booker_account_id: string }>(
      `SELECT booker_account_id FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    await h.bookingService.cancelByGuest(
      { bookingId: paid.bookingId },
      newBookingRequest(booking.rows[0]?.booker_account_id),
    );
    // This refund specifically, not the sweep: an armed failure is consumed by
    // whichever call reaches the provider first, and the sweep sees every open
    // obligation in the database.
    const open = await h.admin.query<{ refund_id: string }>(
      `SELECT refund_id FROM platform.booking_refund WHERE booking_id = $1`,
      [paid.bookingId],
    );
    h.gateway('QPAY').failNext({ kind: 'REJECTED', providerCode: 'REFUND_NOT_ALLOWED' });
    await h.refunds.executeOne(open.rows[0]?.refund_id ?? '', hotel.hotelId);

    expect((await refundRow(paid.bookingId)).state).toBe('FAILED');
    const after = await h.admin.query<{
      state: string;
      payment_state: string;
      refund_state: string;
    }>(`SELECT state, payment_state, refund_state FROM platform.booking WHERE booking_id = $1`, [
      paid.bookingId,
    ]);
    // The booking stays cancelled and the capture stays captured.
    expect(after.rows[0]).toEqual({
      state: 'CANCELLED_GUEST',
      payment_state: 'PAID',
      refund_state: 'FAILED',
    });
    // And nothing was posted for money that did not move.
    expect((await ledger(paid.bookingId))['REFUND']).toBeUndefined();
  }, 120_000);
});

describe('the local calendar the batch uses', () => {
  it('files eligibility under the hotel-local day, not the server’s', async () => {
    const hotel = await h.bookableHotel('local_day', 1, 1000);
    const paid = await paidBooking(hotel, window(75));
    await completeStay(hotel, await bookingRefOf(paid.bookingId), crypto.randomUUID());
    const row = await h.admin.query<{ eligible_local_date: string; server_day: string }>(
      `SELECT to_char(eligible_local_date, 'YYYY-MM-DD') AS eligible_local_date,
              to_char((now() AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS server_day
         FROM platform.booking_payable WHERE booking_id = $1`,
      [paid.bookingId, UB],
    );
    expect(row.rows[0]?.eligible_local_date).toBe(row.rows[0]?.server_day);
  }, 120_000);
});

describe('what a hold shows before the guest pays (doc 11 §5)', () => {
  it('carries the policy version and the free-cancellation deadline', async () => {
    const hotel = await h.bookableHotel('policy_shown', 1, 1000);
    const guest = await h.guest();
    const dates = window(80);
    const held = await hold(hotel, guest, dates);
    expect(held.cancellationPolicyVersion).toBe(1);
    // 24 hours before the arrival day begins in Asia/Ulaanbaatar.
    const arrival = new Date(dates.checkInDate.getTime() - 8 * 3600_000);
    expect(held.freeCancellationUntil.toISOString()).toBe(
      new Date(arrival.getTime() - 24 * 3600_000).toISOString(),
    );
    // And it is frozen: the database refuses to move it.
    await expect(
      h.admin.query(
        `UPDATE platform.booking SET free_cancellation_until = now(), revision = revision + 1
          WHERE booking_id = $1`,
        [held.bookingId],
      ),
    ).rejects.toThrow(/snapshot/);
  }, 120_000);
});

describe('the settlement contract refuses when it is not provisioned', () => {
  it('will not let a booking confirm through the unprovisioned default', async () => {
    const { UnprovisionedSettlement } = await import('../booking/contracts/settlement');
    const port: SettlementPort = new UnprovisionedSettlement();
    await withTenantTransaction(
      h.api,
      {
        hotelId: '00000000-0000-0000-0000-000000000000',
        realm: 'operation',
        actorRef: 'settlement-default',
        correlationId: 'settlement-default',
      },
      async (uow) => {
        await expect(port.contractFor(uow, new Date())).rejects.toThrow(/booking_payable exists/);
      },
    );
  }, 120_000);
});

describe('a guest cancellation cannot be repeated', () => {
  it('raises one obligation however many times the command arrives', async () => {
    const hotel = await h.bookableHotel('cancel_twice', 1, 1000);
    const paid = await paidBooking(hotel, window(85));
    const booking = await h.admin.query<{ booker_account_id: string }>(
      `SELECT booker_account_id FROM platform.booking WHERE booking_id = $1`,
      [paid.bookingId],
    );
    const account = booking.rows[0]?.booker_account_id;
    await h.bookingService.cancelByGuest({ bookingId: paid.bookingId }, newBookingRequest(account));
    await expect(
      h.bookingService.cancelByGuest({ bookingId: paid.bookingId }, newBookingRequest(account)),
    ).rejects.toBeInstanceOf(ApiError);
    const refunds = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text FROM platform.booking_refund WHERE booking_id = $1`,
      [paid.bookingId],
    );
    expect(refunds.rows[0]?.count).toBe('1');
  }, 120_000);
});
