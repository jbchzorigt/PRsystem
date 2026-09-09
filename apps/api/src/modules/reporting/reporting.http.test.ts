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

/**
 * The registry and finance surfaces over real HTTP, through the booted
 * application (doc 12, doc 23).
 *
 * What only this suite can show: that the routes are mounted at all, that the
 * registry list is a `POST` so a guest's name never reaches a URL, that each
 * route refuses an unauthenticated caller at the edge and a Guest-realm token
 * after it, and that the shape checks run before any authority is consulted.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;

let hotelA: string;
let hotelB: string;
let adminA: SeededMembership;
let managerA: SeededMembership;
let receptionA: SeededMembership;
let adminB: SeededMembership;

const NOWHERE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  db = await provisionIamDatabase('reporting_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-reporting-http-seed',
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
  iam = attachIamHarness(db, 'reporting_http', { notifications });

  hotelA = await iam.createHotel('Reporting HTTP A', 'P30');
  hotelB = await iam.createHotel('Reporting HTTP B', 'P30');
  const seed = (hotelId: string, email: string, roles: readonly HotelRole[]) =>
    iam.seedMembership({ hotelId, email, roles });
  adminA = await seed(hotelA, 'admin@reporting-a.test', ['HOTEL_ADMIN']);
  managerA = await seed(hotelA, 'manager@reporting-a.test', ['MANAGER']);
  receptionA = await seed(hotelA, 'reception@reporting-a.test', ['RECEPTION']);
  adminB = await seed(hotelB, 'admin@reporting-b.test', ['HOTEL_ADMIN']);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await iam?.close();
  resetEnvCache();
}, 30_000);

async function signIn(member: SeededMembership): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email, password: member.password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

let keys = 0;
async function call(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  keys += 1;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `reporting-http-${String(keys).padStart(5, '0')}-${String(Date.now())}`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(payload === undefined || method === 'GET' ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const code = (response: { body: Record<string, unknown> }): string | undefined =>
  (response.body['error'] as { code?: string } | undefined)?.code;

/** A Guest-realm session, registered the way doc 09 §6.2 registers one. */
let phones = 0;
async function signedInGuest(): Promise<string> {
  phones += 1;
  const phone = `+9769${String(4_200_000 + phones).padStart(7, '0')}`;
  const requested = await call('POST', '/guest/phone-verifications', undefined, {
    phone,
    purpose: 'REGISTER',
  });
  expect(requested.status).toBe(202);
  const verification = await db.pool.query<{ verification_id: string }>(
    `SELECT verification_id FROM platform.guest_phone_verification
      WHERE state = 'PENDING' ORDER BY sent_at DESC LIMIT 1`,
  );
  const { GUEST_OTP } = await import('../guest/guest.tokens');
  const otp = app.get<{ codeFor(id: string): string }>(GUEST_OTP);
  const registered = await call('POST', '/guest/accounts', undefined, {
    phone,
    code: otp.codeFor(verification.rows[0]?.verification_id as string),
    password: ['synthetic', 'reporting', 'passphrase'].join('-'),
  });
  expect(registered.status).toBe(201);
  return registered.body['token'] as string;
}

/**
 * Every route, each with a body that would pass its own shape check — so what
 * these assertions measure is authority, and not the validation that runs
 * before it.
 */
const HOLD = {
  reason: 'Цагдаагийн албан бичгээр түр хугацаанд хадгална.',
  authorityReference: 'ЦЕГ-2026-100',
};
const ROUTES = (hotelId: string) =>
  [
    ['POST', `/hotels/${hotelId}/registry/queries`, {}],
    ['POST', `/hotels/${hotelId}/registry/legal-holds`, HOLD],
    ['POST', `/hotels/${hotelId}/registry/legal-holds/${NOWHERE}/release`, { reason: HOLD.reason }],
    ['GET', `/hotels/${hotelId}/finance/dashboard`, undefined],
    ['POST', `/hotels/${hotelId}/finance/exports`, { kind: 'GUEST_REGISTRY' }],
    ['GET', `/hotels/${hotelId}/finance/exports`, undefined],
    ['POST', `/hotels/${hotelId}/finance/exports/${NOWHERE}/download`, {}],
    ['GET', `/hotels/${hotelId}/finance/expense-categories`, undefined],
    [
      'POST',
      `/hotels/${hotelId}/finance/expense-categories`,
      { name: 'Түрээс', kind: 'OPERATING' },
    ],
    [
      'POST',
      `/hotels/${hotelId}/finance/expense-categories/${NOWHERE}/state`,
      { state: 'INACTIVE' },
    ],
  ] as const;

