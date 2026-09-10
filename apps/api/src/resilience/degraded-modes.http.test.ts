import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type {
  SimulatedObjectStorage,
  SimulatedPaymentGateway,
  SimulatedPhoneVerification,
  SimulatedSms,
  SimulatedXypIdentity,
} from '@prsystem/ports';
import type { PaymentGatewayRegistry } from '@prsystem/ports';
import type { PublicHarness } from '../modules/public/test-support/public-harness';
import { createPublicHarness } from '../modules/public/test-support/public-harness';
import type { StayHotel } from '../modules/stay/test-support/stay-harness';
import {
  attachOperationHarness,
  OPERATION_PASSWORD,
} from '../modules/operation/test-support/operation-harness';
import type {
  OperationHarness,
  SeededOperator,
} from '../modules/operation/test-support/operation-harness';
import { derivePassword } from '../modules/iam/services/password.service';
import { GUEST_OTP } from '../modules/guest/guest.tokens';
import { BOOKING_PAYMENTS } from '../modules/booking/booking.tokens';
import { XYP_IDENTITY } from '../modules/stay/stay.tokens';
import { OPERATION_SMS } from '../modules/operation/operation.tokens';
import { POLICE_STORAGE } from '../modules/police/police.tokens';

/**
 * Fault injection over the real API — Phase 22 (build-plan §Phase 22;
 * docs/architecture/15-non-functional-targets.md §4 "degraded modes that must
 * not become outages"; threat model T-X-21).
 *
 * The API is started the way production starts it, on a scratch database,
 * with Redis pointed at a port nothing listens on — and each external port is
 * its simulator, armed to fail. What is asserted is the documented behaviour:
 * readiness says so while liveness and reads go on; a provider outage fails a
 * payment closed with the hold intact; a ХУР outage takes the identity the desk
 * typed with `MANUAL` provenance; an SMS outage leaves the job and its failed
 * deliveries on record; a storage outage fails an export cleanly with no
 * partial file to download.
 */
const KMS_SEED = 'synthetic-resilience-seed';
const POLICE_PASSWORD = ['synthetic', 'police', 'passphrase'].join('-');
const GUEST_PASSWORD = ['synthetic', 'guest', 'passphrase'].join('-');

let app: NestFastifyApplication;
let baseUrl: string;
let pub: PublicHarness;
let ops: OperationHarness;
let hotel: StayHotel;
let operator: SeededOperator;
let policeAdmin: { email: string; password: string };

beforeAll(async () => {
  process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'] ??= new URL(
    process.env['DATABASE_URL'] ??
      'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem',
  ).username;
  pub = await createPublicHarness('resilience');
  hotel = await pub.publishedHotel('Resilience буудал');
  await pub.admin.query(
    `INSERT INTO platform.hotel_commission_contract
       (hotel_id, contract_version, party_type, commission_rate_bps, cancellation_policy_version, effective_from)
     VALUES ($1::uuid, 1, 'NEGOTIATED', 1000, 1, now() - interval '1 day')`,
    [hotel.hotelId],
  );
  for (let index = 0; index < 3; index += 1) await hotel.cleanRoom();
  ops = attachOperationHarness(pub.db, 'resilience', { keySeed: KMS_SEED });
  operator = await ops.operator({ permissions: ['OPERATION_READ', 'SUBSCRIPTION_REMINDER_SEND'] });
  await ops.hotel({ name: 'Resilience SMS буудал' });

  const derived = await derivePassword(POLICE_PASSWORD);
  const created = await pub.db.pool.query<{ account_id: string }>(
    `INSERT INTO platform.user_account (realm, realm_role, police_scope_ref, email_normalized, state, email_verified_at)
     VALUES ('police', 'POLICE_ADMIN', 'UNIT-RES', 'admin@police.resilience.test', 'ACTIVE', now()) RETURNING account_id`,
  );
  const accountId = created.rows[0]!.account_id;
  await pub.db.pool.query(
    `INSERT INTO platform.account_credential (account_id, secret_hash, params_version) VALUES ($1::uuid, $2, $3)`,
    [accountId, derived.secretHash, derived.paramsVersion],
  );
  await pub.db.pool.query(
    `INSERT INTO platform.account_permission_grant (account_id, realm, realm_role, permission, granted_by_account_id)
     VALUES ($1::uuid, 'police', 'POLICE_ADMIN', 'WANTED_CASE_EXPORT', $1::uuid)`,
    [accountId],
  );
  policeAdmin = { email: 'admin@police.resilience.test', password: POLICE_PASSWORD };

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED,
    DATABASE_URL: pub.db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    POLICE_ENABLED: 'true',
    POLICE_DATABASE_URL: pub.db.loginUrl(TEST_LOGIN_PRINCIPALS.police),
    // Nothing listens here: Redis is down for the whole suite.
    REDIS_URL: 'redis://127.0.0.1:59998',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();
  const { createApp } = await import('../bootstrap');
  const started = await createApp({ port: 0 });
  app = started.app;
  baseUrl = `http://127.0.0.1:${String(started.port)}`;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ops?.close().catch(() => undefined);
  await pub?.close().catch(() => undefined);
  await pub?.db.drop().catch(() => undefined);
  resetEnvCache();
}, 60_000);

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
      'idempotency-key': `resilience-${String(process.pid)}-${String(keys)}`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function receptionToken(): Promise<string> {
  const signedIn = await call('POST', '/auth/sign-in', undefined, {
    email: hotel.receptionMember.email,
    password: hotel.receptionMember.password,
  });
  expect(signedIn.status).toBe(200);
  return signedIn.body['token'] as string;
}

