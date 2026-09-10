import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHarness, StayHotel } from './test-support/stay-harness';
import { createStayHarness, key, request, syntheticGuest } from './test-support/stay-harness';

/**
 * Phase 08 concurrency, on real PostgreSQL — the build plan's three gates.
 *
 * Two Receptions checking into one room: one stay, one `ROOM_OCCUPIED`. A
 * check-in racing an overdue-conflict resolution that assigns the same room:
 * never both. A check-in racing a configuration apply on the room: the stay
 * pins the version that was current when its transaction saw the room.
 */

let env: StayHarness;
let hotel: StayHotel;

beforeAll(async () => {
  env = await createStayHarness('stay_concurrency');
  hotel = await env.hotel('Race Stay', 'P25');
  await env.shifts.open(
    { hotelId: hotel.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
    hotel.reception,
    request(hotel.reception),
  );
}, 120000);

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

function checkIn(roomId: string, units = 1) {
  return env.checkIns.checkIn(
    {
      hotelId: hotel.hotelId,
      idempotencyKey: key('ci'),
      roomId,
      source: 'WALK_IN',
      stayType: 'HOURLY',
      halfHourUnits: units,
      guest: syntheticGuest(),
    },
    hotel.reception,
    request(hotel.reception),
  );
}

describe('two Receptions, one room', () => {
  it('confirms exactly one stay; the other is refused and writes nothing', async () => {
    const roomId = await hotel.cleanRoom();
    const results = await Promise.all([
      settle(checkIn(roomId)),
      settle(checkIn(roomId)),
      settle(checkIn(roomId)),
    ]);
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok)) {
      if (!loser.ok) expect(loser.error.message).toMatch(/ROOM_OCCUPIED/);
    }
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay_guest WHERE stay_id IN (SELECT stay_id FROM platform.stay WHERE room_id = $1)`,
        [roomId],
      ),
    ).toBe(1);
  });

  it('the same confirmation sent three times under one key is one stay, and the replay is the stored answer', async () => {
    const roomId = await hotel.cleanRoom();
    const idempotencyKey = key('ci');
    const command = () =>
      env.checkIns.checkIn(
        {
          hotelId: hotel.hotelId,
          idempotencyKey,
          roomId,
          source: 'WALK_IN',
          stayType: 'HOURLY',
          halfHourUnits: 1,
          guest: syntheticGuest(),
        },
        hotel.reception,
        request(hotel.reception),
      );
    const results = await Promise.all([settle(command()), settle(command()), settle(command())]);
    expect(results.some((r) => r.ok)).toBe(true);
    for (const r of results) if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    const replay = await command();
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(1);
    expect(replay.roomId).toBe(roomId);
  });
});

describe('a check-in racing an overdue-conflict resolution', () => {
  it('never lets a walk-in and an assignment both take the room', async () => {
    const roomA = await hotel.cleanRoom();
    const roomB = await hotel.cleanRoom();
    env.travel(0);
    const overdue = await checkIn(roomA, 1);
    env.travel(60);
    // Room B must not be eligible at detection, or no conflict opens: hold it with a stay, then free it.
    const holder = await checkIn(roomB, 1);
    const bookingRef = 'BKREF444444';
    env.bookings.add({
      bookingRef,
      categoryId: hotel.categoryId,
      assignedRoomId: roomA,
      plannedCheckInAt: new Date(env.now().getTime() + 10 * 60_000),
      plannedCheckoutAt: new Date(env.now().getTime() + 24 * 60 * 60_000),
      cleaningBufferMinutes: 30,
    });
    const opened = await env.conflicts.refresh(
      { hotelId: hotel.hotelId },
      hotel.reception,
      request(hotel.reception),
    );
    expect(opened.opened).toHaveLength(1);
    const conflict = opened.opened[0];
    if (conflict === undefined) throw new Error('no conflict');
    // Free room B: checkout, buffer, clean.
    await env.stays.recordActualCheckout(
      {
        hotelId: hotel.hotelId,
        stayId: holder.stayId,
        idempotencyKey: key('out'),
        expectedRevision: holder.revision,
      },
      hotel.reception,
      request(hotel.reception),
    );
    env.travel(100);
    const cleaning = await env.housekeeping.view(
      { hotelId: hotel.hotelId, roomId: roomB },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    await env.housekeeping.setState(
      {
        hotelId: hotel.hotelId,
        roomId: roomB,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: cleaning.revision,
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    const [assignment, walkIn] = await Promise.all([
      settle(
        env.conflicts.reassignSameCategory(
          {
            hotelId: hotel.hotelId,
            conflictId: conflict.conflictId,
            idempotencyKey: key('cf'),
            expectedRevision: conflict.revision,
            roomId: roomB,
          },
          hotel.reception,
          request(hotel.reception),
        ),
      ),
      settle(checkIn(roomB, 4)),
    ]);
    // Whichever committed first, the other saw it: an assignment refuses the
    // walk-in that would not fit before the booking, and a walk-in makes the
    // room ineligible for the assignment.
    expect([assignment.ok, walkIn.ok].filter(Boolean)).toHaveLength(1);
    if (!assignment.ok) expect(assignment.error.message).toMatch(/ROOM_NOT_ELIGIBLE/);
    if (!walkIn.ok) expect(walkIn.error.message).toMatch(/ASSIGNED_BOOKING_CONFLICT|ROOM_OCCUPIED/);
    void overdue;
    env.bookings.clear();
    env.travel(0);
  });
});

describe('a check-in racing a configuration apply', () => {
  it('pins the version that was current when the stay saw the room, and never a pending one', async () => {
    const templateId = await hotel.template('Race Template');
    const water = await env.minibar.products.createProduct(
      {
        hotelId: hotel.hotelId,
        idempotencyKey: key('mb'),
        name: 'Ус',
        category: 'Ундаа',
        unit: 'ш',
        sellingPriceMnt: 3000n,
        purchaseCostMnt: 1000n,
        openingQuantity: 50,
        state: 'ACTIVE',
      },
      hotel.manager,
      request(hotel.manager),
    );
    const publish = async (target: number) => {
      const draft = await env.minibar.versions.createDraft(
        {
          hotelId: hotel.hotelId,
          templateId,
          idempotencyKey: key('mb'),
          items: [{ productId: water.productId, targetQuantity: target }],
        },
        hotel.manager,
        request(hotel.manager),
      );
      return env.minibar.versions.publish(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: draft.versionId,
          idempotencyKey: key('mb'),
          expectedRevision: draft.revision,
        },
        hotel.manager,
        request(hotel.manager),
      );
    };
    const v1 = await publish(1);
    const v2 = await publish(2);
    const roomId = await hotel.cleanRoom();
    const readyTask = async (kind: 'OFF_TO_ON' | 'VERSION_ROLLOUT', versionId: string) => {
      await env.minibar.configurations.requestChange(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key('mb'),
          kind,
          targetTemplateId: templateId,
          targetVersionId: versionId,
        },
        hotel.manager,
        request(hotel.manager),
      );
      const view = await env.minibar.configurations.view(
        { hotelId: hotel.hotelId, roomId },
        hotel.manager,
        request(hotel.manager),
      );
      if (view.openTask === null) throw new Error('no task');
      const claimed = await env.minibar.configurations.claimTask(
        {
          hotelId: hotel.hotelId,
          taskId: view.openTask.taskId,
          idempotencyKey: key('mb'),
          expectedRevision: view.openTask.revision,
        },
        hotel.cleaner,
        request(hotel.cleaner),
      );
      return { task: claimed, bounds: view.openTask.bounds };
    };
    const complete = (
      task: { taskId: string; revision: number },
      bounds: readonly { productId: string; maxQuantity: number }[],
      counted: readonly { productId: string; quantity: number }[],
    ) =>
      env.minibar.configurations.completeTask(
        {
          hotelId: hotel.hotelId,
          taskId: task.taskId,
          idempotencyKey: key('mb'),
          expectedRevision: task.revision,
          counted,
          transfers: bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity })),
        },
        hotel.cleaner,
        request(hotel.cleaner),
      );
    const on = await readyTask('OFF_TO_ON', v1.versionId);
    await complete(on.task, on.bounds, []);
    // A rollout to v2 is pending: its task is claimed but not completed.
    const rollout = await readyTask('VERSION_ROLLOUT', v2.versionId);
    const [applied, stay] = await Promise.all([
      settle(complete(rollout.task, rollout.bounds, [{ productId: water.productId, quantity: 1 }])),
      settle(checkIn(roomId, 1)),
    ]);
    // The apply always completes; the check-in either saw the pending change
    // and was refused, or ran after the apply and pinned v2. It never pins v1
    // under a pending change.
    expect(applied.ok).toBe(true);
    if (stay.ok) {
      expect(stay.value.priceBook?.versionId).toBe(v2.versionId);
    } else {
      expect(stay.error.message).toMatch(/CONFIGURATION_CHANGE_PENDING/);
    }
    const books = await env.admin.query<{ version_id: string }>(
      `SELECT version_id FROM platform.stay_minibar_snapshot WHERE room_id = $1`,
      [roomId],
    );
    for (const row of books.rows) expect(row.version_id).toBe(v2.versionId);
  });
});
