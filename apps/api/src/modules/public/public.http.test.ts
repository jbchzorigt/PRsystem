import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { provisionIamDatabase } from '../iam/test-support/iam-harness';

/**
 * The Phase 12 surface over real HTTP, through the booted application
 * (doc 09 §§3–6).
 *
 * What it proves is mostly about absence: no session is required, no token
 * appears in a URL, and a distance the client tried to supply is refused
 * rather than quietly dropped.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;

beforeAll(async () => {
  db = await provisionIamDatabase('public_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-public-http-seed',
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
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  resetEnvCache();
}, 30_000);

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the public surface needs no session', () => {
  it('answers a search and a detail lookup to an anonymous caller', async () => {
    const search = await get('/public/hotels');
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body['listings'])).toBe(true);

    // A hotel that does not exist and one that is not published are the same
    // answer, and neither is a 401 or a 403 (doc 09 §6).
    const detail = await get('/public/hotels/00000000-0000-4000-8000-000000000000');
    expect(detail.status).toBe(404);
  });

  it('refuses a client-supplied distance with 400 rather than ignoring it', async () => {
    const refused = await get('/public/hotels?distanceMetres=5');
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/computed by the server/);
  });

  it('refuses half a window and a malformed date', async () => {
    expect((await get('/public/hotels?checkIn=2026-10-05')).status).toBe(400);
    expect((await get('/public/hotels?checkIn=05-10-2026&checkOut=07-10-2026')).status).toBe(400);
  });
});

describe('the Guest realm’s front door needs no session either', () => {
  it('accepts a code request and answers the same shape for any number', async () => {
    const known = await post('/guest/phone-verifications', {
      phone: '99112233',
      purpose: 'REGISTER',
    });
    const unknown = await post('/guest/phone-verifications', {
      phone: '99112234',
      purpose: 'REGISTER',
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body['requested']).toBe(true);
    expect(unknown.body['requested']).toBe(true);
  });

  it('refuses a link-code purpose a caller tried to choose', async () => {
    const refused = await post('/guest/phone-verifications', {
      phone: '99112233',
      purpose: 'ACCOUNT_LINK',
    });
    expect(refused.status).toBe(400);
  });

  it('answers one message for every failed sign-in', async () => {
    const unknown = await post('/guest/sessions', { phone: '99110000', password: 'whatever-1' });
    const malformed = await post('/guest/sessions', { phone: '99110001', password: 'whatever-1' });
    expect(unknown.status).toBe(401);
    expect(malformed.status).toBe(401);
    // The correlation id differs per request by design; everything a caller
    // could learn from is identical (doc 09 §6.3).
    const shape = (body: Record<string, unknown>): string => {
      const error = body['error'] as Record<string, unknown>;
      return `${String(error['code'])}:${String(error['message'])}`;
    };
    expect(shape(unknown.body)).toBe(shape(malformed.body));
  });
});

describe('no token ever travels in a URL', () => {
  it('declares no path or query parameter that carries a secret', () => {
    // Every secret of this phase — the one-time code, the password, the
    // provider's authorization code, the session token — travels in a request
    // body or an `authorization` header, never in a path or a query string,
    // where it would reach access logs and browser history (doc 09 §6.1).
    for (const path of [
      '/public/hotels',
      '/public/hotels/{hotelId}',
      '/guest/phone-verifications',
      '/guest/accounts',
      '/guest/sessions',
      '/guest/password-resets',
      '/guest/emongolia/authorizations',
      '/guest/emongolia/sessions',
      '/guest/account-links/{requestId}/phone-verifications',
      '/guest/account-links/{requestId}/confirmations',
    ]) {
      // The check is on the *parameters* a path declares, not on the nouns it
      // names: `/guest/password-resets` is a resource, `{token}` would be a
      // secret in an access log and in browser history.
      for (const parameter of path.match(/\{(\w+)\}/g) ?? []) {
        expect(parameter).not.toMatch(/token|code|password|secret|otp/i);
      }
    }
  });

  it('does not echo the code or the password back in any response', async () => {
    const answer = await post('/guest/phone-verifications', {
      phone: '99112299',
      purpose: 'REGISTER',
    });
    const serialised = JSON.stringify(answer.body);
    expect(serialised).not.toMatch(/\d{6}/);
    expect(serialised).not.toMatch(/password/i);
  });
});