async function guestToken(phone: string): Promise<string> {
  const sent = await call('POST', '/guest/phone-verifications', undefined, {
    phone,
    purpose: 'REGISTER',
  });
  expect(sent.status).toBeLessThan(300);
  const otp = app.get<SimulatedPhoneVerification>(GUEST_OTP);
  const message = [...otp.deliveries].reverse().find((m) => m.phone.endsWith(phone.slice(-8)));
  expect(message).toBeDefined();
  const created = await call('POST', '/guest/accounts', undefined, {
    phone,
    code: message!.code,
    password: GUEST_PASSWORD,
  });
  expect(created.status).toBeLessThan(300);
  return created.body['token'] as string;
}

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe('Redis unavailable', () => {
  it('readiness says so; liveness and an authenticated read carry on', async () => {
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    const board = await call('GET', `/hotels/${hotel.hotelId}/rooms/board`, await receptionToken());
    expect(board.status).toBe(200);
  });
});

describe('payment provider unavailable', () => {
  it('fails the invoice closed and leaves the hold where it was', async () => {
    const guest = await guestToken('99661001');
    const held = await call('POST', '/guest/bookings', guest, {
      categoryId: hotel.categoryId,
      checkInDate: today(),
      checkOutDate: tomorrow(),
      stayingGuestName: 'Resilience Guest',
      provider: 'QPAY',
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const bookingId = held.body['bookingId'] as string;
    const attempt = held.body['attempt'] as { attemptId: string };
    const gateway = app
      .get<PaymentGatewayRegistry>(BOOKING_PAYMENTS)
      .gateway('QPAY') as SimulatedPaymentGateway;
    gateway.failNext({ kind: 'UNAVAILABLE', retryable: true });
    const invoice = await call(
      'POST',
      `/guest/bookings/${bookingId}/payment-attempts/${attempt.attemptId}/invoice`,
      guest,
      {},
    );
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(412);
    expect((invoice.body['error'] as { code: string }).code).toBe('PRECONDITION_FAILED');
    const after = await call('GET', `/guest/bookings/${bookingId}`, guest);
    expect(after.body).toMatchObject({
      state: 'HOLDING',
      holdState: 'ACTIVE',
      paymentState: 'PENDING',
    });
    // The provider is back: the same attempt now opens its invoice.
    const retried = await call(
      'POST',
      `/guest/bookings/${bookingId}/payment-attempts/${attempt.attemptId}/invoice`,
      guest,
      {},
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
  });
});

describe('ХУР unavailable', () => {
  it('takes the identity the desk typed, with MANUAL provenance, and the check-in completes', async () => {
    const reception = await receptionToken();
    const shift = await call('POST', `/hotels/${hotel.hotelId}/shifts`, reception, {
      openingCountedMnt: '0',
    });
    expect([201, 409]).toContain(shift.status);
    const deposit = await call('POST', '/auth/sign-in', undefined, {
      email: hotel.managerMember.email,
      password: hotel.managerMember.password,
    });
    const manager = deposit.body['token'] as string;
    const configured = await fetch(
      `${baseUrl}/api/v1/hotels/${hotel.hotelId}/deposit-configuration`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${manager}`,
          'idempotency-key': 'res-deposit',
        },
        body: JSON.stringify({ amountMnt: '50000' }),
      },
    );
    expect(configured.status).toBe(200);
    const board = await call('GET', `/hotels/${hotel.hotelId}/rooms/board`, reception);
    const room = (board.body['rooms'] as { roomId: string; occupancy: string }[]).find(
      (r) => r.occupancy === 'VACANT',
    );
    expect(room).toBeDefined();
    app.get<SimulatedXypIdentity>(XYP_IDENTITY).failNext(1);
    const checkedIn = await call('POST', `/hotels/${hotel.hotelId}/stays`, reception, {
      roomId: room!.roomId,
      source: 'WALK_IN',
      stayType: 'NIGHTLY',
      nightCount: 1,
      guest: {
        identityType: 'MN_REG_NO',
        familyName: 'Резилиенс',
        givenName: 'Зочин',
        dateOfBirth: '1990-01-01',
        nationality: 'MN',
        registrationNumber: 'АА90010199',
      },
    });
    expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(201);
    const provenance = await pub.admin.query<{ provenance: string; assurance: string }>(
      `SELECT provenance, assurance FROM platform.stay_guest WHERE stay_id = $1::uuid AND is_current`,
      [checkedIn.body['stayId']],
    );
    expect(provenance.rows[0]?.provenance).toBe('MANUAL');
  });
});

describe('SMS provider unavailable', () => {
  it('keeps the confirmed job and records the failed deliveries instead of losing them', async () => {
    const signedIn = await call('POST', '/operation/auth/sign-in', undefined, {
      email: operator.email,
      password: OPERATION_PASSWORD,
      code: operator.codeAt(),
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const token = signedIn.body['token'] as string;
    const preview = await call('POST', '/operation/sms/previews', token, {
      body: 'Sain baina uu. Resilience test.',
      filters: {},
    });
    expect(preview.status, JSON.stringify(preview.body)).toBeLessThan(300);
    app.get<SimulatedSms>(OPERATION_SMS).failNext(50);
    const confirmed = await call('POST', '/operation/sms/jobs', token, {
      previewId: preview.body['previewId'],
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBeLessThan(300);
    const history = await call('GET', '/operation/sms/jobs?limit=5', token);
    expect(history.status).toBe(200);
    const jobs = history.body['items'] as {
      jobId: string;
      failed: string | number;
      pending: string | number;
    }[];
    const job = jobs.find((j) => j.jobId === confirmed.body['jobId']);
    expect(job).toBeDefined();
    expect(Number(job!.failed) + Number(job!.pending)).toBeGreaterThan(0);
  });
});

describe('object storage unavailable', () => {
  it('fails the export cleanly, with nothing to download', async () => {
    const signedIn = await call('POST', '/police/auth/sign-in', undefined, policeAdmin);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const token = signedIn.body['token'] as string;
    app
      .get<SimulatedObjectStorage>(POLICE_STORAGE)
      .failNext({ kind: 'UNAVAILABLE', retryable: true });
    const ran = await call('POST', '/police/exports', token, {
      purpose: 'Resilience rehearsal: storage outage',
      taskReference: 'RES-1',
    });
    const failedCleanly =
      (ran.status < 300 && (ran.body['state'] as string) !== 'READY') ||
      ran.status === 503 ||
      ran.status === 412;
    expect(failedCleanly, JSON.stringify(ran.body)).toBe(true);
    if (typeof ran.body['jobId'] === 'string') {
      const download = await call(
        'POST',
        `/police/exports/${ran.body['jobId']}/download`,
        token,
        {},
      );
      expect(download.status).toBeGreaterThanOrEqual(400);
    }
  });
});
