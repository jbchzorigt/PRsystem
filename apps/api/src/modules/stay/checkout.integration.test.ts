import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHarness, StayHotel } from './test-support/stay-harness';
import { createStayHarness, key, request, syntheticGuest } from './test-support/stay-harness';
import type { StayView } from './services/stay-views';
import type { ReportView } from './services/checkout-views';

/**
 * Phase 09 on real PostgreSQL, through the restricted API login.
 *
 * The checkout a Reception starts and the report it opens; the Cleaner's
 * count and the server's pricing from the check-in book; the Reception's
 * return and the new version; the Manager's exception version; the guest's
 * dispute and its decision; the payment attempt's lock, its reconciliation and
 * the settlement that posts the guest's consumption; the adjustments that are
 * the only correction afterwards; the active-stay refill; and the cleaning
 * task the actual checkout leaves behind.
 */

let env: StayHarness;
let h: StayHotel;
let templateId: string;
let waterId: string;
let colaId: string;
let versionId: string;

beforeAll(async () => {
  env = await createStayHarness('checkout_integration');
  h = await env.hotel('Checkout Hotel', 'P25');
  await env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
    h.reception,
    request(h.reception),
  );
  templateId = await h.template('Checkout Template');
  const product = (name: string, price: bigint, opening: number) =>
    env.minibar.products.createProduct(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('mb'),
        name,
        category: 'Ундаа',
        unit: 'ш',
        sellingPriceMnt: price,
        purchaseCostMnt: 1000n,
        openingQuantity: opening,
        state: 'ACTIVE',
      },
      h.manager,
      request(h.manager),
    );
  waterId = (await product('Ус', 3000n, 200)).productId;
  colaId = (await product('Кола', 5000n, 200)).productId;
  const draft = await env.minibar.versions.createDraft(
    {
      hotelId: h.hotelId,
      templateId,
      idempotencyKey: key('mb'),
      items: [
        { productId: waterId, targetQuantity: 2 },
        { productId: colaId, targetQuantity: 1 },
      ],
    },
    h.manager,
    request(h.manager),
  );
  versionId = (
    await env.minibar.versions.publish(
      {
        hotelId: h.hotelId,
        templateId,
        versionId: draft.versionId,
        idempotencyKey: key('mb'),
        expectedRevision: draft.revision,
      },
      h.manager,
      request(h.manager),
    )
  ).versionId;
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

/** A clean room whose minibar is on and filled to target. */
async function stockedRoom(): Promise<string> {
  const roomId = await h.cleanRoom();
  await env.minibar.configurations.requestChange(
    {
      hotelId: h.hotelId,
      roomId,
      idempotencyKey: key('mb'),
      kind: 'OFF_TO_ON',
      targetTemplateId: templateId,
      targetVersionId: versionId,
    },
    h.manager,
    request(h.manager),
  );
  const view = await env.minibar.configurations.view(
    { hotelId: h.hotelId, roomId },
    h.manager,
    request(h.manager),
  );
  const task = view.openTask;
  if (task === null) throw new Error('no configuration task');
  const claimed = await env.minibar.configurations.claimTask(
    {
      hotelId: h.hotelId,
      taskId: task.taskId,
      idempotencyKey: key('mb'),
      expectedRevision: task.revision,
    },
    h.cleaner,
    request(h.cleaner),
  );
  await env.minibar.configurations.completeTask(
    {
      hotelId: h.hotelId,
      taskId: task.taskId,
      idempotencyKey: key('mb'),
      expectedRevision: claimed.revision,
      counted: [],
      transfers: task.bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity })),
    },
    h.cleaner,
    request(h.cleaner),
  );
  return roomId;
}

async function checkIn(roomId: string, units = 2): Promise<StayView> {
  return env.checkIns.checkIn(
    {
      hotelId: h.hotelId,
      idempotencyKey: key('ci'),
      roomId,
      source: 'WALK_IN',
      stayType: 'HOURLY',
      halfHourUnits: units,
      guest: syntheticGuest(),
    },
    h.reception,
    request(h.reception),
  );
}

async function startCheckout(stay: StayView): Promise<ReportView> {
  const started = await env.checkouts.start(
    {
      hotelId: h.hotelId,
      stayId: stay.stayId,
      idempotencyKey: key('co'),
      expectedRevision: stay.revision,
    },
    h.reception,
    request(h.reception),
  );
  if (started.reportId === null) throw new Error('no report');
  return env.reports.view(
    { hotelId: h.hotelId, reportId: started.reportId },
    h.manager,
    request(h.manager),
  );
}