describe('every reporting route is behind a hotel session', () => {
  it('refuses an anonymous caller on all ten', async () => {
    for (const [method, path, payload] of ROUTES(hotelA)) {
      const response = await call(method, path, undefined, payload);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 180_000);

  it('refuses a Guest-realm token: the realms do not merge', async () => {
    const guest = await signedInGuest();
    for (const [method, path, payload] of ROUTES(hotelA)) {
      const response = await call(method, path, guest, payload);
      // The same opaque `NOT_FOUND` a foreign hotel gets, and deliberately so:
      // a Guest token cannot even learn that this hotel exists.
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 180_000);

  it('answers a foreign hotel exactly as it answers one that does not exist', async () => {
    const token = await signIn(adminB);
    for (const hotelId of [hotelA, NOWHERE]) {
      const listed = await call('POST', `/hotels/${hotelId}/registry/queries`, token, {});
      expect({ hotelId, status: listed.status, code: code(listed) }).toEqual({
        hotelId,
        status: 404,
        code: 'NOT_FOUND',
      });
      const dashboard = await call('GET', `/hotels/${hotelId}/finance/dashboard`, token);
      expect(dashboard.status).toBe(404);
    }
  }, 180_000);
});

describe('the registry list is a POST, and its filter is validated before anything else', () => {
  it('returns the page with no name in any URL', async () => {
    const token = await signIn(adminA);
    const listed = await call('POST', `/hotels/${hotelA}/registry/queries`, token, {
      nameSearch: 'Бат',
      pageSize: 50,
    });
    expect(listed.status).toBe(200);
    expect(listed.body['totalRows']).toBe(0);
    expect(listed.body['pageSize']).toBe(50);
    // The route carries no query string at all, which is the point of the POST.
    expect(`/hotels/${hotelA}/registry/queries`).not.toContain('?');
  }, 180_000);

  it('refuses a page size outside the three, and a server-owned field', async () => {
    const token = await signIn(adminA);
    for (const payload of [{ pageSize: 30 }, { pageSize: 0 }, { page: 0 }]) {
      const response = await call('POST', `/hotels/${hotelA}/registry/queries`, token, payload);
      expect({ payload, status: response.status }).toEqual({ payload, status: 400 });
    }
    const owned = await call('POST', `/hotels/${hotelA}/registry/queries`, token, {
      hotelId: hotelB,
    });
    expect({ status: owned.status, code: code(owned) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  }, 180_000);

  it('refuses a hold with no authority reference, and one with too short a reason', async () => {
    const token = await signIn(adminA);
    for (const payload of [
      { reason: 'Цагдаагийн хүсэлтээр хадгална.' },
      { reason: 'Богино', authorityReference: 'ЦЕГ-1' },
    ]) {
      const response = await call('POST', `/hotels/${hotelA}/registry/legal-holds`, token, payload);
      expect({ payload, status: response.status }).toEqual({ payload, status: 400 });
    }
  }, 180_000);
});

describe('the finance surface answers the roles doc 18 §3 gives it', () => {
  it('queues an export for the Hotel Admin and lists it, and refuses Reception', async () => {
    const admin = await signIn(adminA);
    const queued = await call('POST', `/hotels/${hotelA}/finance/exports`, admin, {
      kind: 'GUEST_REGISTRY',
    });
    expect(queued.status).toBe(202);
    expect(queued.body['state']).toBe('QUEUED');

    const listed = await call('GET', `/hotels/${hotelA}/finance/exports`, admin);
    expect(listed.status).toBe(200);
    expect((listed.body['exports'] as unknown[]).length).toBe(1);

    const reception = await signIn(receptionA);
    const refused = await call('POST', `/hotels/${hotelA}/finance/exports`, reception, {
      kind: 'GUEST_REGISTRY',
    });
    expect({ status: refused.status, code: code(refused) }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  }, 180_000);

  it('refuses an export kind it does not know, before any authority is consulted', async () => {
    const reception = await signIn(receptionA);
    const response = await call('POST', `/hotels/${hotelA}/finance/exports`, reception, {
      kind: 'EVERYTHING',
    });
    expect({ status: response.status, code: code(response) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  }, 180_000);

  it('gives the dashboard to the Hotel Admin alone', async () => {
    const admin = await signIn(adminA);
    const dashboard = await call('GET', `/hotels/${hotelA}/finance/dashboard`, admin);
    expect(dashboard.status).toBe(200);
    expect(Object.keys(dashboard.body)).toContain('kpis');

    const manager = await signIn(managerA);
    expect((await call('GET', `/hotels/${hotelA}/finance/dashboard`, manager)).status).toBe(404);
    // The Manager still reaches the registry, so the refusal above was this
    // action's and not the token's.
    expect((await call('POST', `/hotels/${hotelA}/registry/queries`, manager, {})).status).toBe(
      200,
    );
  }, 180_000);

  it('refuses a dashboard range it does not know and a category with no name', async () => {
    const admin = await signIn(adminA);
    const ranged = await call('GET', `/hotels/${hotelA}/finance/dashboard?range=FOREVER`, admin);
    expect({ status: ranged.status, code: code(ranged) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const category = await call('POST', `/hotels/${hotelA}/finance/expense-categories`, admin, {
      kind: 'OPERATING',
    });
    expect(category.status).toBe(400);
  }, 180_000);

  it('creates an expense category and lists it', async () => {
    const admin = await signIn(adminA);
    const created = await call('POST', `/hotels/${hotelA}/finance/expense-categories`, admin, {
      name: 'Цахилгаан',
      kind: 'OPERATING',
    });
    expect(created.status).toBe(201);
    const listed = await call('GET', `/hotels/${hotelA}/finance/expense-categories`, admin);
    expect(listed.status).toBe(200);
    expect((listed.body['categories'] as { name: string }[]).map((row) => row.name)).toContain(
      'Цахилгаан',
    );
  }, 180_000);
});
