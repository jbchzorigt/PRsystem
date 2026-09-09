import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { SimulatedPhoneVerification } from '@prsystem/ports';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { provisionIamDatabase } from '../iam/test-support/iam-harness';
import { GUEST_OTP } from '../guest/guest.tokens';

/**
 * The review surface over real HTTP, through the booted application (doc 10).
 *
 * Three things are proved here and nowhere else: that the routes are mounted,
 * that each refuses an unauthorized caller at the edge, and that the three
 * realms reach three different surfaces — a Guest token opens no moderation
 * route, and no token at all opens the public one.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let otp: SimulatedPhoneVerification;

const NOWHERE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  db = await provisionIamDatabase('review_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-review-http-seed',
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
  otp = app.get<SimulatedPhoneVerification>(GUEST_OTP);
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
      'idempotency-key': `review-http-${String(keys).padStart(5, '0')}-${String(Date.now())}`,
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

/** Registers a Guest the way doc 09 §6.2 does, and returns their session. */
let phones = 0;
async function signedInGuest(): Promise<{ token: string; accountId: string }> {
  phones += 1;
  const phone = `+9769${String(3_000_000 + phones).padStart(7, '0')}`;
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
    password: ['synthetic', 'review', 'passphrase'].join('-'),
  });
  expect(registered.status).toBe(201);
  return {
    token: registered.body['token'] as string,
    accountId: registered.body['accountId'] as string,
  };
}

describe('the guest review surface requires a Guest session', () => {
  it('refuses an anonymous caller on every route', async () => {
    for (const [method, path] of [
      ['GET', '/guest/reviews'],
      ['POST', '/guest/reviews'],
      ['POST', `/guest/reviews/${NOWHERE}/revisions`],
      ['POST', `/guest/reviews/${NOWHERE}/deletion`],
      ['POST', `/guest/reviews/${NOWHERE}/reports`],
    ] as const) {
      const response = await call(method, path, undefined, {});
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);

  it('lists a new guest’s reviews as empty, and refuses a server-owned field', async () => {
    const guest = await signedInGuest();
    const mine = await call('GET', '/guest/reviews', guest.token);
    expect(mine.status).toBe(200);
    expect(mine.body['reviews']).toHaveLength(0);

    const refused = await call('POST', '/guest/reviews', guest.token, {
      bookingId: NOWHERE,
      rating: 5,
      comment: 'Хангалттай урт сэтгэгдэл байна.',
      hotelId: NOWHERE,
    });
    expect(refused.status).toBe(400);
    expect((refused.body['error'] as { code?: string }).code).toBe('VALIDATION_FAILED');
  }, 120_000);

  it('refuses a rating that is not a whole star and a comment that trims to nothing', async () => {
    const guest = await signedInGuest();
    for (const payload of [
      { rating: 4.5, comment: 'Хангалттай урт сэтгэгдэл байна.' },
      { rating: 0, comment: 'Хангалттай урт сэтгэгдэл байна.' },
      { rating: 5, comment: '     ' },
    ]) {
      const response = await call('POST', '/guest/reviews', guest.token, {
        bookingId: NOWHERE,
        ...payload,
      });
      expect(response.status).toBe(400);
    }
  }, 120_000);

  it('answers NOT_FOUND for a booking that is not the caller’s', async () => {
    const guest = await signedInGuest();
    const response = await call('POST', '/guest/reviews', guest.token, {
      bookingId: NOWHERE,
      rating: 5,
      comment: 'Хангалттай урт сэтгэгдэл байна.',
    });
    expect(response.status).toBe(404);
  }, 120_000);
});

describe('the moderation surface belongs to the Platform realm', () => {
  it('refuses an anonymous caller', async () => {
    for (const [method, path] of [
      ['GET', '/operation/reviews/reports'],
      ['POST', `/operation/reviews/${NOWHERE}/hide`],
      ['POST', `/operation/reviews/${NOWHERE}/restore`],
      ['POST', `/operation/reviews/reports/${NOWHERE}/resolution`],
    ] as const) {
      const response = await call(method, path, undefined, {});
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  }, 120_000);

  it('refuses a Guest session: realms never merge', async () => {
    const guest = await signedInGuest();
    const queue = await call('GET', '/operation/reviews/reports', guest.token);
    expect(queue.status).toBe(403);
    const hide = await call('POST', `/operation/reviews/${NOWHERE}/hide`, guest.token, {
      reason: 'SPAM_FRAUD',
      note: 'Гуйвуулах оролдлого байна.',
    });
    expect(hide.status).toBe(403);
  }, 120_000);
});

describe('the hotel reply surface requires a Hotel session', () => {
  it('refuses an anonymous caller and a Guest one', async () => {
    const guest = await signedInGuest();
    for (const [method, path] of [
      ['GET', `/hotels/${NOWHERE}/reviews`],
      ['POST', `/hotels/${NOWHERE}/reviews/${NOWHERE}/reply`],
      ['POST', `/hotels/${NOWHERE}/reviews/${NOWHERE}/reply/revisions`],
      ['POST', `/hotels/${NOWHERE}/reviews/${NOWHERE}/reply/state`],
    ] as const) {
      // A well-formed body throughout, so what these measure is authority and
      // not the shape check that runs before it.
      const payload = { body: 'Хангалттай урт албан ёсны хариу.', state: 'ACTIVE' };
      const anonymous = await call(method, path, undefined, payload);
      expect({ path, status: anonymous.status }).toEqual({ path, status: 401 });
      // A Guest token authenticates but reaches no hotel: the refusal is the
      // uninformative one a foreign hotel gets.
      const asGuest = await call(method, path, guest.token, payload);
      expect({ path, status: asGuest.status }).toEqual({ path, status: 404 });
    }
  }, 120_000);
});

describe('the public review page needs no session at all', () => {
  it('answers NOT_FOUND for an unpublished hotel, the same as for none', async () => {
    const response = await call('GET', `/public/hotels/${NOWHERE}/reviews`);
    expect(response.status).toBe(404);
  }, 120_000);

  it('refuses an unbounded page', async () => {
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
      const response = await call('GET', `/public/hotels/${NOWHERE}/reviews?${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }
  }, 120_000);
});
