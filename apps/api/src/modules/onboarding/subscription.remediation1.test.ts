import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { CommandActor } from '../iam/services/iam-context';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { actorFor } from '../iam/test-support/iam-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 remediation 1 — R5 eBarimt on every confirmed payment, R6 idempotent
 * invoicing without quote races, R7 a paid pending upgrade survives a renewal.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('subscription_remediation1');
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

function syntheticPassword(label: string): string {
  return ['synthetic', label, 'passphrase'].join('-');
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

interface Hotel {
  hotelId: string;
  admin: CommandActor;
  startsAt: Date;
  expiresAt: Date;
}

/** A provisioned hotel whose Primary Admin has activated and signed in. */
async function hotelWith(options: {
  packageCode?: string;
  termMonths?: number;
  confirmedAt?: Date;
}): Promise<Hotel> {
  const n = unique();
  const confirmedAt = options.confirmedAt ?? new Date('2026-08-21T07:00:00.000Z');
  const email = `subrem-${n}@example.test`;
  const draft = citizenDraft({
    registrationNumber: `SRM${n}0011`,
    adminEmail: email,
    hotelDisplayName: `Sub Remediation Hotel ${n}`,
    addressLine: `Sub remediation address ${n}`,
    contactPhone: `+9769944${n}`,
    subscriptionContactPhone: `+9769944${n}`,
    packageCode: options.packageCode ?? 'P20',
    termMonths: options.termMonths ?? 12,
  });
  const created = await env.onboarding.createApplication(draft, request());
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const code = env.phone.codeFor(created.applicationId);
  await env.onboarding.confirmPhoneVerification(created.applicationId, code ?? '', request());
  await env.onboarding.resolveOwner(created.applicationId, request());
  const invoice = await env.onboarding.openInvoice(
    { applicationId: created.applicationId, provider: 'QPAY', idempotencyKey: `srm-idem-${n}` },
    request(),
  );
  const paymentId = env.qpay.pay(invoice.providerInvoiceId, confirmedAt);
  await env.provisioning.applyCallback(
    callbackFor('QPAY', invoice.providerInvoiceId, paymentId),
    request(),
  );
  const outcome = await env.provisioning.provision(
    created.applicationId,
    `srm-prov-${n}`,
    request(),
  );
  if (outcome.kind !== 'provisioned')
    throw new Error(`provisioning failed: ${JSON.stringify(outcome)}`);
  await env.worker.deliverActivations();
  const link = env.notifications.lastInvitationFor(email);
  await env.activation.activate(
    { hotelId: outcome.hotelId, token: link?.token ?? '', password: syntheticPassword(`srm-${n}`) },
    request(),
  );
  const admin = await actorFor(env.iam, {
    membershipId: '',
    accountId: '',
    email,
    password: syntheticPassword(`srm-${n}`),
  });
  const status = await env.subscriptions.status(outcome.hotelId, admin, request());
  if (status === undefined) throw new Error('no subscription');
  return {
    hotelId: outcome.hotelId,
    admin,
    startsAt: status.startsAt,
    expiresAt: status.expiresAt,
  };
}

async function payBilling(
  hotel: Hotel,
  quote: { intentId: string; providerInvoiceId: string },
  confirmedAt: Date,
  options: { provider?: 'QPAY' | 'KHAAN'; feeMnt?: bigint } = {},
) {
  const provider = options.provider ?? 'QPAY';
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  const paymentId = gateway.pay(quote.providerInvoiceId, confirmedAt, undefined, options.feeMnt);
  return env.subscriptions.applyBillingCallback(
    hotel.hotelId,
    callbackFor(provider, quote.providerInvoiceId, paymentId),
    request(),
  );
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await env.admin.query<{ n: string }>(sql, values as unknown[]);
  return Number(result.rows[0]?.n ?? '0');
}

async function expectApiError(work: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

// ================================================================ R5 — eBarimt

describe('R5 — one durable eBarimt intent per confirmed payment, in the payment’s transaction', () => {
  it('the onboarding payment and its issuance intent share a transaction', async () => {
    const hotel = await hotelWith({});
    const rows = await env.admin.query<{ payment_xmin: string; issuance_xmin: string }>(
      `SELECT p.xmin::text AS payment_xmin, i.xmin::text AS issuance_xmin
         FROM platform.subscription_payment p
         JOIN platform.ebarimt_issuance i ON i.hotel_id = p.hotel_id AND i.payment_id = p.payment_id
        WHERE p.hotel_id = $1 AND p.purpose = 'ONBOARDING'`,
      [hotel.hotelId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.payment_xmin).toBe(rows.rows[0]?.issuance_xmin);
  });

  it('a renewal and an upgrade each open exactly one intent with their payment, and replays add none', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 3 });
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `r5-rn-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const renewed = await payBilling(hotel, renewal, new Date());
    expect(renewed.kind).toBe('renewed');
    const upgrade = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'KHAAN',
        idempotencyKey: `r5-up-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const upgraded = await payBilling(hotel, upgrade, new Date(), { provider: 'KHAAN' });
    expect(['upgrade_pending', 'upgrade_applied']).toContain(upgraded.kind);

    const pairs = await env.admin.query<{ purpose: string; same: boolean }>(
      `SELECT p.purpose, (p.xmin = i.xmin) AS same
         FROM platform.subscription_payment p
         JOIN platform.ebarimt_issuance i ON i.hotel_id = p.hotel_id AND i.payment_id = p.payment_id
        WHERE p.hotel_id = $1 ORDER BY p.confirmed_at`,
      [hotel.hotelId],
    );
    expect(pairs.rows.map((row) => row.purpose)).toEqual(['ONBOARDING', 'RENEWAL', 'UPGRADE']);
    expect(pairs.rows.every((row) => row.same)).toBe(true);

    // Duplicate callbacks and worker retries do not add a second intent or receipt.
    await env.subscriptions.applyBillingCallback(
      hotel.hotelId,
      callbackFor('QPAY', renewal.providerInvoiceId, `${renewal.providerInvoiceId}-pay`),
      request(),
    );
    await env.worker.issueReceipts();
    await env.worker.issueReceipts();
    expect(
      await count(`SELECT count(*)::text AS n FROM platform.ebarimt_issuance WHERE hotel_id = $1`, [
        hotel.hotelId,
      ]),
    ).toBe(3);
    expect(
      await count(
        `SELECT count(DISTINCT receipt_number)::text AS n FROM platform.ebarimt_issuance
          WHERE hotel_id = $1 AND state = 'ISSUED'`,
        [hotel.hotelId],
      ),
    ).toBe(3);
  });

  it('the worker issues through the port and emails the receipt with its own template', async () => {
    const hotel = await hotelWith({});
    const processed = await env.worker.issueReceipts();
    expect(processed).toBeGreaterThanOrEqual(1);
    const issuance = await env.admin.query<{
      state: string;
      receipt_number: string | null;
      delivery_state: string;
    }>(
      `SELECT state, receipt_number, delivery_state FROM platform.ebarimt_issuance WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(issuance.rows[0]?.state).toBe('ISSUED');
    expect(issuance.rows[0]?.delivery_state).toBe('SENT');

    const message = env.notifications
      .all()
      .find(
        (entry) =>
          entry.kind === 'ebarimt_receipt' &&
          entry.receiptNumber === issuance.rows[0]?.receipt_number,
      );
    expect(message).toBeDefined();
    expect(message?.kind).toBe('ebarimt_receipt');
    if (message?.kind !== 'ebarimt_receipt') return;
    expect(message.receiptQr).toMatch(/^sim-qr-/);
    expect(message.hotelId).toBe(hotel.hotelId);
    expect(env.notifications.all().filter((entry) => entry.kind === 'password_reset')).toEqual([]);
  });

  it('manual retry is an Operation action: permission, realm and step-up, and no receipt fields', async () => {
    const hotel = await hotelWith({});
    env.receipts.failNext('permanent');
    await env.worker.issueReceipts();
    const queued = await env.admin.query<{ issuance_id: string; state: string }>(
      `SELECT issuance_id, state FROM platform.ebarimt_issuance WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(queued.rows[0]?.state).toBe('MANUAL_RESOLUTION');
    const issuanceId = queued.rows[0]?.issuance_id ?? '';

    // The hotel admin is in the wrong realm; a reader lacks the permission; a
    // stale step-up is refused; the permitted operator can only ask again.
    await expectApiError(
      env.ebarimt.retry(hotel.hotelId, issuanceId, hotel.admin, request()),
      'NOT_FOUND',
    );
    const reader = await env.operationActor({ permissions: ['OPERATION_READ'] });
    await expectApiError(
      env.ebarimt.retry(hotel.hotelId, issuanceId, reader.actor, request()),
      'NOT_FOUND',
    );
    const stale = await env.operationActor({
      permissions: ['SUBSCRIPTION_EBARIMT_RETRY'],
      stepUpAgeSeconds: 15 * 60,
    });
    await expectApiError(
      env.ebarimt.retry(hotel.hotelId, issuanceId, stale.actor, request()),
      'PRECONDITION_FAILED',
    );
    const operator = await env.operationActor({ permissions: ['SUBSCRIPTION_EBARIMT_RETRY'] });
    const queue = await env.ebarimt.manualQueue(operator.actor, request());
    expect(queue.some((item) => item.issuanceId === issuanceId)).toBe(true);
    const outcome = await env.ebarimt.retry(hotel.hotelId, issuanceId, operator.actor, request());
    expect(outcome.kind).toBe('issued');
    const audit = await count(
      `SELECT count(*)::text AS n FROM audit.platform_event
        WHERE action = 'subscription.ebarimt.retry_requested' AND target_ref = $1`,
      [issuanceId],
    );
    expect(audit).toBe(1);
  });
});

// ============================================================ R6 — idempotency

describe('R6 — invoice creation is idempotent and the quote is re-locked', () => {
  it('claims the key before the provider call and passes a stable idempotency key to the gateway', async () => {
    const hotel = await hotelWith({});
    const key = `r6-stable-${unique()}`;
    const invoicesBefore = env.qpay.invoiceCount;
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: key,
      },
      hotel.admin,
      request(),
    );
    const invoice = env.qpay.invoice(quote.providerInvoiceId);
    expect(invoice?.idempotencyKey).toBeDefined();
    expect(invoice?.idempotencyKey).toMatch(/^d1\.subscription\.renewal\./);

    // A retry with the same key and payload returns the exact original result.
    const again = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: key,
      },
      hotel.admin,
      request(),
    );
    expect(again).toEqual(quote);
    expect(env.qpay.invoiceCount).toBe(invoicesBefore + 1);

    // The same key with a different payload is refused, not answered.
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 3,
          provider: 'QPAY',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('recovers the same provider invoice after a lost acknowledgement, for onboarding and billing', async () => {
    // Onboarding.
    const n = unique();
    const created = await env.onboarding.createApplication(
      citizenDraft({
        registrationNumber: `SRM${n}0022`,
        adminEmail: `srm-lost-${n}@example.test`,
        hotelDisplayName: `Lost Ack Hotel ${n}`,
        addressLine: `Lost ack address ${n}`,
        contactPhone: `+9769966${n}`,
        subscriptionContactPhone: `+9769966${n}`,
      }),
      request(),
    );
    await env.onboarding.requestPhoneVerification(created.applicationId, request());
    await env.onboarding.confirmPhoneVerification(
      created.applicationId,
      env.phone.codeFor(created.applicationId) ?? '',
      request(),
    );
    await env.onboarding.resolveOwner(created.applicationId, request());

    const before = env.qpay.invoiceCount;
    env.qpay.loseNextAcknowledgement();
    const key = `r6-lost-${n}`;
    await expectApiError(
      env.onboarding.openInvoice(
        { applicationId: created.applicationId, provider: 'QPAY', idempotencyKey: key },
        request(),
      ),
      'DEPENDENCY_UNAVAILABLE',
    );
    // The provider did create the invoice; we never stored it.
    expect(env.qpay.invoiceCount).toBe(before + 1);
    // The attempt was prepared before the provider was called and is still
    // waiting for the reply that was lost: no live attempt exists (remediation 2).
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_payment_attempt
          WHERE application_id = $1 AND state <> 'PREPARING'`,
        [created.applicationId],
      ),
    ).toBe(0);

    const recovered = await env.onboarding.openInvoice(
      { applicationId: created.applicationId, provider: 'QPAY', idempotencyKey: key },
      request(),
    );
    expect(env.qpay.invoiceCount).toBe(before + 1);
    expect(env.qpay.invoice(recovered.providerInvoiceId)).toBeDefined();

    // Billing.
    const hotel = await hotelWith({});
    const billingBefore = env.khaan.invoiceCount;
    env.khaan.loseNextAcknowledgement();
    const billingKey = `r6-lost-bill-${unique()}`;
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'KHAAN',
          idempotencyKey: billingKey,
        },
        hotel.admin,
        request(),
      ),
      'DEPENDENCY_UNAVAILABLE',
    );
    expect(env.khaan.invoiceCount).toBe(billingBefore + 1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_billing_intent
          WHERE hotel_id = $1 AND state <> 'PREPARING'`,
        [hotel.hotelId],
      ),
    ).toBe(0);
    const recoveredBilling = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'KHAAN',
        idempotencyKey: billingKey,
      },
      hotel.admin,
      request(),
    );
    expect(env.khaan.invoiceCount).toBe(billingBefore + 1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_billing_intent
          WHERE hotel_id = $1 AND provider_invoice_id = $2`,
        [hotel.hotelId, recoveredBilling.providerInvoiceId],
      ),
    ).toBe(1);
  });

  it('never persists a quote against a billing revision that moved while the provider was called', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    // An upgrade is quoted and paid while the renewal's provider call is held open.
    const release = env.qpay.blockNext();
    const renewal = env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `r6-race-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    try {
      // Give the renewal time to reach the provider call.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const upgrade = await env.subscriptions.quoteUpgrade(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P25',
          provider: 'KHAAN',
          idempotencyKey: `r6-race-up-${unique()}`,
        },
        hotel.admin,
        request(),
      );
      const applied = await payBilling(hotel, upgrade, new Date(), { provider: 'KHAAN' });
      expect(['upgrade_pending', 'upgrade_applied']).toContain(applied.kind);
    } finally {
      release();
    }

    await expectApiError(renewal, 'CONFLICT');
    const stale = await env.admin.query<{ quoted: number; current: number }>(
      `SELECT i.quoted_billing_revision AS quoted, s.billing_revision AS current
         FROM platform.subscription_billing_intent i
         JOIN platform.hotel_subscription s ON s.hotel_id = i.hotel_id
        WHERE i.hotel_id = $1 AND i.kind = 'RENEWAL' AND i.state <> 'ABANDONED'`,
      [hotel.hotelId],
    );
    expect(stale.rows).toEqual([]);
  });

  it('keeps the existing usable intent until the replacement invoice is durably established', async () => {
    const hotel = await hotelWith({});
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `r6-keep-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    // The upgrade's provider call fails outright.
    env.khaan.failNext({ kind: 'UNAVAILABLE', retryable: true });
    await expectApiError(
      env.subscriptions.quoteUpgrade(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P25',
          provider: 'KHAAN',
          idempotencyKey: `r6-keep-up-${unique()}`,
        },
        hotel.admin,
        request(),
      ),
      'DEPENDENCY_UNAVAILABLE',
    );
    const intents = await env.admin.query<{ intent_id: string; state: string }>(
      `SELECT intent_id, state FROM platform.subscription_billing_intent WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    // The renewal is untouched; the upgrade the provider could not answer is a
    // prepared row waiting for a retry, never a live one (remediation 2).
    expect(intents.rows.filter((row) => row.state !== 'PREPARING')).toEqual([
      { intent_id: renewal.intentId, state: 'PENDING' },
    ]);
  });
});

