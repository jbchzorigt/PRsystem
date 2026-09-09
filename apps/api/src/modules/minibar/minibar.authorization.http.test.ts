import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HotelRole } from '@prsystem/authz';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from '../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../iam/test-support/iam-harness';
import { SimulatedStaffNotification } from '../iam/contracts/staff-notification.port';
import { STAFF_NOTIFICATION } from '../iam/iam.tokens';
import { countRows } from '../catalog/test-support/catalog-harness';

/**
 * Phase 07 authorization over real HTTP, through the booted application.
 *
 * doc 18 §3 and doc 22 §10, row by row: the Manager on 25,000₮ holds the
 * product, cost, template, configuration and Rollout rows; the Cleaner holds
 * only its own task; Reception reads configuration and batches as `.read`;
 * the Hotel Admin holds none of the writes without the Manager role; the
 * Manager on 20,000₮ is refused every minibar action; a foreign hotel and an
 * unknown hotel are the same `NOT_FOUND` with no trace.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;

let hotelA: string;
let hotelSmall: string;
let hotelB: string;
let adminA: SeededMembership;
let managerA: SeededMembership;
let cleanerA: SeededMembership;
let receptionA: SeededMembership;
let managerSmall: SeededMembership;
let managerB: SeededMembership;

beforeAll(async () => {
  db = await provisionIamDatabase('minibar_authz_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-minibar-authz-seed',
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    REDIS_URL: 'redis://127.0.0.1:59998',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();
  const { createApp } = await import('../../bootstrap');
  const started = await createApp({ port: 0 });
  app = started.app;
  baseUrl = `http://127.0.0.1:${String(started.port)}`;
  const notifications = app.get<SimulatedStaffNotification>(STAFF_NOTIFICATION);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  iam = attachIamHarness(db, 'minibar_authz_http', { notifications });

  hotelA = await iam.createHotel('Minibar Authz A', 'P25');
  hotelSmall = await iam.createHotel('Minibar Authz Small', 'P20');
  hotelB = await iam.createHotel('Minibar Authz B', 'P25');
  const seed = (hotelId: string, email: string, roles: readonly HotelRole[]) =>
    iam.seedMembership({ hotelId, email, roles });
  adminA = await seed(hotelA, 'admin@minibar-a.test', ['HOTEL_ADMIN']);
  managerA = await seed(hotelA, 'manager@minibar-a.test', ['MANAGER']);
  cleanerA = await seed(hotelA, 'cleaner@minibar-a.test', ['CLEANER']);
  receptionA = await seed(hotelA, 'reception@minibar-a.test', ['RECEPTION']);
  managerSmall = await seed(hotelSmall, 'manager@minibar-small.test', ['MANAGER']);
  managerB = await seed(hotelB, 'manager@minibar-b.test', ['MANAGER']);
}, 120000);

afterAll(async () => {
  await app?.close();
  await iam?.close();
  resetEnvCache();
}, 30000);

async function signIn(member: SeededMembership): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email, password: member.password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

let keySequence = 0;
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  token: string | undefined,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  keySequence += 1;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'idempotency-key': `mb-authz-${String(keySequence).padStart(5, '0')}-${String(Date.now())}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function code(response: { body: Record<string, unknown> }): string | undefined {
  return (response.body['error'] as { code?: string } | undefined)?.code;
}

async function rowsOf(hotelId: string): Promise<Record<string, number>> {
  const q = (table: string): Promise<number> =>
    countRows(iam.admin, `SELECT count(*)::text AS n FROM platform.${table} WHERE hotel_id = $1`, [
      hotelId,
    ]);
  return {
    products: await q('minibar_product'),
    movements: await q('inventory_movement'),
    versions: await q('minibar_template_version'),
    changes: await q('room_configuration_change'),
    batches: await q('rollout_batch'),
    overrides: await q('minibar_shortage_override'),
  };
}

let categoryA: string;
let roomA: string;
let templateA: string;
let productA: string;
let versionA: string;
let changeA: string;
let taskA: string;

describe('the Manager builds the minibar and the Cleaner reconciles', () => {
  it('sets up a room, a product, a published version and a change; the Cleaner claims and completes the task', async () => {
    const manager = await signIn(managerA);
    await call('PUT', `/hotels/${hotelA}/catalog/stay-configuration`, manager, {
      hourlyRateMnt: 1,
      nightlyRateMnt: 1,
      fixedCheckoutMinute: 720,
      cleaningBufferMinutes: 30,
    });
    const category = await call('POST', `/hotels/${hotelA}/catalog/categories`, manager, {
      name: 'Std',
    });
    categoryA = category.body['categoryId'] as string;
    const room = await call('POST', `/hotels/${hotelA}/catalog/rooms`, manager, {
      roomNumber: '301',
      categoryId: categoryA,
    });
    roomA = room.body['roomId'] as string;
    const template = await call('POST', `/hotels/${hotelA}/catalog/minibar-templates`, manager, {
      name: 'Std Minibar',
    });
    templateA = template.body['entityId'] as string;

    const product = await call('POST', `/hotels/${hotelA}/minibar/products`, manager, {
      name: 'Ус',
      category: 'Ус',
      unit: 'ш',
      sellingPriceMnt: 3000,
      purchaseCostMnt: '1000',
      openingQuantity: 10,
    });
    expect(product.status).toBe(201);
    productA = product.body['productId'] as string;
    expect(product.body).toMatchObject({ warehouseQuantity: 10, avgCostMnt: '1000' });

    const receipt = await call(
      'POST',
      `/hotels/${hotelA}/minibar/products/${productA}/receipts`,
      manager,
      { quantity: 10, unitCostMnt: 1200 },
    );
    expect(receipt.status).toBe(201);
    const ledger = await call(
      'GET',
      `/hotels/${hotelA}/minibar/products/${productA}/ledger`,
      manager,
    );
    expect(ledger.status).toBe(200);
    expect((ledger.body as unknown as unknown[]).length).toBe(2);

    const draft = await call(
      'POST',
      `/hotels/${hotelA}/minibar/templates/${templateA}/versions`,
      manager,
      { items: [{ productId: productA, targetQuantity: 2 }] },
    );
    expect(draft.status).toBe(201);
    const published = await call(
      'POST',
      `/hotels/${hotelA}/minibar/templates/${templateA}/versions/${draft.body['versionId'] as string}/publish`,
      manager,
      { expectedRevision: draft.body['revision'] },
    );
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ state: 'PUBLISHED', isDefault: true });
    versionA = published.body['versionId'] as string;

    const change = await call(
      'POST',
      `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration/changes`,
      manager,
      { kind: 'OFF_TO_ON', targetTemplateId: templateA, targetVersionId: versionA },
    );
    expect(change.status).toBe(201);
    expect(change.body['state']).toBe('READY_FOR_RECONCILIATION');
    changeA = change.body['changeId'] as string;

    const cleaner = await signIn(cleanerA);
    const tasks = await call('GET', `/hotels/${hotelA}/minibar/tasks`, cleaner);
    expect(tasks.status).toBe(200);
    const task = (tasks.body as unknown as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(task['changeId']).toBe(changeA);
    taskA = task['taskId'] as string;
    const claimed = await call('POST', `/hotels/${hotelA}/minibar/tasks/${taskA}/claim`, cleaner, {
      expectedRevision: task['revision'],
    });
    expect(claimed.status).toBe(200);
    const completed = await call(
      'POST',
      `/hotels/${hotelA}/minibar/tasks/${taskA}/complete`,
      cleaner,
      {
        expectedRevision: claimed.body['revision'],
        counted: [],
        transfers: [{ productId: productA, quantity: 2 }],
      },
    );
    expect(completed.status).toBe(200);
    expect((completed.body['change'] as Record<string, unknown>)['state']).toBe('APPLIED');

    const view = await call(
      'GET',
      `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration`,
      manager,
    );
    expect(view.body).toMatchObject({ mode: 'ON', minibarStatus: 'FULL', checkInBlockers: [] });
  });

  it('validates before anything runs: a fractional price, an out-of-bounds transfer, a one-room batch', async () => {
    const manager = await signIn(managerA);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/minibar/products`, manager, {
          name: 'x',
          category: 'y',
          unit: 'z',
          sellingPriceMnt: 1.5,
          purchaseCostMnt: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/minibar/rollouts/preview`, manager, {
          templateId: templateA,
          targetVersionId: versionA,
          roomIds: [roomA],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/minibar/tasks/${taskA}/complete`,
          await signIn(cleanerA),
          { expectedRevision: 0, counted: [], transfers: [{ productId: productA, quantity: 0 }] },
        )
      ).status,
    ).toBe(400);
  });
});

describe('everyone else', () => {
  it('a Hotel Admin without the Manager role is refused every write and reads the configuration', async () => {
    const token = await signIn(adminA);
    const before = await rowsOf(hotelA);
    for (const [method, path, body] of [
      [
        'POST',
        `/hotels/${hotelA}/minibar/products`,
        { name: 'N', category: 'c', unit: 'u', sellingPriceMnt: 1, purchaseCostMnt: 1 },
      ],
      [
        'POST',
        `/hotels/${hotelA}/minibar/products/${productA}/receipts`,
        { quantity: 1, unitCostMnt: 1 },
      ],
      [
        'POST',
        `/hotels/${hotelA}/minibar/products/${productA}/corrections`,
        { type: 'WASTE', quantity: 1, reason: 'r' },
      ],
      ['POST', `/hotels/${hotelA}/minibar/templates/${templateA}/versions`, {}],
      [
        'POST',
        `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration/changes`,
        { kind: 'ON_TO_OFF' },
      ],
      ['POST', `/hotels/${hotelA}/minibar/rooms/${roomA}/shortage-overrides`, { reason: 'r' }],
      [
        'POST',
        `/hotels/${hotelA}/minibar/rollouts`,
        { templateId: templateA, targetVersionId: versionA, roomIds: [roomA, categoryA] },
      ],
    ] as const) {
      const response = await call(method, path, token, body);
      expect({ path, status: response.status, code: code(response) }).toEqual({
        path,
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect(await rowsOf(hotelA)).toEqual(before);
    const view = await call('GET', `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration`, token);
    expect(view.status).toBe(200);
  });

  it('Reception reads the configuration and writes nothing; the Cleaner cannot publish or request', async () => {
    const reception = await signIn(receptionA);
    expect(
      (await call('GET', `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration`, reception))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration/changes`,
          reception,
          { kind: 'ON_TO_OFF' },
        )
      ).status,
    ).toBe(404);
    expect((await call('GET', `/hotels/${hotelA}/minibar/products`, reception)).status).toBe(404);
    const cleaner = await signIn(cleanerA);
    expect(
      (await call('POST', `/hotels/${hotelA}/minibar/templates/${templateA}/versions`, cleaner, {}))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration/changes`,
          cleaner,
          { kind: 'ON_TO_OFF' },
        )
      ).status,
    ).toBe(404);
    // A Manager without the Cleaner role cannot execute a task (doc 18 §3).
    const manager = await signIn(managerA);
    expect((await call('GET', `/hotels/${hotelA}/minibar/tasks`, manager)).status).toBe(404);
  });

  it('a 20,000₮ hotel is refused every minibar action with the opaque denial', async () => {
    const token = await signIn(managerSmall);
    const before = await rowsOf(hotelSmall);
    for (const [method, path, body] of [
      ['GET', `/hotels/${hotelSmall}/minibar/products`, undefined],
      [
        'POST',
        `/hotels/${hotelSmall}/minibar/products`,
        { name: 'N', category: 'c', unit: 'u', sellingPriceMnt: 1, purchaseCostMnt: 1 },
      ],
      ['POST', `/hotels/${hotelSmall}/minibar/templates/${templateA}/versions`, {}],
    ] as const) {
      const response = await call(method, path, token, body);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    expect(await rowsOf(hotelSmall)).toEqual(before);
  });

  it('a foreign hotel and an unknown hotel are NOT_FOUND with no trace; unauthenticated is 401', async () => {
    const foreign = await signIn(managerB);
    const before = await rowsOf(hotelA);
    expect((await call('GET', `/hotels/${hotelA}/minibar/products`, foreign)).status).toBe(404);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/minibar/rooms/${roomA}/configuration/changes`,
          foreign,
          { kind: 'ON_TO_OFF' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelB}/minibar/rooms/${roomA}/configuration/changes`,
          foreign,
          { kind: 'ON_TO_OFF' },
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `/hotels/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/minibar/products`, foreign))
        .status,
    ).toBe(404);
    expect(await rowsOf(hotelA)).toEqual(before);
    expect((await call('GET', `/hotels/${hotelA}/minibar/products`, undefined)).status).toBe(401);
  });
});
