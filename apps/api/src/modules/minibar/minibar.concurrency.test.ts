import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { ProductView } from './services/product.service';
import type { VersionView } from './services/version.service';
import type { MinibarHarness, MinibarHotel } from './test-support/minibar-harness';
import { createMinibarHarness, key, request } from './test-support/minibar-harness';

/**
 * Phase 07 concurrency, on real PostgreSQL — the build plan's four gates.
 *
 * Parallel refills against a scarce warehouse never go negative and never
 * over-transfer; a retried transfer posts once; a duplicate Confirm under one
 * key creates one batch; two Rollouts on one room violate the one-pending
 * invariant exactly once.
 */

let env: MinibarHarness;
let hotel: MinibarHotel;
let templateId: string;
let juice: ProductView;
let v1: VersionView;
let v2: VersionView;

beforeAll(async () => {
  env = await createMinibarHarness('minibar_concurrency');
  hotel = await env.hotel('Race Minibar', 'P30');
  templateId = await hotel.template();
  juice = await env.products.createProduct(
    {
      hotelId: hotel.hotelId,
      idempotencyKey: key(),
      name: 'Жүүс',
      category: 'Ундаа',
      unit: 'ш',
      sellingPriceMnt: 5000n,
      purchaseCostMnt: 2000n,
      openingQuantity: 3,
      state: 'ACTIVE',
    },
    hotel.manager,
    request(hotel.manager),
  );
  const publish = async (target: number): Promise<VersionView> => {
    const draft = await env.versions.createDraft(
      {
        hotelId: hotel.hotelId,
        templateId,
        idempotencyKey: key(),
        items: [{ productId: juice.productId, targetQuantity: target }],
      },
      hotel.manager,
      request(hotel.manager),
    );
    return env.versions.publish(
      {
        hotelId: hotel.hotelId,
        templateId,
        versionId: draft.versionId,
        idempotencyKey: key(),
        expectedRevision: draft.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
  };
  v1 = await publish(2);
  v2 = await publish(3);
}, 120000);

afterAll(async () => {
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

async function readyTask(
  roomId: string,
  version: VersionView,
  kind: 'OFF_TO_ON' | 'VERSION_ROLLOUT' = 'OFF_TO_ON',
) {
  await env.configurations.requestChange(
    {
      hotelId: hotel.hotelId,
      roomId,
      idempotencyKey: key(),
      kind,
      targetTemplateId: templateId,
      targetVersionId: version.versionId,
    },
    hotel.manager,
    request(hotel.manager),
  );
  const view = await env.configurations.view(
    { hotelId: hotel.hotelId, roomId },
    hotel.manager,
    request(hotel.manager),
  );
  if (view.openTask === null) throw new Error('no task');
  const claimed = await env.configurations.claimTask(
    {
      hotelId: hotel.hotelId,
      taskId: view.openTask.taskId,
      idempotencyKey: key(),
      expectedRevision: view.openTask.revision,
    },
    hotel.cleaner,
    request(hotel.cleaner),
  );
  return claimed;
}

async function warehouse(): Promise<number> {
  const row = await env.admin.query<{ quantity: number }>(
    `SELECT quantity FROM platform.minibar_warehouse_stock WHERE product_id = $1`,
    [juice.productId],
  );
  return row.rows[0]?.quantity ?? 0;
}

describe('parallel refills against a scarce warehouse', () => {
  it('never go negative and never over-transfer: three units, two rooms wanting two each', async () => {
    const rooms = [await hotel.room(), await hotel.room()];
    const tasks = [
      await readyTask(rooms[0] as string, v1),
      await readyTask(rooms[1] as string, v1),
    ];
    const results = await Promise.all(
      tasks.map((task) =>
        settle(
          env.configurations.completeTask(
            {
              hotelId: hotel.hotelId,
              taskId: task.taskId,
              idempotencyKey: key(),
              expectedRevision: task.revision,
              counted: [],
              transfers: [{ productId: juice.productId, quantity: 2 }],
            },
            hotel.cleaner,
            request(hotel.cleaner),
          ),
        ),
      ),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]?.ok) expect(losers[0]?.error.message).toContain('INSUFFICIENT_STOCK');
    expect(await warehouse()).toBe(1);
    const inRooms = await countRows(
      env.admin,
      `SELECT coalesce(sum(quantity), 0)::text AS n FROM platform.room_minibar_stock WHERE product_id = $1`,
      [juice.productId],
    );
    expect(inRooms).toBe(2);
    // Nothing was posted for the loser: the ledger holds exactly one transfer.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE product_id = $1 AND movement_type = 'TRANSFER_TO_ROOM'`,
        [juice.productId],
      ),
    ).toBe(1);
    await env.products.receiveStock(
      {
        hotelId: hotel.hotelId,
        productId: juice.productId,
        idempotencyKey: key(),
        quantity: 20,
        unitCostMnt: 2000n,
      },
      hotel.manager,
      request(hotel.manager),
    );
  });
});

describe('a retried transfer posts once', () => {
  it('the same completion sent three times at once moves the quantity one time', async () => {
    const roomId = await hotel.room();
    const task = await readyTask(roomId, v1);
    const idempotencyKey = key();
    const before = await warehouse();
    const command = () =>
      env.configurations.completeTask(
        {
          hotelId: hotel.hotelId,
          taskId: task.taskId,
          idempotencyKey,
          expectedRevision: task.revision,
          counted: [],
          transfers: [{ productId: juice.productId, quantity: 2 }],
        },
        hotel.cleaner,
        request(hotel.cleaner),
      );
    const results = await Promise.all([settle(command()), settle(command()), settle(command())]);
    for (const result of results) {
      if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    }
    expect(results.some((r) => r.ok)).toBe(true);
    expect(await warehouse()).toBe(before - 2);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(1);
    // A later replay under the same key returns the stored answer and moves nothing.
    const replay = await command();
    expect(replay.change.state).toBe('APPLIED');
    expect(await warehouse()).toBe(before - 2);
    // A fresh key for the same transfer is refused by the bound the first posting consumed.
    const again = await settle(
      env.configurations.completeTask(
        {
          hotelId: hotel.hotelId,
          taskId: task.taskId,
          idempotencyKey: key(),
          expectedRevision: task.revision,
          counted: [],
          transfers: [{ productId: juice.productId, quantity: 2 }],
        },
        hotel.cleaner,
        request(hotel.cleaner),
      ),
    );
    expect(again.ok).toBe(false);
    expect(await warehouse()).toBe(before - 2);
  });
});

describe('duplicate Confirm with one idempotency key', () => {
  it('creates one batch and one child per room', async () => {
    const rooms = [await hotel.room(), await hotel.room()];
    for (const roomId of rooms) {
      const task = await readyTask(roomId, v1);
      await env.configurations.completeTask(
        {
          hotelId: hotel.hotelId,
          taskId: task.taskId,
          idempotencyKey: key(),
          expectedRevision: task.revision,
          counted: [],
          transfers: [{ productId: juice.productId, quantity: 2 }],
        },
        hotel.cleaner,
        request(hotel.cleaner),
      );
    }
    const idempotencyKey = key();
    const confirm = () =>
      env.rollouts.confirm(
        {
          hotelId: hotel.hotelId,
          templateId,
          targetVersionId: v2.versionId,
          roomIds: rooms,
          idempotencyKey,
        },
        hotel.manager,
        request(hotel.manager),
      );
    const results = await Promise.all([settle(confirm()), settle(confirm()), settle(confirm())]);
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ok.map((r) => (r.ok ? r.value.batchId : '')));
    expect(ids.size).toBe(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.rollout_batch WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room_configuration_change WHERE hotel_id = $1 AND batch_id IS NOT NULL`,
        [hotel.hotelId],
      ),
    ).toBe(2);
  });
});

describe('two Rollouts on one room', () => {
  it('violate the one-pending invariant exactly once, whichever wins', async () => {
    const roomId = await hotel.room();
    const task = await readyTask(roomId, v1);
    await env.configurations.completeTask(
      {
        hotelId: hotel.hotelId,
        taskId: task.taskId,
        idempotencyKey: key(),
        expectedRevision: task.revision,
        counted: [],
        transfers: [{ productId: juice.productId, quantity: 2 }],
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    const rollout = () =>
      env.configurations.requestChange(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key(),
          kind: 'VERSION_ROLLOUT',
          targetTemplateId: templateId,
          targetVersionId: v2.versionId,
        },
        hotel.manager,
        request(hotel.manager),
      );
    const [a, b] = await Promise.all([settle(rollout()), settle(rollout())]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    if (loser !== undefined && !loser.ok) expect(loser.error.code).toBe('CONFLICT');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room_configuration_change WHERE room_id = $1 AND state <> ALL (ARRAY['APPLIED','CANCELLED','ROLLED_BACK'])`,
        [roomId],
      ),
    ).toBe(1);
    // And the database index would refuse a second pending row even if the service did not.
    await expect(
      env.admin.query(
        `INSERT INTO platform.room_configuration_change (hotel_id, room_id, kind, state) VALUES ($1, $2, 'ON_TO_OFF', 'READY_FOR_RECONCILIATION')`,
        [hotel.hotelId, roomId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
