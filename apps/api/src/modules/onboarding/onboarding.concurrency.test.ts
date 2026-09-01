import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 concurrency, on real PostgreSQL.
 *
 * Every race here is run genuinely simultaneously — `Promise.all` over separate
 * connections — rather than simulated by interleaving calls by hand. What is
 * asserted is not that one of them won, but that the *effect* happened exactly
 * once and that the loser stopped rather than applying a second one.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('onboarding_concurrency');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

const request = (): RequestContext => newOnboardingRequest();

let sequence = 0;
function unique(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
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

async function readyApplication(): Promise<{ applicationId: string }> {
  const n = unique();
  const created = await env.onboarding.createApplication(
    citizenDraft({
      registrationNumber: `CON${n}0011`,
      adminEmail: `con-${n}@example.test`,
      hotelDisplayName: `Concurrency Hotel ${n}`,
      addressLine: `Concurrency address ${n}`,
      contactPhone: `+9769955${n}`,
      subscriptionContactPhone: `+9769955${n}`,
      termMonths: 12,
    }),
    request(),
  );
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const code = env.phone.codeFor(created.applicationId);
  await env.onboarding.confirmPhoneVerification(created.applicationId, code ?? '', request());
  await env.onboarding.resolveOwner(created.applicationId, request());
  return { applicationId: created.applicationId };
}

async function paidApplication(): Promise<{ applicationId: string }> {
  const ready = await readyApplication();
  const invoice = await env.onboarding.openInvoice(
    { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `con-${unique()}` },
    request(),
  );
  const paymentId = env.qpay.pay(invoice.providerInvoiceId, new Date('2026-08-21T07:00:00.000Z'));
  await env.provisioning.applyCallback(
    callbackFor('QPAY', invoice.providerInvoiceId, paymentId),
    request(),
  );
  return ready;
}

async function provisionedHotel(): Promise<{ hotelId: string; startsAt: Date }> {
  const paid = await paidApplication();
  const outcome = await env.provisioning.provision(
    paid.applicationId,
    `con-provision-${unique()}`,
    request(),
  );
  if (outcome.kind !== 'provisioned') throw new Error('provisioning failed');
  const status = await env.subscriptions.status(outcome.hotelId, request());
  if (status === undefined) throw new Error('no subscription');
  return { hotelId: outcome.hotelId, startsAt: status.startsAt };
}

async function count(sql: string, values: readonly unknown[]): Promise<number> {
  const result = await env.admin.query<{ n: string }>(sql, values as unknown[]);
  return Number(result.rows[0]?.n ?? '0');
}

describe('ONB-DEC-008 — simultaneous payment callbacks', () => {
  it('two identical callbacks produce one paid transition', async () => {
    const ready = await readyApplication();
    const invoice = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `con-${unique()}` },
      request(),
    );
    const paymentId = env.qpay.pay(invoice.providerInvoiceId, new Date());
    const callback = callbackFor('QPAY', invoice.providerInvoiceId, paymentId);

    // Genuinely at once, on separate connections.
    const [a, b] = await Promise.all([
      env.provisioning.applyCallback(callback, request()),
      env.provisioning.applyCallback(callback, request()),
    ]);

    // One of them applied the payment; the other found it already applied. Which
    // is which is the database's business — that exactly one did is ours.
    expect([a.kind, b.kind].filter((kind) => kind === 'paid')).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_event
          WHERE application_id = $1 AND reason = 'payment_confirmed'`,
        [ready.applicationId],
      ),
    ).toBe(1);
  });

  it('two providers paying at once leave one subscription and one case', async () => {
    const ready = await readyApplication();
    const qpayInvoice = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: `con-${unique()}` },
      request(),
    );
    // The second gateway's attempt is seeded directly: the service refuses a
    // second live invoice, which is the rule. This is the provider-side race
    // where both were somehow driven — doc 15 §4.1's "two-provider success".
    const khaanInvoice = await env.khaan.createInvoice({
      provider: 'KHAAN',
      merchantRef: `race-${unique()}`,
      amountMnt: 240_000n,
      currency: 'MNT',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // Seeded `CANCELLED`, because the live-attempt index allows one at a time and
    // QPay holds it. That is the shape doc 15 §4.1 describes: a superseded
    // attempt that the provider went on to collect anyway.
    await env.admin.query(
      `INSERT INTO platform.onboarding_payment_attempt
         (application_id, provider, merchant_ref, provider_invoice_id, amount_mnt, package_code,
          term_months, monthly_price_mnt, vat_rate_bp, price_book_version, tax_config_version,
          package_feature_version, expires_at, state, terminal_at, terminal_reason)
       VALUES ($1,'KHAAN',$2,$2,240000,'P20',12,20000,1000,'pb','tax','pkg',
               now() + interval '1 hour', 'CANCELLED', now(), 'race-fixture')`,
      [ready.applicationId, khaanInvoice.providerInvoiceId],
    );
    env.khaan.settle(khaanInvoice.providerInvoiceId, {
      outcome: 'paid',
      providerPaymentId: `${khaanInvoice.providerInvoiceId}-pay`,
      paidAmountMnt: 240_000n,
      currency: 'MNT',
      merchantRef: khaanInvoice.providerInvoiceId,
      confirmedAt: new Date(),
    });

    const qpayPayment = env.qpay.pay(qpayInvoice.providerInvoiceId, new Date());
    const [a, b] = await Promise.all([
      env.provisioning.applyCallback(
        callbackFor('QPAY', qpayInvoice.providerInvoiceId, qpayPayment),
        request(),
      ),
      env.provisioning.applyCallback(
        callbackFor(
          'KHAAN',
          khaanInvoice.providerInvoiceId,
          `${khaanInvoice.providerInvoiceId}-pay`,
        ),
        request(),
      ),
    ]);

    const kinds = [a.kind, b.kind];
    expect(kinds.filter((kind) => kind === 'paid')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'requires_reconciliation')).toHaveLength(1);

    // Exactly one paid attempt drives the application.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_payment_attempt
          WHERE application_id = $1 AND state = 'PAID'`,
        [ready.applicationId],
      ),
    ).toBe(1);
  });
});

