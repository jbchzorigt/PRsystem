import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { provisionIamDatabase } from '../iam/test-support/iam-harness';
import { derivePassword } from '../iam/services/password.service';

/**
 * The Police surface over real HTTP, through the booted application (doc 13).
 *
 * What only this suite can show: that the routes are mounted at all, that the
 * Police portal has its own sign-in and its own realm, that a Hotel token
 * reaches none of it, and that the shape checks run before any authority is
 * consulted. The check-in list is asserted to have no download route of any
 * kind — doc 13 §4.1 closes bulk export to both Police roles, and a route that
 * did not exist is the only way to be sure.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;

const NOWHERE = '00000000-0000-4000-8000-000000000000';
const PASSWORD = ['synthetic', 'police', 'passphrase'].join('-');
const ADMIN_EMAIL = 'admin@police-http.test';
const HOTEL_EMAIL = 'staff@police-http.test';

beforeAll(async () => {
  db = await provisionIamDatabase('police_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-police-http-seed',
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    // The Police realm is its own credential, and the module exists only
    // because this deployment holds one (doc 13 §3).
    POLICE_ENABLED: 'true',
    POLICE_DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.police),
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

  // A Police Admin and a Hotel account, each with a real credential: the
  // Police portal's sign-in is the one under test, and the Hotel account is
  // there to be refused by it.
  const derived = await derivePassword(PASSWORD);
  for (const [realm, email, role] of [
    ['police', ADMIN_EMAIL, 'POLICE_ADMIN'],
    ['hotel', HOTEL_EMAIL, null],
  ] as const) {
    const created = await db.pool.query<{ account_id: string }>(
      `INSERT INTO platform.user_account
         (realm, realm_role, police_scope_ref, email_normalized, state, email_verified_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())
       RETURNING account_id`,
      [realm, role, role === null ? null : 'UNIT-HTTP', email],
    );
    await db.pool.query(
      `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
       VALUES ($1::uuid, $2, $3)`,
      [created.rows[0]?.account_id, derived.secretHash, derived.paramsVersion],
    );
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  resetEnvCache();
}, 30_000);

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
      'idempotency-key': `police-http-${String(keys).padStart(5, '0')}-${String(Date.now())}`,
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

async function policeToken(): Promise<string> {
  const signedIn = await call('POST', '/police/auth/sign-in', undefined, {
    email: ADMIN_EMAIL,
    password: PASSWORD,
  });
  expect(signedIn.status).toBe(200);
  return signedIn.body['token'] as string;
}

async function hotelToken(): Promise<string> {
  const signedIn = await call('POST', '/auth/sign-in', undefined, {
    email: HOTEL_EMAIL,
    password: PASSWORD,
  });
  expect(signedIn.status).toBe(200);
  return signedIn.body['token'] as string;
}

const ROUTES = [
  ['POST', '/police/wanted-people', { registrationNumber: 'АА90010112' }],
  [
    'POST',
    `/police/wanted-people/${NOWHERE}/identity-decisions`,
    { revisionId: NOWHERE, approve: true, reason: 'Батлах шийдвэр.' },
  ],
  [
    'POST',
    `/police/wanted-people/${NOWHERE}/cases`,
    {
      reasonText: 'Хангалттай урт эрэн сурвалжлах үндэслэл.',
      crimeCategory: 'Хулгай',
      owningUnitRef: 'UNIT-HTTP',
    },
  ],
  [
    'POST',
    `/police/cases/${NOWHERE}/state`,
    { state: 'ACTIVE', reason: 'Идэвхжүүлэх шийдвэр.', expectedRevision: 0 },
  ],
  ['GET', `/police/matches/${NOWHERE}`, undefined],
  ['POST', `/police/matches/${NOWHERE}/acknowledgement`, { expectedRevision: 0 }],
  ['POST', '/police/matches/searches', { registrationNumber: 'АА90010112' }],
  [
    'POST',
    `/police/matches/${NOWHERE}/found`,
    { expectedRevision: 0, locationKind: 'AT_MATCH_HOTEL' },
  ],
  [
    'POST',
    `/police/matches/${NOWHERE}/found-corrections`,
    { reason: 'Залруулах хангалттай урт шалтгаан.' },
  ],
  [
    'POST',
    `/police/matches/${NOWHERE}/false-match`,
    { reasonCode: 'WRONG_NUMBER_ENTERED', reasonNote: 'Хангалттай урт тайлбар байна.' },
  ],
  ['GET', '/police/check-ins', undefined],
  ['GET', '/police/dashboard', undefined],
  ['GET', '/police/dashboard/charts', undefined],
  [
    'POST',
    '/police/exports',
    { purpose: 'Хангалттай урт зорилгын тайлбар.', taskReference: 'T-1' },
  ],
  ['POST', `/police/exports/${NOWHERE}/download`, {}],
] as const;

describe('every Police route is behind a Police session', () => {
  it('refuses an anonymous caller on all fifteen', async () => {
    for (const [method, path, payload] of ROUTES) {
      const response = await call(method, path, undefined, payload);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 180_000);

  it('refuses a Hotel token: realms never merge', async () => {
    const token = await hotelToken();
    for (const [method, path, payload] of ROUTES) {
      const response = await call(method, path, token, payload);
      // The opaque denial every other realm boundary answers with.
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 180_000);

  it('refuses a Police address at the Hotel sign-in and the reverse', async () => {
    const crossed = await call('POST', '/auth/sign-in', undefined, {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    expect(crossed.status).toBe(401);
    const alsoCrossed = await call('POST', '/police/auth/sign-in', undefined, {
      email: HOTEL_EMAIL,
      password: PASSWORD,
    });
    expect(alsoCrossed.status).toBe(401);
  }, 180_000);
});

describe('the Police portal’s own surface', () => {
  it('signs a Police Admin in and answers the dashboard counters', async () => {
    const token = await policeToken();
    const counters = await call('GET', '/police/dashboard', token);
    expect(counters.status).toBe(200);
    expect(Object.keys(counters.body).sort()).toEqual([
      'activeCases',
      'activeWantedPeople',
      'falseMatches',
      'foundPeople',
      'matchEvents',
      'matchedPeople',
      'openMatches',
    ]);
  }, 180_000);

  it('opens the active check-in list and refuses a historical search with no reason', async () => {
    const token = await policeToken();
    const active = await call('GET', '/police/check-ins', token);
    expect(active.status).toBe(200);
    expect(active.body['historical']).toBe(false);

    const noReason = await call(
      'GET',
      '/police/check-ins?from=2026-08-01T00:00:00.000Z&to=2026-08-10T00:00:00.000Z',
      token,
    );
    expect({ status: noReason.status, code: code(noReason) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    const tooLong = await call(
      'GET',
      '/police/check-ins?from=2026-06-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&reason=Мөрдөн байцаалт',
      token,
    );
    expect(tooLong.status).toBe(400);
  }, 180_000);

  it('has no route that downloads the check-in list, in any shape', async () => {
    const token = await policeToken();
    for (const path of [
      '/police/check-ins/export',
      '/police/check-ins/exports',
      '/police/check-ins.csv',
      '/police/check-ins/download',
    ]) {
      const response = await call('GET', path, token);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 180_000);

  it('refuses a malformed request before it consults any authority', async () => {
    const token = await policeToken();
    // A registration number that could never match, a state that does not
    // exist, and a reason code outside the approved four.
    const badNumber = await call('POST', '/police/wanted-people', token, {
      registrationNumber: '',
    });
    expect(badNumber.status).toBe(400);
    const badState = await call('POST', `/police/cases/${NOWHERE}/state`, token, {
      state: 'FOUND',
      reason: 'Хүчингүй төлөв.',
      expectedRevision: 0,
    });
    expect({ status: badState.status, code: code(badState) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const badReason = await call('POST', `/police/matches/${NOWHERE}/false-match`, token, {
      reasonCode: 'BECAUSE',
      reasonNote: 'Хангалттай урт тайлбар байна.',
    });
    expect(badReason.status).toBe(400);
    // And a server-owned field is refused rather than ignored.
    const owned = await call('POST', '/police/wanted-people', token, {
      registrationNumber: 'АА90010112',
      personId: NOWHERE,
    });
    expect({ status: owned.status, code: code(owned) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  }, 180_000);

  it('takes the exact search as a POST, so a number never reaches a URL', async () => {
    const token = await policeToken();
    const searched = await call('POST', '/police/matches/searches', token, {
      registrationNumber: 'АА90010112',
    });
    // Nothing matches in this database, and the point is the shape of the call.
    expect([404, 409]).toContain(searched.status);
    // The same path as a `GET` is not a search: it falls through to the
    // single-match route, whose identifier is a uuid, and is refused there. No
    // route of this module reads a registration number out of a query string.
    const asQuery = await call(
      'GET',
      '/police/matches/searches?registrationNumber=АА90010112',
      token,
    );
    expect([400, 404]).toContain(asQuery.status);
  }, 180_000);
});
