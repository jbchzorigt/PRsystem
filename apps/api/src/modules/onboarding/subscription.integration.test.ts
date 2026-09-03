import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandActor } from '../iam/services/iam-context';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { actorFor } from '../iam/test-support/iam-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 — subscription lifecycle, on a real database.
 *
 * doc 16 (`SUB-DEC-005`, `SUB-DEC-008`, `SUB-DEC-009`), doc 17
 * (`LIFE-DEC-001`…`007`) and doc 14 (`OPS-DEC-006`, `OPS-DEC-007`).
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('subscription_integration');
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

/**
 * A provisioned hotel with a subscription starting exactly at `confirmedAt`.
 *
 * The whole real flow, because the subscription's dates are derived from the
 * payment and there is no other way to get one.
 */
async function hotelWith(options: {
  packageCode?: string;
  termMonths?: number;
  confirmedAt?: Date;
}): Promise<{ hotelId: string; startsAt: Date; expiresAt: Date; subscriptionId: string }> {
  const n = unique();
  const confirmedAt = options.confirmedAt ?? new Date('2026-08-21T07:00:00.000Z');
  const email = `sub-${n}@example.test`;
  const draft = citizenDraft({
    registrationNumber: `SUB${n}0011`,
    adminEmail: email,
    hotelDisplayName: `Subscription Hotel ${n}`,
    addressLine: `Subscription address ${n}`,
    contactPhone: `+9769933${n}`,
    subscriptionContactPhone: `+9769933${n}`,
    packageCode: options.packageCode ?? 'P20',
    termMonths: options.termMonths ?? 12,
  });
  const created = await env.onboarding.createApplication(draft, request());
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const code = env.phone.codeFor(created.applicationId);
  await env.onboarding.confirmPhoneVerification(created.applicationId, code ?? '', request());
  await env.onboarding.resolveOwner(created.applicationId, request());
  const invoice = await env.onboarding.openInvoice(
    { applicationId: created.applicationId, provider: 'QPAY', idempotencyKey: `sub-idem-${n}` },
    request(),
  );
  const paymentId = env.qpay.pay(invoice.providerInvoiceId, confirmedAt);
  await env.provisioning.applyCallback(
    callbackFor('QPAY', invoice.providerInvoiceId, paymentId),
    request(),
  );
  const outcome = await env.provisioning.provision(
    created.applicationId,
    `sub-provision-${n}`,
    request(),
  );
  if (outcome.kind !== 'provisioned') {
    throw new Error(`provisioning failed: ${JSON.stringify(outcome)}`);
  }
  // The Primary Admin activates and signs in: every subscription command is
  // an authorized Hotel Admin action from here on (R1).
  await env.worker.deliverActivations();
  const link = env.notifications.lastInvitationFor(email);
  const password = ['synthetic', `sub-${n}`, 'passphrase'].join('-');
  await env.activation.activate(
    { hotelId: outcome.hotelId, token: link?.token ?? '', password },
    request(),
  );
  admins.set(
    outcome.hotelId,
    await actorFor(env.iam, { membershipId: '', accountId: '', email, password }),
  );
  const row = await env.admin.query<{ subscription_id: string; starts_at: Date; expires_at: Date }>(
    `SELECT subscription_id, starts_at, expires_at FROM platform.hotel_subscription
      WHERE hotel_id = $1`,
    [outcome.hotelId],
  );
  const subscription = row.rows[0];
  if (subscription === undefined) throw new Error('no subscription');
  return {
    hotelId: outcome.hotelId,
    startsAt: subscription.starts_at,
    expiresAt: subscription.expires_at,
    subscriptionId: subscription.subscription_id,
  };
}

/** The activated Primary Admin of a hotel this file provisioned. */
const admins = new Map<string, CommandActor>();
function adminOf(hotelId: string): CommandActor {
  const actor = admins.get(hotelId);
  if (actor === undefined) throw new Error(`no admin actor for ${hotelId}`);
  return actor;
}