async function claimReport(report: ReportView): Promise<ReportView> {
  return env.reports.claimInspection(
    {
      hotelId: h.hotelId,
      reportId: report.reportId,
      idempotencyKey: key('rp'),
      expectedRevision: report.revision,
    },
    h.cleaner,
    request(h.cleaner),
  );
}

async function submit(
  report: ReportView,
  counted: readonly { productId: string; quantity: number }[],
  noUsage = false,
): Promise<ReportView> {
  return env.reports.submit(
    {
      hotelId: h.hotelId,
      reportId: report.reportId,
      idempotencyKey: key('rp'),
      expectedRevision: report.revision,
      counted,
      noUsage,
    },
    h.cleaner,
    request(h.cleaner),
  );
}

function currentVersion(report: ReportView) {
  const version = report.versions.find((v) => v.versionId === report.currentVersionId);
  if (version === undefined) throw new Error('no current version');
  return version;
}

async function payAndSettle(report: ReportView, ref: string): Promise<ReportView> {
  const locked = await env.paymentLocks.lockForPayment(
    {
      hotelId: h.hotelId,
      reportId: report.reportId,
      idempotencyKey: key('pl'),
      expectedRevision: report.revision,
      attemptRef: ref,
    },
    h.reception,
    request(h.reception),
  );
  const lock = locked.locks.find((l) => l.attemptRef === ref);
  if (lock === undefined) throw new Error('no lock');
  env.payments.set(ref, 'SUCCEEDED', BigInt(lock.amountMnt));
  return env.paymentLocks.reconcile(
    {
      hotelId: h.hotelId,
      lockId: lock.lockId,
      idempotencyKey: key('pl'),
      expectedRevision: lock.revision,
    },
    h.reception,
    request(h.reception),
  );
}

/** The lock and the reconcile with the attempts port left silent: only a zero lock may settle. */
async function payAndSettleWithoutProvider(report: ReportView, ref: string): Promise<ReportView> {
  const locked = await env.paymentLocks.lockForPayment(
    {
      hotelId: h.hotelId,
      reportId: report.reportId,
      idempotencyKey: key('pl'),
      expectedRevision: report.revision,
      attemptRef: ref,
    },
    h.reception,
    request(h.reception),
  );
  const lock = locked.locks.find((l) => l.attemptRef === ref);
  if (lock === undefined) throw new Error('no lock');
  return env.paymentLocks.reconcile(
    {
      hotelId: h.hotelId,
      lockId: lock.lockId,
      idempotencyKey: key('pl'),
      expectedRevision: lock.revision,
    },
    h.reception,
    request(h.reception),
  );
}

describe('the checkout and its minibar report (CHK-DEC-001, PRICE-DEC-003, -007)', () => {
  it('starts, is counted by the Cleaner, priced by the server, and only then may the stay complete', async () => {
    const roomId = await stockedRoom();
    const stay = await checkIn(roomId);
    const report = await startCheckout(stay);
    expect(report.state).toBe('PENDING');
    const board = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    expect(board.state).toBe('CHECKOUT_IN_PROGRESS');

    // The obligation is open: the actual checkout is refused while it is.
    const early = await refused(
      env.stays.recordActualCheckout(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('out'),
          expectedRevision: board.revision,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(early.message).toContain('CHECKOUT_OBLIGATION_OPEN');

    const claimed = await claimReport(report);
    expect(claimed.state).toBe('IN_INSPECTION');
    // Two of the water are gone, the cola is untouched.
    const submitted = await submit(claimed, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 1 },
    ]);
    expect(submitted.state).toBe('SUBMITTED');
    const version = currentVersion(submitted);
    expect(version.totalMnt).toBe('6000');
    expect(
      version.lines.map((l) => [
        l.productName,
        l.openingQuantity,
        l.countedQuantity,
        l.billableQuantity,
        l.lineTotalMnt,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['Ус', 2, 0, 2, '6000'],
        ['Кола', 1, 1, 0, '0'],
      ]),
    );
    expect(submitted.payableMnt).toBe('6000');

    const settled = await payAndSettle(submitted, `attempt-${stay.stayId}`);
    expect(settled.state).toBe('SETTLED');
    // The guest's consumption reached the stock ledger, linked to the stay.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement
          WHERE stay_id = $1 AND movement_type = 'GUEST_CONSUMPTION'`,
        [stay.stayId],
      ),
    ).toBe(1);

    const beforeCheckout = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    const done = await env.stays.recordActualCheckout(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('out'),
        expectedRevision: beforeCheckout.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(done.state).toBe('COMPLETED');
    // doc 04 §5.2 (11): the room's cleaning became a task.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cleaning_task WHERE room_id = $1 AND state = 'PENDING'`,
        [roomId],
      ),
    ).toBe(1);
  }, 120000);

  it('states no usage rather than leaving the report empty, and charges nothing', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [], true);
    const version = currentVersion(submitted);
    expect(version.noUsage).toBe(true);
    expect(version.totalMnt).toBe('0');
    expect(version.lines.every((line) => line.billableQuantity === 0)).toBe(true);
  }, 60000);

  it('a lock for nothing settles at the reconcile without asking any provider (Phase 22, A-P22-2)', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [], true);
    env.payments.clear();
    const settled = await payAndSettleWithoutProvider(submitted, `nothing-${stay.stayId}`);
    expect(settled.state).toBe('SETTLED');
    expect(settled.locks[0]).toMatchObject({ amountMnt: '0', state: 'SETTLED' });
  }, 60000);
});

