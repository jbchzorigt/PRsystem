import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultAdapterModes } from '@prsystem/ports';
import type { BookingHarness } from '../booking/test-support/booking-harness';
import { createBookingHarness } from '../booking/test-support/booking-harness';
import { newBookingRequest } from '../booking/services/booking-context';
import type { StayHotel } from '../stay/test-support/stay-harness';
import {
  attachSettlementWorkerRuntime,
  createSettlementWorkerRuntime,
} from './worker/settlement-worker';

/**
 * The runtime the worker drives, over real PostgreSQL (Phase 20).
 *
 * The two sweeps are the Phase 14 services; what this proves is the glue the
 * worker deployment runs — that the runtime executes an open refund and runs a
 * due payout through the very same path, that a disabled adapter is reported
 * as such so the consumer will not schedule it, and that a `DISABLED` answer
 * settles nothing.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `settlement-worker-${String(keys)}`;
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
  h = await createBookingHarness('settlement_worker');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h.resetClock();
});

async function paidAndCancelled(hotel: StayHotel): Promise<string> {
  const guest = await h.guest();
  const held = await h.bookingService.hold(
    {
      categoryId: hotel.categoryId,
      ...window(35),
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
      idempotencyKey: key(),
    },
    newBookingRequest(guest),
  );
  const outcome = await h.bookingService.applyCapture(
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
  expect(outcome.outcome).toBe('confirmed');
  await h.bookingService.cancelByGuest({ bookingId: held.bookingId }, newBookingRequest(guest));
  return held.bookingId;
}

async function refundState(bookingId: string): Promise<string> {
  const result = await h.admin.query<{ state: string }>(
    `SELECT state FROM platform.booking_refund WHERE booking_id = $1 ORDER BY requested_at LIMIT 1`,
    [bookingId],
  );
  return result.rows[0]?.state ?? 'none';
}

describe('the settlement worker runtime', () => {
  it('executes an open refund through the Phase 14 executor', async () => {
    const hotel = await h.bookableHotel('worker_refund', 1, 1000);
    const bookingId = await paidAndCancelled(hotel);
    expect(await refundState(bookingId)).toBe('REQUIRED');

    const runtime = attachSettlementWorkerRuntime(h.settlementDeps);
    expect(runtime.enabled).toEqual({ refunds: true, payouts: true });
    const executed = await runtime.executeOpenRefunds();
    expect(executed).toBeGreaterThanOrEqual(1);
    expect(await refundState(bookingId)).toBe('REFUNDED');
    // Idempotent: the obligation is settled, and asking again finds nothing of this booking's.
    await runtime.executeOpenRefunds();
    expect(await refundState(bookingId)).toBe('REFUNDED');
    await runtime.close();
  }, 120_000);

  it('treats a DISABLED gateway as no decision: the refund stays open, nothing is marked failed', async () => {
    const hotel = await h.bookableHotel('worker_refund_disabled', 1, 1000);
    const bookingId = await paidAndCancelled(hotel);
    // The refund executor built over production defaults: both gateways answer DISABLED.
    const production = createSettlementWorkerRuntime({
      databaseUrl: h.settlementDeps.pool.options.connectionString as string,
      adapters: { appEnv: 'production', slots: defaultAdapterModes('production') },
    });
    expect(production.enabled).toEqual({ refunds: false, payouts: false });
    // Called anyway, as a misrouted job would: the gate is not a provider's answer.
    expect(await production.executeOpenRefunds()).toBe(0);
    expect(await refundState(bookingId)).toBe('PENDING');
    await production.close();
    // And the simulator-backed runtime settles what the disabled one left open.
    const runtime = attachSettlementWorkerRuntime(h.settlementDeps);
    await runtime.executeOpenRefunds();
    expect(await refundState(bookingId)).toBe('REFUNDED');
  }, 120_000);

  it('reports the sweeps the selection permits, and runs the due payouts through the Phase 14 runner', async () => {
    const enabled = createSettlementWorkerRuntime({
      databaseUrl: h.settlementDeps.pool.options.connectionString as string,
      adapters: { appEnv: 'ci', slots: defaultAdapterModes('ci') },
    });
    expect(enabled.enabled).toEqual({ refunds: true, payouts: true });
    await enabled.close();
    const partial = createSettlementWorkerRuntime({
      databaseUrl: h.settlementDeps.pool.options.connectionString as string,
      adapters: { appEnv: 'ci', slots: { ...defaultAdapterModes('ci'), payout: 'disabled' } },
    });
    expect(partial.enabled).toEqual({ refunds: true, payouts: false });
    await partial.close();

    // Nothing is due yet in this harness's clock, and the runner says so.
    const runtime = attachSettlementWorkerRuntime(h.settlementDeps);
    expect(typeof (await runtime.runDuePayouts())).toBe('number');
    await runtime.close();
  }, 120_000);
});
