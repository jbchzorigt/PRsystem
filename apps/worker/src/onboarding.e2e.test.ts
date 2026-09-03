import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { LoginPrincipal } from '@prsystem/db';
import { createLogger } from '@prsystem/telemetry';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type {
  SimulatedPaymentGateway,
  SimulatedPhoneVerification,
  PaymentGateways,
} from '@prsystem/ports';
import {
  PAYMENT_GATEWAYS,
  PHONE_VERIFICATION,
  createOnboardingWorkerRuntime,
} from '@prsystem/api/onboarding-worker';
import type { OnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import { QUEUE_NAMES, connectionFromUrl } from './queues';
import { createOnboardingWorkers, scheduleOnboardingSweeps } from './jobs/onboarding';

/**
 * R3 — from the provider callback, over HTTP, through the real BullMQ consumer,
 * to exactly one of everything.
 *
 * The API deployment and the worker deployment are both real here: the API is
 * booted through `createApp`, the worker consumers are the ones `main.ts`
 * registers, and Redis is the compose service. PostgreSQL is the job record —
 * the Redis message is a signal, and the sweep proves it is only that.
 */

const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://127.0.0.1:56379';
const KMS_SEED = 'synthetic-onboarding-e2e-seed';

let db: TestDatabase;
let admin: Pool;
let app: NestFastifyApplication;
let baseUrl: string;
let runtime: OnboardingWorkerRuntime;
let workers: readonly Worker[];
let queue: Queue;
let gateway: SimulatedPaymentGateway;
let phone: SimulatedPhoneVerification;

const logger = createLogger({ level: 'error', serviceName: 'onboarding-e2e' });

beforeAll(async () => {
  db = await createTestDatabase('onboarding_e2e');
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  admin = db.pool;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED,
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    REDIS_URL,
    QUEUE_PREFIX: `e2e-${db.name}`,
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_BUCKET: 'prsystem-local',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();

  const { createApp } = await import('@prsystem/api/bootstrap');
  const started = await createApp({ port: 0 });
  app = started.app;
  baseUrl = `http://127.0.0.1:${String(started.port)}`;
  gateway = app.get<PaymentGateways>(PAYMENT_GATEWAYS).gateway('QPAY') as SimulatedPaymentGateway;
  phone = app.get<SimulatedPhoneVerification>(PHONE_VERIFICATION);

  runtime = createOnboardingWorkerRuntime({
    databaseUrl: db.loginUrl(TEST_LOGIN_PRINCIPALS.worker),
    appEnv: 'ci',
    kmsAdapter: 'local',
    kmsSeed: KMS_SEED,
  });
  const connection = connectionFromUrl(REDIS_URL);
  // A namespace of its own, so two test runs on one Redis never see each
  // other's jobs.
  const prefix = `e2e-${db.name}`;
  workers = createOnboardingWorkers(connection, runtime, logger, { prefix });
  queue = new Queue(QUEUE_NAMES.provisioning, { connection, prefix });
  await scheduleOnboardingSweeps(connection, { prefix, everyMs: 60_000 });
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
}, 180000);

afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await queue?.close();
  await runtime?.close();
  await app?.close();
  await db?.drop();
  resetEnvCache();
}, 60000);

async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitFor(predicate: () => Promise<boolean>, ms = 15000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not reached in time');
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const result = await admin.query<{ n: string }>(sql, values);
  return Number(result.rows[0]?.n ?? '0');
}

