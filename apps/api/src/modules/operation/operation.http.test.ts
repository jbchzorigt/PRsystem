import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { provisionIamDatabase } from '../iam/test-support/iam-harness';
import type { OperationHarness } from './test-support/operation-harness';
import {
  HOTEL_ADMIN_PASSWORD,
  OPERATION_PASSWORD,
  attachOperationHarness,
} from './test-support/operation-harness';

/**
 * The Operation surface over real HTTP, through the booted application.
 *
 * What only this suite can show: that the routes are mounted, that the Operation
 * portal has its own sign-in and its own realm, that a Hotel token reaches none
 * of the platform's own surface, and that the shape checks run before any
 * authority is consulted. It also asserts the two absences doc 14 turns on —
 * there is no inbound SMS route and no email-change route, in any shape.
 */

const KMS_SEED = 'synthetic-operation-http-seed';

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let h: OperationHarness;

const NOWHERE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  db = await provisionIamDatabase('operation_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED,
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
  // The harness seals its factors under the seed the application runs on, so a
  // code minted here is one the running application will accept.
  h = attachOperationHarness(db, 'operation_http', { keySeed: KMS_SEED });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
  resetEnvCache();
});

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
      'idempotency-key': `operation-http-${String(keys).padStart(5, '0')}-${String(Date.now())}`,
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

const ROUTES = [
  ['GET', '/operation/dashboard/kpi', undefined],
  ['GET', '/operation/subscriptions', undefined],
  ['GET', '/operation/onboarding/queue', undefined],
  ['POST', `/operation/subscriptions/${NOWHERE}/password-reset`, {}],
  [
    'POST',
    `/operation/subscriptions/${NOWHERE}/suspension`,
    { suspend: true, reasonCode: 'HTTP_PROBE', note: 'Хангалттай урт тайлбар байна.' },
  ],
  ['GET', `/operation/subscriptions/${NOWHERE}/suspension-history`, undefined],
  ['GET', '/operation/reconciliations', undefined],
  [
    'POST',
    '/operation/recovery-requests',
    {
      hotelId: NOWHERE,
      caseReference: 'SUP-HTTP-1',
      note: 'Хангалттай урт тайлбар байна.',
    },
  ],
  ['GET', '/operation/recovery-requests', undefined],
  [
    'POST',
    `/operation/recovery-requests/${NOWHERE}/decision`,
    { decision: 'APPROVED', reason: 'Хангалттай урт шалтгаан байна.' },
  ],
  [
    'POST',
    '/operation/accounts',
    { email: 'probe@operation.test', role: 'OPERATION_ADMIN', permissions: [] },
  ],
  [
    'POST',
    `/operation/accounts/${NOWHERE}/state`,
    { state: 'SUSPENDED', reason: 'Хангалттай урт шалтгаан байна.' },
  ],
  [
    'POST',
    `/operation/accounts/${NOWHERE}/permissions`,
    { permission: 'OPERATION_READ', granted: true, reason: 'Хангалттай урт шалтгаан байна.' },
  ],
  [
    'POST',
    `/operation/contact-changes/${NOWHERE}/exception`,
    { reference: 'OWNER-1', reason: 'Хангалттай урт шалтгаан байна.' },
  ],
  ['POST', '/operation/sms/previews', { body: 'Сануулга.', filters: {} }],
  ['POST', '/operation/sms/jobs', { previewId: NOWHERE }],
  ['GET', '/operation/sms/jobs', undefined],
  ['POST', '/operation/sms/deliveries/refresh', {}],
] as const;

