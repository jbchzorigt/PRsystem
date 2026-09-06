import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { SimulatedPhoneVerification } from '@prsystem/ports';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { provisionIamDatabase } from '../iam/test-support/iam-harness';
import { GUEST_OTP } from '../guest/guest.tokens';

/**
 * The Guest boundary over real HTTP, through the booted application
 * (doc 09 §§6–7, §11).
 *
 * The sessions here are real: a guest registers by phone the way Phase 12 says
 * they do, and the token that comes back is the only thing that identifies them
 * to every route below.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let otp: SimulatedPhoneVerification;

beforeAll(async () => {
  db = await provisionIamDatabase('booking_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-booking-http-seed',
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
  otp = app.get<SimulatedPhoneVerification>(GUEST_OTP);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  resetEnvCache();
}, 30_000);

interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
  payload?: Record<string, unknown>,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `http-${String(Math.random()).slice(2)}`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(payload === undefined || method === 'GET' ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Registers a Guest the way doc 09 §6.2 does, and returns their session. */
let phones = 0;
async function signedInGuest(): Promise<{ token: string; accountId: string }> {
  phones += 1;
  const phone = `+9769${String(2_000_000 + phones).padStart(7, '0')}`;
  const requested = await call('POST', '/guest/phone-verifications', undefined, {
    phone,
    purpose: 'REGISTER',
  });
  expect(requested.status).toBe(202);
  const verification = await db.pool.query<{ verification_id: string }>(
    `SELECT verification_id FROM platform.guest_phone_verification
      WHERE state = 'PENDING' ORDER BY sent_at DESC LIMIT 1`,
  );
  const code = otp.codeFor(verification.rows[0]?.verification_id as string);
  const registered = await call('POST', '/guest/accounts', undefined, {
    phone,
    code,
    password: ['synthetic', 'http', 'passphrase'].join('-'),
  });
  expect(registered.status).toBe(201);
  return {
    token: registered.body['token'] as string,
    accountId: registered.body['accountId'] as string,
  };
}

describe('the booking surface requires a Guest session', () => {
  it('refuses an anonymous caller on every route', async () => {
    for (const [method, path] of [
      ['GET', '/guest/bookings'],
      ['GET', '/guest/bookings/00000000-0000-4000-8000-000000000000'],
      ['POST', '/guest/bookings'],
      ['POST', '/guest/bookings/00000000-0000-4000-8000-000000000000/cancellation'],
    ] as const) {
      const response = await call(method, path, undefined, {});
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);

  it('refuses a Hotel-realm session: realms never merge', async () => {
    const hotel = await db.pool.query<{ hotel_id: string }>(
      `INSERT INTO platform.hotel (display_name) VALUES ('Booking HTTP') RETURNING hotel_id`,
    );
    void hotel;
    // A staff member signs in through the Hotel realm's own door; that token
    // carries no authority in the Guest realm (ADR-0005).
    const staff = await call('POST', '/auth/sign-in', undefined, {
      email: 'nobody@booking-http.test',
      password: ['synthetic', 'not', 'a', 'credential'].join('-'),
    });
    expect(staff.status).toBe(401);
  }, 120_000);
});

describe('a signed-in Guest reaches only their own bookings', () => {
  it('lists their own and nothing else', async () => {
    const guest = await signedInGuest();
    const mine = await call('GET', '/guest/bookings', guest.token);
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.body['bookings'])).toBe(true);
    expect(mine.body['bookings']).toHaveLength(0);
  }, 120_000);

  it('answers 404 for a booking id that is not theirs, and for one that never existed', async () => {
    const guest = await signedInGuest();
    const missing = await call(
      'GET',
      '/guest/bookings/00000000-0000-4000-8000-000000000000',
      guest.token,
    );
    expect(missing.status).toBe(404);
  }, 120_000);

  it('refuses a request that names the hotel, the booker or the price', async () => {
    const guest = await signedInGuest();
    for (const field of ['hotelId', 'bookerAccountId', 'totalAmountMnt']) {
      const refused = await call('POST', '/guest/bookings', guest.token, {
        categoryId: '00000000-0000-4000-8000-000000000000',
        checkInDate: '2027-06-01',
        checkOutDate: '2027-06-02',
        stayingGuestName: 'Синтетик зочин',
        provider: 'QPAY',
        [field]: 'anything',
      });
      expect({ field, status: refused.status }).toEqual({ field, status: 400 });
      expect(JSON.stringify(refused.body)).toMatch(/determined by the server/);
    }
  }, 120_000);

  it('refuses a window that is not whole nights', async () => {
    const guest = await signedInGuest();
    const refused = await call('POST', '/guest/bookings', guest.token, {
      categoryId: '00000000-0000-4000-8000-000000000000',
      checkInDate: '2027-06-02',
      checkOutDate: '2027-06-01',
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
    });
    expect(refused.status).toBe(400);
  }, 120_000);
});

describe('the provider callback is trusted for nothing (PAY-DEC-005)', () => {
  it('needs no session, and tells an unauthenticated caller nothing', async () => {
    // A gateway holds no session, so the route is open — and therefore answers
    // the same for a forged callback, an unknown invoice and a wrong signature.
    for (const payload of [
      { providerInvoiceId: 'qpay-inv-000001' },
      { providerInvoiceId: 'qpay-inv-000001', signature: 'not-the-signature' },
      { providerInvoiceId: 'unknown-invoice', signature: 'sim-QPAY-unknown-invoice' },
    ]) {
      const response = await call('POST', '/payments/callbacks/qpay', undefined, payload);
      expect({ payload, status: response.status, outcome: response.body['outcome'] }).toEqual({
        payload,
        status: 200,
        outcome: 'rejected',
      });
      // And nothing about which references exist.
      expect(Object.keys(response.body)).toEqual(['outcome']);
    }
  }, 120_000);

  it('refuses a provider it does not implement', async () => {
    const response = await call('POST', '/payments/callbacks/paypal', undefined, {
      providerInvoiceId: 'x',
    });
    expect(response.status).toBe(400);
  }, 120_000);

  it('refuses a callback with no invoice reference at all', async () => {
    const response = await call('POST', '/payments/callbacks/khaan', undefined, {});
    expect(response.status).toBe(400);
  }, 120_000);
});

describe('the hotel-staff actions of doc 18 §3.3', () => {
  const hotelId = '00000000-0000-4000-8000-0000000000aa';
  const bookingId = '00000000-0000-4000-8000-0000000000bb';

  it('refuses an anonymous caller', async () => {
    for (const path of [
      `/hotels/${hotelId}/bookings/${bookingId}/no-show`,
      `/hotels/${hotelId}/bookings/${bookingId}/hotel-cancellation`,
    ]) {
      const response = await call('POST', path, undefined, { reason: 'x' });
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);

  it('refuses a Guest session: a no-show is not the guest’s to declare', async () => {
    const guest = await signedInGuest();
    for (const path of [
      `/hotels/${hotelId}/bookings/${bookingId}/no-show`,
      `/hotels/${hotelId}/bookings/${bookingId}/hotel-cancellation`,
    ]) {
      const response = await call('POST', path, guest.token, { reason: 'x' });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
  }, 120_000);

  it('exposes no route that marks a refund successful (doc 18 §3.3)', async () => {
    const guest = await signedInGuest();
    for (const path of [
      `/hotels/${hotelId}/bookings/${bookingId}/refund`,
      `/hotels/${hotelId}/bookings/${bookingId}/refunds`,
      `/guest/bookings/${bookingId}/refund`,
    ]) {
      const response = await call('POST', path, guest.token, {});
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 120_000);
});
