import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHotel } from '../stay/test-support/stay-harness';
import { syntheticGuest } from '../stay/test-support/stay-harness';
import type { StayView } from '../stay/services/stay-views';
import type { BillingHarness } from './test-support/billing-harness';
import { createBillingHarness, key, request } from './test-support/billing-harness';
import { withTenantTransaction } from '@prsystem/db';
import { BillingPaymentAttempts } from './contracts/stay-payment-attempts';
import { hotelScope } from './services/billing-context';
import type { FolioView } from './services/billing-views';

/**
 * Phase 10 on real PostgreSQL, through the restricted API login.
 *
 * The one bill of a stay and what it charges; the deposit a walk-in owes and
 * the configuration it was confirmed under; the deposit applied to a line
 * without adding cash; the refund that is not refunded until the provider says
 * so; the release that only proof of no movement allows; the late success that
 * freezes the deposit and opens exactly one case; and the correction that never
 * edits what it corrects.
 */

let env: BillingHarness;
let h: StayHotel;

beforeAll(async () => {
  env = await createBillingHarness('billing_integration');
  h = await env.hotel('Billing Hotel', 'P25');
  await env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
    h.reception,
    request(h.reception),
  );
  await env.configureDeposit(h, 50_000n);
}, 180000);

afterAll(async () => {
  env.travel(0);
  await env.close();
}, 30000);