describe('every Operation route is behind an Operation session', () => {
  it('refuses an anonymous caller on all eighteen', async () => {
    for (const [method, path, payload] of ROUTES) {
      const response = await call(method, path, undefined, payload);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 180_000);

  it('refuses a Hotel token: realms never merge', async () => {
    const hotel = await h.hotel();
    const signedIn = await call('POST', '/auth/sign-in', undefined, {
      email: hotel.admin.email,
      password: HOTEL_ADMIN_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const token = signedIn.body['token'] as string;

    for (const [method, path, payload] of ROUTES) {
      const response = await call(method, path, token, payload);
      // The opaque denial every other realm boundary answers with. A malformed
      // body is refused first, which is also correct — shape before authority.
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 180_000);

  it('refuses an Operation address at the Hotel sign-in and the reverse', async () => {
    const operator = await h.operator({ permissions: ['OPERATION_READ'] });
    const hotel = await h.hotel();
    const crossed = await call('POST', '/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
    });
    expect(crossed.status).toBe(401);
    const alsoCrossed = await call('POST', '/operation/auth/sign-in', undefined, {
      email: hotel.admin.email,
      password: HOTEL_ADMIN_PASSWORD,
      code: '000000',
    });
    expect(alsoCrossed.status).toBe(401);
  }, 180_000);
});

describe('the Operation portal’s own surface', () => {
  it('signs an operator in with two factors and answers the KPI partition', async () => {
    const operator = await h.operator({ permissions: ['OPERATION_READ'] });
    await h.hotel();

    // A password with a wrong code is refused, and says nothing about which
    // half was wrong.
    const wrongCode = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: '000000',
    });
    expect(wrongCode.status).toBe(401);

    const signedIn = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: operator.codeAt(),
    });
    expect(signedIn.status).toBe(200);
    expect(Object.keys(signedIn.body).sort()).toEqual(['accountId', 'token']);

    const token = signedIn.body['token'] as string;
    const kpi = await call('GET', '/operation/dashboard/kpi', token);
    expect(kpi.status).toBe(200);
    expect(Object.keys(kpi.body).sort()).toEqual([
      'asOf',
      'inactiveApplications',
      'packages',
      'sms',
      'status',
      'totalHotels',
    ]);
  }, 180_000);

  it('refuses a malformed request before it consults any authority', async () => {
    const operator = await h.operator({ permissions: ['OPERATION_READ'] });
    const signedIn = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: operator.codeAt(),
    });
    const token = signedIn.body['token'] as string;

    // A reason code that is not a code, a state that does not exist, and a
    // message longer than doc 14 §5.3 allows.
    const badReason = await call('POST', `/operation/subscriptions/${NOWHERE}/suspension`, token, {
      suspend: true,
      reasonCode: 'lowercase',
      note: 'Хангалттай урт тайлбар байна.',
    });
    expect({ status: badReason.status, code: code(badReason) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    const badState = await call('POST', `/operation/accounts/${NOWHERE}/state`, token, {
      state: 'DELETED',
      reason: 'Хангалттай урт шалтгаан байна.',
    });
    expect(badState.status).toBe(400);

    const tooLong = await call('POST', '/operation/sms/previews', token, {
      body: 'я'.repeat(301),
      filters: {},
    });
    expect({ status: tooLong.status, code: code(tooLong) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    // And a server-owned field is refused rather than ignored.
    const owned = await call('POST', '/operation/recovery-requests', token, {
      hotelId: NOWHERE,
      caseReference: 'SUP-1',
      note: 'Хангалттай урт тайлбар байна.',
      newEmail: 'attacker@example.test',
    });
    expect({ status: owned.status, code: code(owned) }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  }, 180_000);

  it('has no route that changes an address, and none that receives an SMS', async () => {
    const operator = await h.operator({ permissions: ['OPERATION_READ'] });
    const signedIn = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: operator.codeAt(),
    });
    const token = signedIn.body['token'] as string;

    for (const [method, path] of [
      ['POST', `/operation/subscriptions/${NOWHERE}/email`],
      ['POST', `/operation/accounts/${NOWHERE}/email`],
      ['POST', '/operation/sms/inbound'],
      ['POST', '/operation/sms/callbacks'],
      ['POST', '/operation/sms/replies'],
      ['GET', '/operation/sms/inbox'],
    ] as const) {
      const response = await call(method, path, token, {});
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 180_000);

  it('takes the whole subscription list through query parameters, masked', async () => {
    const operator = await h.operator({ permissions: ['OPERATION_READ'] });
    const hotel = await h.hotel({ packageCode: 'P30' });
    const signedIn = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: operator.codeAt(),
    });
    const token = signedIn.body['token'] as string;

    const page = await call(
      'GET',
      `/operation/subscriptions?package=P30&limit=10&name=${encodeURIComponent(hotel.name)}`,
      token,
    );
    expect(page.status).toBe(200);
    const items = page.body['items'] as Record<string, unknown>[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(items)).not.toContain(hotel.admin.email);

    // A filter value that is not a date is refused rather than ignored.
    const badDate = await call('GET', '/operation/subscriptions?expiresFrom=tomorrow', token);
    expect(badDate.status).toBe(400);
  }, 180_000);
});