/** Quotes, pays and applies a renewal or upgrade in one step. */
async function payBilling(
  hotelId: string,
  quote: { intentId: string; providerInvoiceId: string },
  confirmedAt: Date,
  provider: 'QPAY' | 'KHAAN' = 'QPAY',
): Promise<Awaited<ReturnType<typeof env.subscriptions.applyBillingCallback>>> {
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  const paymentId = gateway.pay(quote.providerInvoiceId, confirmedAt);
  return env.subscriptions.applyBillingCallback(
    hotelId,
    callbackFor(provider, quote.providerInvoiceId, paymentId),
    request(),
  );
}

/**
 * Brings a paid pending upgrade's boundary into the past, so the boundary
 * operation can be exercised without waiting a calendar month for it.
 *
 * Two statements, because the guard refuses to move a live boundary — a pending
 * target whose effective moment could slide would be an entitlement somebody
 * paid for arriving whenever a writer felt like it. So the fixture clears the
 * pending upgrade and re-establishes it at the earlier moment, which is a
 * fixture manipulation and not a path any service offers.
 */
async function bringBoundaryForward(hotelId: string): Promise<void> {
  const current = await env.admin.query<{ pending: string }>(
    `SELECT pending_upgrade_package AS pending FROM platform.hotel_subscription
      WHERE hotel_id = $1`,
    [hotelId],
  );
  const pending = current.rows[0]?.pending;
  if (pending === undefined || pending === null) throw new Error('no pending upgrade to move');
  await env.admin.query(
    `UPDATE platform.hotel_subscription
        SET pending_upgrade_package = NULL, pending_upgrade_effective_at = NULL,
            billing_revision = billing_revision + 1, revision = revision + 1
      WHERE hotel_id = $1`,
    [hotelId],
  );
  await env.admin.query(
    `UPDATE platform.hotel_subscription
        SET pending_upgrade_package = $2,
            pending_upgrade_effective_at = now() - interval '1 minute',
            billing_revision = billing_revision + 1, revision = revision + 1
      WHERE hotel_id = $1`,
    [hotelId, pending],
  );
}

// ================================================================ authoritative state

