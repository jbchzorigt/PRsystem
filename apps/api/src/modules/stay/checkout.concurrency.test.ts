import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHarness, StayHotel } from './test-support/stay-harness';
import { createStayHarness, key, request, syntheticGuest } from './test-support/stay-harness';
import type { ReportView } from './services/checkout-views';
import type { StayView } from './services/stay-views';

/**
 * Phase 09 concurrency, on real PostgreSQL — the build plan's gate and the
 * two money-shaped races beside it.
 *
 * Two Cleaners claiming one minibar inspection: one takes it. Two Receptions
 * starting a payment on one report: one attempt exists. Two reconciliations of
 * one successful attempt: one settlement, one consumption movement, one charge.
 */

let env: StayHarness;
let h: StayHotel;
let templateId: string;
let waterId: string;
let versionId: string;

beforeAll(async () => {
  env = await createStayHarness('checkout_concurrency');
  h = await env.hotel('Race Checkout', 'P25');
  await env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
    h.reception,
    request(h.reception),
  );
  templateId = await h.template('Race Template');
  waterId = (
    await env.minibar.products.createProduct(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('mb'),
        name: 'Ус',
        category: 'Ундаа',
        unit: 'ш',
        sellingPriceMnt: 3000n,
        purchaseCostMnt: 1000n,
        openingQuantity: 100,
        state: 'ACTIVE',
      },
      h.manager,
      request(h.manager),
    )
  ).productId;
  const draft = await env.minibar.versions.createDraft(
    {
      hotelId: h.hotelId,
      templateId,
      idempotencyKey: key('mb'),
      items: [{ productId: waterId, targetQuantity: 2 }],
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

async function settle<T>(
  work: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: error as ApiError };
  }
}

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

async function checkedInRoom(): Promise<StayView> {
  const roomId = await stockedRoom();
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

async function openReport(stay: StayView): Promise<ReportView> {
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
  return env.reports.view(
    { hotelId: h.hotelId, reportId: started.reportId as string },
    h.manager,
    request(h.manager),
  );
}

describe('two Cleaners, one inspection', () => {
  it('assigns the task to exactly one of them and refuses the others', async () => {
    const stay = await checkedInRoom();
    const report = await openReport(stay);
    const second = await env.actorFor(
      await env.seed(h.hotelId, `cleaner-2-${stay.stayId.slice(0, 8)}@race.test`, ['CLEANER']),
    );
    const third = await env.actorFor(
      await env.seed(h.hotelId, `cleaner-3-${stay.stayId.slice(0, 8)}@race.test`, ['CLEANER']),
    );
    const claim = (actor: typeof h.cleaner) =>
      env.reports.claimInspection(
        {
          hotelId: h.hotelId,
          reportId: report.reportId,
          idempotencyKey: key('rp'),
          expectedRevision: report.revision,
        },
        actor,
        request(actor),
      );
    const results = await Promise.all([
      settle(claim(h.cleaner)),
      settle(claim(second)),
      settle(claim(third)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const loser of results.filter((result) => !result.ok)) {
      if (!loser.ok) expect(loser.error.code).toBe('CONFLICT');
    }
    const claimed = await env.reports.view(
      { hotelId: h.hotelId, reportId: report.reportId },
      h.manager,
      request(h.manager),
    );
    expect(claimed.state).toBe('IN_INSPECTION');
    expect(claimed.revision).toBe(report.revision + 1);
  }, 120000);
});

describe('two Cleaners, one cleaning task', () => {
  it('one claims it; the other is refused and the room is cleaned once', async () => {
    const stay = await checkedInRoom();
    const report = await openReport(stay);
    const claimed = await env.reports.claimInspection(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: report.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const submitted = await env.reports.submit(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: claimed.revision,
        counted: [{ productId: waterId, quantity: 2 }],
        noUsage: false,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const ref = `race-clean-${stay.stayId}`;
    const locked = await env.paymentLocks.lockForPayment(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('pl'),
        expectedRevision: submitted.revision,
        attemptRef: ref,
      },
      h.reception,
      request(h.reception),
    );
    const lock = locked.locks.find((candidate) => candidate.attemptRef === ref);
    if (lock === undefined) throw new Error('no lock');
    env.payments.set(ref, 'SUCCEEDED', 0n);
    await env.paymentLocks.reconcile(
      {
        hotelId: h.hotelId,
        lockId: lock.lockId,
        idempotencyKey: key('pl'),
        expectedRevision: lock.revision,
      },
      h.reception,
      request(h.reception),
    );
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
    const task = queue.find((candidate) => candidate.roomId === view.roomId);
    if (task === undefined) throw new Error('no cleaning task');
    const other = await env.actorFor(
      await env.seed(h.hotelId, `cleaner-4-${stay.stayId.slice(0, 8)}@race.test`, ['CLEANER']),
    );
    const claim = (actor: typeof h.cleaner) =>
      env.cleaningTasks.claimTask(
        {
          hotelId: h.hotelId,
          taskId: task.taskId,
          idempotencyKey: key('ct'),
          expectedRevision: task.revision,
        },
        actor,
        request(actor),
      );
    const results = await Promise.all([settle(claim(h.cleaner)), settle(claim(other))]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cleaning_task
          WHERE room_id = $1 AND state = 'IN_PROGRESS'`,
        [view.roomId],
      ),
    ).toBe(1);
  }, 150000);
});

describe('two payment attempts on one report', () => {
  it('leaves one hold, and a settled version is never charged twice', async () => {
    const stay = await checkedInRoom();
    const report = await openReport(stay);
    const claimed = await env.reports.claimInspection(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: report.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const submitted = await env.reports.submit(
      {
        hotelId: h.hotelId,
        reportId: report.reportId,
        idempotencyKey: key('rp'),
        expectedRevision: claimed.revision,
        counted: [{ productId: waterId, quantity: 0 }],
        noUsage: false,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const lockWith = (ref: string) =>
      env.paymentLocks.lockForPayment(
        {
          hotelId: h.hotelId,
          reportId: report.reportId,
          idempotencyKey: key('pl'),
          expectedRevision: submitted.revision,
          attemptRef: ref,
        },
        h.reception,
        request(h.reception),
      );
    const attempts = await Promise.all([
      settle(lockWith(`a-${stay.stayId}`)),
      settle(lockWith(`b-${stay.stayId}`)),
    ]);
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.minibar_payment_lock
          WHERE report_id = $1 AND state = 'HELD'`,
        [report.reportId],
      ),
    ).toBe(1);

    const held = await env.reports.view(
      { hotelId: h.hotelId, reportId: report.reportId },
      h.manager,
      request(h.manager),
    );
    const lock = held.locks.find((candidate) => candidate.state === 'HELD');
    if (lock === undefined) throw new Error('no held lock');
    env.payments.set(lock.attemptRef, 'SUCCEEDED', BigInt(lock.amountMnt));
    const reconcile = () =>
      env.paymentLocks.reconcile(
        {
          hotelId: h.hotelId,
          lockId: lock.lockId,
          idempotencyKey: key('pl'),
          expectedRevision: lock.revision,
        },
        h.reception,
        request(h.reception),
      );
    const settlements = await Promise.all([settle(reconcile()), settle(reconcile())]);
    expect(settlements.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.minibar_payment_lock
          WHERE report_id = $1 AND state = 'SETTLED'`,
        [report.reportId],
      ),
    ).toBe(1);
    // The guest's consumption reached the ledger exactly once.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement
          WHERE stay_id = $1 AND movement_type = 'GUEST_CONSUMPTION'`,
        [stay.stayId],
      ),
    ).toBe(1);
  }, 150000);
});
