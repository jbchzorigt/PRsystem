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

/**
 * Phase 10: the room charge is posted and paid, and the bill closed, which is
 * what the actual checkout now waits for.
 */
async function settleFolio(stayId: string, token: string): Promise<void> {
  const charged = await call('POST', `/hotels/${hotelA}/stays/${stayId}/folio/charges`, token, {});
  expect(charged.status).toBe(200);
  const balance = charged.body['balanceMnt'] as string;
  if (balance !== '0') {
    const shift = await call('GET', `/hotels/${hotelA}/shifts/current`, token);
    const shiftId = (shift.body['shift'] as { shiftId: string } | null)?.shiftId;
    const paid = await call('POST', `/hotels/${hotelA}/stays/${stayId}/folio/payments`, token, {
      channel: 'CASH',
      amountMnt: Number(balance),
      shiftId,
    });
    expect(paid.status).toBe(201);
  }
  const view = await call('GET', `/hotels/${hotelA}/stays/${stayId}/folio`, token);
  const settled = await call('POST', `/hotels/${hotelA}/stays/${stayId}/folio/settle`, token, {
    expectedRevision: view.body['revision'],
  });
  expect(settled.status).toBe(200);
}

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
    // Phase 10: a walk-in checks in against a configured deposit, so the
    // Manager configures one before any check-in is possible (`DEP-DEC-001`).
    expect(
      (
        await call('PUT', `/hotels/${hotelA}/deposit-configuration`, manager, {
          amountMnt: 50000,
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
    // Phase 10: the stay completes once its bill is settled (`RC-DEC-001`).
    const open = await call('POST', `/hotels/${hotelA}/stays/${stayA}/checkout`, reception, {
      expectedRevision: stayRevision,
    });
    expect(open.status).toBe(412);
    expect(open.body['error']).toMatchObject({ code: 'PRECONDITION_FAILED' });
    await settleFolio(stayA, reception);
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

describe('the checkout, the report and the Cleaner’s queue (Phase 09, doc 18 §3)', () => {
  let stayFree: string;
  let stayFreeRevision: number;

  it('Reception starts the checkout of a minibar-disabled room and no report is opened', async () => {
    const reception = await signIn(receptionA);
    const cleaner = await signIn(cleanerA);
    // The room must be clean at the arrival: the Cleaner marks it.
    const cleaning = await call('GET', `/hotels/${hotelA}/rooms/${roomFree}/cleaning`, cleaner);
    expect(cleaning.status).toBe(200);
    const marked = await call('POST', `/hotels/${hotelA}/rooms/${roomFree}/cleaning`, cleaner, {
      toState: 'CLEAN',
      expectedRevision: cleaning.body['revision'] as number,
    });
    expect(marked.status).toBe(200);
    const checkIn = await call('POST', `/hotels/${hotelA}/stays`, reception, {
      roomId: roomFree,
      stayType: 'HOURLY',
      halfHourUnits: 2,
      guest,
    });
    expect(checkIn.status).toBe(201);
    stayFree = checkIn.body['stayId'] as string;
    stayFreeRevision = checkIn.body['revision'] as number;

    const admin = await signIn(adminA);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/stays/${stayFree}/checkout/start`, admin, {
          expectedRevision: stayFreeRevision,
        })
      ).status,
    ).toBe(404);
    const started = await call(
      'POST',
      `/hotels/${hotelA}/stays/${stayFree}/checkout/start`,
      reception,
      { expectedRevision: stayFreeRevision },
    );
    expect(started.status).toBe(200);
    // `CHK-DEC-001`: a room with no minibar waits for no report.
    expect(started.body).toMatchObject({ state: 'CHECKOUT_IN_PROGRESS', reportId: null });
    stayFreeRevision = started.body['revision'] as number;
  });

  it('the Cleaner holds the queue and the versions; Reception holds the return and the payment', async () => {
    const reception = await signIn(receptionA);
    const cleaner = await signIn(cleanerA);
    const admin = await signIn(adminA);
    // The Cleaner's own lists.
    expect((await call('GET', `/hotels/${hotelA}/cleaning-tasks`, cleaner)).status).toBe(200);
    expect((await call('GET', `/hotels/${hotelA}/minibar-refills`, cleaner)).status).toBe(200);
    // Reception may see what it must act on; a report's prices are not the Cleaner's.
    expect((await call('GET', `/hotels/${hotelA}/minibar-reports`, reception)).status).toBe(200);
    const unknownReport = '00000000-0000-4000-8000-0000000000c9';
    expect(
      (await call('GET', `/hotels/${hotelA}/minibar-reports/${unknownReport}`, cleaner)).status,
    ).toBe(404);
    // A Hotel Admin without the operational roles holds none of it.
    expect((await call('GET', `/hotels/${hotelA}/cleaning-tasks`, admin)).status).toBe(404);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/minibar-refills`, admin, {
          stayId: stayFree,
          productId: '00000000-0000-4000-8000-0000000000ca',
          quantity: 1,
        })
      ).status,
    ).toBe(404);
    // The Cleaner asks for no refill and starts no checkout.
    expect(
      (
        await call('POST', `/hotels/${hotelA}/minibar-refills`, cleaner, {
          stayId: stayFree,
          productId: '00000000-0000-4000-8000-0000000000ca',
          quantity: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/stays/${stayFree}/checkout/cancel`, cleaner, {
          expectedRevision: stayFreeRevision,
          reason: 'Буцаах',
        })
      ).status,
    ).toBe(404);
  });

  it('the actual checkout leaves a task only its Cleaner completes, and the room becomes clean', async () => {
    const reception = await signIn(receptionA);
    const cleaner = await signIn(cleanerA);
    await settleFolio(stayFree, reception);
    const done = await call('POST', `/hotels/${hotelA}/stays/${stayFree}/checkout`, reception, {
      expectedRevision: stayFreeRevision,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'COMPLETED' });
    const queue = await call('GET', `/hotels/${hotelA}/cleaning-tasks`, cleaner);
    expect(queue.status).toBe(200);
    const tasks = queue.body['tasks'] as { taskId: string; roomId: string; revision: number }[];
    const task = tasks.find((candidate) => candidate.roomId === roomFree);
    expect(task).toBeDefined();
    // Reception neither claims nor completes it.
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/cleaning-tasks/${task?.taskId as string}/claim`,
          reception,
          { expectedRevision: task?.revision as number },
        )
      ).status,
    ).toBe(404);
    const claimed = await call(
      'POST',
      `/hotels/${hotelA}/cleaning-tasks/${task?.taskId as string}/claim`,
      cleaner,
      { expectedRevision: task?.revision as number },
    );
    expect(claimed.status).toBe(200);
    const completed = await call(
      'POST',
      `/hotels/${hotelA}/cleaning-tasks/${task?.taskId as string}/complete`,
      cleaner,
      { expectedRevision: claimed.body['revision'] as number, refilled: [] },
    );
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ state: 'COMPLETED' });
    const cleaning = await call('GET', `/hotels/${hotelA}/rooms/${roomFree}/cleaning`, cleaner);
    expect(cleaning.body).toMatchObject({ state: 'CLEAN' });
  });
});