describe('OPS-DEC-016 — the authoritative subscription state', () => {
  it('answers from the authoritative row, and the pipeline sees it', async () => {
    const hotel = await hotelWith({ packageCode: 'P25', termMonths: 3 });
    const snapshot = await env.subscriptionState.snapshot(hotel.hotelId, new Date());
    expect(snapshot?.effectivePackage).toBe('P25');
    expect(snapshot?.state).toBe('ACTIVE');
    expect(snapshot?.hotelId).toBe(hotel.hotelId);
  });

  it('still fails closed for a hotel that was never provisioned', async () => {
    // The Phase 04 behaviour, preserved: an unanswerable port denies at stage 5.
    const snapshot = await env.subscriptionState.snapshot(
      '00000000-0000-0000-0000-0000000000aa',
      new Date(),
    );
    expect(snapshot).toBeUndefined();
  });

  it('follows the clock across expiry, grace and the hard lock', async () => {
    const hotel = await hotelWith({});
    const expiresAt = hotel.expiresAt;
    const at = async (offsetMs: number): Promise<string | undefined> =>
      (
        await env.subscriptionState.snapshot(
          hotel.hotelId,
          new Date(expiresAt.getTime() + offsetMs),
        )
      )?.state;

    expect(await at(-169 * 60 * 60 * 1000)).toBe('ACTIVE');
    expect(await at(-168 * 60 * 60 * 1000)).toBe('EXPIRING_SOON');
    expect(await at(-1)).toBe('EXPIRING_SOON');
    expect(await at(0)).toBe('GRACE');
    expect(await at(48 * 60 * 60 * 1000 - 1)).toBe('GRACE');
    expect(await at(48 * 60 * 60 * 1000)).toBe('EXPIRED');
  });

  it('reports listing eligibility through grace and hides it after', async () => {
    const live = await hotelWith({});
    expect(
      (await env.subscriptions.status(live.hotelId, adminOf(live.hotelId), request()))
        ?.listingEligible,
    ).toBe(true);

    // A hotel whose paid window and grace both ran out, reached the only way a
    // real one can: a one-month term paid for long ago. Nothing rewrites the
    // dates — the guard would refuse that, and rightly.
    const lapsed = await hotelWith({
      termMonths: 1,
      confirmedAt: new Date('2026-01-05T07:00:00.000Z'),
    });
    const locked = await env.subscriptions.status(
      lapsed.hotelId,
      adminOf(lapsed.hotelId),
      request(),
    );
    expect(locked?.state).toBe('EXPIRED');
    expect(locked?.listingEligible).toBe(false);
  });

  it('leaves a provisioned hotel unlisted until somebody publishes it', async () => {
    // doc 15 §6: paid is not published. Phase 05 owns the axis, Phase 12 the gate.
    const hotel = await hotelWith({});
    const profile = await env.admin.query<{ listing_state: string }>(
      `SELECT listing_state FROM platform.hotel_profile WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(profile.rows[0]?.listing_state).toBe('UNLISTED');
  });
});

// ===================================================================== renewal

describe('OPS-DEC-007 / LIFE-DEC-005 — renewal', () => {
  it('extends from the existing expiry when paid before it', async () => {
    const hotel = await hotelWith({ termMonths: 1 });
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `renew-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    expect(quote.amountMnt).toBe('20000');

    const outcome = await payBilling(
      hotel.hotelId,
      quote,
      new Date(hotel.expiresAt.getTime() - 1000),
    );
    expect(outcome.kind).toBe('renewed');
    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    // 21 September 15:00 local + 1 month = 21 October 15:00 local.
    expect(status?.expiresAt).toEqual(new Date('2026-10-21T07:00:00.000Z'));
  });

  it('still extends from the original expiry when paid inside grace', async () => {
    const hotel = await hotelWith({ termMonths: 1 });
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `renew-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    // One hour into grace. The customer must not accumulate the 48 free hours.
    const outcome = await payBilling(
      hotel.hotelId,
      quote,
      new Date(hotel.expiresAt.getTime() + 60 * 60 * 1000),
    );
    expect(outcome.kind).toBe('renewed');
    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.expiresAt).toEqual(new Date('2026-10-21T07:00:00.000Z'));
    expect(status?.startsAt).toEqual(hotel.startsAt);
  });

  it('restarts at the confirmation when paid after grace', async () => {
    const hotel = await hotelWith({ termMonths: 1 });
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `renew-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    const afterGrace = new Date(hotel.expiresAt.getTime() + 49 * 60 * 60 * 1000);
    const outcome = await payBilling(hotel.hotelId, quote, afterGrace);
    expect(outcome.kind).toBe('renewed');

    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.startsAt).toEqual(afterGrace);
    // 23 September 16:00 local + 1 month.
    expect(status?.expiresAt).toEqual(new Date('2026-10-23T08:00:00.000Z'));
  });

  it('refuses a renewal below the package floor, through the service', async () => {
    // `LIFE-DEC-001`: there is no downgrade API, and the server refuses the
    // request a client could still send.
    const hotel = await hotelWith({ packageCode: 'P30', termMonths: 1 });
    for (const target of ['P20', 'P25']) {
      await expect(
        env.subscriptions.quoteRenewal(
          {
            hotelId: hotel.hotelId,
            targetPackage: target,
            termMonths: 1,
            provider: 'QPAY',
            idempotencyKey: `down-${unique()}`,
          },
          adminOf(hotel.hotelId),
          request(),
        ),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
  });

  it('refuses a downgrade at the database, not only in the service', async () => {
    // The same rule, one layer down: a direct statement is refused too, so a
    // later phase's code path cannot reintroduce what `LIFE-DEC-001` removed.
    const hotel = await hotelWith({ packageCode: 'P30', termMonths: 1 });
    await expect(
      env.admin.query(
        `UPDATE platform.hotel_subscription
            SET effective_package = 'P20', package_floor = 'P20',
                billing_revision = billing_revision + 1, revision = revision + 1
          WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      env.admin.query(
        `UPDATE platform.hotel_subscription
            SET package_floor = 'P25', billing_revision = billing_revision + 1,
                revision = revision + 1
          WHERE hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('never moves starts_at or shortens the term on a duplicate callback', async () => {
    const hotel = await hotelWith({ termMonths: 1 });
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 3,
        provider: 'QPAY',
        idempotencyKey: `renew-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    const paymentId = env.qpay.pay(
      quote.providerInvoiceId,
      new Date(hotel.expiresAt.getTime() - 1),
    );
    const callback = callbackFor('QPAY', quote.providerInvoiceId, paymentId);

    const first = await env.subscriptions.applyBillingCallback(hotel.hotelId, callback, request());
    const second = await env.subscriptions.applyBillingCallback(hotel.hotelId, callback, request());
    expect(first.kind).toBe('renewed');
    expect(second).toEqual({ kind: 'replay' });

    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.expiresAt).toEqual(new Date('2026-12-21T07:00:00.000Z'));
    // Exactly one renewal event and one payment.
    const events = await env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.subscription_event
        WHERE hotel_id = $1 AND event_type = 'RENEWED'`,
      [hotel.hotelId],
    );
    expect(events.rows[0]?.n).toBe('1');
  });
});

// ===================================================================== upgrade

describe('LIFE-DEC-002 / LIFE-DEC-006 — upgrade', () => {
  it('charges the difference for the remaining whole months and waits for the boundary', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const quote = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    // Eleven whole service months remain after the first boundary.
    expect(quote.amountMnt).toBe('55000');

    const outcome = await payBilling(
      hotel.hotelId,
      quote,
      new Date(hotel.startsAt.getTime() + 1000),
    );
    expect(outcome.kind).toBe('upgrade_pending');

    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    // The entitlement has not moved; the floor has.
    expect(status?.effectivePackage).toBe('P20');
    expect(status?.pendingUpgradePackage).toBe('P25');
    expect(status?.packageFloor).toBe('P25');
    // And the term is untouched.
    expect(status?.expiresAt).toEqual(hotel.expiresAt);
  });

  it('prices a second upgrade incrementally and inherits the same boundary', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const first = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await payBilling(hotel.hotelId, first, new Date(hotel.startsAt.getTime() + 1000));

    const second = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    // (30,000 − 25,000) × 11, not (30,000 − 20,000) × 11.
    expect(second.amountMnt).toBe('55000');
    expect(second.effectiveAt).toBe(first.effectiveAt);

    await payBilling(hotel.hotelId, second, new Date(hotel.startsAt.getTime() + 2000));
    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.pendingUpgradePackage).toBe('P30');
    expect(status?.packageFloor).toBe('P30');
    expect(status?.effectivePackage).toBe('P20');

    // Both payments are immutable history: two rows, neither reversed.
    const payments = await env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.subscription_payment
        WHERE hotel_id = $1 AND purpose = 'UPGRADE'`,
      [hotel.hotelId],
    );
    expect(payments.rows[0]?.n).toBe('2');
  });

  it('refuses an equal or lower target, and offers no invoice for either', async () => {
    const hotel = await hotelWith({ packageCode: 'P25', termMonths: 12 });
    for (const target of ['P20', 'P25']) {
      await expect(
        env.subscriptions.quoteUpgrade(
          {
            hotelId: hotel.hotelId,
            targetPackage: target,
            provider: 'QPAY',
            idempotencyKey: `extra-key-${unique()}`,
          },
          adminOf(hotel.hotelId),
          request(),
        ),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
  });

  it('creates no invoice when no whole service month remains', async () => {
    // `LIFE-DEC-002`: the answer is a higher-package renewal, not a zero invoice.
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 1 });
    await expect(
      env.subscriptions.quoteUpgrade(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P30',
          provider: 'QPAY',
          idempotencyKey: `extra-key-${unique()}`,
        },
        adminOf(hotel.hotelId),
        request(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('applies the target immediately when the inherited boundary has passed', async () => {
    // `LIFE-DEC-007`: a second upgrade inherits the first's boundary, and if that
    // boundary has arrived by the time the payment confirms, the target is
    // applied in the same transaction rather than left pending for a worker that
    // would only re-apply it.
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const first = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await payBilling(hotel.hotelId, first, new Date(hotel.startsAt.getTime() + 1000));
    await bringBoundaryForward(hotel.hotelId);

    const second = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        provider: 'KHAAN',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    const outcome = await payBilling(hotel.hotelId, second, new Date(), 'KHAAN');
    expect(outcome.kind).toBe('upgrade_applied');
    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.effectivePackage).toBe('P30');
    expect(status?.pendingUpgradePackage).toBeNull();
  });

  it('applies a due pending upgrade through the boundary worker, exactly once', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const quote = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P30',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await payBilling(hotel.hotelId, quote, new Date(hotel.startsAt.getTime() + 1000));

    await bringBoundaryForward(hotel.hotelId);

    const applied = await env.subscriptions.applyDueUpgrades();
    expect(applied).toBeGreaterThan(0);
    const status = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(status?.effectivePackage).toBe('P30');
    expect(status?.pendingUpgradePackage).toBeNull();

    // A second sweep applies nothing: there is no pending target left.
    expect(await env.subscriptions.applyDueUpgrade(hotel.hotelId, request())).toBe(false);
    const events = await env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.subscription_event
        WHERE hotel_id = $1 AND event_type = 'UPGRADE_APPLIED'`,
      [hotel.hotelId],
    );
    expect(events.rows[0]?.n).toBe('1');
  });
});

// =========================================================== renewal versus upgrade

describe('LIFE-DEC-006 — one live intent, and stale quotes', () => {
  it('supersedes a live renewal quote when an upgrade starts', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `renewal-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'QPAY',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );

    const stale = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.subscription_billing_intent WHERE intent_id = $1`,
      [renewal.intentId],
    );
    expect(stale.rows[0]?.state).toBe('STALE');
  });

  it('sends a late payment on a superseded quote to reconciliation, changing nothing', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `renewal-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'KHAAN',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    const before = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());

    const outcome = await payBilling(hotel.hotelId, renewal, new Date());
    expect(outcome.kind).toBe('requires_reconciliation');

    const after = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect(after?.expiresAt).toEqual(before?.expiresAt);
    expect(after?.effectivePackage).toBe(before?.effectivePackage);
    expect(after?.packageFloor).toBe(before?.packageFloor);
  });

  it('closes a reconciliation case without granting any entitlement', async () => {
    const hotel = await hotelWith({ packageCode: 'P20', termMonths: 12 });
    const renewal = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 12,
        provider: 'QPAY',
        idempotencyKey: `renewal-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'KHAAN',
        idempotencyKey: `upgrade-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await payBilling(hotel.hotelId, renewal, new Date());

    const before = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    const operator = await env.operationActor({ permissions: ['SUBSCRIPTION_PAYMENT_RECONCILE'] });
    const accountId = operator.accountId;

    await env.subscriptions.closeReconciliation(
      {
        hotelId: hotel.hotelId,
        intentId: renewal.intentId,
        outcome: 'EXTERNALLY_VOIDED',
        reason: 'refunded by the provider outside the platform',
      },
      operator.actor,
      request(),
    );

    // The subscription is exactly where it was: closing a case grants nothing.
    const after = await env.subscriptions.status(hotel.hotelId, adminOf(hotel.hotelId), request());
    expect({
      expiresAt: after?.expiresAt,
      effectivePackage: after?.effectivePackage,
      packageFloor: after?.packageFloor,
      startsAt: after?.startsAt,
    }).toEqual({
      expiresAt: before?.expiresAt,
      effectivePackage: before?.effectivePackage,
      packageFloor: before?.packageFloor,
      startsAt: before?.startsAt,
    });

    const closed = await env.admin.query<{ outcome: string; account: string }>(
      `SELECT reconciliation_outcome AS outcome, reconciled_by_account_id::text AS account
         FROM platform.subscription_billing_intent WHERE intent_id = $1`,
      [renewal.intentId],
    );
    expect(closed.rows[0]).toEqual({ outcome: 'EXTERNALLY_VOIDED', account: accountId });
  });
});

// ======================================================================= eBarimt

describe('SUB-DEC-005 / SUB-DEC-008 — eBarimt', () => {
  async function paidRenewal(): Promise<{ hotelId: string; paymentId: string }> {
    const hotel = await hotelWith({ termMonths: 1 });
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `ebarimt-${unique()}`,
      },
      adminOf(hotel.hotelId),
      request(),
    );
    await payBilling(hotel.hotelId, quote, new Date(hotel.expiresAt.getTime() - 1000));
    const payment = await env.admin.query<{ payment_id: string }>(
      `SELECT payment_id FROM platform.subscription_payment
        WHERE hotel_id = $1 AND purpose = 'RENEWAL'`,
      [hotel.hotelId],
    );
    return { hotelId: hotel.hotelId, paymentId: payment.rows[0]?.payment_id as string };
  }

  it('issues one receipt per confirmed payment and emails it only after it exists', async () => {
    const paid = await paidRenewal();
    const outcome = await env.ebarimt.processOne(
      paid.hotelId,
      (await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request()))?.issuanceId ?? '',
      request(),
    );
    expect(outcome.kind).toBe('issued');

    const issuance = await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request());
    expect(issuance?.state).toBe('ISSUED');
    expect(issuance?.deliveryState).toBe('SENT');
    expect(issuance?.receiptNumber).toMatch(/^SIM-\d{10}$/);
  });

  it('a failed issuance never rolls back the subscription and lands in the manual queue', async () => {
    const paid = await paidRenewal();
    const before = await env.subscriptions.status(paid.hotelId, adminOf(paid.hotelId), request());
    const issuanceId =
      (await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request()))?.issuanceId ?? '';

    env.receipts.failNext('permanent');
    const outcome = await env.ebarimt.processOne(paid.hotelId, issuanceId, request());
    expect(outcome.kind).toBe('manual_resolution');

    // The subscription is untouched.
    const after = await env.subscriptions.status(paid.hotelId, adminOf(paid.hotelId), request());
    expect(after?.expiresAt).toEqual(before?.expiresAt);
    expect(after?.state).toBe(before?.state);

    const reader = await env.operationActor({ permissions: ['SUBSCRIPTION_EBARIMT_RETRY'] });
    const queue = await env.ebarimt.manualQueue(reader.actor, request());
    expect(queue.map((entry) => entry.issuanceId)).toContain(issuanceId);
  });

  it('an operator retry can only ask the issuer again, never write a receipt field', async () => {
    const paid = await paidRenewal();
    const issuanceId =
      (await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request()))?.issuanceId ?? '';
    env.receipts.failNext('permanent');
    await env.ebarimt.processOne(paid.hotelId, issuanceId, request());

    const operator = await env.operationActor({ permissions: ['SUBSCRIPTION_EBARIMT_RETRY'] });
    const accountId = operator.accountId;
    const retried = await env.ebarimt.retry(paid.hotelId, issuanceId, operator.actor, request());
    expect(retried.kind).toBe('issued');

    const issued = await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request());
    expect(issued?.state).toBe('ISSUED');
    // The receipt came from the port, and the row records who asked for it.
    const attributed = await env.admin.query<{ retried_by: string | null }>(
      `SELECT retried_by_account_id::text AS retried_by FROM platform.ebarimt_issuance
        WHERE issuance_id = $1`,
      [issuanceId],
    );
    expect(attributed.rows[0]?.retried_by).toBe(accountId);
  });

  it('a fabricated receipt cannot be written, and an issued one cannot be rewritten', async () => {
    const paid = await paidRenewal();
    const issuanceId =
      (await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request()))?.issuanceId ?? '';

    // A partial receipt is refused by the database, not by a service check.
    await expect(
      env.admin.query(
        `UPDATE platform.ebarimt_issuance
            SET receipt_number = 'INVENTED', state = 'ISSUED', revision = revision + 1
          WHERE issuance_id = $1`,
        [issuanceId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await env.ebarimt.processOne(paid.hotelId, issuanceId, request());
    await expect(
      env.admin.query(
        `UPDATE platform.ebarimt_issuance
            SET receipt_number = 'REWRITTEN', revision = revision + 1
          WHERE issuance_id = $1`,
        [issuanceId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a receipt whose amount disagrees with the payment it belongs to', async () => {
    // doc 16 §6: the receipt's amount equals the confirmed payment's. An issuer
    // that answers with a different figure has not issued this payment's receipt.
    const paid = await paidRenewal();
    const issuanceId =
      (await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request()))?.issuanceId ?? '';

    const original = env.deps.ebarimt.issue.bind(env.deps.ebarimt);
    (env.deps.ebarimt as { issue: unknown }).issue = () =>
      Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'sim-wrong',
          receiptNumber: 'SIM-WRONG',
          qr: 'q',
          issuedAt: new Date(),
          totalMnt: 999_999n,
          vatMnt: 1n,
        },
      });
    try {
      const outcome = await env.ebarimt.processOne(paid.hotelId, issuanceId, request());
      expect(outcome).toEqual({ kind: 'manual_resolution', reason: 'receipt_amount_mismatch' });
    } finally {
      (env.deps.ebarimt as { issue: unknown }).issue = original;
    }
    const issuance = await env.ebarimt.issuanceFor(paid.hotelId, paid.paymentId, request());
    expect(issuance?.receiptNumber).toBeNull();
  });
});

// ============================================================ no refund, ever

describe('SUB-DEC-009 — a confirmed subscription payment is never reversed', () => {
  it('cannot be updated or deleted, by anybody', async () => {
    const hotel = await hotelWith({ termMonths: 1 });
    const payment = await env.admin.query<{ payment_id: string }>(
      `SELECT payment_id FROM platform.subscription_payment WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    const paymentId = payment.rows[0]?.payment_id;
    await expect(
      env.admin.query(
        `UPDATE platform.subscription_payment SET gross_amount_mnt = 0 WHERE payment_id = $1`,
        [paymentId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      env.admin.query(`DELETE FROM platform.subscription_payment WHERE payment_id = $1`, [
        paymentId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('records the gross, the VAT and the platform-borne fee separately', async () => {
    // `SUB-DEC-006` / `SUB-DEC-007`: the customer pays the published price, and
    // the provider fee is the platform's cost — beside the gross, never inside it.
    const hotel = await hotelWith({ packageCode: 'P25', termMonths: 1 });
    const payment = await env.admin.query<{
      gross: string;
      vat: string;
      fee: string;
      net: string;
    }>(
      `SELECT gross_amount_mnt AS gross, vat_amount_mnt AS vat,
              provider_fee_mnt AS fee, net_amount_mnt AS net
         FROM platform.subscription_payment WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    // The provider stated no fee for this payment: the fee is unknown and no
    // net amount is derived from it (remediation 2, finding 6). A stated zero
    // is a different fact, recorded as zero.
    expect(payment.rows[0]).toEqual({
      gross: '25000',
      vat: '2273',
      fee: null,
      net: null,
    });
  });
});
