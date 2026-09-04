import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import type { DependencySource } from '../catalog/contracts/dependency-sources';
import { DEPENDENCY_SOURCES } from '../catalog/contracts/dependency-sources';
import { countRows } from '../catalog/test-support/catalog-harness';
import { SAFE_POINT_SOURCES, VERSION_STAY_SOURCE } from './contracts/safe-point-sources';
import type { ChangeView, TaskView } from './services/configuration.service';
import type { ProductView } from './services/product.service';
import type { VersionView } from './services/version.service';
import type { MinibarHarness, MinibarHotel } from './test-support/minibar-harness';
import { createMinibarHarness, key, request } from './test-support/minibar-harness';

/**
 * Phase 07 on real PostgreSQL, through the restricted API login.
 *
 * The ledger and the weighted average (`INV-DEC-001`…`005`), template versions
 * (`RML-DEC-015`…`021`), room configuration and reconciliation through the
 * Cleaner's bounded task (`RML-DEC-007`…`014`), the shortage override
 * (`INV-DEC-006`), single and multi-room Rollout (`RML-DEC-022`…`028`), the
 * hand-off to the catalog's lifecycle, and the tenant boundary.
 */

let env: MinibarHarness;
let hotel: MinibarHotel;

beforeAll(async () => {
  env = await createMinibarHarness('minibar_integration');
  hotel = await env.hotel('Minibar Hotel', 'P25');
}, 120000);