describe('provider callback → worker → one hotel', () => {
  it('provisions exactly one of everything through the consumer the worker registers', async () => {
    const created = await post('/onboarding/applications', {
      ownerType: 'CITIZEN',
      ownerDisplayName: 'E2E Applicant',
      registrationNumber: 'E2E990011',
      contactPhone: '+97699000123',
      subscriptionContactPhone: '+97699000123',
      adminEmail: 'e2e-owner@example.test',
      hotelDisplayName: 'E2E Hotel',
      hotelPublicPhone: '+97611000123',
      district: 'Sukhbaatar',
      khoroo: '1-r khoroo',
      addressLine: 'E2E address 1',
      latitudeMicro: 47_918_000,
      longitudeMicro: 106_917_000,
      packageCode: 'P20',
      termMonths: 3,
    });
    expect(created.status).toBe(201);
    const applicationId = created.body['applicationId'] as string;
    const token = created.body['applicantToken'] as string;
    const applicant = { 'x-onboarding-token': token };

    expect((await post('/onboarding/applications/phone-verification', {}, applicant)).status).toBe(
      202,
    );
    const code = phone.codeFor(applicationId);
    expect(code).toBeDefined();
    expect(
      (await post('/onboarding/applications/phone-verification/confirm', { code }, applicant)).body,
    ).toEqual({ verified: true });
    const resolved = await post('/onboarding/applications/owner-resolution', {}, applicant);
    expect(resolved.body['proofRequired']).toBe(false);

    const invoice = await post(
      '/onboarding/applications/invoice',
      { provider: 'QPAY' },
      {
        ...applicant,
        'idempotency-key': 'e2e-invoice-000001',
      },
    );
    expect(invoice.status).toBe(201);
    const providerInvoiceId = invoice.body['providerInvoiceId'] as string;
    const paymentId = gateway.pay(providerInvoiceId, new Date());

    const callback = await post('/onboarding/payments/qpay/callback', {
      providerInvoiceId,
      providerPaymentId: paymentId,
      signature: gateway.signatureFor(providerInvoiceId),
    });
    expect(callback.status).toBe(202);

    // The durable record first: the application carries the job.
    const job = await admin.query<{ state: string; available: boolean }>(
      `SELECT state, (provision_available_at <= now()) AS available
         FROM platform.onboarding_application WHERE application_id = $1`,
      [applicationId],
    );
    expect(job.rows[0]).toEqual({ state: 'PAID_PENDING_PROVISIONING', available: true });

    // Then the consumer. The signal reaches the worker through Redis; the
    // worker provisions from the row, not from the message.
    try {
      await waitFor(
        async () =>
          (await count(
            `SELECT count(*)::text AS n FROM platform.onboarding_application
              WHERE application_id = $1 AND state = 'PROVISIONED'`,
            [applicationId],
          )) === 1,
      );
    } catch (error) {
      // The row is the job record: say what it recorded, not just that it is late.
      const row = await admin.query(
        `SELECT state, provision_attempts, provision_last_error, provision_claim_token IS NOT NULL AS claimed
           FROM platform.onboarding_application WHERE application_id = $1`,
        [applicationId],
      );
      throw new Error(`${(error as Error).message}: ${JSON.stringify(row.rows[0])}`);
    }
    const hotel = await admin.query<{ hotel_id: string }>(
      `SELECT provisioned_hotel_id AS hotel_id FROM platform.onboarding_application
        WHERE application_id = $1`,
      [applicationId],
    );
    const hotelId = hotel.rows[0]?.hotel_id as string;

    // Sweeps for delivery and receipts, through the same consumers.
    await queue.add('sweep', { kind: 'sweep' });
    const deliveries = new Queue(QUEUE_NAMES.activationDelivery, {
      connection: connectionFromUrl(REDIS_URL),
      prefix: `e2e-${db.name}`,
    });
    const receipts = new Queue(QUEUE_NAMES.ebarimtIssuance, {
      connection: connectionFromUrl(REDIS_URL),
      prefix: `e2e-${db.name}`,
    });
    try {
      await deliveries.add('sweep', { kind: 'sweep' });
      await receipts.add('sweep', { kind: 'sweep' });
      await waitFor(
        async () =>
          (await count(
            `SELECT count(*)::text AS n FROM platform.activation_delivery
              WHERE hotel_id = $1 AND state = 'SENT'`,
            [hotelId],
          )) === 1 &&
          (await count(
            `SELECT count(*)::text AS n FROM platform.ebarimt_issuance
              WHERE hotel_id = $1 AND state = 'ISSUED'`,
            [hotelId],
          )) === 1,
      );
    } finally {
      await deliveries.close();
      await receipts.close();
    }

    for (const [what, sql] of [
      ['hotel', `SELECT count(*)::text AS n FROM platform.hotel WHERE hotel_id = $1`],
      [
        'subscription',
        `SELECT count(*)::text AS n FROM platform.hotel_subscription WHERE hotel_id = $1`,
      ],
      [
        'owner link',
        `SELECT count(*)::text AS n FROM platform.hotel_owner_link WHERE hotel_id = $1`,
      ],
      [
        'primary admin',
        `SELECT count(*)::text AS n FROM platform.staff_membership WHERE hotel_id = $1 AND is_primary_admin`,
      ],
      [
        'default drawer',
        `SELECT count(*)::text AS n FROM platform.cash_location WHERE hotel_id = $1 AND is_default_drawer`,
      ],
      [
        'activation delivery',
        `SELECT count(*)::text AS n FROM platform.activation_delivery WHERE hotel_id = $1`,
      ],
      [
        'provisioned event',
        `SELECT count(*)::text AS n FROM platform.outbox_event WHERE hotel_id = $1 AND event_type = 'onboarding.hotel.provisioned'`,
      ],
      [
        'receipt intent',
        `SELECT count(*)::text AS n FROM platform.ebarimt_issuance WHERE hotel_id = $1`,
      ],
    ] as const) {
      expect({ what, n: await count(sql, [hotelId]) }).toEqual({ what, n: 1 });
    }
    expect(await count(`SELECT count(*)::text AS n FROM platform.subscription_owner`)).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM platform.hotel`)).toBe(1);
  }, 60000);

  it('the sweep recovers an expired claim and a crash while PROVISIONING, and stops after five attempts', async () => {
    const created = await post('/onboarding/applications', {
      ownerType: 'CITIZEN',
      ownerDisplayName: 'E2E Crash',
      registrationNumber: 'E2E990022',
      contactPhone: '+97699000124',
      subscriptionContactPhone: '+97699000124',
      adminEmail: 'e2e-crash@example.test',
      hotelDisplayName: 'E2E Crash Hotel',
      hotelPublicPhone: '+97611000124',
      district: 'Sukhbaatar',
      khoroo: '2-r khoroo',
      addressLine: 'E2E address 2',
      latitudeMicro: 47_900_000,
      longitudeMicro: 106_900_000,
      packageCode: 'P20',
      termMonths: 1,
    });
    const applicationId = created.body['applicationId'] as string;
    const applicant = { 'x-onboarding-token': created.body['applicantToken'] as string };
    await post('/onboarding/applications/phone-verification', {}, applicant);
    await post(
      '/onboarding/applications/phone-verification/confirm',
      { code: phone.codeFor(applicationId) },
      applicant,
    );
    await post('/onboarding/applications/owner-resolution', {}, applicant);

    // Pause the consumers so the signal is not acted on, and break provisioning
    // at the boundary so every attempt fails.
    await Promise.all(workers.map((worker) => worker.pause()));
    await admin.query(`
      CREATE OR REPLACE FUNCTION platform.e2e_trap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'e2e trap' USING ERRCODE = 'P0001'; END $$;
      CREATE TRIGGER e2e_trap BEFORE INSERT ON platform.cash_location
        FOR EACH ROW EXECUTE FUNCTION platform.e2e_trap();`);
    try {
      const invoice = await post(
        '/onboarding/applications/invoice',
        { provider: 'QPAY' },
        {
          ...applicant,
          'idempotency-key': 'e2e-invoice-000002',
        },
      );
      const providerInvoiceId = invoice.body['providerInvoiceId'] as string;
      const paymentId = gateway.pay(providerInvoiceId, new Date());
      await post('/onboarding/payments/qpay/callback', {
        providerInvoiceId,
        providerPaymentId: paymentId,
        signature: gateway.signatureFor(providerInvoiceId),
      });

      // A crash: claimed, PROVISIONING, lease expired, nothing built.
      await admin.query(
        `UPDATE platform.onboarding_application
            SET state = 'PROVISIONING', state_changed_at = now(), state_reason = 'crash',
                provision_attempts = 1, provision_claim_token = gen_random_uuid(),
                provision_claimed_until = now() - interval '1 second', revision = revision + 1
          WHERE application_id = $1`,
        [applicationId],
      );

      // Every sweep: reclaim, fail at the boundary, persist a real backoff.
      let lastAvailable: Date | undefined;
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        await admin.query(
          `UPDATE platform.onboarding_application SET provision_available_at = now(), revision = revision + 1
            WHERE application_id = $1`,
          [applicationId],
        );
        const pass = await runtime.provisionDue();
        expect(pass.claimed).toBe(1);
        const row = await admin.query<{
          state: string;
          attempts: number;
          available_at: Date;
          claim: string | null;
        }>(
          `SELECT state, provision_attempts AS attempts, provision_available_at AS available_at,
                  provision_claim_token AS claim
             FROM platform.onboarding_application WHERE application_id = $1`,
          [applicationId],
        );
        expect(row.rows[0]?.state).toBe('PROVISIONING_FAILED');
        expect(Number(row.rows[0]?.attempts)).toBe(attempt);
        expect(row.rows[0]?.claim).toBeNull();
        // The backoff is persisted and grows: the next availability is in the future.
        expect(row.rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now());
        const availableAt = row.rows[0]?.available_at as Date;
        if (lastAvailable !== undefined) {
          expect(availableAt.getTime() - Date.now()).toBeGreaterThan(
            (lastAvailable.getTime() - Date.now()) / 2,
          );
        }
        lastAvailable = availableAt;
      }

      // Exhausted: the sweep no longer sees it, however available it is.
      await admin.query(
        `UPDATE platform.onboarding_application SET provision_available_at = now(), revision = revision + 1
          WHERE application_id = $1`,
        [applicationId],
      );
      const exhausted = await runtime.provisionDue();
      expect(exhausted.claimed).toBe(0);
      expect(
        await count(
          `SELECT count(*)::text AS n FROM platform.hotel h
             JOIN platform.onboarding_application a ON a.provisioned_hotel_id = h.hotel_id
            WHERE a.application_id = $1`,
          [applicationId],
        ),
      ).toBe(0);
    } finally {
      await admin.query(
        `DROP TRIGGER e2e_trap ON platform.cash_location; DROP FUNCTION platform.e2e_trap();`,
      );
      await Promise.all(workers.map((worker) => worker.resume()));
    }
  }, 60000);
});
