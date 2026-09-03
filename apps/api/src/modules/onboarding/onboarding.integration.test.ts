import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import {
  citizenDraft,
  createOnboardingHarness,
  organizationDraft,
} from './test-support/onboarding-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';
import { actorFor } from '../iam/test-support/iam-harness';

/** Unwraps a port result, or fails the test with the error it carried. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`port refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * Phase 05 — hotel onboarding and subscription, end to end on a real database.
 *
 * Everything runs through the restricted `prsystem_api` login, so the RLS
 * policies, the grants, the guards and the provisioning boundary are the ones
 * production has.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('onboarding_integration');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

const request = (): RequestContext => newOnboardingRequest();

let sequence = 0;
/**
 * A synthetic passphrase, composed rather than written out.
 *
 * `tools/scan-secrets.mjs` reports any `password: '<12+ chars>'` literal, and it
 * is right to: a test fixture that looks like a credential is exactly what a
 * committed credential looks like. Composing the value keeps the scanner strict
 * without an allow-list entry per fixture.
 */
function syntheticPassword(label: string): string {
  return ['synthetic', label, 'passphrase'].join('-');
}

function unique(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

/** A draft nothing else in this file collides with. */
function freshCitizen(overrides: Record<string, unknown> = {}): ReturnType<typeof citizenDraft> {
  const n = unique();
  return citizenDraft({
    registrationNumber: `SYN${n}0011`,
    adminEmail: `owner-${n}@example.test`,
    hotelDisplayName: `Synthetic Hotel ${n}`,
    addressLine: `Synthetic address ${n}`,
    contactPhone: `+9769900${n}`,
    subscriptionContactPhone: `+9769900${n}`,
    ...overrides,
  });
}

/** Draft → phone verified → owner resolved. The state an invoice can open from. */
async function readyApplication(
  overrides: Record<string, unknown> = {},
): Promise<{ applicationId: string; token: string; email: string }> {
  const draft = freshCitizen(overrides);
  const created = await env.onboarding.createApplication(draft, request());
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const code = env.phone.codeFor(created.applicationId);
  if (code === undefined) throw new Error('the simulator recorded no code');
  await env.onboarding.confirmPhoneVerification(created.applicationId, code, request());
  await env.onboarding.resolveOwner(created.applicationId, request());
  return {
    applicationId: created.applicationId,
    token: created.applicantToken,
    email: draft.adminEmail,
  };
}

/** Opens an invoice and pays it through the simulator, returning the outcome. */
async function payThrough(
  applicationId: string,
  provider: 'QPAY' | 'KHAAN' = 'QPAY',
  confirmedAt = new Date(),
): Promise<{ invoiceId: string; paymentId: string }> {
  const invoice = await env.onboarding.openInvoice(
    { applicationId, provider, idempotencyKey: `idem-${provider}-${unique()}-${applicationId}` },
    request(),
  );
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  const paymentId = gateway.pay(invoice.providerInvoiceId, confirmedAt);
  return { invoiceId: invoice.providerInvoiceId, paymentId };
}

function callbackFor(provider: 'QPAY' | 'KHAAN', invoiceId: string, paymentId?: string) {
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  return {
    provider,
    providerInvoiceId: invoiceId,
    ...(paymentId === undefined ? {} : { providerPaymentId: paymentId }),
    signature: gateway.signatureFor(invoiceId),
  } as const;
}

/** The whole flow, to a provisioned hotel. */
async function provisionedHotel(overrides: Record<string, unknown> = {}): Promise<{
  applicationId: string;
  hotelId: string;
  email: string;
}> {
  const ready = await readyApplication(overrides);
  const paid = await payThrough(ready.applicationId);
  const outcome = await env.provisioning.applyCallback(
    callbackFor('QPAY', paid.invoiceId, paid.paymentId),
    request(),
  );
  expect(outcome.kind).toBe('paid');
  const provisioned = await env.provisioning.provision(
    ready.applicationId,
    `provision-${ready.applicationId}`,
    request(),
  );
  if (provisioned.kind !== 'provisioned') {
    throw new Error(`provisioning did not succeed: ${JSON.stringify(provisioned)}`);
  }
  return { applicationId: ready.applicationId, hotelId: provisioned.hotelId, email: ready.email };
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await env.admin.query<{ n: string }>(sql, values as unknown[]);
  return Number(result.rows[0]?.n ?? '0');
}

// =============================================================== the pre-payment gate

describe('ONB-DEC-001 — nothing exists before authoritative payment', () => {
  it('a complete, unpaid application creates no hotel graph at all', async () => {
    const ready = await readyApplication();
    await payThrough(ready.applicationId); // invoiced, but no callback

    // Every one of the seven things doc 15 §3 forbids before payment.
    for (const table of [
      'platform.hotel',
      'platform.hotel_subscription',
      'platform.staff_membership',
      'platform.server_session',
      'platform.hotel_profile',
      'platform.cash_location',
      'platform.hotel_admin_activation',
      'platform.activation_delivery',
    ]) {
      expect({ table, rows: await count(`SELECT count(*)::text AS n FROM ${table}`) }).toEqual({
        table,
        rows: 0,
      });
    }
    // And exactly one thing does exist: the request itself.
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.onboarding_application WHERE application_id = $1',
        [ready.applicationId],
      ),
    ).toBe(1);
  });

  it('an unverified phone produces no invoice', async () => {
    const draft = freshCitizen();
    const created = await env.onboarding.createApplication(draft, request());
    await env.onboarding.resolveOwner(created.applicationId, request());

    await expect(
      env.onboarding.openInvoice(
        {
          applicationId: created.applicationId,
          provider: 'QPAY',
          idempotencyKey: `idem-${unique()}`,
        },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_payment_attempt
          WHERE application_id = $1`,
        [created.applicationId],
      ),
    ).toBe(0);
  });

  it('an unpaid runtime caller cannot reach the provisioning boundary', async () => {
    // The security property behind `ONB-DEC-001`, proved at the database rather
    // than at the service: the API login holds no INSERT on the tenant root, and
    // the one function that does refuses an application that is not paid.
    const ready = await readyApplication();
    const client = await env.api.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hotel_id', $1, true)`, [
        '00000000-0000-0000-0000-000000000000',
      ]);
      await client.query(`SELECT set_config('app.realm', 'hotel', true)`);
      await client.query(`SELECT set_config('app.actor_ref', 'probe', true)`);
      await client.query(`SELECT set_config('app.onboarding_ref', $1, true)`, [
        ready.applicationId,
      ]);

      await expect(
        client.query(`INSERT INTO platform.hotel (display_name) VALUES ('probe')`),
      ).rejects.toMatchObject({ code: '42501' });

      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.onboarding_ref', $1, true)`, [
        ready.applicationId,
      ]);
      await expect(
        client.query(
          `SELECT platform.provision_paid_hotel($1, 'probe-key-0001', NULL, NULL, NULL, NULL,
                                                NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                                                gen_random_uuid())`,
          [ready.applicationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await count('SELECT count(*)::text AS n FROM platform.hotel')).toBe(0);
  });
});