// ================================================== R7 — pending upgrade survives

describe('R7 — a paid pending upgrade is preserved through renewal', () => {
  async function pendingP25(): Promise<Hotel & { effectiveAt: Date }> {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const upgrade = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `r7-up-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const paid = await payBilling(hotel, upgrade, new Date());
    expect(paid.kind).toBe('upgrade_pending');
    const status = await env.subscriptions.status(hotel.hotelId, hotel.admin, request());
    if (status?.pendingUpgradeEffectiveAt === null || status === undefined) {
      throw new Error('no pending upgrade');
    }
    return { ...hotel, effectiveAt: status.pendingUpgradeEffectiveAt };
  }

  it('renews at the pending target, keeping the target and its boundary while extending expiry', async () => {
    const hotel = await pendingP25();
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        termMonths: 3,
        provider: 'QPAY',
        idempotencyKey: `r7-rn-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const renewed = await payBilling(hotel, renewal, new Date());
    expect(renewed.kind).toBe('renewed');
    const status = await env.subscriptions.status(hotel.hotelId, hotel.admin, request());
    expect(status?.effectivePackage).toBe('P20');
    expect(status?.pendingUpgradePackage).toBe('P25');
    expect(status?.pendingUpgradeEffectiveAt?.toISOString()).toBe(hotel.effectiveAt.toISOString());
    expect(status?.expiresAt.getTime()).toBeGreaterThan(hotel.expiresAt.getTime());
    expect(status?.packageFloor).toBe('P25');
  });

  it('refuses a renewal directly above the pending target until the incremental upgrade is done', async () => {
    const hotel = await pendingP25();
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P30',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: `r7-above-${unique()}`,
        },
        hotel.admin,
        request(),
      ),
      'PRECONDITION_FAILED',
    );
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_billing_intent
          WHERE hotel_id = $1 AND kind = 'RENEWAL'`,
        [hotel.hotelId],
      ),
    ).toBe(0);

    // The approved path: P25 → P30 incrementally, then renew at P30.
    const second = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        provider: 'QPAY',
        idempotencyKey: `r7-inc-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    expect(second.effectiveAt).toBe(hotel.effectiveAt.toISOString());
    const incremental = await payBilling(hotel, second, new Date());
    expect(incremental.kind).toBe('upgrade_pending');
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `r7-rn30-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const renewed = await payBilling(hotel, renewal, new Date());
    expect(renewed.kind).toBe('renewed');
    const status = await env.subscriptions.status(hotel.hotelId, hotel.admin, request());
    expect(status?.pendingUpgradePackage).toBe('P30');
    expect(status?.pendingUpgradeEffectiveAt?.toISOString()).toBe(hotel.effectiveAt.toISOString());
    expect(status?.effectivePackage).toBe('P20');
  });
});
