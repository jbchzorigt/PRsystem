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
import { countRows } from './test-support/catalog-harness';

/**
 * Phase 06 authorization over real HTTP, through the booted application.
 *
 * The routes authenticate with `SessionGuard` and authorize nothing at the
 * edge: every handler resolves the live membership and scope grant for the
 * hotel in the path, then evaluates the named action inside the transaction.
 * doc 18 §3, row by row: the Manager holds the catalog and the tariffs; the
 * Hotel Admin holds none of them without the Manager role and reads the
 * lifecycle and the resolved tariff; Reception reads both as `.read` and
 * writes nothing; the minibar is refused on 20,000₮ whatever the role; a
 * foreign hotel, an unknown hotel and a stale session are the same `NOT_FOUND`.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;

let hotelA: string;
let hotelB: string;
let hotelSmall: string;
let adminA: SeededMembership;
let managerA: SeededMembership;
let managerPlusA: SeededMembership;
let receptionA: SeededMembership;
let cleanerA: SeededMembership;
let managerB: SeededMembership;
let managerSmall: SeededMembership;

const UNKNOWN_HOTEL = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

beforeAll(async () => {
  db = await provisionIamDatabase('catalog_authz_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-catalog-authz-seed',
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    REDIS_URL: 'redis://127.0.0.1:59998',
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_BUCKET: 'prsystem-local',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
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
  iam = attachIamHarness(db, 'catalog_authz_http', { notifications });

  hotelA = await iam.createHotel('Catalog Authz A', 'P30');
  hotelB = await iam.createHotel('Catalog Authz B', 'P30');
  hotelSmall = await iam.createHotel('Catalog Authz Small', 'P20');
  const seed = (hotelId: string, email: string, roles: readonly HotelRole[]) =>
    iam.seedMembership({ hotelId, email, roles });
  adminA = await seed(hotelA, 'admin@catalog-a.test', ['HOTEL_ADMIN']);
  managerA = await seed(hotelA, 'manager@catalog-a.test', ['MANAGER']);
  managerPlusA = await seed(hotelA, 'manager-plus@catalog-a.test', ['MANAGER_PLUS']);
  receptionA = await seed(hotelA, 'reception@catalog-a.test', ['RECEPTION']);
  cleanerA = await seed(hotelA, 'cleaner@catalog-a.test', ['CLEANER']);
  managerB = await seed(hotelB, 'manager@catalog-b.test', ['MANAGER']);
  managerSmall = await seed(hotelSmall, 'manager@catalog-small.test', ['MANAGER']);
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
      'idempotency-key': `authz-${String(keySequence).padStart(5, '0')}-${String(Date.now())}`,
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
    configuration: await q('hotel_stay_configuration'),
    categories: await q('room_category'),
    rooms: await q('room'),
    products: await q('minibar_product'),
    events: await q('catalog_event'),
  };
}

let categoryA: string;
let roomA: string;

describe('the Manager configures the catalog and the tariffs', () => {
  it('sets the configuration, creates a category and a room with overrides, reads the rate', async () => {
    const token = await signIn(managerA);
    const configured = await call('PUT', `/hotels/${hotelA}/catalog/stay-configuration`, token, {
      hourlyRateMnt: 20000,
      nightlyRateMnt: '100000',
      fixedCheckoutMinute: 720,
      cleaningBufferMinutes: 30,
    });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ hourlyRateMnt: '20000', configVersion: 2 });

    const category = await call('POST', `/hotels/${hotelA}/catalog/categories`, token, {
      name: 'Standard',
      nightlyRateMnt: 120000,
    });
    expect(category.status).toBe(201);
    categoryA = category.body['categoryId'] as string;

    const room = await call('POST', `/hotels/${hotelA}/catalog/rooms`, token, {
      roomNumber: '101',
      categoryId: categoryA,
      hourlyRateMnt: 25000,
    });
    expect(room.status).toBe(201);
    roomA = room.body['roomId'] as string;

    const rate = await call(
      'GET',
      `/hotels/${hotelA}/tariffs/effective?stayType=HOURLY&channel=WALK_IN&roomId=${roomA}`,
      token,
    );
    expect(rate.status).toBe(200);
    expect(rate.body).toMatchObject({ unitPriceMnt: '25000', sourceLevel: 'ROOM' });

    const listing = await call('GET', `/hotels/${hotelA}/catalog`, token);
    expect(listing.status).toBe(200);
    expect((listing.body['rooms'] as unknown[]).length).toBe(1);
  });

  it('a Manager Plus on 30,000₮ holds the same rows', async () => {
    const token = await signIn(managerPlusA);
    const category = await call('POST', `/hotels/${hotelA}/catalog/categories`, token, {
      name: 'Plus',
      hourlyRateMnt: 1,
    });
    expect(category.status).toBe(201);
    const product = await call('POST', `/hotels/${hotelA}/catalog/minibar-products`, token, {
      name: 'Water',
    });
    expect(product.status).toBe(201);
  });

  it('validates the payload before anything runs: a float amount, an unknown state, a bad kind', async () => {
    const token = await signIn(managerA);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/catalog/categories`, token, {
          name: 'Bad',
          nightlyRateMnt: 10.5,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/catalog/categories`, token, {
          name: 'Bad',
          state: 'RETIRING',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('GET', `/hotels/${hotelA}/catalog/things/${roomA}/lifecycle`, token)).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle/deactivation`,
          token,
          {
            expectedRevision: -1,
          },
        )
      ).status,
    ).toBe(400);
  });
});

describe('everyone else', () => {
  it('a Hotel Admin without the Manager role is refused every write and reads the state', async () => {
    const token = await signIn(adminA);
    const before = await rowsOf(hotelA);
    for (const [method, path, body] of [
      ['PUT', `/hotels/${hotelA}/catalog/stay-configuration`, { hourlyRateMnt: 1 }],
      ['POST', `/hotels/${hotelA}/catalog/categories`, { name: 'Denied' }],
      ['POST', `/hotels/${hotelA}/catalog/rooms`, { roomNumber: '999', categoryId: categoryA }],
      ['POST', `/hotels/${hotelA}/catalog/minibar-products`, { name: 'Denied' }],
      [
        'POST',
        `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle/deactivation`,
        { expectedRevision: 0 },
      ],
      [
        'POST',
        `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle/hard-delete`,
        { expectedRevision: 0 },
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

    const view = await call('GET', `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle`, token);
    expect(view.status).toBe(200);
    expect(view.body['state']).toBe('ACTIVE');
    const rate = await call(
      'GET',
      `/hotels/${hotelA}/tariffs/effective?stayType=NIGHTLY&channel=ONLINE&categoryId=${categoryA}`,
      token,
    );
    expect(rate.status).toBe(200);
    expect(rate.body).toMatchObject({ unitPriceMnt: '120000', sourceLevel: 'CATEGORY' });
    const denied = await countRows(
      iam.admin,
      `SELECT count(*)::text AS n FROM audit.platform_event
        WHERE actor_ref = $1 AND outcome = 'denied' AND action LIKE 'authz.hotel.%'`,
      [adminA.accountId],
    );
    expect(denied).toBe(6);
  });

  it('Reception reads the lifecycle and the rate and writes nothing; the Cleaner reads neither here', async () => {
    const reception = await signIn(receptionA);
    const view = await call('GET', `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle`, reception);
    expect(view.status).toBe(200);
    const rate = await call(
      'GET',
      `/hotels/${hotelA}/tariffs/effective?stayType=HOURLY&channel=WALK_IN&roomId=${roomA}`,
      reception,
    );
    expect(rate.status).toBe(200);
    const write = await call('PATCH', `/hotels/${hotelA}/catalog/rooms/${roomA}`, reception, {
      expectedRevision: 0,
      hourlyRateMnt: 1,
    });
    expect(write.status).toBe(404);
    const transition = await call(
      'POST',
      `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle/deactivation`,
      reception,
      { expectedRevision: 0 },
    );
    expect(transition.status).toBe(404);

    // The Cleaner's lifecycle_view is scoped to its own task (doc 18 §3), a
    // resource Phase 09 owns; with no task there is nothing it may read, and
    // the tariff row denies it outright.
    const cleaner = await signIn(cleanerA);
    expect(
      (
        await call(
          'GET',
          `/hotels/${hotelA}/tariffs/effective?stayType=HOURLY&channel=WALK_IN&roomId=${roomA}`,
          cleaner,
        )
      ).status,
    ).toBe(404);
  });

  it('a 20,000₮ hotel is refused the minibar, and nothing is written', async () => {
    const token = await signIn(managerSmall);
    const before = await rowsOf(hotelSmall);
    const product = await call('POST', `/hotels/${hotelSmall}/catalog/minibar-products`, token, {
      name: 'Juice',
    });
    // The same opaque denial as a missing role: stage 3 evaluates the named
    // permission with the effective package (doc 06 §5).
    expect({ status: product.status, code: code(product) }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(await rowsOf(hotelSmall)).toEqual(before);
    // The catalog itself is every package's.
    const category = await call('POST', `/hotels/${hotelSmall}/catalog/categories`, token, {
      name: 'Standard',
    });
    expect(category.status).toBe(201);
  });

  it('a foreign hotel, an unknown hotel and a stale scope are the same NOT_FOUND with no trace', async () => {
    const foreign = await signIn(managerB);
    const before = await rowsOf(hotelA);
    for (const [path, target] of [
      [`/hotels/${hotelA}/catalog`, hotelA],
      [`/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle`, hotelA],
      [`/hotels/${UNKNOWN_HOTEL}/catalog`, UNKNOWN_HOTEL],
    ] as const) {
      const response = await call('GET', path, foreign);
      expect({ target, status: response.status }).toEqual({ target, status: 404 });
    }
    const write = await call(
      'POST',
      `/hotels/${hotelA}/catalog/rooms/${roomA}/lifecycle/deactivation`,
      foreign,
      { expectedRevision: 0 },
    );
    expect(write.status).toBe(404);
    expect(await rowsOf(hotelA)).toEqual(before);

    const stale = await signIn(managerA);
    expect((await call('GET', `/hotels/${hotelA}/catalog`, stale)).status).toBe(200);
    await iam.admin.query(
      `UPDATE platform.staff_membership SET membership_revision = membership_revision + 1
        WHERE membership_id = $1`,
      [managerA.membershipId],
    );
    expect((await call('GET', `/hotels/${hotelA}/catalog`, stale)).status).toBe(404);
    expect(
      (await call('POST', `/hotels/${hotelA}/catalog/categories`, stale, { name: 'Stale' })).status,
    ).toBe(404);
  });

  it('an unauthenticated request is refused before any of it', async () => {
    expect((await call('GET', `/hotels/${hotelA}/catalog`, undefined)).status).toBe(401);
    expect(
      (await call('POST', `/hotels/${hotelA}/catalog/categories`, undefined, { name: 'X' })).status,
    ).toBe(401);
  });

  it('there is no route that captures a snapshot', async () => {
    const token = await signIn(managerB);
    for (const path of [
      `/hotels/${hotelB}/tariffs/snapshots`,
      `/hotels/${hotelB}/tariffs/snapshots/WALK_IN_STAY/${roomA}`,
    ]) {
      const response = await call('POST', path, token, { stayType: 'HOURLY', roomId: roomA });
      expect(response.status).toBe(404);
    }
  });
});