describe('the price is the stay’s own (PRICE-DEC-002, -006, -007)', () => {
  it('refuses a product the check-in never priced, and ignores a later price edit', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const stranger = await env.minibar.products.createProduct(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('mb'),
        name: `Шинэ-${stay.stayId.slice(0, 8)}`,
        category: 'Ундаа',
        unit: 'ш',
        sellingPriceMnt: 7000n,
        purchaseCostMnt: 1000n,
        openingQuantity: 10,
        state: 'ACTIVE',
      },
      h.manager,
      request(h.manager),
    );
    const absent = await refused(submit(report, [{ productId: stranger.productId, quantity: 1 }]));
    expect(absent.message).toContain('PRODUCT_NOT_IN_PRICE_BOOK');

    // The Manager raises the current price; the active stay keeps its own.
    const products = await env.minibar.products.listProducts(
      h.hotelId,
      h.manager,
      request(h.manager),
    );
    const water = products.find((p) => p.productId === waterId);
    await env.minibar.products.updateProduct(
      {
        hotelId: h.hotelId,
        productId: waterId,
        idempotencyKey: key('mb'),
        expectedRevision: water?.revision as number,
        sellingPriceMnt: 12000n,
      },
      h.manager,
      request(h.manager),
    );
    const submitted = await submit(report, [
      { productId: waterId, quantity: 1 },
      { productId: colaId, quantity: 1 },
    ]);
    const line = currentVersion(submitted).lines.find((l) => l.productId === waterId);
    expect(line?.unitPriceMnt).toBe('3000');
    expect(line?.billableQuantity).toBe(1);
    expect(currentVersion(submitted).totalMnt).toBe('3000');

    // Put the catalogue back, so the later cases start from the same prices.
    const raised = (
      await env.minibar.products.listProducts(h.hotelId, h.manager, request(h.manager))
    ).find((p) => p.productId === waterId);
    await env.minibar.products.updateProduct(
      {
        hotelId: h.hotelId,
        productId: waterId,
        idempotencyKey: key('mb'),
        expectedRevision: raised?.revision as number,
        sellingPriceMnt: 3000n,
      },
      h.manager,
      request(h.manager),
    );
  }, 90000);
});

describe('correction before payment (CHK-DEC-002, CHK-DEC-003)', () => {
  it('Reception returns the report, the Cleaner’s correction is a new version, and the first one stays', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const first = await submit(report, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 0 },
    ]);
    expect(currentVersion(first).totalMnt).toBe('11000');
    const returned = await env.reports.returnToCleaner(
      {
        hotelId: h.hotelId,
        reportId: first.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: first.revision,
        reason: 'Зочин колаг уугаагүй гэж байна',
      },
      h.reception,
      request(h.reception),
    );
    expect(returned.state).toBe('RETURNED');
    const second = await submit(returned, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 1 },
    ]);
    expect(second.versions).toHaveLength(2);
    expect(second.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(second.versions[0]?.totalMnt).toBe('11000');
    expect(currentVersion(second).totalMnt).toBe('6000');
    // The superseded version is immutable, whoever asks.
    await expect(
      env.admin.query(
        `UPDATE platform.minibar_usage_report_version SET total_mnt = 0 WHERE version_id = $1`,
        [second.versions[0]?.versionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 90000);

  it('a Manager’s exception version carries its reason and the same prices', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await startCheckout(stay);
    const exception = await env.reports.submitException(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: report.revision,
        counted: [
          { productId: waterId, quantity: 2 },
          { productId: colaId, quantity: 0 },
        ],
        noUsage: false,
        reason: 'Цэвэрлэгч ажилд гараагүй',
      },
      h.manager,
      request(h.manager),
    );
    const version = currentVersion(exception);
    expect(version.kind).toBe('EXCEPTION');
    expect(version.submittedRole).toBe('MANAGER');
    expect(version.reason).toBe('Цэвэрлэгч ажилд гараагүй');
    expect(version.totalMnt).toBe('5000');
  }, 60000);
});

