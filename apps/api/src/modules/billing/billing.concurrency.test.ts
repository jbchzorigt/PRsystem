import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHotel } from '../stay/test-support/stay-harness';
import { syntheticGuest } from '../stay/test-support/stay-harness';
import type { StayView } from '../stay/services/stay-views';
import type { BillingHarness } from './test-support/billing-harness';
import { createBillingHarness, key, request } from './test-support/billing-harness';
import type { FolioView } from './services/billing-views';

/**
 * Phase 10 concurrency, on real PostgreSQL — the build plan's two gates.
 *
 * An allocation racing a refund reservation on one deposit: the aggregate is
 * locked, so the second sees what the first committed and the balance never
 * goes negative. A correction approved twice at once: one reversal, one
 * corrected record, one balance effect.
 */

let env: BillingHarness;
let h: StayHotel;

beforeAll(async () => {
  env = await createBillingHarness('billing_concurrency');
  h = await env.hotel('Race Billing', 'P25');
  await env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh') },
    h.reception,
    request(h.reception),
  );
  await env.configureDeposit(h, 50_000n);
}, 180000);

afterAll(async () => {
  env.travel(0);
  await env.close();
}, 30000);

async function settle<T>(
  work: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: error as ApiError };
  }
}

async function checkIn(): Promise<StayView> {
  const roomId = await h.cleanRoom();
  return env.checkIns.checkIn(
    {
      hotelId: h.hotelId,
      idempotencyKey: key('ci'),
      roomId,
      source: 'WALK_IN',
      stayType: 'HOURLY',
      halfHourUnits: 2,
      guest: syntheticGuest(),
    },
    h.reception,
    request(h.reception),
  );
}

async function paidReference(amountMnt: bigint): Promise<string> {
  const qpay = env.simulators.get('QPAY');
  if (qpay === undefined) throw new Error('no simulator');
  const created = await qpay.createInvoice(
    {
      intentId: key('in'),
      merchantRef: key('mr'),
      amountMnt,
      currency: 'MNT',
      idempotencyKey: key('ik'),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    { correlationId: key('co') },
  );
  if (!created.ok) throw new Error('the simulator refused the invoice');
  qpay.pay(created.value.providerInvoiceId, new Date());
  return created.value.providerInvoiceId;
}

async function fundedStay(): Promise<{ stay: StayView; folio: FolioView }> {
  const stay = await checkIn();
  await env.deposits2.receive(
    {
      hotelId: h.hotelId,
      stayId: stay.stayId,
      idempotencyKey: key('dp'),
      channel: 'QPAY',
      amountMnt: 50_000n,
      providerReference: await paidReference(50_000n),
    },
    h.reception,
    request(h.reception),
  );
  const folio = await env.folios.postCharges(
    { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
    h.reception,
    request(h.reception),
  );
  return { stay, folio };
}

describe('an allocation racing a refund reservation', () => {
  it('serializes on the aggregate and never lets the balance go negative', async () => {
    const { stay, folio } = await fundedStay();
    const line = folio.lines[0];
    if (line === undefined) throw new Error('no line');
    const receipt = folio.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');

    // 50,000₮ is available. The allocation wants 20,000₮ and the refund wants
    // all 50,000₮: at most one of them can have what it asked for.
    const [allocation, refund] = await Promise.all([
      settle(
        env.folios.allocate(
          {
            hotelId: h.hotelId,
            stayId: stay.stayId,
            idempotencyKey: key('al'),
            folioLineId: line.lineId,
            amountMnt: 20_000n,
          },
          h.reception,
          request(h.reception),
        ),
      ),
      settle(
        env.refunds2.request(
          {
            hotelId: h.hotelId,
            stayId: stay.stayId,
            idempotencyKey: key('rf'),
            originalTransactionId: receipt.transactionId,
            amountMnt: 50_000n,
          },
          h.reception,
          request(h.reception),
        ),
      ),
    ]);
    expect([allocation.ok, refund.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const after = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    const deposit = after.deposit;
    if (deposit === null) throw new Error('no deposit');
    // Whatever the order, the invariant holds and the totals agree with the rows.
    expect(BigInt(deposit.availableMnt)).toBeGreaterThanOrEqual(0n);
    expect(
      BigInt(deposit.receivedMnt) -
        BigInt(deposit.reversedMnt) -
        BigInt(deposit.allocatedMnt) -
        BigInt(deposit.refundReservedMnt) -
        BigInt(deposit.refundedMnt),
    ).toBe(BigInt(deposit.availableMnt));
    expect(BigInt(deposit.allocatedMnt) + BigInt(deposit.refundReservedMnt)).toBeLessThanOrEqual(
      50_000n,
    );
    if (!allocation.ok) expect(allocation.error.message).toContain('ALLOCATION_ABOVE_AVAILABLE');
    if (!refund.ok) expect(refund.error.message).toContain('REFUND_ABOVE_AVAILABLE');
  }, 150000);

  it('three allocations of the same line leave exactly one', async () => {
    const { stay, folio } = await fundedStay();
    const line = folio.lines[0];
    if (line === undefined) throw new Error('no line');
    const allocate = () =>
      env.folios.allocate(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('al'),
          folioLineId: line.lineId,
          amountMnt: 20_000n,
        },
        h.reception,
        request(h.reception),
      );
    const results = await Promise.all([settle(allocate()), settle(allocate()), settle(allocate())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.deposit_allocation WHERE stay_id = $1`,
        [stay.stayId],
      ),
    ).toBe(1);
  }, 150000);
});

describe('a correction approved twice at once', () => {
  it('executes exactly one reversal and one corrected record', async () => {
    const stay = await checkIn();
    const received = await env.deposits2.receive(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('dp'),
        channel: 'QPAY',
        amountMnt: 50_000n,
        providerReference: await paidReference(50_000n),
      },
      h.reception,
      request(h.reception),
    );
    const receipt = received.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');
    const requested = await env.corrections2.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('cr'),
        originalTransactionId: receipt.transactionId,
        reason: 'Дүн буруу',
        correctedAmountMnt: 60_000n,
        correctedChannel: 'QPAY',
        correctedReference: await paidReference(60_000n),
      },
      h.reception,
      request(h.reception),
    );
    const correction = requested.corrections[0];
    if (correction === undefined) throw new Error('no correction');
    const approve = () =>
      env.corrections2.decide(
        {
          hotelId: h.hotelId,
          correctionId: correction.correctionId,
          idempotencyKey: key('cd'),
          expectedRevision: correction.revision,
          approve: true,
          decisionReason: 'Зөвшөөрсөн',
        },
        h.manager,
        request(h.manager),
      );
    const results = await Promise.all([settle(approve()), settle(approve())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.payment_transaction
          WHERE stay_id = $1 AND kind = 'DEPOSIT_REVERSAL'`,
        [stay.stayId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.payment_transaction
          WHERE stay_id = $1 AND kind = 'CORRECTED_PAYMENT'`,
        [stay.stayId],
      ),
    ).toBe(1);
    const after = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    expect(after.deposit).toMatchObject({
      receivedMnt: '110000',
      reversedMnt: '50000',
      availableMnt: '60000',
    });
  }, 180000);
});