describe('the folio, the deposit and the money (Phase 10, doc 18 §3)', () => {
  let depositStay: string;
  let depositStayRevision: number;
  let depositRoom: string;
  let receiptId: string;

  it('Reception takes the deposit and applies it; a Cleaner and a bare Hotel Admin cannot', async () => {
    const reception = await signIn(receptionA);
    const cleaner = await signIn(cleanerA);
    const admin = await signIn(adminA);
    const manager = await signIn(managerA);
    const created = await call('POST', `/hotels/${hotelA}/catalog/rooms`, manager, {
      roomNumber: '103',
      categoryId: categoryA,
      state: 'ACTIVE',
    });
    expect(created.status).toBe(201);
    depositRoom = created.body['roomId'] as string;
    expect(
      (
        await call('POST', `/hotels/${hotelA}/rooms/${depositRoom}/cleaning`, cleaner, {
          toState: 'CLEAN',
          expectedRevision: 0,
        })
      ).status,
    ).toBe(200);
    const checkIn = await call('POST', `/hotels/${hotelA}/stays`, reception, {
      roomId: depositRoom,
      stayType: 'HOURLY',
      halfHourUnits: 2,
      guest,
    });
    expect(checkIn.status).toBe(201);
    depositStay = checkIn.body['stayId'] as string;
    depositStayRevision = checkIn.body['revision'] as number;

    // The bill exists with the deposit requirement the confirmation snapshotted.
    const folio = await call('GET', `/hotels/${hotelA}/stays/${depositStay}/folio`, reception);
    expect(folio.status).toBe(200);
    expect(folio.body['deposit']).toMatchObject({ required: true, requiredAmountMnt: '50000' });

    // A Cleaner sees no bill, and a Hotel Admin without Reception takes no deposit.
    expect(
      (await call('GET', `/hotels/${hotelA}/stays/${depositStay}/folio`, cleaner)).status,
    ).toBe(404);
    void depositRoom;
    expect(
      (
        await call('POST', `/hotels/${hotelA}/stays/${depositStay}/deposit`, admin, {
          channel: 'CASH',
          amountMnt: 50000,
        })
      ).status,
    ).toBe(404);

    // Cash needs its shift; the Reception's own shift is the one it opened.
    const noShift = await call(
      'POST',
      `/hotels/${hotelA}/stays/${depositStay}/deposit`,
      reception,
      {
        channel: 'CASH',
        amountMnt: 50000,
      },
    );
    expect(noShift.status).toBe(400);
    expect(code(noShift)).toBe('VALIDATION_FAILED');
  });

  it('the deposit is configured by a Manager alone, and covers a line without adding cash', async () => {
    const reception = await signIn(receptionA);
    const manager = await signIn(managerA);
    // Reception never configures the deposit.
    expect(
      (
        await call('PUT', `/hotels/${hotelA}/deposit-configuration`, reception, {
          amountMnt: 60000,
        })
      ).status,
    ).toBe(404);
    const outOfRange = await call('PUT', `/hotels/${hotelA}/deposit-configuration`, manager, {
      amountMnt: 10000,
    });
    expect(outOfRange.status).toBe(400);

    const shift = await call('GET', `/hotels/${hotelA}/shifts/current`, reception);
    const shiftId = (shift.body['shift'] as { shiftId: string } | null)?.shiftId;
    const received = await call(
      'POST',
      `/hotels/${hotelA}/stays/${depositStay}/deposit`,
      reception,
      {
        channel: 'CASH',
        amountMnt: 50000,
        ...(shiftId === undefined ? {} : { shiftId }),
      },
    );
    expect(received.status).toBe(201);
    receiptId = (
      (received.body['transactions'] as { transactionId: string; kind: string }[]).find(
        (t) => t.kind === 'DEPOSIT_RECEIPT',
      ) as { transactionId: string }
    ).transactionId;
    const charged = await call(
      'POST',
      `/hotels/${hotelA}/stays/${depositStay}/folio/charges`,
      reception,
      {},
    );
    expect(charged.status).toBe(200);
    const lines = charged.body['lines'] as { lineId: string; amountMnt: string }[];
    const allocated = await call(
      'POST',
      `/hotels/${hotelA}/stays/${depositStay}/folio/allocations`,
      reception,
      { folioLineId: lines[0]?.lineId, amountMnt: Number(lines[0]?.amountMnt) },
    );
    expect(allocated.status).toBe(201);
    expect(allocated.body['balanceMnt']).toBe('0');
    void depositStayRevision;
  });

  it('an alternate-channel refund waits for a Manager, and the reconciliation is nobody’s here', async () => {
    const reception = await signIn(receptionA);
    const manager = await signIn(managerA);
    const admin = await signIn(adminA);
    const requested = await call(
      'POST',
      `/hotels/${hotelA}/stays/${depositStay}/deposit/refunds`,
      reception,
      {
        originalTransactionId: receiptId,
        amountMnt: 10000,
        channel: 'QPAY',
        reason: 'Бэлэн мөнгө байхгүй',
      },
    );
    expect(requested.status).toBe(201);
    const refund = (requested.body['refunds'] as { requestId: string; revision: number }[])[0];
    // Reception does not decide its own exception.
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/deposit-refunds/${refund?.requestId as string}/decide`,
          reception,
          { expectedRevision: refund?.revision, approve: true, reason: 'Зөвшөөрөв' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          `/hotels/${hotelA}/deposit-refunds/${refund?.requestId as string}/decide`,
          manager,
          { expectedRevision: refund?.revision, approve: true, reason: 'Зөвшөөрөв' },
        )
      ).status,
    ).toBe(200);
    // The late-refund reconciliation is Platform Operation's, not the hotel's.
    for (const token of [reception, manager, admin]) {
      expect((await call('GET', `/hotels/${hotelA}/deposit-reconciliation`, token)).status).toBe(
        404,
      );
    }
  });
});