describe('the guest’s dispute (CHK-DEC-006)', () => {
  it('holds the payment until a Manager decides, and a waiver reduces what is payable without editing the report', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 0 },
    ]);
    expect(submitted.payableMnt).toBe('11000');
    const flagged = await env.disputes.flag(
      {
        hotelId: h.hotelId,
        reportId: submitted.reportId,
        idempotencyKey: key('dp'),
        productId: colaId,
        disputedQuantity: 1,
        note: 'Зочин колаг уугаагүй гэж маргаж байна',
      },
      h.reception,
      request(h.reception),
    );
    const blocked = await refused(
      env.paymentLocks.lockForPayment(
        {
          hotelId: h.hotelId,
          reportId: flagged.reportId,
          idempotencyKey: key('pl'),
          expectedRevision: flagged.revision,
          attemptRef: `disputed-${stay.stayId}`,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(blocked.message).toContain('DISPUTE_OPEN');

    const dispute = flagged.disputes[0];
    if (dispute === undefined) throw new Error('no dispute');
    const decided = await env.disputes.resolve(
      {
        hotelId: h.hotelId,
        disputeId: dispute.disputeId,
        idempotencyKey: key('dp'),
        expectedRevision: dispute.revision,
        decision: 'WAIVED',
        reason: 'Менежер чөлөөлсөн',
      },
      h.manager,
      request(h.manager),
    );
    expect(decided.disputes[0]?.state).toBe('WAIVED');
    expect(decided.disputes[0]?.waivedAmountMnt).toBe('5000');
    // The version is untouched; only what is payable moved.
    expect(currentVersion(decided).totalMnt).toBe('11000');
    expect(decided.payableMnt).toBe('6000');
    const settled = await payAndSettle(decided, `waived-${stay.stayId}`);
    expect(settled.locks.find((l) => l.state === 'SETTLED')?.amountMnt).toBe('6000');
  }, 90000);
});

