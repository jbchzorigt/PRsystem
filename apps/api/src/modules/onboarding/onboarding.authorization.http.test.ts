import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { SimulatedPaymentGateway } from '@prsystem/ports';
import type { PaymentGateways } from '@prsystem/ports';
import type { IamHarness, SeededMembership } from '../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../iam/test-support/iam-harness';
import { SimulatedStaffNotification } from '../iam/contracts/staff-notification.port';
import { STAFF_NOTIFICATION } from '../iam/iam.tokens';
import { PAYMENT_GATEWAYS } from './onboarding.tokens';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { attachOnboardingHarness } from './test-support/onboarding-harness';

/**
 * R1 — Hotel and Operation authorization on the subscription surface, over
 * real HTTP.
 *
 * `SessionGuard` authenticates; it authorizes nothing. Every route here has to
 * resolve the actor's live membership and session scope before it binds the
 * hotel in the path, then run the Phase 04 pipeline against the canonical
 * action — `hotel.subscription.pay` for money, the always-available notice for
 * reading the state. Two hotels, six kinds of caller, and the refusals are the
 * same `NOT_FOUND` with no side effect.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let db: TestDatabase;
let iam: IamHarness;
let onboarding: OnboardingHarness;
let qpay: SimulatedPaymentGateway;

let hotelA: string;
let hotelB: string;
let adminA: SeededMembership;
let managerA: SeededMembership;
let receptionA: SeededMembership;
let suspendedA: SeededMembership;
let staleA: SeededMembership;
let adminB: SeededMembership;

const UNKNOWN_HOTEL = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

beforeAll(async () => {
  db = await provisionIamDatabase('onboarding_authz_http');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-onboarding-authz-seed',
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
  const gateways = app.get<PaymentGateways>(PAYMENT_GATEWAYS);
  qpay = gateways.gateway('QPAY') as SimulatedPaymentGateway;
  expect(qpay).toBeInstanceOf(SimulatedPaymentGateway);

  iam = attachIamHarness(db, 'onboarding_authz_http', { notifications });
  onboarding = attachOnboardingHarness(db, 'onboarding_authz_http', {
    keySeed: 'synthetic-onboarding-authz-seed',
    iam,
  });

  hotelA = await iam.createHotel('Authz Hotel A', 'P25');
  hotelB = await iam.createHotel('Authz Hotel B', 'P25');
  adminA = await iam.seedMembership({
    hotelId: hotelA,
    email: 'admin@authz-a.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  managerA = await iam.seedMembership({
    hotelId: hotelA,
    email: 'manager@authz-a.test',
    roles: ['MANAGER'],
  });
  receptionA = await iam.seedMembership({
    hotelId: hotelA,
    email: 'reception@authz-a.test',
    roles: ['RECEPTION'],
  });
  suspendedA = await iam.seedMembership({
    hotelId: hotelA,
    email: 'suspended@authz-a.test',
    roles: ['HOTEL_ADMIN'],
  });
  await iam.admin.query(
    `UPDATE platform.staff_membership
        SET state = 'SUSPENDED', state_changed_at = now(), membership_revision = membership_revision + 1
      WHERE membership_id = $1`,
    [suspendedA.membershipId],
  );
  staleA = await iam.seedMembership({
    hotelId: hotelA,
    email: 'stale@authz-a.test',
    roles: ['HOTEL_ADMIN'],
  });
  adminB = await iam.seedMembership({
    hotelId: hotelB,
    email: 'admin@authz-b.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 120000);

afterAll(async () => {
  await app?.close();
  await onboarding?.close();
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

async function call(
  method: 'GET' | 'POST',
  path: string,
  token: string | undefined,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'idempotency-key': `authz-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function sideEffects(hotelId: string): Promise<{ intents: number; hotelAudit: number }> {
  const intents = await iam.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM platform.subscription_billing_intent WHERE hotel_id = $1`,
    [hotelId],
  );
  const audit = await iam.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit.platform_event
      WHERE hotel_id = $1 AND action LIKE 'subscription.%'`,
    [hotelId],
  );
  return {
    intents: Number(intents.rows[0]?.n ?? '0'),
    hotelAudit: Number(audit.rows[0]?.n ?? '0'),
  };
}

const RENEWAL = { targetPackage: 'P25', termMonths: 1, provider: 'QPAY' };
const UPGRADE = { targetPackage: 'P30', provider: 'QPAY' };

describe('the Hotel Admin', () => {
  it('reads the state, renews and upgrades their own hotel', async () => {
    const token = await signIn(adminA);
    const status = await call('GET', `/hotels/${hotelA}/subscription`, token);
    expect(status.status).toBe(200);
    expect(status.body['effectivePackage']).toBe('P25');

    const renewal = await call('POST', `/hotels/${hotelA}/subscription/renewals`, token, RENEWAL);
    expect(renewal.status).toBe(201);
    expect(renewal.body['providerInvoiceId']).toBeDefined();
  });
});

describe('everyone else sees the same NOT_FOUND and leaves no trace', () => {
  const cases: [string, () => Promise<string>, () => string][] = [
    ['a Manager', () => signIn(managerA), () => hotelA],
    ['a Reception member', () => signIn(receptionA), () => hotelA],
    ['a suspended membership', () => signIn(suspendedA), () => hotelA],
    ['a foreign hotel id', () => signIn(adminB), () => hotelA],
    ['an unknown hotel id', () => signIn(adminA), () => UNKNOWN_HOTEL],
  ];

  for (const [label, token, target] of cases) {
    it(`${label} cannot renew or upgrade`, async () => {
      const before = await sideEffects(target());
      const invoicesBefore = qpay.invoiceCount;
      const bearer = await token();
      for (const [path, body] of [
        [`/hotels/${target()}/subscription/renewals`, RENEWAL],
        [`/hotels/${target()}/subscription/upgrades`, UPGRADE],
      ] as const) {
        const response = await call('POST', path, bearer, body);
        expect({
          path,
          status: response.status,
          code: (response.body['error'] as { code?: string })?.code,
        }).toEqual({ path, status: 404, code: 'NOT_FOUND' });
      }
      expect(await sideEffects(target())).toEqual(before);
      expect(qpay.invoiceCount).toBe(invoicesBefore);
    });
  }

  it('a suspended membership, a foreign hotel and an unknown hotel cannot even read the state', async () => {
    for (const [bearer, target] of [
      [await signIn(suspendedA), hotelA],
      [await signIn(adminB), hotelA],
      [await signIn(adminA), UNKNOWN_HOTEL],
    ] as const) {
      const response = await call('GET', `/hotels/${target}/subscription`, bearer);
      expect(response.status).toBe(404);
    }
    // Reading the state is what the hard-lock notice needs, so any active
    // member of the hotel may do it — but nothing more.
    for (const member of [managerA, receptionA]) {
      const response = await call('GET', `/hotels/${hotelA}/subscription`, await signIn(member));
      expect(response.status).toBe(200);
    }
  });

  it('a stale session scope grant is refused although the membership is still active', async () => {
    const bearer = await signIn(staleA);
    const fresh = await call('GET', `/hotels/${hotelA}/subscription`, bearer);
    expect(fresh.status).toBe(200);
    // The membership moves on after the session was issued.
    await iam.admin.query(
      `UPDATE platform.staff_membership SET membership_revision = membership_revision + 1
        WHERE membership_id = $1`,
      [staleA.membershipId],
    );
    const stale = await call('GET', `/hotels/${hotelA}/subscription`, bearer);
    expect(stale.status).toBe(404);
    const renewal = await call('POST', `/hotels/${hotelA}/subscription/renewals`, bearer, RENEWAL);
    expect(renewal.status).toBe(404);
  });

  it('an unauthenticated request is refused before any of it', async () => {
    const response = await call(
      'POST',
      `/hotels/${hotelA}/subscription/renewals`,
      undefined,
      RENEWAL,
    );
    expect(response.status).toBe(401);
  });
});

describe('the eBarimt manual queue is an Operation surface', () => {
  it('is not reachable through a Hotel session route at all', async () => {
    const bearer = await signIn(adminA);
    const response = await call('GET', `/hotels/${hotelA}/subscription/ebarimt`, bearer);
    expect(response.status).toBe(404);
  });

  it('refuses a Hotel-realm session, an unpermitted operator and a stale step-up; audits the permitted one', async () => {
    const hotelBearer = await signIn(adminA);
    expect((await call('GET', '/operation/ebarimt/manual-queue', hotelBearer)).status).toBe(404);

    const reader = await onboarding.operationActor({ permissions: ['OPERATION_READ'] });
    expect((await call('GET', '/operation/ebarimt/manual-queue', reader.token)).status).toBe(404);

    const stale = await onboarding.operationActor({
      permissions: ['SUBSCRIPTION_EBARIMT_RETRY'],
      stepUpAgeSeconds: 30 * 60,
    });
    expect((await call('GET', '/operation/ebarimt/manual-queue', stale.token)).status).toBe(412);

    const operator = await onboarding.operationActor({
      permissions: ['SUBSCRIPTION_EBARIMT_RETRY'],
    });
    const listed = await call('GET', '/operation/ebarimt/manual-queue', operator.token);
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body['items'])).toBe(true);
    const audited = await iam.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.platform_event
        WHERE action = 'subscription.ebarimt.queue_read' AND actor_ref = $1`,
      [operator.accountId],
    );
    expect(Number(audited.rows[0]?.n)).toBe(1);
  });
});