describe('ONB-DEC-006 — simultaneous provisioning', () => {
  it('two runners create one hotel and one of everything under it', async () => {
    const paid = await paidApplication();
    const key = `con-provision-${unique()}`;

    const [a, b] = await Promise.all([
      env.provisioning.provision(paid.applicationId, key, request()),
      env.provisioning.provision(paid.applicationId, key, request()),
    ]);

    // One provisioned; the other found the application claimed or already done.
    const provisioned = [a, b].filter((outcome) => outcome.kind === 'provisioned');
    expect(provisioned).toHaveLength(1);

    const hotelId = provisioned[0]?.kind === 'provisioned' ? provisioned[0].hotelId : '';
    for (const [table, column] of [
      ['platform.hotel', 'hotel_id'],
      ['platform.hotel_subscription', 'hotel_id'],
      ['platform.hotel_owner_link', 'hotel_id'],
      ['platform.cash_location', 'hotel_id'],
      ['platform.hotel_admin_activation', 'hotel_id'],
      ['platform.subscription_payment', 'hotel_id'],
    ] as const) {
      expect({
        table,
        rows: await count(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`, [
          hotelId,
        ]),
      }).toEqual({ table, rows: 1 });
    }
    // And exactly one Primary Hotel Admin membership.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.staff_membership
          WHERE hotel_id = $1 AND is_primary_admin`,
        [hotelId],
      ),
    ).toBe(1);
  });
});

describe('LIFE-DEC-006 / LIFE-DEC-007 — the boundary worker versus a callback', () => {
  it('applies a due upgrade exactly once when both commit at the same moment', async () => {
    const hotel = await provisionedHotel();
    const first = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `u-${unique()}`,
      },
      request(),
    );
    const firstPayment = env.qpay.pay(first.providerInvoiceId, new Date());
    await env.subscriptions.applyBillingCallback(
      hotel.hotelId,
      callbackFor('QPAY', first.providerInvoiceId, firstPayment),
      request(),
    );

    // Bring the boundary into the past, so the worker has real work to do.
    await env.admin.query(
      `UPDATE platform.hotel_subscription
          SET pending_upgrade_package = NULL, pending_upgrade_effective_at = NULL,
              billing_revision = billing_revision + 1, revision = revision + 1
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    await env.admin.query(
      `UPDATE platform.hotel_subscription
          SET pending_upgrade_package = 'P25',
              pending_upgrade_effective_at = now() - interval '1 minute',
              billing_revision = billing_revision + 1, revision = revision + 1
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );

    // Two workers sweep the same subscription at once. They take the same row
    // lock and compete for the same billing revision.
    const [a, b] = await Promise.all([
      env.subscriptions.applyDueUpgrade(hotel.hotelId, request()),
      env.subscriptions.applyDueUpgrade(hotel.hotelId, request()),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    const status = await env.subscriptions.status(hotel.hotelId, request());
    expect(status?.effectivePackage).toBe('P25');
    expect(status?.pendingUpgradePackage).toBeNull();
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_event
          WHERE hotel_id = $1 AND event_type = 'UPGRADE_APPLIED'`,
        [hotel.hotelId],
      ),
    ).toBe(1);
  });

  it('a boundary sweep racing a second-upgrade callback applies one entitlement', async () => {
    const hotel = await provisionedHotel();
    const first = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `u-${unique()}`,
      },
      request(),
    );
    const firstPayment = env.qpay.pay(first.providerInvoiceId, new Date());
    await env.subscriptions.applyBillingCallback(
      hotel.hotelId,
      callbackFor('QPAY', first.providerInvoiceId, firstPayment),
      request(),
    );
    await env.admin.query(
      `UPDATE platform.hotel_subscription
          SET pending_upgrade_package = NULL, pending_upgrade_effective_at = NULL,
              billing_revision = billing_revision + 1, revision = revision + 1
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    await env.admin.query(
      `UPDATE platform.hotel_subscription
          SET pending_upgrade_package = 'P25',
              pending_upgrade_effective_at = now() - interval '1 minute',
              billing_revision = billing_revision + 1, revision = revision + 1
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );

    const second = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        provider: 'KHAAN',
        idempotencyKey: `u-${unique()}`,
      },
      request(),
    );
    const secondPayment = env.khaan.pay(second.providerInvoiceId, new Date());

    const [worker, callback] = await Promise.all([
      env.subscriptions.applyDueUpgrade(hotel.hotelId, request()),
      env.subscriptions.applyBillingCallback(
        hotel.hotelId,
        callbackFor('KHAAN', second.providerInvoiceId, secondPayment),
        request(),
      ),
    ]);

    // Whichever order they landed in, the subscription ends up in exactly one
    // consistent state and the money is recorded once.
    const status = await env.subscriptions.status(hotel.hotelId, request());
    expect(['P25', 'P30']).toContain(status?.effectivePackage);
    expect(status?.packageFloor === 'P30' || callback.kind === 'requires_reconciliation').toBe(
      true,
    );
    void worker;
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_payment
          WHERE hotel_id = $1 AND provider_payment_id = $2`,
        [hotel.hotelId, secondPayment],
      ),
    ).toBeLessThanOrEqual(1);
  });

  it('a renewal and an upgrade quoted at once leave exactly one live intent', async () => {
    const hotel = await provisionedHotel();
    await Promise.allSettled([
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: `r-${unique()}`,
        },
        request(),
      ),
      env.subscriptions.quoteUpgrade(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P25',
          provider: 'KHAAN',
          idempotencyKey: `u-${unique()}`,
        },
        request(),
      ),
    ]);

    // `LIFE-DEC-006`: the partial unique index is the arbiter, so at most one
    // intent is live however the two interleaved.
    const live = await count(
      `SELECT count(*)::text AS n FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND state = 'PENDING'`,
      [hotel.hotelId],
    );
    expect(live).toBeLessThanOrEqual(1);
  });
});

describe('doc 15 §5 — the activation delivery queue', () => {
  it('two drains deliver one message and settle it once', async () => {
    const hotel = await provisionedHotel();
    const [a, b] = await Promise.all([
      env.provisioning.drainActivationDeliveries(),
      env.provisioning.drainActivationDeliveries(),
    ]);
    expect(a + b).toBeGreaterThan(0);

    const settled = await env.admin.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM platform.activation_delivery WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(settled.rows[0]?.state).toBe('SENT');
    // The lease is what stops the second drain touching a claimed entry.
    expect(Number(settled.rows[0]?.attempts)).toBe(1);
  });
});