async function refused(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a refusal');
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

/** A QPay invoice the guest has paid: the reference a movement carries. */
function paidReference(amountMnt: bigint): Promise<string> {
  const qpay = env.simulators.get('QPAY');
  if (qpay === undefined) throw new Error('no simulator');
  return qpay
    .createInvoice(
      {
        intentId: key('in'),
        merchantRef: key('mr'),
        amountMnt,
        currency: 'MNT',
        idempotencyKey: key('ik'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      { correlationId: key('co') },
    )
    .then((result) => {
      if (!result.ok) throw new Error('the simulator refused the invoice');
      qpay.pay(result.value.providerInvoiceId, new Date());
      return result.value.providerInvoiceId;
    });
}

async function receiveDeposit(stayId: string, amountMnt = 50_000n): Promise<FolioView> {
  return env.deposits2.receive(
    {
      hotelId: h.hotelId,
      stayId,
      idempotencyKey: key('dp'),
      channel: 'QPAY',
      amountMnt,
      providerReference: await paidReference(amountMnt),
    },
    h.reception,
    request(h.reception),
  );
}

describe('the stay module’s payment attempts are the folio’s own transactions (Phase 22, A-P22-2)', () => {
  it('answers SUCCEEDED with the captured amount for a payment reference, and UNKNOWN for none', async () => {
    const stay = await checkIn();
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    const paid = await env.folios.pay(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('py'),
        channel: 'MANUAL_POS',
        amountMnt: 15_000n,
        approvalCode: 'A22-0001',
        terminalId: 'T-22',
        providerReference: `pos-${stay.stayId}`,
      },
      h.reception,
      request(h.reception),
    );
    const transaction = paid.transactions.find((t) => t.kind === 'FOLIO_PAYMENT');
    expect(transaction).toBeDefined();
    const attempts = new BillingPaymentAttempts();
    const scope = hotelScope(h.hotelId, request(h.reception));
    const byReference = await withTenantTransaction(env.api, scope, (uow) =>
      attempts.statusOf(uow, `pos-${stay.stayId}`),
    );
    expect(byReference).toEqual({
      attemptRef: `pos-${stay.stayId}`,
      status: 'SUCCEEDED',
      capturedAmountMnt: 15_000n,
    });
    const byTransaction = await withTenantTransaction(env.api, scope, (uow) =>
      attempts.statusOf(uow, transaction!.transactionId),
    );
    expect(byTransaction.status).toBe('SUCCEEDED');
    const unknown = await withTenantTransaction(env.api, scope, (uow) =>
      attempts.statusOf(uow, 'no-such-attempt'),
    );
    expect(unknown).toEqual({
      attemptRef: 'no-such-attempt',
      status: 'UNKNOWN',
      capturedAmountMnt: null,
    });
  }, 90000);
});

describe('the one bill of a stay (RC-DEC-001, DEP-DEC-001, -008)', () => {
  it('opens with the check-in, carries the deposit requirement it was confirmed under, and charges the room once', async () => {
    const stay = await checkIn();
    const folio = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    expect(folio.deposit).toMatchObject({
      required: true,
      requiredAmountMnt: '50000',
      configScope: 'HOTEL',
      source: 'WALK_IN',
    });
    const charged = await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    expect(charged.chargedMnt).toBe('20000');
    expect(charged.balanceMnt).toBe('20000');
    // Posting again bills nothing twice: the line is idempotent on the stay.
    const again = await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    expect(again.chargedMnt).toBe('20000');
    expect(again.lines).toHaveLength(1);
  }, 90000);

  it('refuses a walk-in check-in in a hotel with no configured deposit (DEP-DEC-001)', async () => {
    const other = await env.hotel('No Deposit Hotel', 'P25');
    await env.shifts.open(
      { hotelId: other.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
      other.reception,
      request(other.reception),
    );
    const roomId = await other.cleanRoom();
    const refusal = await refused(
      env.checkIns.checkIn(
        {
          hotelId: other.hotelId,
          idempotencyKey: key('ci'),
          roomId,
          source: 'WALK_IN',
          stayType: 'HOURLY',
          halfHourUnits: 1,
          guest: syntheticGuest(),
        },
        other.reception,
        request(other.reception),
      ),
    );
    expect(refusal.message).toContain('DEPOSIT_NOT_CONFIGURED');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE hotel_id = $1`,
        [other.hotelId],
      ),
    ).toBe(0);
  }, 90000);
});

describe('the deposit, its balance and what it may cover (DEP-DEC-002, -007)', () => {
  it('covers a line without adding cash, and never goes below zero', async () => {
    const stay = await checkIn();
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    const received = await receiveDeposit(stay.stayId);
    expect(received.deposit).toMatchObject({ receivedMnt: '50000', availableMnt: '50000' });
    const line = received.lines[0];
    if (line === undefined) throw new Error('no line');

    const tooMuch = await refused(
      env.folios.allocate(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('al'),
          folioLineId: line.lineId,
          amountMnt: 90_000n,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(tooMuch.message).toContain('ALLOCATION_ABOVE_AVAILABLE');

    const allocated = await env.folios.allocate(
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
    expect(allocated.depositAppliedMnt).toBe('20000');
    expect(allocated.balanceMnt).toBe('0');
    expect(allocated.deposit).toMatchObject({ allocatedMnt: '20000', availableMnt: '30000' });
    // doc 20 §9: an allocation is not a new payment — no cash movement exists.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.payment_transaction
          WHERE stay_id = $1 AND kind = 'FOLIO_PAYMENT'`,
        [stay.stayId],
      ),
    ).toBe(0);
    expect(allocated.transactions.filter((t) => t.kind === 'DEPOSIT_RECEIPT')).toHaveLength(1);

    const settled = await env.folios.settle(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('st'),
        expectedRevision: allocated.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(settled.state).toBe('SETTLED');
    // The database refuses a negative balance even bypassing the service.
    await expect(
      env.admin.query(
        `UPDATE platform.deposit_aggregate SET allocated_mnt = allocated_mnt + 100000,
                revision = revision + 1 WHERE stay_id = $1`,
        [stay.stayId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120000);

  it('refuses a QPay payment the provider has not confirmed, and a POS movement with no approval code', async () => {
    const stay = await checkIn();
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    const qpay = env.simulators.get('QPAY');
    if (qpay === undefined) throw new Error('no simulator');
    const unpaid = await qpay.createInvoice(
      {
        intentId: key('in'),
        merchantRef: key('mr'),
        amountMnt: 20_000n,
        currency: 'MNT',
        idempotencyKey: key('ik'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      { correlationId: key('co') },
    );
    if (!unpaid.ok) throw new Error('the simulator refused the invoice');
    const notPaid = await refused(
      env.folios.pay(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('py'),
          channel: 'QPAY',
          amountMnt: 20_000n,
          providerReference: unpaid.value.providerInvoiceId,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(notPaid.message).toContain('PROVIDER_NOT_PAID');
    const noCode = await refused(
      env.folios.pay(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('py'),
          channel: 'MANUAL_POS',
          amountMnt: 20_000n,
          providerReference: 'POS-1',
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(noCode.message).toContain('APPROVAL_CODE_REQUIRED');
    qpay.pay(unpaid.value.providerInvoiceId, new Date());
    const paid = await env.folios.pay(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('py'),
        channel: 'QPAY',
        amountMnt: 20_000n,
        providerReference: unpaid.value.providerInvoiceId,
      },
      h.reception,
      request(h.reception),
    );
    expect(paid.paidMnt).toBe('20000');
    expect(paid.balanceMnt).toBe('0');
  }, 120000);
});

describe('the refund and its reservation (DEP-DEC-003, -004, -009)', () => {
  it('reserves at once, keeps the reservation through a failure, and pays out only on a provider success', async () => {
    const stay = await checkIn();
    const received = await receiveDeposit(stay.stayId);
    const receipt = received.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');
    const requested = await env.refunds2.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('rf'),
        originalTransactionId: receipt.transactionId,
        amountMnt: 50_000n,
      },
      h.reception,
      request(h.reception),
    );
    expect(requested.deposit).toMatchObject({
      refundReservedMnt: '50000',
      availableMnt: '0',
    });
    const refund = requested.refunds[0];
    if (refund === undefined) throw new Error('no refund');

    // While it is reserved, the same money cannot be allocated to a charge.
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    const view = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    const line = view.lines[0];
    if (line === undefined) throw new Error('no line');
    const blocked = await refused(
      env.folios.allocate(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('al'),
          folioLineId: line.lineId,
          amountMnt: 10_000n,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(blocked.message).toContain('ALLOCATION_ABOVE_AVAILABLE');

    // The provider refuses once: the money stays reserved for the retry.
    const qpay = env.simulators.get('QPAY');
    if (qpay === undefined) throw new Error('no simulator');
    qpay.failNext({ kind: 'TIMEOUT', retryable: true });
    const failed = await env.refunds2.execute(
      {
        hotelId: h.hotelId,
        requestId: refund.requestId,
        idempotencyKey: key('rx'),
        expectedRevision: refund.revision,
      },
      h.reception,
      request(h.reception),
    );
    const afterFailure = failed.refunds.find((r) => r.requestId === refund.requestId);
    expect(afterFailure?.state).toBe('FAILED');
    expect(failed.deposit).toMatchObject({ refundReservedMnt: '50000', refundedMnt: '0' });

    const retried = await env.refunds2.execute(
      {
        hotelId: h.hotelId,
        requestId: refund.requestId,
        idempotencyKey: key('rx'),
        expectedRevision: afterFailure?.revision as number,
      },
      h.reception,
      request(h.reception),
    );
    const settled = retried.refunds.find((r) => r.requestId === refund.requestId);
    expect(settled?.state).toBe('SUCCEEDED');
    expect(retried.deposit).toMatchObject({ refundReservedMnt: '0', refundedMnt: '50000' });
    expect(retried.transactions.filter((t) => t.kind === 'DEPOSIT_REFUND')).toHaveLength(1);
  }, 150000);

  it('an alternate channel waits for a Manager, and a release needs proof no money moved', async () => {
    const stay = await checkIn();
    const received = await receiveDeposit(stay.stayId);
    const receipt = received.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');
    const requested = await env.refunds2.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('rf'),
        originalTransactionId: receipt.transactionId,
        amountMnt: 50_000n,
        channel: 'CASH',
        reason: 'QPay буцаалт ажиллахгүй байна',
      },
      h.reception,
      request(h.reception),
    );
    const refund = requested.refunds[0];
    if (refund === undefined) throw new Error('no refund');
    expect(refund).toMatchObject({ alternateChannel: true, approvalState: 'PENDING' });
    const early = await refused(
      env.refunds2.execute(
        {
          hotelId: h.hotelId,
          requestId: refund.requestId,
          idempotencyKey: key('rx'),
          expectedRevision: refund.revision,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(early.message).toContain('APPROVAL_REQUIRED');
    const approved = await env.refunds2.decide(
      {
        hotelId: h.hotelId,
        requestId: refund.requestId,
        idempotencyKey: key('rd'),
        expectedRevision: refund.revision,
        approve: true,
        reason: 'Бэлнээр буцаана',
      },
      h.manager,
      request(h.manager),
    );
    const decided = approved.refunds.find((r) => r.requestId === refund.requestId);
    expect(decided?.approvalState).toBe('APPROVED');

    // A cash refund is released without a provider; a card one is not.
    const released = await env.refunds2.release(
      {
        hotelId: h.hotelId,
        requestId: refund.requestId,
        idempotencyKey: key('rl'),
        expectedRevision: decided?.revision as number,
        reason: 'Зочин мөнгөө аваагүй',
      },
      h.manager,
      request(h.manager),
    );
    const afterRelease = released.refunds.find((r) => r.requestId === refund.requestId);
    expect(afterRelease?.state).toBe('RELEASED');
    expect(released.deposit).toMatchObject({ refundReservedMnt: '0', refundedMnt: '0' });
  }, 150000);
});

describe('a released refund the provider then paid (DEP-DEC-009, -010)', () => {
  it('freezes the deposit, opens exactly one case, and posts the covered amount and the shortfall', async () => {
    const stay = await checkIn();
    const received = await receiveDeposit(stay.stayId);
    const receipt = received.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');
    const requested = await env.refunds2.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('rf'),
        originalTransactionId: receipt.transactionId,
        amountMnt: 50_000n,
      },
      h.reception,
      request(h.reception),
    );
    const refund = requested.refunds[0];
    if (refund === undefined) throw new Error('no refund');
    const qpay = env.simulators.get('QPAY');
    if (qpay === undefined) throw new Error('no simulator');
    // The provider says the invoice failed, so the release is legal.
    qpay.settle(receipt.providerReference as string, { state: 'FAILED' });
    const released = await env.refunds2.release(
      {
        hotelId: h.hotelId,
        requestId: refund.requestId,
        idempotencyKey: key('rl'),
        expectedRevision: refund.revision,
        reason: 'Provider буцаалтыг боловсруулаагүй',
      },
      h.manager,
      request(h.manager),
    );
    expect(released.deposit).toMatchObject({ refundReservedMnt: '0' });

    // The deposit is spent on the bill while the refund is released.
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    const view = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    const line = view.lines[0];
    if (line === undefined) throw new Error('no line');
    await env.folios.allocate(
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

    // And then the provider pays it after all.
    qpay.settle(receipt.providerReference as string, {
      state: 'PAID',
      paidAmountMnt: 50_000n,
    });
    const checked = await env.refunds2.checkForLateSuccess(
      { hotelId: h.hotelId, requestId: refund.requestId, idempotencyKey: key('lc') },
      h.manager,
      request(h.manager),
    );
    expect(checked.deposit?.frozen).toBe(true);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.deposit_reconciliation_case WHERE stay_id = $1`,
        [stay.stayId],
      ),
    ).toBe(1);
    // No second refund was posted to the guest.
    expect(checked.transactions.filter((t) => t.kind === 'DEPOSIT_REFUND')).toHaveLength(0);
    // And a frozen deposit funds nothing more.
    const frozen = await refused(
      env.folios.allocate(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('al'),
          folioLineId: line.lineId,
          amountMnt: 1_000n,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(frozen.message).toMatch(/DEPOSIT_FROZEN|LINE_ALREADY_COVERED/);

    // Platform Operation resolves it: what the deposit can cover, and the rest.
    const hotelAdminRefusal = await refused(
      env.cases.list({ hotelId: h.hotelId }, h.manager, request(h.manager)),
    );
    expect(hotelAdminRefusal.code).toBe('NOT_FOUND');
    const operator = await env.operationActor(['DEPOSIT_REFUND_RECONCILE']);
    const cases = await env.cases.list({ hotelId: h.hotelId }, operator, request(operator));
    expect(cases).toHaveLength(1);
    const openCase = cases[0];
    if (openCase === undefined) throw new Error('no case');
    const claimed = await env.cases.claimCase(
      {
        hotelId: h.hotelId,
        caseId: openCase.caseId,
        idempotencyKey: key('cc'),
        expectedRevision: openCase.revision,
      },
      operator,
      request(operator),
    );
    expect(claimed.state).toBe('RECONCILING');
    const resolved = await env.cases.resolve(
      {
        hotelId: h.hotelId,
        caseId: openCase.caseId,
        idempotencyKey: key('cr'),
        expectedRevision: claimed.revision,
        outcome: 'PROVIDER_SUCCESS_POSTED',
        note: 'Provider мөнгийг гаргасан',
      },
      operator,
      request(operator),
    );
    expect(resolved).toMatchObject({
      state: 'RESOLVED',
      outcome: 'PROVIDER_SUCCESS_POSTED',
      coveredAmountMnt: '30000',
      shortfallAmountMnt: '20000',
    });
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.hotel_finance_event
          WHERE stay_id = $1 AND kind = 'LATE_REFUND_SHORTFALL'`,
        [stay.stayId],
      ),
    ).toBe(1);
    const after = await env.folios.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    expect(after.deposit).toMatchObject({ frozen: false, refundedMnt: '30000' });
    expect(after.transactions.filter((t) => t.kind === 'LATE_REFUND_COVERED')).toHaveLength(1);
  }, 180000);
});

describe('the financial correction (DEP-DEC-006)', () => {
  it('never edits the original: it reverses it and records the corrected movement', async () => {
    const stay = await checkIn();
    const received = await receiveDeposit(stay.stayId, 100_000n);
    const receipt = received.transactions.find((t) => t.kind === 'DEPOSIT_RECEIPT');
    if (receipt === undefined) throw new Error('no receipt');
    const requested = await env.corrections2.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('cr'),
        originalTransactionId: receipt.transactionId,
        reason: 'Дүн буруу бүртгэгдсэн',
        correctedAmountMnt: 60_000n,
        correctedChannel: 'QPAY',
        correctedReference: await paidReference(60_000n),
      },
      h.reception,
      request(h.reception),
    );
    const correction = requested.corrections[0];
    if (correction === undefined) throw new Error('no correction');
    // One non-terminal request per movement.
    const second = await refused(
      env.corrections2.request(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('cr'),
          originalTransactionId: receipt.transactionId,
          reason: 'Дахин',
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(second.message).toContain('CORRECTION_ALREADY_OPEN');

    const executed = await env.corrections2.decide(
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
    const decided = executed.corrections.find((c) => c.correctionId === correction.correctionId);
    expect(decided?.state).toBe('EXECUTED');
    expect(decided?.reversalTransactionId).not.toBeNull();
    expect(decided?.correctedTransactionId).not.toBeNull();
    expect(executed.deposit).toMatchObject({
      receivedMnt: '160000',
      reversedMnt: '100000',
      availableMnt: '60000',
    });
    // The original movement is untouched, whoever issues the statement.
    await expect(
      env.admin.query(
        `UPDATE platform.payment_transaction SET amount_mnt = 1 WHERE transaction_id = $1`,
        [receipt.transactionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 150000);
});
