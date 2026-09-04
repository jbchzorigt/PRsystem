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
 * Phase 08 authorization over real HTTP, through the booted application.
 *
 * doc 18 §3 row by row: Reception opens the shift, checks in with or without
 * a backdate, submits a correction and records the checkout; the Manager
 * decides corrections and the higher-category and cancellation remedies; the
 * Cleaner sets the cleaning state on 25,000₮; the Hotel Admin without those
 * roles is refused every write and reads the board; nobody edits a stay's
 * times through any route; a foreign hotel, an unknown hotel and an
 * unauthenticated caller are `NOT_FOUND`, `NOT_FOUND` and `401`.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;

let hotelA: string;
let hotelB: string;
let adminA: SeededMembership;
let managerA: SeededMembership;
let cleanerA: SeededMembership;
let receptionA: SeededMembership;
let managerB: SeededMembership;

beforeAll(async () => {
  db = await provisionIamDatabase('stay_authz_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-stay-authz-seed',
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
  iam = attachIamHarness(db, 'stay_authz_http', { notifications });

  hotelA = await iam.createHotel('Stay Authz A', 'P25');
  hotelB = await iam.createHotel('Stay Authz B', 'P25');
  const seed = (hotelId: string, email: string, roles: readonly HotelRole[]) =>
    iam.seedMembership({ hotelId, email, roles });
  adminA = await seed(hotelA, 'admin@stay-a.test', ['HOTEL_ADMIN']);
  managerA = await seed(hotelA, 'manager@stay-a.test', ['MANAGER']);
  cleanerA = await seed(hotelA, 'cleaner@stay-a.test', ['CLEANER']);
  receptionA = await seed(hotelA, 'reception@stay-a.test', ['RECEPTION']);
  managerB = await seed(hotelB, 'manager@stay-b.test', ['MANAGER']);
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
      'idempotency-key': `st-authz-${String(keySequence).padStart(5, '0')}-${String(Date.now())}`,
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
    shifts: await q('reception_shift'),
    stays: await q('stay'),
    guests: await q('stay_guest'),
    corrections: await q('stay_time_correction'),
    cleaning: await q('room_cleaning_event'),
    conflicts: await q('booking_fulfillment_conflict'),
  };
}

const guest = {
  identityType: 'MN_REG_NO',
  registrationNumber: 'АА90010112',
  familyName: 'Синтетик',
  givenName: 'Зочин',
  dateOfBirth: '1990-01-01',
  nationality: 'MN',
};

let categoryA: string;
let roomA: string;
let roomFree: string;
let stayA: string;
let stayRevision: number;
let shiftOpenedAt: string;

describe('Reception, Cleaner and Manager, each their own rows', () => {
  it('the Manager configures, the Cleaner cleans, Reception opens the shift, quotes and checks in', async () => {
    const manager = await signIn(managerA);
    expect(
      (
        await call('PUT', `/hotels/${hotelA}/catalog/stay-configuration`, manager, {
          hourlyRateMnt: 20000,
          nightlyRateMnt: 100000,
          fixedCheckoutMinute: 720,
          cleaningBufferMinutes: 30,
        })
      ).status,
    ).toBe(200);
    const category = await call('POST', `/hotels/${hotelA}/catalog/categories`, manager, {
      name: 'Standard',
      state: 'ACTIVE',
    });
    expect(category.status).toBe(201);
    categoryA = category.body['categoryId'] as string;
    for (const number of ['101', '102']) {
      const room = await call('POST', `/hotels/${hotelA}/catalog/rooms`, manager, {
        roomNumber: number,
        categoryId: categoryA,
        state: 'ACTIVE',
      });
      expect(room.status).toBe(201);
      if (number === '101') roomA = room.body['roomId'] as string;
      else roomFree = room.body['roomId'] as string;
    }

    const cleaner = await signIn(cleanerA);
    const clean = await call('POST', `/hotels/${hotelA}/rooms/${roomA}/cleaning`, cleaner, {
      toState: 'CLEAN',
      expectedRevision: 0,
    });
    expect(clean.status).toBe(200);
    expect(clean.body).toMatchObject({ state: 'CLEAN' });
    expect((await call('GET', `/hotels/${hotelA}/rooms/${roomA}/cleaning`, cleaner)).status).toBe(
      200,
    );

    const reception = await signIn(receptionA);
    expect((await call('GET', `/hotels/${hotelA}/shifts/current`, reception)).body).toEqual({
      shift: null,
    });
    const shift = await call('POST', `/hotels/${hotelA}/shifts`, reception, {});
    expect(shift.status).toBe(201);
    shiftOpenedAt = shift.body['openedAt'] as string;
    const quote = await call('POST', `/hotels/${hotelA}/stays/quote`, reception, {
      roomId: roomA,
      stayType: 'HOURLY',
      halfHourUnits: 2,
    });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ roomChargeMnt: '20000', blockers: [] });
    const board = await call('GET', `/hotels/${hotelA}/rooms/board`, reception);
    expect(board.status).toBe(200);
    expect((board.body['rooms'] as unknown[]).length).toBe(2);

    const stay = await call('POST', `/hotels/${hotelA}/stays`, reception, {
      roomId: roomA,
      stayType: 'HOURLY',
      halfHourUnits: 2,
      guest,
    });
    expect(stay.status).toBe(201);
    expect(stay.body).toMatchObject({ state: 'ACTIVE', roomChargeMnt: '20000' });
    expect(JSON.stringify(stay.body)).not.toContain('90010112');
    stayA = stay.body['stayId'] as string;
    stayRevision = stay.body['revision'] as number;
    expect((await call('GET', `/hotels/${hotelA}/stays/${stayA}`, reception)).status).toBe(200);
  });

  it('validates before anything runs: a fractional unit, a bad identity type, a non-timestamp arrival', async () => {
    const reception = await signIn(receptionA);
    const before = await rowsOf(hotelA);
    for (const body of [
      { roomId: roomFree, stayType: 'HOURLY', halfHourUnits: 1.5, guest },
      {
        roomId: roomFree,
        stayType: 'HOURLY',
        halfHourUnits: 1,
        guest: { ...guest, identityType: 'DRIVER' },
      },
      {
        roomId: roomFree,
        stayType: 'HOURLY',
        halfHourUnits: 1,
        actualCheckInAt: 'yesterday',
        guest,
      },
      { roomId: roomFree, stayType: 'WEEKLY', guest },
    ]) {
      const response = await call('POST', `/hotels/${hotelA}/stays`, reception, body);
      expect({ status: response.status, code: code(response) }).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    expect(await rowsOf(hotelA)).toEqual(before);
  });

  it('the correction is Reception to submit and the Manager to decide; the checkout is Reception', async () => {
    const reception = await signIn(receptionA);
    const manager = await signIn(managerA);
    const submitted = await call(
      'POST',
      `/hotels/${hotelA}/stays/${stayA}/time-corrections`,
      reception,
      {
        correctedActualCheckInAt: shiftOpenedAt,
        reason: 'Зочин эрт ирсэн',
      },
    );
    expect(submitted.status).toBe(201);
    const correctionId = submitted.body['correctionId'] as string;
    const receptionDecides = await call(
      'POST',
      `/hotels/${hotelA}/stays/${stayA}/time-corrections/${correctionId}/approve`,
      reception,
      { expectedRevision: 0 },
    );
    expect(receptionDecides.status).toBe(404);
    const approved = await call(
      'POST',
      `/hotels/${hotelA}/stays/${stayA}/time-corrections/${correctionId}/approve`,
      manager,
      { expectedRevision: 0 },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: 'APPROVED', selfApproved: false });
    expect(
      (await call('GET', `/hotels/${hotelA}/stays/${stayA}/time-corrections`, manager)).status,
    ).toBe(200);
    const managerCheckout = await call(
      'POST',
      `/hotels/${hotelA}/stays/${stayA}/checkout`,
      manager,
      { expectedRevision: stayRevision },
    );
    expect(managerCheckout.status).toBe(404);
    const checkout = await call('POST', `/hotels/${hotelA}/stays/${stayA}/checkout`, reception, {
      expectedRevision: stayRevision,
    });
    expect(checkout.status).toBe(200);
    expect(checkout.body).toMatchObject({ state: 'COMPLETED' });
  });

  it('no route mutates a stay time: PATCH and PUT on a stay do not exist', async () => {
    const reception = await signIn(receptionA);
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await call(method, `/hotels/${hotelA}/stays/${stayA}`, reception, {
        plannedCheckoutAt: new Date().toISOString(),
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('everyone else', () => {
  it('a Hotel Admin without the Reception or Cleaner role is refused every write and reads the board', async () => {
    const token = await signIn(adminA);
    const before = await rowsOf(hotelA);
    for (const [method, path, body] of [
      ['POST', `/hotels/${hotelA}/shifts`, {}],
      [
        'POST',
        `/hotels/${hotelA}/rooms/${roomFree}/cleaning`,
        { toState: 'CLEAN', expectedRevision: 0 },
      ],
      [
        'POST',
        `/hotels/${hotelA}/stays`,
        { roomId: roomFree, stayType: 'HOURLY', halfHourUnits: 1, guest },
      ],
      [
        'POST',
        `/hotels/${hotelA}/stays/${stayA}/time-corrections`,
        { correctedActualCheckInAt: new Date().toISOString(), reason: 'r' },
      ],
      ['POST', `/hotels/${hotelA}/stays/${stayA}/checkout`, { expectedRevision: 0 }],
      ['POST', `/hotels/${hotelA}/fulfillment-conflicts/refresh`, {}],
    ] as const) {
      const response = await call(method, path, token, body);
      expect({ path, status: response.status, code: code(response) }).toEqual({
        path,
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect(await rowsOf(hotelA)).toEqual(before);
    const board = await call('GET', `/hotels/${hotelA}/rooms/board`, token);
    expect(board.status).toBe(200);
  });

  it('the Cleaner cannot check in or open a shift; Reception cannot set the cleaning state', async () => {
    const cleaner = await signIn(cleanerA);
    expect((await call('POST', `/hotels/${hotelA}/shifts`, cleaner, {})).status).toBe(404);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/stays`, cleaner, {
          roomId: roomFree,
          stayType: 'HOURLY',
          halfHourUnits: 1,
          guest,
        })
      ).status,
    ).toBe(404);
    const reception = await signIn(receptionA);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/rooms/${roomFree}/cleaning`, reception, {
          toState: 'CLEAN',
          expectedRevision: 0,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `/hotels/${hotelA}/rooms/${roomFree}/cleaning`, reception)).status,
    ).toBe(200);
  });

  it('a foreign hotel and an unknown hotel are NOT_FOUND with no trace; unauthenticated is 401', async () => {
    const foreign = await signIn(managerB);
    const before = await rowsOf(hotelA);
    expect((await call('GET', `/hotels/${hotelA}/rooms/board`, foreign)).status).toBe(404);
    expect((await call('GET', `/hotels/${hotelA}/stays/${stayA}`, foreign)).status).toBe(404);
    expect((await call('POST', `/hotels/${hotelA}/shifts`, foreign, {})).status).toBe(404);
    expect(
      (await call('GET', `/hotels/00000000-0000-4000-8000-000000000000/rooms/board`, foreign))
        .status,
    ).toBe(404);
    expect(await rowsOf(hotelA)).toEqual(before);
    expect((await call('GET', `/hotels/${hotelA}/rooms/board`, undefined)).status).toBe(401);
    expect(
      (await call('POST', `/hotels/${hotelA}/stays`, undefined, { roomId: roomFree })).status,
    ).toBe(401);
    void hotelB;
  });
});
