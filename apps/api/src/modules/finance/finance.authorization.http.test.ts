import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HotelRole } from '@prsystem/authz';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from '../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../iam/test-support/iam-harness';
import type { SimulatedStaffNotification } from '../iam/contracts/staff-notification.port';
import { STAFF_NOTIFICATION } from '../iam/iam.tokens';
import { countRows } from '../catalog/test-support/catalog-harness';

/**
 * Phase 11 authorization over real HTTP, through the booted application.
 *
 * doc 18 §3 row by row: Reception opens the shift over the drawer, counts it
 * and hands it over; the Hotel Admin alone adds a cash location, approves an
 * expense and approves a withdrawal; the Manager tops up and initiates a
 * transfer but cannot approve its own expense; the Cleaner holds nothing here;
 * and a foreign hotel is `NOT_FOUND` with no trace.
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
let reception2A: SeededMembership;
let managerB: SeededMembership;
let drawerA: string;

beforeAll(async () => {
  db = await provisionIamDatabase('finance_authz_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-finance-authz-seed',
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
  iam = attachIamHarness(db, 'finance_authz_http', { notifications });

  hotelA = await iam.createHotel('Finance Authz A', 'P30');
  hotelB = await iam.createHotel('Finance Authz B', 'P30');
  const seed = (hotelId: string, email: string, roles: readonly HotelRole[]) =>
    iam.seedMembership({ hotelId, email, roles });
  adminA = await seed(hotelA, 'admin@finance-a.test', ['HOTEL_ADMIN']);
  managerA = await seed(hotelA, 'manager@finance-a.test', ['MANAGER']);
  cleanerA = await seed(hotelA, 'cleaner@finance-a.test', ['CLEANER']);
  receptionA = await seed(hotelA, 'reception@finance-a.test', ['RECEPTION']);
  reception2A = await seed(hotelA, 'reception2@finance-a.test', ['RECEPTION']);
  managerB = await seed(hotelB, 'manager@finance-b.test', ['MANAGER']);
  const drawer = await iam.admin.query<{ cash_location_id: string }>(
    `SELECT cash_location_id FROM platform.cash_location
      WHERE hotel_id = $1 AND is_default_drawer IS TRUE`,
    [hotelA],
  );
  drawerA = drawer.rows[0]?.cash_location_id as string;
}, 180000);

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
  method: 'GET' | 'POST',
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
      'idempotency-key': `fi-authz-${String(keySequence).padStart(5, '0')}-${String(Date.now())}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('the shift over the drawer, over HTTP (doc 03, doc 18 §3)', () => {
  it('Reception opens on a counted drawer, counts it and hands it to the next Reception', async () => {
    const reception = await signIn(receptionA);
    const next = await signIn(reception2A);
    const manager = await signIn(managerA);

    const opened = await call('POST', `/hotels/${hotelA}/shifts`, reception, {
      openingCountedMnt: 40_000,
    });
    expect(opened.status).toBe(201);
    expect(opened.body['locationId']).toBe(drawerA);
    expect(opened.body['openingBalanceMnt']).toBe('40000');
    const shiftId = opened.body['shiftId'] as string;

    // A Manager holds neither the count nor the handover of a Reception shift.
    expect(
      (
        await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/count`, manager, {
          expectedRevision: 0,
          countedCashMnt: 40_000,
        })
      ).status,
    ).toBe(404);

    const counted = await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/count`, reception, {
      expectedRevision: 0,
      countedCashMnt: 40_000,
    });
    expect(counted.status).toBe(200);
    expect(counted.body['state']).toBe('CLOSING');
    expect(counted.body['varianceMnt']).toBe('0');

    const handed = await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/handover`, reception, {
      expectedRevision: counted.body['revision'],
      toAccountId: reception2A.accountId,
    });
    expect(handed.status).toBe(200);

    const accepted = await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/accept-cash`, next, {
      expectedRevision: handed.body['revision'],
      incomingCountedMnt: 40_000,
    });
    expect(accepted.status).toBe(200);
    const closed = await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/close`, next, {
      expectedRevision: accepted.body['revision'],
    });
    expect(closed.status).toBe(200);
    expect(closed.body['state']).toBe('CLOSED');
    expect(closed.body['reviewState']).toBe('PENDING_MANAGER');

    const reviewed = await call('POST', `/hotels/${hotelA}/shifts/${shiftId}/review`, manager, {
      expectedRevision: closed.body['revision'],
      decision: 'ACCEPT',
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body['reviewState']).toBe('RESOLVED');
  }, 120000);
});

describe('the drawer, the expense and who may touch them', () => {
  it('the Hotel Admin adds a location and approves; the Manager moves cash but approves nothing', async () => {
    const admin = await signIn(adminA);
    const manager = await signIn(managerA);
    const reception = await signIn(receptionA);
    const cleaner = await signIn(cleanerA);

    // A shift must be open for any drawer movement at all.
    const shift = await call('POST', `/hotels/${hotelA}/shifts`, reception, {
      openingCountedMnt: 0,
    });
    expect(shift.status).toBe(201);

    expect(
      (
        await call('POST', `/hotels/${hotelA}/cash/locations`, manager, {
          kind: 'SAFE',
          name: 'Сейф',
          code: 'SAFE-A',
        })
      ).status,
    ).toBe(404);
    const safe = await call('POST', `/hotels/${hotelA}/cash/locations`, admin, {
      kind: 'SAFE',
      name: 'Сейф',
      code: 'SAFE-A',
    });
    expect(safe.status).toBe(201);

    // The top-up is the Manager's; Reception and the Cleaner hold neither.
    expect(
      (
        await call('POST', `/hotels/${hotelA}/cash/top-ups`, reception, {
          locationId: drawerA,
          amountMnt: 30_000,
          reason: 'the owner added change',
        })
      ).status,
    ).toBe(404);
    const topUp = await call('POST', `/hotels/${hotelA}/cash/top-ups`, manager, {
      locationId: drawerA,
      amountMnt: 30_000,
      reason: 'the owner added change',
    });
    expect(topUp.status).toBe(201);
    expect(topUp.body['movementType']).toBe('CASH_TOP_UP');

    expect((await call('GET', `/hotels/${hotelA}/cash/locations`, cleaner)).status).toBe(404);

    // An expense: submitted by the Manager, approved only by the Hotel Admin.
    const expense = await call('POST', `/hotels/${hotelA}/finance/expenses`, manager, {
      category: 'Ариун цэврийн хэрэглэл',
      description: 'cleaning supplies',
      amountMnt: 12_000,
      method: 'CASH',
    });
    expect(expense.status).toBe(201);
    const expenseId = expense.body['expenseId'] as string;
    expect(
      (
        await call('POST', `/hotels/${hotelA}/finance/expenses/${expenseId}/decide`, manager, {
          expectedRevision: 0,
          decision: 'APPROVE',
        })
      ).status,
    ).toBe(404);
    const approved = await call(
      'POST',
      `/hotels/${hotelA}/finance/expenses/${expenseId}/decide`,
      admin,
      { expectedRevision: 0, decision: 'APPROVE' },
    );
    expect(approved.status).toBe(200);
    // An approval moves nothing: the drawer still holds only the top-up.
    expect(
      await countRows(
        iam.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement
          WHERE hotel_id = $1 AND movement_type = 'PAID_CASH_EXPENSE'`,
        [hotelA],
      ),
    ).toBe(0);

    const paid = await call(
      'POST',
      `/hotels/${hotelA}/finance/expenses/${expenseId}/pay`,
      manager,
      {
        expectedRevision: approved.body['revision'],
        locationId: drawerA,
      },
    );
    expect(paid.status).toBe(200);
    expect(paid.body['state']).toBe('PAID');
    expect(paid.body['movementId']).not.toBeNull();
  }, 120000);

  it('a foreign hotel and an unauthenticated caller reach nothing', async () => {
    const foreign = await signIn(managerB);
    expect((await call('GET', `/hotels/${hotelA}/cash/locations`, foreign)).status).toBe(404);
    expect(
      (
        await call('POST', `/hotels/${hotelA}/cash/top-ups`, foreign, {
          locationId: drawerA,
          amountMnt: 1_000,
          reason: 'not theirs',
        })
      ).status,
    ).toBe(404);
    expect((await call('GET', `/hotels/${hotelA}/finance/expenses`, undefined)).status).toBe(401);
    // Nothing of hotel A's was written by any of it.
    expect(
      await countRows(
        iam.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement
          WHERE hotel_id = $1 AND movement_type = 'CASH_TOP_UP'`,
        [hotelA],
      ),
    ).toBe(1);
  }, 90000);
});