afterAll(async () => {
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

async function product(
  name: string,
  opening: number,
  price = 3000n,
  cost = 1000n,
): Promise<ProductView> {
  return env.products.createProduct(
    {
      hotelId: hotel.hotelId,
      idempotencyKey: key(),
      name,
      category: 'Ус',
      unit: 'ш',
      sellingPriceMnt: price,
      purchaseCostMnt: cost,
      openingQuantity: opening,
      state: 'ACTIVE',
    },
    hotel.manager,
    request(hotel.manager),
  );
}

async function publishedVersion(
  templateId: string,
  items: readonly { productId: string; targetQuantity: number }[],
): Promise<VersionView> {
  const draft = await env.versions.createDraft(
    { hotelId: hotel.hotelId, templateId, idempotencyKey: key(), items },
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
}

async function warehouse(productId: string): Promise<{ quantity: number; avg: string | null }> {
  const row = await env.admin.query<{ quantity: number; avg_cost_mnt: string | null }>(
    `SELECT quantity, avg_cost_mnt FROM platform.minibar_warehouse_stock WHERE product_id = $1`,
    [productId],
  );
  return { quantity: row.rows[0]?.quantity ?? 0, avg: row.rows[0]?.avg_cost_mnt ?? null };
}

async function roomStock(roomId: string): Promise<Record<string, number>> {
  const rows = await env.admin.query<{ product_id: string; quantity: number }>(
    `SELECT product_id, quantity FROM platform.room_minibar_stock WHERE room_id = $1 AND quantity > 0`,
    [roomId],
  );
  return Object.fromEntries(rows.rows.map((r) => [r.product_id, r.quantity]));
}

async function openTask(changeId: string): Promise<TaskView> {
  const change = await env.admin.query<{ room_id: string }>(
    `SELECT room_id FROM platform.room_configuration_change WHERE change_id = $1`,
    [changeId],
  );
  const view = await env.configurations.view(
    { hotelId: hotel.hotelId, roomId: change.rows[0]?.room_id as string },
    hotel.manager,
    request(hotel.manager),
  );
  if (view.openTask === null) throw new Error('no open task');
  return view.openTask;
}

async function claimAndComplete(
  taskId: string,
  counted: readonly { productId: string; quantity: number }[],
  transfers: readonly { productId: string; quantity: number }[],
): Promise<{ task: TaskView; change: ChangeView }> {
  const task = await env.admin.query<{ revision: number; state: string }>(
    `SELECT revision, state FROM platform.minibar_reconciliation_task WHERE task_id = $1`,
    [taskId],
  );
  let revision = task.rows[0]?.revision ?? 0;
  if (task.rows[0]?.state === 'OPEN') {
    const claimed = await env.configurations.claimTask(
      { hotelId: hotel.hotelId, taskId, idempotencyKey: key(), expectedRevision: revision },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    revision = claimed.revision;
  }
  return env.configurations.completeTask(
    {
      hotelId: hotel.hotelId,
      taskId,
      idempotencyKey: key(),
      expectedRevision: revision,
      counted,
      transfers,
    },
    hotel.cleaner,
    request(hotel.cleaner),
  );
}

/** Turn a room ON at a version: request, then the Cleaner fills it from the warehouse. */
async function turnOn(
  roomId: string,
  templateId: string,
  version: VersionView,
): Promise<ChangeView> {
  const change = await env.configurations.requestChange(
    {
      hotelId: hotel.hotelId,
      roomId,
      idempotencyKey: key(),
      kind: 'OFF_TO_ON',
      targetTemplateId: templateId,
      targetVersionId: version.versionId,
    },
    hotel.manager,
    request(hotel.manager),
  );
  const task = await openTask(change.changeId);
  const done = await claimAndComplete(
    task.taskId,
    [],
    task.bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity })),
  );
  return done.change;
}

describe('the ledger and the weighted average (INV-DEC-001…005)', () => {
  let water: ProductView;

  it('creates a product whose form quantity is the warehouse opening balance, as one OPENING movement', async () => {
    water = await product('Ус 0.5л', 10, 3000n, 1000n);
    expect(water).toMatchObject({
      warehouseQuantity: 10,
      avgCostMnt: '1000',
      sellingPriceMnt: '3000',
    });
    const movements = await env.products.ledger(
      { hotelId: hotel.hotelId, productId: water.productId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movementType: 'OPENING',
      location: 'WAREHOUSE',
      quantity: 10,
      unitCostMnt: '1000',
    });
  });

  it('reproduces doc 22 §5: 10 at 1,000 then 10 at 1,200 is 1,100, and the receipt states the new purchase cost', async () => {
    await env.products.receiveStock(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        quantity: 10,
        unitCostMnt: 1200n,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(await warehouse(water.productId)).toEqual({ quantity: 20, avg: '1100' });
    const listed = await env.products.listProducts(
      hotel.hotelId,
      hotel.manager,
      request(hotel.manager),
    );
    expect(listed.find((p) => p.productId === water.productId)).toMatchObject({
      purchaseCostMnt: '1200',
      avgCostMnt: '1100',
    });
  });

  it('a waste is costed at the average in force, carries its reason, and never re-costs later', async () => {
    const waste = await env.products.recordCorrection(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        type: 'WASTE',
        quantity: 2,
        reason: 'хугацаа дууссан',
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(waste).toMatchObject({
      movementType: 'WASTE',
      location: 'WAREHOUSE',
      quantity: 2,
      unitCostMnt: '1100',
      reason: 'хугацаа дууссан',
    });
    expect((await warehouse(water.productId)).quantity).toBe(18);
    await env.products.receiveStock(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        quantity: 2,
        unitCostMnt: 2000n,
      },
      hotel.manager,
      request(hotel.manager),
    );
    // (18 × 1100 + 2 × 2000) / 20 = 1190; the earlier waste still says 1100.
    expect((await warehouse(water.productId)).avg).toBe('1190');
    const again = await env.products.ledger(
      { hotelId: hotel.hotelId, productId: water.productId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(again.find((m) => m.movementId === waste.movementId)?.unitCostMnt).toBe('1100');
  });

  it('refuses a negative balance as INSUFFICIENT_STOCK and posts nothing', async () => {
    const before = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE product_id = $1`,
      [water.productId],
    );
    const error = await refused(
      env.products.recordCorrection(
        {
          hotelId: hotel.hotelId,
          productId: water.productId,
          idempotencyKey: key(),
          type: 'ADJUST_MINUS',
          quantity: 999,
          reason: 'тооллого',
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('INSUFFICIENT_STOCK');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE product_id = $1`,
        [water.productId],
      ),
    ).toBe(before);
    expect((await warehouse(water.productId)).quantity).toBe(20);
  });

  it('the balance is exactly what the ledger sums to, and nothing but the trigger can write it', async () => {
    const sum = await env.admin.query<{ n: string }>(
      `SELECT coalesce(sum(CASE movement_type WHEN 'OPENING' THEN quantity WHEN 'PURCHASE' THEN quantity
                                WHEN 'ADJUST_PLUS' THEN CASE WHEN location = 'WAREHOUSE' THEN quantity ELSE 0 END
                                WHEN 'RETURN_TO_WAREHOUSE' THEN quantity
                                WHEN 'TRANSFER_TO_ROOM' THEN -quantity
                                WHEN 'WASTE' THEN CASE WHEN location = 'WAREHOUSE' THEN -quantity ELSE 0 END
                                WHEN 'ADJUST_MINUS' THEN CASE WHEN location = 'WAREHOUSE' THEN -quantity ELSE 0 END
                                ELSE 0 END), 0)::text AS n
         FROM platform.inventory_movement WHERE product_id = $1`,
      [water.productId],
    );
    expect(Number(sum.rows[0]?.n)).toBe((await warehouse(water.productId)).quantity);
    const grants = await env.admin.query<{ privilege_type: string; grantee: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name IN ('minibar_warehouse_stock', 'room_minibar_stock')
          AND grantee IN ('prsystem_api', 'prsystem_worker')`,
    );
    expect(new Set(grants.rows.map((g) => g.privilege_type))).toEqual(new Set(['SELECT']));
    await expect(
      env.admin.query(`UPDATE platform.inventory_movement SET quantity = 1 WHERE product_id = $1`, [
        water.productId,
      ]),
    ).rejects.toThrow();
  });

  it('a selling-price edit is audited old → new and applies to later check-ins, not stock', async () => {
    const listed = await env.products.listProducts(
      hotel.hotelId,
      hotel.manager,
      request(hotel.manager),
    );
    const current = listed.find((p) => p.productId === water.productId) as ProductView;
    const updated = await env.products.updateProduct(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        expectedRevision: current.revision,
        sellingPriceMnt: 4000n,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(updated.sellingPriceMnt).toBe('4000');
    const audit = await env.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.platform_event WHERE action = 'minibar.product.price_change' AND target_ref = $1`,
      [water.productId],
    );
    expect(audit.rows[0]?.payload).toMatchObject({
      previousSellingPriceMnt: '3000',
      sellingPriceMnt: '4000',
    });
    expect((await warehouse(water.productId)).quantity).toBe(20);
  });
});

describe('template versions (RML-DEC-015…021)', () => {
  let templateId: string;
  let cola: ProductView;
  let beer: ProductView;
  let v1: VersionView;

  beforeAll(async () => {
    templateId = await hotel.template('Standard Minibar');
    cola = await product('Кола', 50);
    beer = await product('Шар айраг', 50);
  });

  it('refuses a publish with every failing rule named, and the draft stays a draft', async () => {
    const unpriced = await env.catalog.catalog.createMinibarEntity(
      {
        hotelId: hotel.hotelId,
        idempotencyKey: key(),
        kind: 'MINIBAR_PRODUCT',
        name: 'Unpriced',
        state: 'ACTIVE',
      },
      hotel.manager,
      request(hotel.manager),
    );
    const draft = await env.versions.createDraft(
      {
        hotelId: hotel.hotelId,
        templateId,
        idempotencyKey: key(),
        items: [{ productId: unpriced.entityId, targetQuantity: 1 }],
      },
      hotel.manager,
      request(hotel.manager),
    );
    const error = await refused(
      env.versions.publish(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: draft.versionId,
          idempotencyKey: key(),
          expectedRevision: draft.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual([
      expect.objectContaining({ field: unpriced.entityId, issue: 'PRODUCT_UNPRICED' }),
    ]);
    const versions = await env.versions.listVersions(
      { hotelId: hotel.hotelId, templateId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(versions.find((v) => v.versionId === draft.versionId)?.state).toBe('DRAFT');
    // The Phase 06 lifecycle refuses a retiring product too.
    const retired = await env.catalog.lifecycle.requestDeactivation(
      {
        hotelId: hotel.hotelId,
        kind: 'MINIBAR_PRODUCT',
        entityId: unpriced.entityId,
        idempotencyKey: key(),
        expectedRevision: 0,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(retired.state).toBe('INACTIVE');
    const again = await refused(
      env.versions.publish(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: draft.versionId,
          idempotencyKey: key(),
          expectedRevision: draft.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(again.details?.map((d) => d.issue)).toEqual(
      expect.arrayContaining(['PRODUCT_NOT_ACTIVE', 'PRODUCT_UNPRICED']),
    );
  });

  it('the first published version becomes the Default; a second does not move it; Set default is atomic', async () => {
    v1 = await publishedVersion(templateId, [{ productId: cola.productId, targetQuantity: 2 }]);
    expect(v1).toMatchObject({ state: 'PUBLISHED', isDefault: true, versionNo: 2 });
    const v2 = await publishedVersion(templateId, [
      { productId: cola.productId, targetQuantity: 2 },
      { productId: beer.productId, targetQuantity: 1 },
    ]);
    expect(v2).toMatchObject({ state: 'PUBLISHED', isDefault: false });
    const moved = await env.versions.setDefault(
      {
        hotelId: hotel.hotelId,
        templateId,
        versionId: v2.versionId,
        idempotencyKey: key(),
        expectedRevision: v2.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(moved.isDefault).toBe(true);
    const defaults = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM platform.minibar_template_version WHERE template_id = $1 AND is_default`,
      [templateId],
    );
    expect(defaults).toBe(1);
    // And the database refuses a second Default by index, whoever writes it.
    await expect(
      env.admin.query(
        `UPDATE platform.minibar_template_version SET is_default = true, revision = revision + 1 WHERE version_id = $1`,
        [v1.versionId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('publish and Set default create no room pointer, change, task, movement or blocker (RML-DEC-020)', async () => {
    const counts = async (): Promise<Record<string, number>> => ({
      changes: await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room_configuration_change WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
      tasks: await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.minibar_reconciliation_task WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
      movements: await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
      configurations: await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room_minibar_configuration WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    });
    const before = await counts();
    const v3 = await publishedVersion(templateId, [
      { productId: beer.productId, targetQuantity: 3 },
    ]);
    await env.versions.setDefault(
      {
        hotelId: hotel.hotelId,
        templateId,
        versionId: v3.versionId,
        idempotencyKey: key(),
        expectedRevision: v3.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(await counts()).toEqual(before);
  });

  it('a published version is immutable in the database; a draft is not', async () => {
    const item = await env.admin.query<{ item_id: string }>(
      `SELECT item_id FROM platform.minibar_template_version_item WHERE version_id = $1`,
      [v1.versionId],
    );
    await expect(
      env.admin.query(
        `UPDATE platform.minibar_template_version_item SET target_quantity = 9 WHERE item_id = $1`,
        [item.rows[0]?.item_id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const error = await refused(
      env.versions.replaceDraftItems(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: v1.versionId,
          idempotencyKey: key(),
          expectedRevision: v1.revision,
          items: [],
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(error.code).toBe('CONFLICT');
  });

  it('archive is blocked for the Default and for a version rooms are on; a never-published draft can be deleted', async () => {
    const versions = await env.versions.listVersions(
      { hotelId: hotel.hotelId, templateId },
      hotel.manager,
      request(hotel.manager),
    );
    const current = versions.find((v) => v.isDefault) as VersionView;
    const blocked = await refused(
      env.versions.archive(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: current.versionId,
          idempotencyKey: key(),
          expectedRevision: current.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(blocked.message).toContain('ARCHIVE_BLOCKED');
    expect(blocked.details?.map((d) => d.field)).toContain('default');

    const roomId = await hotel.room();
    const applied = await turnOn(roomId, templateId, v1);
    expect(applied.state).toBe('APPLIED');
    const onV1 = (
      await env.versions.listVersions(
        { hotelId: hotel.hotelId, templateId },
        hotel.manager,
        request(hotel.manager),
      )
    ).find((v) => v.versionId === v1.versionId) as VersionView;
    const inUse = await refused(
      env.versions.archive(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: v1.versionId,
          idempotencyKey: key(),
          expectedRevision: onV1.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(inUse.details?.map((d) => d.field)).toContain('rooms');

    const draft = await env.versions.createDraft(
      { hotelId: hotel.hotelId, templateId, idempotencyKey: key() },
      hotel.manager,
      request(hotel.manager),
    );
    const gone = await env.versions.deleteDraft(
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
    expect(gone.deleted).toBe(true);
  });
});

describe('room configuration and reconciliation (RML-DEC-007…014, INV-DEC-006, INV-DEC-007)', () => {
  let templateId: string;
  let water: ProductView;
  let cola: ProductView;
  let vA: VersionView;
  let vB: VersionView;

  beforeAll(async () => {
    templateId = await hotel.template('Premium Minibar');
    water = await product('Ус 1л', 6);
    cola = await product('Кола 0.33', 6);
    vA = await publishedVersion(templateId, [{ productId: water.productId, targetQuantity: 2 }]);
    vB = await publishedVersion(templateId, [
      { productId: water.productId, targetQuantity: 1 },
      { productId: cola.productId, targetQuantity: 2 },
    ]);
  });

  it('OFF → ON: the request goes READY on evidence, the task is bounded, the Cleaner fills, and the room is ON and FULL', async () => {
    const roomId = await hotel.room();
    const change = await env.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key(),
        kind: 'OFF_TO_ON',
        targetTemplateId: templateId,
        targetVersionId: vA.versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(change.state).toBe('READY_FOR_RECONCILIATION');
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(view.checkInBlockers).toEqual(['CONFIGURATION_CHANGE_PENDING']);
    expect(view.safePoint.every((f) => f.state === 'not_yet_provisioned')).toBe(true);
    const task = view.openTask as TaskView;
    expect(task.bounds).toEqual([
      { productId: water.productId, direction: 'TO_ROOM', maxQuantity: 2, targetQuantity: 2 },
    ]);

    const second = await refused(
      env.configurations.requestChange(
        { hotelId: hotel.hotelId, roomId, idempotencyKey: key(), kind: 'ON_TO_OFF' },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(second.message).toContain('pending');

    const out = await refused(
      claimAndComplete(task.taskId, [], [{ productId: water.productId, quantity: 3 }]),
    );
    expect(out.message).toContain('OUT_OF_BOUNDS');

    const done = await claimAndComplete(
      task.taskId,
      [],
      [{ productId: water.productId, quantity: 2 }],
    );
    expect(done.change.state).toBe('APPLIED');
    expect(done.task.state).toBe('COMPLETED');
    const after = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(after).toMatchObject({
      mode: 'ON',
      templateId,
      currentVersionId: vA.versionId,
      minibarStatus: 'FULL',
      checkInBlockers: [],
    });
    expect(await roomStock(roomId)).toEqual({ [water.productId]: 2 });
    expect((await warehouse(water.productId)).quantity).toBe(4);
    const movement = await env.admin.query<{ task_id: string; configuration_change_id: string }>(
      `SELECT task_id, configuration_change_id FROM platform.inventory_movement WHERE room_id = $1`,
      [roomId],
    );
    expect(movement.rows[0]).toEqual({
      task_id: task.taskId,
      configuration_change_id: change.changeId,
    });
  });

  it('A → B: the delta returns excess and refills the new product; a short warehouse blocks, a receipt and a resolve unblock', async () => {
    const roomId = await hotel.room();
    await turnOn(roomId, templateId, vA);
    // Drain cola so the target cannot be met.
    await env.products.recordCorrection(
      {
        hotelId: hotel.hotelId,
        productId: cola.productId,
        idempotencyKey: key(),
        type: 'WASTE',
        quantity: 6,
        reason: 'test drain',
      },
      hotel.manager,
      request(hotel.manager),
    );
    const change = await env.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key(),
        kind: 'VERSION_ROLLOUT',
        targetTemplateId: templateId,
        targetVersionId: vB.versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const task = await openTask(change.changeId);
    expect(task.bounds).toEqual(
      [
        {
          productId: water.productId,
          direction: 'TO_WAREHOUSE',
          maxQuantity: 1,
          targetQuantity: 1,
        },
        { productId: cola.productId, direction: 'TO_ROOM', maxQuantity: 2, targetQuantity: 2 },
      ].sort((a, b) => a.productId.localeCompare(b.productId)),
    );
    const first = await claimAndComplete(
      task.taskId,
      [{ productId: water.productId, quantity: 2 }],
      [{ productId: water.productId, quantity: 1 }],
    );
    expect(first.change.state).toBe('BLOCKED_STOCK');
    expect(await roomStock(roomId)).toEqual({ [water.productId]: 1 });

    const short = await refused(
      env.configurations.resolveChange(
        {
          hotelId: hotel.hotelId,
          changeId: change.changeId,
          idempotencyKey: key(),
          expectedRevision: first.change.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(short.message).toContain('STOCK_SHORT');

    await env.products.receiveStock(
      {
        hotelId: hotel.hotelId,
        productId: cola.productId,
        idempotencyKey: key(),
        quantity: 10,
        unitCostMnt: 900n,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const resumed = await env.configurations.resolveChange(
      {
        hotelId: hotel.hotelId,
        changeId: change.changeId,
        idempotencyKey: key(),
        expectedRevision: first.change.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(resumed.state).toBe('IN_PROGRESS');
    const again = await openTask(change.changeId);
    const done = await claimAndComplete(
      again.taskId,
      [{ productId: water.productId, quantity: 1 }],
      [{ productId: cola.productId, quantity: 2 }],
    );
    expect(done.change.state).toBe('APPLIED');
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(view).toMatchObject({ currentVersionId: vB.versionId, minibarStatus: 'FULL' });
    expect(await roomStock(roomId)).toEqual({ [water.productId]: 1, [cola.productId]: 2 });
  });

  it('a count variance blocks until the Manager records a reasoned correction against the change', async () => {
    const roomId = await hotel.room();
    await turnOn(roomId, templateId, vA);
    const change = await env.configurations.requestChange(
      { hotelId: hotel.hotelId, roomId, idempotencyKey: key(), kind: 'ON_TO_OFF' },
      hotel.manager,
      request(hotel.manager),
    );
    const task = await openTask(change.changeId);
    // The ledger says 2; the Cleaner finds 1.
    const blocked = await claimAndComplete(
      task.taskId,
      [{ productId: water.productId, quantity: 1 }],
      [],
    );
    expect(blocked.change.state).toBe('BLOCKED_VARIANCE');
    expect(blocked.change.blockerDetail).toMatchObject({
      variances: [{ productId: water.productId, held: 2, counted: 1 }],
    });
    const stuck = await refused(
      env.configurations.resolveChange(
        {
          hotelId: hotel.hotelId,
          changeId: change.changeId,
          idempotencyKey: key(),
          expectedRevision: blocked.change.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(stuck.message).toContain('VARIANCE_UNRESOLVED');
    await env.products.recordCorrection(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        type: 'WASTE',
        quantity: 1,
        reason: 'алга болсон',
        roomId,
        configurationChangeId: change.changeId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    const latest = view.pendingChange as ChangeView;
    const resumed = await env.configurations.resolveChange(
      {
        hotelId: hotel.hotelId,
        changeId: change.changeId,
        idempotencyKey: key(),
        expectedRevision: latest.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    // One water remains in the room and must still go back; the Cleaner continues.
    expect(resumed.state).toBe('IN_PROGRESS');
    const done = await claimAndComplete(
      task.taskId,
      [{ productId: water.productId, quantity: 1 }],
      [{ productId: water.productId, quantity: 1 }],
    );
    expect(done.change.state).toBe('APPLIED');
    const off = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(off).toMatchObject({
      mode: 'OFF',
      templateId: null,
      currentVersionId: null,
      minibarStatus: 'NOT_APPLICABLE',
    });
  });

  it('a shortage can be applied under an audited override as SHORT, which then clears the check-in blocker', async () => {
    const roomId = await hotel.room();
    await env.products.recordCorrection(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        type: 'WASTE',
        quantity: (await warehouse(water.productId)).quantity,
        reason: 'drain',
      },
      hotel.manager,
      request(hotel.manager),
    );
    const change = await env.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key(),
        kind: 'OFF_TO_ON',
        targetTemplateId: templateId,
        targetVersionId: vA.versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const task = await openTask(change.changeId);
    const blocked = await claimAndComplete(task.taskId, [], []);
    expect(blocked.change.state).toBe('BLOCKED_STOCK');
    const applied = await env.configurations.resolveChange(
      {
        hotelId: hotel.hotelId,
        changeId: change.changeId,
        idempotencyKey: key(),
        expectedRevision: blocked.change.revision,
        applyWithOverride: { reason: 'нөөц дутуу, зочин хүлээж байна' },
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(applied.state).toBe('APPLIED');
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(view).toMatchObject({ mode: 'ON', minibarStatus: 'SHORT', checkInBlockers: [] });
    expect(view.overrideId).not.toBeNull();
    const audit = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM audit.platform_event WHERE action = 'minibar.override.create' AND target_ref = $1`,
      [view.overrideId],
    );
    expect(audit).toBe(1);
    await env.products.receiveStock(
      {
        hotelId: hotel.hotelId,
        productId: water.productId,
        idempotencyKey: key(),
        quantity: 20,
        unitCostMnt: 1000n,
      },
      hotel.manager,
      request(hotel.manager),
    );
  });

  it('a change with posted movements is rolled back through a bounded task, never cancelled', async () => {
    const roomId = await hotel.room();
    await turnOn(roomId, templateId, vA);
    const change = await env.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key(),
        kind: 'VERSION_ROLLOUT',
        targetTemplateId: templateId,
        targetVersionId: vB.versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const task = await openTask(change.changeId);
    // Move only the cola in; leave the water excess where it is.
    const partial = await claimAndComplete(
      task.taskId,
      [{ productId: water.productId, quantity: 2 }],
      [{ productId: cola.productId, quantity: 2 }],
    );
    expect(partial.change.movementStarted).toBe(true);
    const cannot = await refused(
      env.configurations.cancelChange(
        {
          hotelId: hotel.hotelId,
          changeId: change.changeId,
          idempotencyKey: key(),
          expectedRevision: partial.change.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(cannot.message).toContain('MOVEMENT_STARTED');
    const rollback = await env.configurations.requestRollback(
      {
        hotelId: hotel.hotelId,
        changeId: change.changeId,
        idempotencyKey: key(),
        expectedRevision: partial.change.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(rollback.state).toBe('ROLLBACK_REQUIRED');
    const rollbackTask = await openTask(change.changeId);
    expect(rollbackTask.kind).toBe('ROLLBACK');
    expect(rollbackTask.bounds).toEqual([
      { productId: cola.productId, direction: 'TO_WAREHOUSE', maxQuantity: 2, targetQuantity: 0 },
    ]);
    const done = await claimAndComplete(
      rollbackTask.taskId,
      [],
      [{ productId: cola.productId, quantity: 2 }],
    );
    expect(done.change.state).toBe('ROLLED_BACK');
    expect(await roomStock(roomId)).toEqual({ [water.productId]: 2 });
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(view).toMatchObject({
      currentVersionId: vA.versionId,
      pendingChange: null,
      checkInBlockers: [],
    });
    // Both movements are in the ledger, immutable, linked to the change.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.inventory_movement WHERE configuration_change_id = $1`,
        [change.changeId],
      ),
    ).toBe(2);
  });

  it('a cancel before any movement is direct, and the database refuses a cancel after one', async () => {
    const roomId = await hotel.room();
    const change = await env.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key(),
        kind: 'OFF_TO_ON',
        targetTemplateId: templateId,
        targetVersionId: vA.versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const cancelled = await env.configurations.cancelChange(
      {
        hotelId: hotel.hotelId,
        changeId: change.changeId,
        idempotencyKey: key(),
        expectedRevision: change.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(cancelled.state).toBe('CANCELLED');
    expect(
      (
        await env.configurations.view(
          { hotelId: hotel.hotelId, roomId },
          hotel.manager,
          request(hotel.manager),
        )
      ).checkInBlockers,
    ).toEqual([]);
    // A rolled-back change is terminal: the database refuses to cancel it too.
    const rolledBack = await env.admin.query<{ change_id: string }>(
      `SELECT change_id FROM platform.room_configuration_change WHERE hotel_id = $1 AND movement_started AND state = 'ROLLED_BACK' LIMIT 1`,
      [hotel.hotelId],
    );
    expect(rolledBack.rowCount).toBe(1);
    await expect(
      env.admin.query(
        `UPDATE platform.room_configuration_change SET state = 'CANCELLED', revision = revision + 1 WHERE change_id = $1`,
        [rolledBack.rows[0]?.change_id],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    const moved = await env.admin.query<{ change_id: string }>(
      `SELECT change_id FROM platform.room_configuration_change WHERE hotel_id = $1 AND movement_started AND state = 'APPLIED' LIMIT 1`,
      [hotel.hotelId],
    );
    await expect(
      env.admin.query(
        `UPDATE platform.room_configuration_change SET state = 'CANCELLED', revision = revision + 1 WHERE change_id = $1`,
        [moved.rows[0]?.change_id],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('a retiring product blocks check-in as a configuration blocker, and ON → OFF completes a retiring room (doc 26 §2, §3.1)', async () => {
    const roomId = await hotel.room();
    await turnOn(roomId, templateId, vA);
    const listed = await env.products.listProducts(
      hotel.hotelId,
      hotel.manager,
      request(hotel.manager),
    );
    const w = listed.find((p) => p.productId === water.productId) as ProductView;
    const retiring = await env.catalog.lifecycle.requestDeactivation(
      {
        hotelId: hotel.hotelId,
        kind: 'MINIBAR_PRODUCT',
        entityId: water.productId,
        idempotencyKey: key(),
        expectedRevision: w.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(retiring.state).toBe('RETIRING');
    expect(retiring.blockers.map((b) => b.sourceId)).toEqual(
      expect.arrayContaining(['product.template_version_item', 'product.room_stock']),
    );
    const view = await env.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(view.checkInBlockers).toEqual(['PRODUCT_NOT_ACTIVE']);
    const reactivated = await env.catalog.lifecycle.cancelDeactivation(
      {
        hotelId: hotel.hotelId,
        kind: 'MINIBAR_PRODUCT',
        entityId: water.productId,
        idempotencyKey: key(),
        expectedRevision: retiring.revision,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(reactivated.state).toBe('ACTIVE');

    // The room retires: its minibar is a blocker; turning it off resolves it.
    const room = await env.catalog.lifecycle.requestDeactivation(
      {
        hotelId: hotel.hotelId,
        kind: 'ROOM',
        entityId: roomId,
        idempotencyKey: key(),
        expectedRevision: 0,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(room.state).toBe('RETIRING');
    expect(room.blockers.map((b) => b.sourceId)).toEqual(
      expect.arrayContaining(['room.minibar_configuration', 'room.minibar_stock']),
    );
    const off = await env.configurations.requestChange(
      { hotelId: hotel.hotelId, roomId, idempotencyKey: key(), kind: 'ON_TO_OFF' },
      hotel.manager,
      request(hotel.manager),
    );
    const task = await openTask(off.changeId);
    const done = await claimAndComplete(
      task.taskId,
      [{ productId: water.productId, quantity: 2 }],
      [{ productId: water.productId, quantity: 2 }],
    );
    expect(done.change.state).toBe('APPLIED');
    const finished = await env.catalog.lifecycle.view(
      { hotelId: hotel.hotelId, kind: 'ROOM', entityId: roomId },
      hotel.manager,
      request(hotel.manager),
    );
    expect(finished.state).toBe('INACTIVE');
    const history = await env.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.catalog_event WHERE entity_id = $1 AND event_type = 'DEACTIVATED'`,
      [roomId],
    );
    expect(history.rows[0]?.payload).toMatchObject({
      finalizedBy: 'system',
      trigger: 'minibar.configuration.applied',
    });
  });

  it('refuses a retiring room, a draft target and a foreign version as INELIGIBLE with the reason', async () => {
    const roomId = await hotel.room();
    const draft = await env.versions.createDraft(
      {
        hotelId: hotel.hotelId,
        templateId,
        idempotencyKey: key(),
        items: [{ productId: water.productId, targetQuantity: 1 }],
      },
      hotel.manager,
      request(hotel.manager),
    );
    const notPublished = await refused(
      env.configurations.requestChange(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key(),
          kind: 'OFF_TO_ON',
          targetTemplateId: templateId,
          targetVersionId: draft.versionId,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(notPublished.message).toContain('TARGET_NOT_PUBLISHED');
    const other = await env.hotel('Other Minibar Hotel', 'P25');
    const foreign = await refused(
      env.configurations.requestChange(
        {
          hotelId: other.hotelId,
          roomId: await other.room(),
          idempotencyKey: key(),
          kind: 'OFF_TO_ON',
          targetTemplateId: templateId,
          targetVersionId: vA.versionId,
        },
        other.manager,
        request(other.manager),
      ),
    );
    expect(foreign.code).toBe('NOT_FOUND');
    const across = await refused(
      env.configurations.view(
        { hotelId: hotel.hotelId, roomId },
        other.manager,
        request(other.manager),
      ),
    );
    expect(across.code).toBe('NOT_FOUND');
  });
});

describe('multi-room Rollout (RML-DEC-025…028)', () => {
  let templateId: string;
  let vA: VersionView;
  let vB: VersionView;
  let juice: ProductView;
  let onRooms: string[];
  let offRoom: string;

  beforeAll(async () => {
    templateId = await hotel.template('Batch Minibar');
    juice = await product('Жүүс', 100);
    vA = await publishedVersion(templateId, [{ productId: juice.productId, targetQuantity: 1 }]);
    vB = await publishedVersion(templateId, [{ productId: juice.productId, targetQuantity: 2 }]);
    onRooms = [await hotel.room(), await hotel.room()];
    for (const roomId of onRooms) await turnOn(roomId, templateId, vA);
    offRoom = await hotel.room();
  });

  it('preview classifies without writing; confirm accepts the eligible rooms and skips the rest with a reason', async () => {
    const preview = await env.rollouts.preview(
      {
        hotelId: hotel.hotelId,
        templateId,
        targetVersionId: vB.versionId,
        roomIds: [...onRooms, offRoom],
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(preview.map((r) => r.eligibility)).toEqual(['READY_NOW', 'READY_NOW', 'INELIGIBLE']);
    expect(preview[2]?.code).toBe('MINIBAR_OFF');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.rollout_batch WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).toBe(0);

    const idempotencyKey = key();
    const batch = await env.rollouts.confirm(
      {
        hotelId: hotel.hotelId,
        templateId,
        targetVersionId: vB.versionId,
        roomIds: [...onRooms, offRoom],
        idempotencyKey,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(batch.state).toBe('IN_PROGRESS');
    expect(batch.counts).toMatchObject({
      selected: 3,
      accepted: 2,
      SKIPPED: 1,
      READY_FOR_RECONCILIATION: 2,
    });
    const again = await env.rollouts.confirm(
      {
        hotelId: hotel.hotelId,
        templateId,
        targetVersionId: vB.versionId,
        roomIds: [...onRooms, offRoom],
        idempotencyKey,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(again.batchId).toBe(batch.batchId);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.rollout_batch WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).toBe(1);

    // The target is pinned: it cannot be archived while children are open.
    const vBNow = (
      await env.versions.listVersions(
        { hotelId: hotel.hotelId, templateId },
        hotel.manager,
        request(hotel.manager),
      )
    ).find((v) => v.versionId === vB.versionId) as VersionView;
    const archive = await refused(
      env.versions.archive(
        {
          hotelId: hotel.hotelId,
          templateId,
          versionId: vB.versionId,
          idempotencyKey: key(),
          expectedRevision: vBNow.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(archive.details?.map((d) => d.field)).toContain('pending');

    // One child applies, the other is cancelled by Cancel remaining.
    const first = batch.rooms.find((r) => r.roomId === onRooms[0])?.change as ChangeView;
    const task = await openTask(first.changeId);
    const done = await claimAndComplete(
      task.taskId,
      [{ productId: juice.productId, quantity: 1 }],
      task.bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity })),
    );
    expect(done.change.state).toBe('APPLIED');
    const cancelled = await env.rollouts.cancelRemaining(
      { hotelId: hotel.hotelId, batchId: batch.batchId, idempotencyKey: key() },
      hotel.manager,
      request(hotel.manager),
    );
    expect(cancelled.state).toBe('PARTIALLY_COMPLETED');
    expect(cancelled.counts).toMatchObject({ APPLIED: 1, CANCELLED: 1, SKIPPED: 1 });

    // Retry links to the source and re-checks eligibility: the applied room is now ALREADY_ON_TARGET.
    const retry = await env.rollouts.confirm(
      {
        hotelId: hotel.hotelId,
        templateId,
        targetVersionId: vB.versionId,
        roomIds: [...onRooms],
        idempotencyKey: key(),
        retryOfBatchId: batch.batchId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    expect(retry.retryOfBatchId).toBe(batch.batchId);
    expect(retry.rooms.map((r) => [r.result, r.reasonCode])).toEqual([
      ['SKIPPED', 'ALREADY_ON_TARGET'],
      ['ACCEPTED', null],
    ]);
  });

  it('every room in the batch is refused a second pending change while its child is open', async () => {
    const error = await refused(
      env.configurations.requestChange(
        {
          hotelId: hotel.hotelId,
          roomId: onRooms[1] as string,
          idempotencyKey: key(),
          kind: 'ON_TO_OFF',
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(error.message).toContain('pending');
  });
});

describe('the safe-point registry and the live schema', () => {
  it('names later-phase relations that do not exist yet, and would enforce their columns once they do', async () => {
    for (const source of [...SAFE_POINT_SOURCES, VERSION_STAY_SOURCE]) {
      const present = await env.admin.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [source.relation],
      );
      if (present.rows[0]?.present !== true) continue;
      const [schema, table] = source.relation.split('.');
      const column = await env.admin.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS present`,
        [schema, table, source.column],
      );
      expect({ id: source.id, column: column.rows[0]?.present }).toEqual({
        id: source.id,
        column: true,
      });
    }
  });

  it('the catalog registry now finds every Phase 07 relation it predicted, with its column', async () => {
    const phase07: DependencySource[] = DEPENDENCY_SOURCES.filter((s) => s.owningPhase === '07');
    expect(phase07.length).toBeGreaterThanOrEqual(8);
    for (const source of phase07) {
      const [schema, table] = source.relation.split('.');
      const column = await env.admin.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS present`,
        [schema, table, source.column],
      );
      expect({ id: source.id, column: column.rows[0]?.present }).toEqual({
        id: source.id,
        column: true,
      });
    }
  });
});