describe('the payment lock and what may release it (CHK-DEC-004)', () => {
  it('keeps the hold while the provider says pending or unknown, and releases only a confirmed failure', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 1 },
      { productId: colaId, quantity: 1 },
    ]);
    const ref = `pending-${stay.stayId}`;
    const locked = await env.paymentLocks.lockForPayment(
      {
        hotelId: h.hotelId,
        reportId: submitted.reportId,
        idempotencyKey: key('pl'),
        expectedRevision: submitted.revision,
        attemptRef: ref,
      },
      h.reception,
      request(h.reception),
    );
    expect(locked.state).toBe('LOCKED');
    let lock = locked.locks.find((l) => l.attemptRef === ref);
    if (lock === undefined) throw new Error('no lock');

    // A submitted version cannot be replaced while an attempt holds it.
    const held = await refused(
      submit({ ...locked, revision: locked.revision }, [{ productId: waterId, quantity: 2 }]),
    );
    expect(held.message).toContain('REPORT_NOT_OPEN');

    env.payments.set(ref, 'PENDING');
    const stillHeld = await env.paymentLocks.reconcile(
      {
        hotelId: h.hotelId,
        lockId: lock.lockId,
        idempotencyKey: key('pl'),
        expectedRevision: lock.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(stillHeld.state).toBe('LOCKED');
    expect(stillHeld.locks.find((l) => l.lockId === lock?.lockId)?.providerStatus).toBe('PENDING');

    lock = stillHeld.locks.find((l) => l.lockId === lock?.lockId);
    if (lock === undefined) throw new Error('no lock');
    env.payments.set(ref, 'UNKNOWN');
    const unknown = await env.paymentLocks.reconcile(
      {
        hotelId: h.hotelId,
        lockId: lock.lockId,
        idempotencyKey: key('pl'),
        expectedRevision: lock.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(unknown.state).toBe('LOCKED');

    lock = unknown.locks.find((l) => l.lockId === lock?.lockId);
    if (lock === undefined) throw new Error('no lock');
    env.payments.set(ref, 'FAILED_NO_FUNDS');
    const released = await env.paymentLocks.reconcile(
      {
        hotelId: h.hotelId,
        lockId: lock.lockId,
        idempotencyKey: key('pl'),
        expectedRevision: lock.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(released.state).toBe('SUBMITTED');
    expect(released.locks.find((l) => l.lockId === lock?.lockId)?.state).toBe('RELEASED');
    // With no money taken, the report is open to correction again.
    const corrected = await env.reports.returnToCleaner(
      {
        hotelId: h.hotelId,
        reportId: released.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: released.revision,
        reason: 'Дахин тоолуулах',
      },
      h.reception,
      request(h.reception),
    );
    expect(corrected.state).toBe('RETURNED');
  }, 120000);

  it('one version can back one successful charge, and the database says so too', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 1 },
      { productId: colaId, quantity: 1 },
    ]);
    const settled = await payAndSettle(submitted, `once-${stay.stayId}`);
    expect(settled.state).toBe('SETTLED');
    const versionId2 = settled.currentVersionId as string;
    const again = await refused(
      env.paymentLocks.lockForPayment(
        {
          hotelId: h.hotelId,
          reportId: settled.reportId,
          idempotencyKey: key('pl'),
          expectedRevision: settled.revision,
          attemptRef: `twice-${stay.stayId}`,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(again.message).toContain('REPORT_NOT_SUBMITTED');
    // Even bypassing the service, a second settled lock on the version is refused.
    await expect(
      env.admin.query(
        `INSERT INTO platform.minibar_payment_lock
           (hotel_id, report_id, version_id, attempt_ref, state, provider_status, amount_mnt,
            locked_by_account_id, resolved_at, resolved_by_account_id)
         VALUES ($1, $2, $3, 'bypass', 'SETTLED', 'SUCCEEDED', 1, gen_random_uuid(), now(),
                 gen_random_uuid())`,
        [h.hotelId, settled.reportId, versionId2],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  }, 90000);

  it('after a settlement only adjustments, priced from the original snapshot (CHK-DEC-005)', async () => {
    const stay = await checkIn(await stockedRoom());
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 1 },
    ]);
    const settled = await payAndSettle(submitted, `adjust-${stay.stayId}`);
    // The current price has moved on; the reversal uses the stay's own.
    const adjusted = await env.paymentLocks.adjust(
      {
        hotelId: h.hotelId,
        reportId: settled.reportId,
        idempotencyKey: key('adj'),
        kind: 'OVERCHARGE_REVERSAL',
        productId: waterId,
        quantity: 1,
        reason: 'Нэг ус илүү тооцсон',
      },
      h.manager,
      request(h.manager),
    );
    expect(adjusted.adjustments).toHaveLength(1);
    expect(adjusted.adjustments[0]).toMatchObject({
      kind: 'OVERCHARGE_REVERSAL',
      amountMnt: '3000',
    });
    // The settled report is immutable, whoever issues the statement.
    await expect(
      env.admin.query(
        `UPDATE platform.minibar_usage_report SET state = 'SUBMITTED' WHERE report_id = $1`,
        [settled.reportId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      env.admin.query(
        `UPDATE platform.minibar_report_adjustment SET amount_mnt = 1 WHERE report_id = $1`,
        [settled.reportId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 90000);
});

describe('the active-stay refill (doc 04 §5.1, PRICE-DEC-005)', () => {
  it('adds to what the guest can be charged for, and refuses the checkout while it is open', async () => {
    const roomId = await stockedRoom();
    const stay = await checkIn(roomId);
    const task = await env.refills.request(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('rf'),
        productId: waterId,
        quantity: 2,
      },
      h.reception,
      request(h.reception),
    );
    expect(task.state).toBe('PENDING');
    // doc 25 §6.1: the checkout cannot start over an unfinished refill.
    const blocked = await refused(
      env.checkouts.start(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('co'),
          expectedRevision: stay.revision,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(blocked.message).toContain('REFILL_TASK_OPEN');

    const claimed = await env.refills.claimTask(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('rf'),
        expectedRevision: task.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const completed = await env.refills.complete(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('rf'),
        expectedRevision: claimed.revision,
        confirmedQuantity: 1,
      },
      h.cleaner,
      request(h.cleaner),
    );
    expect(completed.state).toBe('COMPLETED');
    expect(completed.confirmedQuantity).toBe(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement
          WHERE stay_id = $1 AND movement_type = 'TRANSFER_TO_ROOM'`,
        [stay.stayId],
      ),
    ).toBe(1);

    // A Manager takes one out of the room against the stay: not the guest's.
    await env.minibar.products.recordCorrection(
      {
        hotelId: h.hotelId,
        productId: colaId,
        idempotencyKey: key('mb'),
        type: 'WASTE',
        quantity: 1,
        reason: 'Хугарсан',
        roomId,
        stayId: stay.stayId,
      },
      h.manager,
      request(h.manager),
    );

    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 0 },
    ]);
    const water = currentVersion(submitted).lines.find((l) => l.productId === waterId);
    const cola = currentVersion(submitted).lines.find((l) => l.productId === colaId);
    expect(water).toMatchObject({ openingQuantity: 2, refillQuantity: 1, billableQuantity: 3 });
    expect(cola).toMatchObject({
      openingQuantity: 1,
      nonGuestOutQuantity: 1,
      billableQuantity: 0,
      lineTotalMnt: '0',
    });
    expect(currentVersion(submitted).totalMnt).toBe('9000');
  }, 120000);
});

describe('the cleaning task (doc 04 §3, §5.2)', () => {
  it('is claimed by one Cleaner, refills the room to target and marks it clean', async () => {
    const roomId = await stockedRoom();
    const stay = await checkIn(roomId);
    const report = await claimReport(await startCheckout(stay));
    const submitted = await submit(report, [
      { productId: waterId, quantity: 0 },
      { productId: colaId, quantity: 0 },
    ]);
    await payAndSettle(submitted, `clean-${stay.stayId}`);
    const view = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.reception,
      request(h.reception),
    );
    await env.stays.recordActualCheckout(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('out'),
        expectedRevision: view.revision,
      },
      h.reception,
      request(h.reception),
    );
    const queue = await env.cleaningTasks.queue(
      { hotelId: h.hotelId },
      h.cleaner,
      request(h.cleaner),
    );
    const task = queue.find((candidate) => candidate.roomId === roomId);
    if (task === undefined) throw new Error('no cleaning task');
    const claimed = await env.cleaningTasks.claimTask(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('ct'),
        expectedRevision: task.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    expect(claimed.state).toBe('IN_PROGRESS');
    const cleaning = await env.housekeeping.view(
      { hotelId: h.hotelId, roomId },
      h.cleaner,
      request(h.cleaner),
    );
    expect(cleaning.state).toBe('CLEANING');

    // Above the target is refused; the room is refilled to it and marked clean.
    const tooMuch = await refused(
      env.cleaningTasks.complete(
        {
          hotelId: h.hotelId,
          taskId: task.taskId,
          idempotencyKey: key('ct'),
          expectedRevision: claimed.revision,
          refilled: [{ productId: waterId, quantity: 5 }],
        },
        h.cleaner,
        request(h.cleaner),
      ),
    );
    expect(tooMuch.message).toContain('REFILL_ABOVE_TARGET');
    const done = await env.cleaningTasks.complete(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('ct'),
        expectedRevision: claimed.revision,
        refilled: [
          { productId: waterId, quantity: 2 },
          { productId: colaId, quantity: 1 },
        ],
      },
      h.cleaner,
      request(h.cleaner),
    );
    expect(done.state).toBe('COMPLETED');
    const after = await env.housekeeping.view(
      { hotelId: h.hotelId, roomId },
      h.cleaner,
      request(h.cleaner),
    );
    expect(after.state).toBe('CLEAN');
    const configuration = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    expect(configuration.minibarStatus).toBe('FULL');
  }, 150000);
});

describe('the registries and the live schema', () => {
  it('the catalog and safe-point registries find the Phase 09 relations, with their columns', async () => {
    const relations = [
      ['platform.cleaning_task', 'room_id'],
      ['platform.minibar_usage_report', 'room_id'],
      ['platform.minibar_usage_report', 'stay_id'],
      ['platform.minibar_refill_task', 'room_id'],
      ['platform.minibar_refill_task', 'product_id'],
    ] as const;
    for (const [relation, column] of relations) {
      const [schema, table] = relation.split('.');
      const found = await env.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, table, column],
      );
      expect(found.rows[0]?.n, `${relation}.${column}`).toBe('1');
    }
  });
});
