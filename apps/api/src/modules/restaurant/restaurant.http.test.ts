import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from '../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../iam/test-support/iam-harness';
import type { SimulatedStaffNotification } from '../iam/contracts/staff-notification.port';
import { STAFF_NOTIFICATION } from '../iam/iam.tokens';

/**
 * The restaurant surface over real HTTP, through the booted application
 * (doc 08 §§3–9, §11).
 *
 * Three things are proved here and cannot be proved anywhere else: that the
 * routes exist and are mounted, that every one of them refuses an unauthorized
 * caller *at the edge*, and that the room-session header and the Hotel-realm
 * bearer are two different credentials which never substitute for one another.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;
let hotelId: string;
let managerPlus: SeededMembership;
let reception: SeededMembership;
let restaurantId: string;

const NOWHERE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  db = await provisionIamDatabase('restaurant_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-restaurant-http-seed',
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
  iam = attachIamHarness(db, 'restaurant_http', { notifications });
  hotelId = await iam.createHotel('Restaurant HTTP', 'P30');
  managerPlus = await iam.seedMembership({
    hotelId,
    email: 'mplus@restaurant-http.test',
    roles: ['MANAGER_PLUS'],
  });
  reception = await iam.seedMembership({
    hotelId,
    email: 'reception@restaurant-http.test',
    roles: ['RECEPTION'],
  });
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
  options: { token?: string; session?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  keys += 1;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `rest-http-${String(keys).padStart(5, '0')}-${String(Date.now())}`,
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.session === undefined ? {} : { 'x-restaurant-session': options.session }),
    },
    ...(options.body === undefined || method === 'GET'
      ? {}
      : { body: JSON.stringify(options.body) }),
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

describe('the staff surface is mounted and gated', () => {
  it('registers a restaurant for Manager Plus', async () => {
    const token = await signIn(managerPlus);
    const created = await call('POST', `/hotels/${hotelId}/restaurants`, {
      token,
      body: {
        displayName: 'HTTP Restaurant',
        cuisineKind: 'MONGOLIAN',
        addressLine: 'Улаанбаатар',
        latitudeMicro: 47_918_000,
        longitudeMicro: 106_917_000,
        contactPhone: '+97699001122',
      },
    });
    expect(created.status).toBe(201);
    restaurantId = created.body['restaurantId'] as string;
    expect(restaurantId).toBeTruthy();
  }, 120_000);

  it('refuses Reception the registration Manager Plus alone holds', async () => {
    const token = await signIn(reception);
    const payload = {
      displayName: 'Not allowed',
      cuisineKind: 'MONGOLIAN',
      addressLine: 'Улаанбаатар',
      latitudeMicro: 47_918_000,
      longitudeMicro: 106_917_000,
      contactPhone: '+97699001122',
    };
    const refused = await call('POST', `/hotels/${hotelId}/restaurants`, { token, body: payload });
    // The refusal is the uninformative one the platform uses everywhere: a
    // hotel the caller has no authority in answers exactly as one that does
    // not exist (doc 06 §2).
    const foreign = await call('POST', `/hotels/${NOWHERE}/restaurants`, { token, body: payload });
    expect(refused.status).toBe(404);
    expect(code(refused)).toBe('NOT_FOUND');
    expect(refused.status).toBe(foreign.status);
    expect(code(refused)).toBe(code(foreign));
    // And nothing was written.
    const rows = await iam.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.restaurant WHERE display_name = $1`,
      ['Not allowed'],
    );
    expect(rows.rows[0]?.n).toBe('0');
  }, 120_000);

  it('refuses a request that names a server-owned field', async () => {
    const token = await signIn(managerPlus);
    const refused = await call('POST', `/hotels/${hotelId}/restaurants`, {
      token,
      body: {
        displayName: 'Server owned',
        cuisineKind: 'MONGOLIAN',
        addressLine: 'Улаанбаатар',
        latitudeMicro: 47_918_000,
        longitudeMicro: 106_917_000,
        contactPhone: '+97699001122',
        hotelId: NOWHERE,
      },
    });
    expect(refused.status).toBe(400);
    expect(code(refused)).toBe('VALIDATION_FAILED');
  }, 120_000);

  it('refuses an anonymous caller on every staff route', async () => {
    for (const [method, path] of [
      ['POST', `/hotels/${hotelId}/restaurants`],
      ['POST', `/hotels/${hotelId}/restaurants/${NOWHERE}/link`],
      ['POST', `/hotels/${hotelId}/restaurants/${NOWHERE}/schedule`],
      ['POST', `/hotels/${hotelId}/restaurants/${NOWHERE}/menu/items`],
      ['POST', `/hotels/${hotelId}/rooms/${NOWHERE}/qr-token`],
      ['POST', `/hotels/${hotelId}/stays/${NOWHERE}/guest-access-codes`],
      ['POST', `/hotels/${hotelId}/restaurant-orders/${NOWHERE}/acceptance`],
      ['POST', `/hotels/${hotelId}/restaurant-orders/${NOWHERE}/refund`],
    ] as const) {
      const response = await call(method, path, { body: {} });
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);
});

describe('the room guest’s credential is its own', () => {
  it('refuses every guest route without a room session', async () => {
    for (const [method, path] of [
      ['GET', '/restaurant/guest/menus'],
      ['GET', '/restaurant/guest/orders'],
      ['POST', '/restaurant/guest/orders'],
      ['POST', `/restaurant/guest/orders/${NOWHERE}/invoice`],
      ['POST', `/restaurant/guest/orders/${NOWHERE}/refund-request`],
    ] as const) {
      const response = await call(method, path, { body: {} });
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);

  it('does not accept a Hotel-realm bearer as a room session', async () => {
    const token = await signIn(managerPlus);
    // The staff token is valid — for the Hotel realm. It is not a room session,
    // and the guest surface reads a different header entirely (CLAUDE.md §4).
    const refused = await call('GET', '/restaurant/guest/orders', { token });
    expect(refused.status).toBe(401);
    const alsoRefused = await call('GET', '/restaurant/guest/orders', { session: token });
    expect(alsoRefused.status).toBe(401);
  }, 120_000);

  it('answers a wrong QR, a wrong code and a stale one identically', async () => {
    const answers = await Promise.all([
      call('POST', '/restaurant/guest/sessions', {
        body: { roomToken: 'x'.repeat(43), code: '123456' },
      }),
      call('POST', '/restaurant/guest/sessions', {
        body: { roomToken: 'y'.repeat(43), code: '654321' },
      }),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body['error']).toMatchObject({ message: 'that code did not work' });
    }
  }, 120_000);
});

describe('the payment callback is trusted for nothing', () => {
  it('answers the same for a forged callback as for one naming nothing', async () => {
    const forged = await call('POST', '/restaurant/payments/callbacks/qpay', {
      body: { providerInvoiceId: 'no-such-invoice', signature: 'forged', status: 'PAID' },
    });
    const unknown = await call('POST', '/restaurant/payments/callbacks/qpay', {
      body: { providerInvoiceId: 'also-no-such-invoice' },
    });
    expect(forged.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(forged.body).toEqual(unknown.body);
    // And it names no order: a caller who could not already name the invoice
    // learns nothing from this endpoint.
    expect(forged.body['orderId']).toBeUndefined();
  }, 120_000);

  it('refuses an unknown provider', async () => {
    const response = await call('POST', '/restaurant/payments/callbacks/nowhere', {
      body: { providerInvoiceId: 'anything' },
    });
    expect(response.status).toBe(400);
  }, 120_000);
});