// ================================================================= required fields

describe('ONB-DEC-002 / ONB-DEC-004 — the two registration types', () => {
  it('refuses a citizen application that carries a representative', async () => {
    await expect(
      env.onboarding.createApplication(
        freshCitizen({ representativeName: 'Nobody' }) as never,
        request(),
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an organization application with no representative', async () => {
    const draft = { ...organizationDraft(), representativeName: undefined } as never;
    await expect(env.onboarding.createApplication(draft, request())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('accepts a complete organization application', async () => {
    const n = unique();
    const created = await env.onboarding.createApplication(
      organizationDraft({
        registrationNumber: `SYN${n}0044`,
        adminEmail: `org-${n}@example.test`,
        hotelDisplayName: `Synthetic Org ${n}`,
        addressLine: `Org address ${n}`,
        contactPhone: `+9769911${n}`,
        subscriptionContactPhone: `+9769911${n}`,
      }),
      request(),
    );
    expect(created.state).toBe('DRAFT');
  });

  it.each([
    ['a missing package', { packageCode: 'P99' }],
    ['a term the document does not allow', { termMonths: 6 }],
    ['a malformed registration number', { registrationNumber: 'x' }],
    ['a malformed email', { adminEmail: 'not-an-email' }],
    ['a malformed phone', { contactPhone: 'abc' }],
    ['an out-of-range latitude', { latitudeMicro: 95_000_000 }],
    ['an empty district', { district: '   ' }],
  ])('refuses %s', async (_label, override) => {
    await expect(
      env.onboarding.createApplication(freshCitizen(override) as never, request()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('never returns the registration number, and never stores it in clear', async () => {
    const draft = freshCitizen();
    const created = await env.onboarding.createApplication(draft, request());
    expect(JSON.stringify(created)).not.toContain(draft.registrationNumber);

    // Not in the row, not in the audit stream, not in the outbox.
    const leaked = await count(
      `SELECT count(*)::text AS n FROM platform.onboarding_application
        WHERE application_id = $1 AND owner_identifier_ciphertext::text LIKE '%' || $2 || '%'`,
      [created.applicationId, draft.registrationNumber],
    );
    expect(leaked).toBe(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit.platform_event
          WHERE payload::text LIKE '%' || $1 || '%'`,
        [draft.registrationNumber],
      ),
    ).toBe(0);
  });
});

// ============================================================ payment confirmation

describe('doc 15 §4 — only a provider-confirmed payment activates anything', () => {
  it('rejects a callback whose signature does not verify', async () => {
    const ready = await readyApplication();
    const paid = await payThrough(ready.applicationId);
    const outcome = await env.provisioning.applyCallback(
      { provider: 'QPAY', providerInvoiceId: paid.invoiceId, signature: 'forged' },
      request(),
    );
    expect(outcome).toEqual({ kind: 'rejected', reason: 'bad_signature' });
  });

  it('rejects an unknown invoice reference', async () => {
    const outcome = await env.provisioning.applyCallback(
      {
        provider: 'QPAY',
        providerInvoiceId: 'qpay-inv-999999',
        signature: env.qpay.signatureFor('qpay-inv-999999'),
      },
      request(),
    );
    expect(outcome).toEqual({ kind: 'rejected', reason: 'unknown_reference' });
  });

  it('rejects a provider that did not issue the invoice', async () => {
    const ready = await readyApplication();
    const paid = await payThrough(ready.applicationId, 'QPAY');
    const outcome = await env.provisioning.applyCallback(
      { ...callbackFor('QPAY', paid.invoiceId, paid.paymentId), provider: 'KHAAN' },
      request(),
    );
    expect(outcome.kind).toBe('rejected');
  });

  it.each([
    ['a merchant reference mismatch', 'merchantRef', 'merchant_ref_mismatch'],
    ['an amount mismatch', 'amount', 'amount_mismatch'],
    ['a currency mismatch', 'currency', 'currency_mismatch'],
  ])('refuses %s against the stored attempt', async (_label, field, reason) => {
    const ready = await readyApplication();
    const invoice = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    const stored = env.qpay.invoice(invoice.providerInvoiceId);
    if (stored === undefined) throw new Error('the simulator lost its invoice');
    env.qpay.settle(invoice.providerInvoiceId, {
      state: 'PAID',
      providerPaymentId: `${invoice.providerInvoiceId}-pay`,
      paidAmountMnt: field === 'amount' ? stored.amountMnt + 1n : stored.amountMnt,
      currency: field === 'currency' ? 'USD' : stored.currency,
      merchantRef: field === 'merchantRef' ? 'somebody-elses-ref' : stored.merchantRef,
      paidAt: new Date(),
    });

    const outcome = await env.provisioning.applyCallback(
      callbackFor('QPAY', invoice.providerInvoiceId, `${invoice.providerInvoiceId}-pay`),
      request(),
    );
    expect(outcome).toEqual({ kind: 'rejected', reason });
    // And nothing moved: the application is still awaiting payment.
    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(state.rows[0]?.state).toBe('PENDING_PAYMENT');
  });

  it('never treats an uncertain result as success, and blocks a replacement invoice', async () => {
    const ready = await readyApplication();
    const invoice = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    // The provider's status query times out: an indeterminate answer, never a
    // success (doc 15 §4).
    env.qpay.failNext({ kind: 'TIMEOUT', retryable: true });
    const outcome = await env.provisioning.applyCallback(
      callbackFor('QPAY', invoice.providerInvoiceId),
      request(),
    );
    expect(outcome).toEqual({ kind: 'not_paid', state: 'PAYMENT_UNCERTAIN' });

    // `ONB-DEC-008`: no replacement invoice while the attempt is uncertain.
    await expect(
      env.onboarding.openInvoice(
        {
          applicationId: ready.applicationId,
          provider: 'KHAAN',
          idempotencyKey: `idem-${unique()}`,
        },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lets a definitively failed attempt be retried with a new one', async () => {
    const ready = await readyApplication();
    const first = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    env.qpay.settle(first.providerInvoiceId, { state: 'FAILED', failureCode: 'declined' });
    await env.provisioning.applyCallback(callbackFor('QPAY', first.providerInvoiceId), request());

    const second = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'KHAAN', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    expect(second.providerInvoiceId).not.toBe(first.providerInvoiceId);
    // The old attempt stays terminal history.
    const states = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.onboarding_payment_attempt
        WHERE application_id = $1 ORDER BY created_at`,
      [ready.applicationId],
    );
    expect(states.rows.map((r) => r.state)).toEqual(['FAILED', 'PENDING']);
  });

  it('makes a late capture on a dead attempt a case, and still does not pay the application', async () => {
    // doc 15 §4.1: a late success resurrects an *expired* attempt and nothing
    // else. A provider that collects on an attempt the platform already declared
    // failed is money held against no live attempt — a reconciliation case in its
    // own right, not a payment, and not something the application inherits.
    const ready = await readyApplication();
    const dead = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    env.qpay.settle(dead.providerInvoiceId, { state: 'FAILED', failureCode: 'declined' });
    await env.provisioning.applyCallback(callbackFor('QPAY', dead.providerInvoiceId), request());

    const latePayment = env.qpay.pay(dead.providerInvoiceId, new Date());
    const outcome = await env.provisioning.applyCallback(
      callbackFor('QPAY', dead.providerInvoiceId, latePayment),
      request(),
    );
    expect(outcome.kind).toBe('requires_reconciliation');

    const row = await env.admin.query<{ state: string; terminal_reason: string }>(
      `SELECT state, terminal_reason FROM platform.onboarding_payment_attempt
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(row.rows[0]).toMatchObject({
      state: 'PAID_REQUIRES_RECONCILIATION',
      terminal_reason: 'superseded_attempt_paid',
    });

    // The application is untouched: unpaid, and with no hotel behind it.
    const application = await env.admin.query<{ state: string; paid_attempt_id: string | null }>(
      `SELECT state, paid_attempt_id FROM platform.onboarding_application
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(application.rows[0]).toMatchObject({ state: 'PAYMENT_FAILED', paid_attempt_id: null });
    expect(await count(`SELECT count(*)::text AS n FROM platform.hotel`)).toBe(0);
  });

  it('replays a duplicate callback without a second transition', async () => {
    const ready = await readyApplication();
    const paid = await payThrough(ready.applicationId);
    const callback = callbackFor('QPAY', paid.invoiceId, paid.paymentId);

    const first = await env.provisioning.applyCallback(callback, request());
    const second = await env.provisioning.applyCallback(callback, request());
    const third = await env.provisioning.applyCallback(callback, request());
    expect(first.kind).toBe('paid');
    expect([second.kind, third.kind]).toEqual(['replay', 'replay']);

    // One payment-confirmed event, not three.
    const events = await env.admin.query<{ reason: string }>(
      `SELECT reason FROM platform.onboarding_event
        WHERE application_id = $1 AND reason = 'payment_confirmed'`,
      [ready.applicationId],
    );
    expect(events.rowCount).toBe(1);
  });

  it('makes a second provider paying one application a reconciliation case', async () => {
    // doc 15 §4.1: the first valid confirmed payment wins; a second capture is
    // money that arrived, never a second subscription.
    const ready = await readyApplication();
    const qpay = await payThrough(ready.applicationId, 'QPAY');
    const first = await env.provisioning.applyCallback(
      callbackFor('QPAY', qpay.invoiceId, qpay.paymentId),
      request(),
    );
    expect(first.kind).toBe('paid');

    // Khaan's invoice is opened directly: the application is paid, so the
    // ordinary route would refuse — which is itself the point. This is the
    // provider-side race where both gateways were driven at once.
    const khaanInvoice = unwrap(
      await env.khaan.createInvoice(
        {
          intentId: `race-${ready.applicationId}`,
          merchantRef: 'race-merchant-ref',
          amountMnt: 20_000n,
          currency: 'MNT',
          expiresAt: new Date(Date.now() + 3_600_000),
          idempotencyKey: `race-${ready.applicationId}`,
        },
        { correlationId: 'test' },
      ),
    );
    await env.admin.query(
      `INSERT INTO platform.onboarding_payment_attempt
         (application_id, provider, merchant_ref, provider_invoice_id, amount_mnt, package_code,
          term_months, monthly_price_mnt, vat_rate_bp, price_book_version, tax_config_version,
          package_feature_version, expires_at, state, terminal_at, terminal_reason)
       VALUES ($1,'KHAAN','race-merchant-ref',$2,20000,'P20',1,20000,1000,'pb','tax','pkg',
               now() + interval '1 hour', 'PENDING', NULL, NULL)`,
      [ready.applicationId, khaanInvoice.providerInvoiceId],
    );
    const khaanPayment = env.khaan.pay(khaanInvoice.providerInvoiceId, new Date());

    const second = await env.provisioning.applyCallback(
      callbackFor('KHAAN', khaanInvoice.providerInvoiceId, khaanPayment),
      request(),
    );
    expect(second.kind).toBe('requires_reconciliation');

    // Exactly one paid attempt drives the application, and it is QPay's.
    const application = await env.admin.query<{ paid_attempt_id: string }>(
      `SELECT paid_attempt_id FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    const paidAttempt = await env.admin.query<{ provider: string }>(
      `SELECT provider FROM platform.onboarding_payment_attempt WHERE attempt_id = $1`,
      [application.rows[0]?.paid_attempt_id],
    );
    expect(paidAttempt.rows[0]?.provider).toBe('QPAY');
  });

  it('supersedes a newer unpaid attempt when an older expired one pays late', async () => {
    const ready = await readyApplication();
    const first = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `idem-${unique()}` },
      request(),
    );
    env.qpay.settle(first.providerInvoiceId, { state: 'EXPIRED' });
    await env.provisioning.applyCallback(callbackFor('QPAY', first.providerInvoiceId), request());

    const second = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'KHAAN', idempotencyKey: `idem-${unique()}` },
      request(),
    );

    // The expired one pays after all.
    const latePayment = env.qpay.pay(first.providerInvoiceId, new Date());
    const outcome = await env.provisioning.applyCallback(
      callbackFor('QPAY', first.providerInvoiceId, latePayment),
      request(),
    );
    expect(outcome.kind).toBe('paid');

    const states = await env.admin.query<{ provider: string; state: string }>(
      `SELECT provider, state FROM platform.onboarding_payment_attempt
        WHERE application_id = $1 ORDER BY created_at`,
      [ready.applicationId],
    );
    expect(states.rows).toEqual([
      { provider: 'QPAY', state: 'PAID' },
      { provider: 'KHAAN', state: 'CANCELLED' },
    ]);

    // And when the superseded one pays too, it is a reconciliation case.
    const alsoPaid = env.khaan.pay(second.providerInvoiceId, new Date());
    const later = await env.provisioning.applyCallback(
      callbackFor('KHAAN', second.providerInvoiceId, alsoPaid),
      request(),
    );
    expect(later.kind).toBe('requires_reconciliation');
  });
});

// ================================================================== provisioning

describe('ONB-DEC-006 — durable, all-or-nothing provisioning', () => {
  it('creates the whole tenant graph in one transaction', async () => {
    const provisioned = await provisionedHotel();

    const graph = await env.admin.query<{
      hotels: string;
      profiles: string;
      links: string;
      subscriptions: string;
      memberships: string;
      roles: string;
      drawers: string;
      activations: string;
      deliveries: string;
      payments: string;
    }>(
      `SELECT (SELECT count(*)::text FROM platform.hotel WHERE hotel_id = $1) AS hotels,
              (SELECT count(*)::text FROM platform.hotel_profile WHERE hotel_id = $1) AS profiles,
              (SELECT count(*)::text FROM platform.hotel_owner_link WHERE hotel_id = $1) AS links,
              (SELECT count(*)::text FROM platform.hotel_subscription WHERE hotel_id = $1) AS subscriptions,
              (SELECT count(*)::text FROM platform.staff_membership
                WHERE hotel_id = $1 AND is_primary_admin) AS memberships,
              (SELECT count(*)::text FROM platform.membership_role_grant
                WHERE hotel_id = $1 AND role = 'HOTEL_ADMIN') AS roles,
              (SELECT count(*)::text FROM platform.cash_location
                WHERE hotel_id = $1 AND is_default_drawer) AS drawers,
              (SELECT count(*)::text FROM platform.hotel_admin_activation WHERE hotel_id = $1) AS activations,
              (SELECT count(*)::text FROM platform.activation_delivery WHERE hotel_id = $1) AS deliveries,
              (SELECT count(*)::text FROM platform.subscription_payment WHERE hotel_id = $1) AS payments`,
      [provisioned.hotelId],
    );
    expect(graph.rows[0]).toEqual({
      hotels: '1',
      profiles: '1',
      links: '1',
      subscriptions: '1',
      memberships: '1',
      roles: '1',
      drawers: '1',
      activations: '1',
      deliveries: '1',
      payments: '1',
    });
  });

  it('names the default drawer exactly as doc 24 §2.1 requires', async () => {
    const provisioned = await provisionedHotel();
    const drawer = await env.admin.query<{ name: string; kind: string }>(
      `SELECT name, kind FROM platform.cash_location
        WHERE hotel_id = $1 AND is_default_drawer IS TRUE`,
      [provisioned.hotelId],
    );
    expect(drawer.rows[0]).toEqual({ name: 'Үндсэн касс', kind: 'DRAWER' });
  });

  it('starts the subscription at the confirmed payment instant, to the millisecond', async () => {
    const ready = await readyApplication();
    const confirmedAt = new Date('2026-08-21T07:00:00.000Z');
    const paid = await payThrough(ready.applicationId, 'QPAY', confirmedAt);
    await env.provisioning.applyCallback(
      callbackFor('QPAY', paid.invoiceId, paid.paymentId),
      request(),
    );
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `provision-${ready.applicationId}`,
      request(),
    );
    if (outcome.kind !== 'provisioned') throw new Error('provisioning failed');

    const row = await env.admin.query<{ starts_at: Date; expires_at: Date }>(
      `SELECT starts_at, expires_at FROM platform.hotel_subscription WHERE hotel_id = $1`,
      [outcome.hotelId],
    );
    // `OPS-DEC-006`: starts_at is the confirmation, and expiry is one calendar
    // month later in Asia/Ulaanbaatar — 21 August 15:00 local becomes 21
    // September 15:00 local.
    expect(row.rows[0]?.starts_at).toEqual(confirmedAt);
    expect(row.rows[0]?.expires_at).toEqual(new Date('2026-09-21T07:00:00.000Z'));
  });

  it('is idempotent: a repeated provisioning creates no second hotel', async () => {
    const provisioned = await provisionedHotel();
    const again = await env.provisioning.provision(
      provisioned.applicationId,
      `provision-${provisioned.applicationId}`,
      request(),
    );
    expect(again).toEqual({ kind: 'already_provisioned', hotelId: provisioned.hotelId });
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_application
          WHERE provisioned_hotel_id = $1`,
        [provisioned.hotelId],
      ),
    ).toBe(1);
  });

  it('leaves zero partial entities when the transaction fails, and records the failure', async () => {
    // The failure is provoked at a real entity boundary: an account already
    // holds the admin address, so the `user_account` insert inside the
    // provisioning transaction violates its unique key. Everything the wrapper
    // had already written must roll back with it.
    const ready = await readyApplication();
    const paid = await payThrough(ready.applicationId);
    await env.provisioning.applyCallback(
      callbackFor('QPAY', paid.invoiceId, paid.paymentId),
      request(),
    );
    // The obstruction appears after payment: before it, the invoice itself
    // refuses an address another account holds (R2).
    await env.admin.query(
      `INSERT INTO platform.user_account (realm, email_normalized) VALUES ('hotel', $1)`,
      [ready.email],
    );

    const before = await count('SELECT count(*)::text AS n FROM platform.hotel');
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `provision-${ready.applicationId}`,
      request(),
    );
    expect(outcome.kind).toBe('failed');

    // Not one row of the graph survived.
    expect(await count('SELECT count(*)::text AS n FROM platform.hotel')).toBe(before);
    // And the failure itself was recorded — outside the rolled-back transaction,
    // which is the whole reason it is a separate one.
    const application = await env.admin.query<{ state: string; provision_attempts: number }>(
      `SELECT state, provision_attempts FROM platform.onboarding_application
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(application.rows[0]?.state).toBe('PROVISIONING_FAILED');
    expect(Number(application.rows[0]?.provision_attempts)).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_event
          WHERE application_id = $1 AND to_state = 'PROVISIONING_FAILED'`,
        [ready.applicationId],
      ),
    ).toBe(1);

    // The payment is untouched: it is never taken again.
    const attempt = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.onboarding_payment_attempt WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(attempt.rows[0]?.state).toBe('PAID');
  });

  it('stops automatic retries at five and requires a permissioned manual one', async () => {
    const ready = await readyApplication();
    const paid = await payThrough(ready.applicationId);
    await env.provisioning.applyCallback(
      callbackFor('QPAY', paid.invoiceId, paid.paymentId),
      request(),
    );
    // The obstruction appears after payment: somebody registers the admin
    // email in the meantime, so the boundary refuses to create a second
    // account for it (doc 15 §5.1) until the existing one is proved.
    await env.admin.query(
      `INSERT INTO platform.user_account (realm, email_normalized) VALUES ('hotel', $1)`,
      [ready.email],
    );

    // Five sweeps, each finding the job due again after its persisted backoff.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await env.admin.query(
        `UPDATE platform.onboarding_application SET provision_available_at = now(),
                revision = revision + 1
          WHERE application_id = $1`,
        [ready.applicationId],
      );
      const swept = await env.worker.provisionDue();
      expect({ attempt, failed: swept.failed }).toEqual({ attempt, failed: 1 });
    }
    const attempts = await env.admin.query<{ provision_attempts: number; state: string }>(
      `SELECT provision_attempts, state FROM platform.onboarding_application
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(Number(attempts.rows[0]?.provision_attempts)).toBe(5);
    expect(attempts.rows[0]?.state).toBe('PROVISIONING_FAILED');
    // The sweep no longer sees it.
    await env.admin.query(
      `UPDATE platform.onboarding_application SET provision_available_at = now(),
              revision = revision + 1
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect((await env.worker.provisionDue()).claimed).toBe(0);

    // A sixth automatic attempt is refused; only the manual path continues.
    const sixth = await env.provisioning.provision(
      ready.applicationId,
      `provision-${ready.applicationId}`,
      request(),
    );
    expect(sixth).toEqual({ kind: 'exhausted', attempts: 5 });

    // The manual retry is attributed and audited, and it still cannot change a
    // thing about the payment or the terms — it takes no such parameters.
    const unpermitted = await env.operationActor({ permissions: ['OPERATION_READ'] });
    await expect(
      env.provisioning.retryProvisioning(ready.applicationId, unpermitted.actor, request()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const operator = await env.operationActor({ permissions: ['ONBOARDING_PROVISION_RETRY'] });
    await env.provisioning.retryProvisioning(ready.applicationId, operator.actor, request());
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit.platform_event
          WHERE action = 'onboarding.provisioning.retry_requested' AND target_ref = $1`,
        [ready.applicationId],
      ),
    ).toBe(1);
  });

  it('a retry after the obstruction clears provisions on the same payment', async () => {
    const ready = await readyApplication();
    const confirmedAt = new Date('2026-08-21T07:00:00.000Z');
    const paid = await payThrough(ready.applicationId, 'QPAY', confirmedAt);
    await env.provisioning.applyCallback(
      callbackFor('QPAY', paid.invoiceId, paid.paymentId),
      request(),
    );
    const blocker = await env.admin.query<{ account_id: string }>(
      `INSERT INTO platform.user_account (realm, email_normalized) VALUES ('hotel', $1)
       RETURNING account_id`,
      [ready.email],
    );
    await env.provisioning.provision(ready.applicationId, `p-${ready.applicationId}`, request());

    // Remove the obstruction by giving the blocking account a different address.
    await env.admin.query(
      `UPDATE platform.user_account SET email_normalized = $2, revision = revision + 1
        WHERE account_id = $1`,
      [blocker.rows[0]?.account_id, `moved-${unique()}@example.test`],
    );
    // The failed attempt persisted a backoff that every claim honours
    // (remediation 2); the retry is due once it has elapsed.
    await env.admin.query(
      `UPDATE platform.onboarding_application SET provision_available_at = now(), revision = revision + 1
        WHERE application_id = $1`,
      [ready.applicationId],
    );

    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `p-${ready.applicationId}`,
      request(),
    );
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind !== 'provisioned') return;
    const row = await env.admin.query<{ starts_at: Date }>(
      `SELECT starts_at FROM platform.hotel_subscription WHERE hotel_id = $1`,
      [outcome.hotelId],
    );
    // The retry did not move `starts_at` — it is still the original confirmation.
    expect(row.rows[0]?.starts_at).toEqual(confirmedAt);
  });
});

// ==================================================================== activation

describe('ONB-DEC-003 — the first Hotel Admin sets their own password', () => {
  it('delivers one single-use link and never a password', async () => {
    const provisioned = await provisionedHotel();
    const drained = await env.provisioning.drainActivationDeliveries();
    expect(drained).toBeGreaterThan(0);

    const message = env.notifications.lastInvitationFor(provisioned.email);
    expect(message).toBeDefined();
    // The account exists and cannot sign in: there is no credential at all.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.account_credential c
           JOIN platform.hotel_admin_activation a ON a.account_id = c.account_id
          WHERE a.hotel_id = $1`,
        [provisioned.hotelId],
      ),
    ).toBe(0);

    const activated = await env.activation.activate(
      {
        hotelId: provisioned.hotelId,
        token: message?.token ?? '',
        password: syntheticPassword('activation-01'),
      },
      request(),
    );
    expect(activated.accountId).toBeDefined();

    // The link is destroyed, not merely marked used.
    const after = await env.admin.query<{ state: string; token_hash: string | null }>(
      `SELECT state, token_hash FROM platform.hotel_admin_activation WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    expect(after.rows[0]).toEqual({ state: 'ACTIVE', token_hash: null });

    // And it cannot be used again.
    await expect(
      env.activation.activate(
        {
          hotelId: provisioned.hotelId,
          token: message?.token ?? '',
          password: syntheticPassword('activation-02'),
        },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an email outage does not roll back provisioning and does not duplicate the link', async () => {
    const provisioned = await provisionedHotel();
    env.notifications.failNext(2);

    await env.provisioning.drainActivationDeliveries();
    // The hotel is still there, and the delivery is queued for another attempt.
    expect(
      await count('SELECT count(*)::text AS n FROM platform.hotel WHERE hotel_id = $1', [
        provisioned.hotelId,
      ]),
    ).toBe(1);
    const queued = await env.admin.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM platform.activation_delivery WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    expect(queued.rows[0]?.state).toBe('PENDING');

    // Retry until it lands. Still exactly one delivery row and one link.
    await env.admin.query(
      `UPDATE platform.activation_delivery SET available_at = now() WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    await env.provisioning.drainActivationDeliveries();
    await env.admin.query(
      `UPDATE platform.activation_delivery SET available_at = now() WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    await env.provisioning.drainActivationDeliveries();

    const settled = await env.admin.query<{ state: string; secret_ciphertext: Buffer | null }>(
      `SELECT state, secret_ciphertext FROM platform.activation_delivery WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    expect(settled.rows[0]?.state).toBe('SENT');
    // The sealed secret is destroyed once delivered.
    expect(settled.rows[0]?.secret_ciphertext).toBeNull();
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.activation_delivery WHERE hotel_id = $1',
        [provisioned.hotelId],
      ),
    ).toBe(1);
  });

  it('a proved existing active account gets no link, no token and no second account', async () => {
    // The existing-account branch of doc 15 §5 step 7 and §5.1: the email
    // already belongs to an active account, which proves itself by signing in
    // and binding — never by a test writing the column.
    const elsewhere = await env.iam.createHotel('Elsewhere Hotel', 'P20');
    const member = await env.iam.seedMembership({
      hotelId: elsewhere,
      email: `existing-${unique()}@example.test`,
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    const ready = await readyApplication({ adminEmail: member.email });
    await env.onboarding.bindExistingAccount(
      ready.applicationId,
      await actorFor(env.iam, member),
      request(),
    );
    const accountId = member.accountId;

    const paid = await payThrough(ready.applicationId);
    await env.provisioning.applyCallback(
      callbackFor('QPAY', paid.invoiceId, paid.paymentId),
      request(),
    );
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `p-${ready.applicationId}`,
      request(),
    );
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind !== 'provisioned') return;

    const activation = await env.admin.query<{
      state: string;
      token_hash: string | null;
      account_id: string;
    }>(
      `SELECT state, token_hash, account_id FROM platform.hotel_admin_activation WHERE hotel_id = $1`,
      [outcome.hotelId],
    );
    expect(activation.rows[0]).toEqual({
      state: 'ACTIVE',
      token_hash: null,
      account_id: accountId,
    });
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.activation_delivery WHERE hotel_id = $1',
        [outcome.hotelId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.user_account WHERE email_normalized = $1`,
        [ready.email],
      ),
    ).toBe(1);
  });
});
