import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { CommandActor } from '../iam/services/iam-context';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { actorFor } from '../iam/test-support/iam-harness';
import { withTenantTransaction } from '@prsystem/db';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { hotelScope, newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 remediation 2 — the correctness closure, findings 1 to 6.
 *
 * Written before the fixes and run against the review base first. Every case
 * names the control flow it reproduces; a case that passes on the base is
 * reported as such rather than reshaped until it fails.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('onboarding_remediation2');
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

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await env.admin.query<{ n: string }>(sql, values as unknown[]);
  return Number(result.rows[0]?.n ?? '0');
}

async function expectApiError(work: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

function fresh(overrides: Record<string, unknown> = {}): ReturnType<typeof citizenDraft> {
  const n = unique();
  return citizenDraft({
    registrationNumber: `RM2${n}0011`,
    adminEmail: `rm2-${n}@example.test`,
    hotelDisplayName: `Remediation Two Hotel ${n}`,
    addressLine: `Remediation two address ${n}`,
    contactPhone: `+9769933${n}`,
    subscriptionContactPhone: `+9769933${n}`,
    ...overrides,
  });
}

async function verified(overrides: Record<string, unknown> = {}): Promise<{
  applicationId: string;
  email: string;
  phone: string;
  registrationNumber: string;
}> {
  const draft = fresh(overrides);
  const created = await env.onboarding.createApplication(draft, request());
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const code = env.phone.codeFor(created.applicationId);
  if (code === undefined) throw new Error('the simulator recorded no code');
  await env.onboarding.confirmPhoneVerification(created.applicationId, code, request());
  return {
    applicationId: created.applicationId,
    email: draft.adminEmail,
    phone: draft.contactPhone,
    registrationNumber: draft.registrationNumber,
  };
}

async function payAndConfirm(
  applicationId: string,
  options: { feeMnt?: bigint; idempotencyKey?: string } = {},
): Promise<{ invoiceId: string; paymentId: string; attemptId: string }> {
  const invoice = await env.onboarding.openInvoice(
    {
      applicationId,
      provider: 'QPAY',
      idempotencyKey: options.idempotencyKey ?? `rm2-${unique()}-${applicationId}`,
    },
    request(),
  );
  const paymentId = env.qpay.pay(invoice.providerInvoiceId, new Date(), undefined, options.feeMnt);
  const outcome = await env.provisioning.applyCallback(
    callbackFor('QPAY', invoice.providerInvoiceId, paymentId),
    request(),
  );
  if (outcome.kind !== 'paid') throw new Error(`not paid: ${JSON.stringify(outcome)}`);
  return { invoiceId: invoice.providerInvoiceId, paymentId, attemptId: invoice.attemptId };
}

interface Hotel {
  hotelId: string;
  applicationId: string;
  admin: CommandActor;
  email: string;
  phone: string;
  reg: string;
  expiresAt: Date;
}

async function provisionedHotel(
  overrides: Record<string, unknown> = {},
  options: { feeMnt?: bigint } = {},
): Promise<Hotel> {
  const ready = await verified({ packageCode: 'P20', termMonths: 12, ...overrides });
  await env.onboarding.resolveOwner(ready.applicationId, request());
  await payAndConfirm(ready.applicationId, options);
  const outcome = await env.provisioning.provision(
    ready.applicationId,
    `rm2-provision-${ready.applicationId}`,
    request(),
  );
  if (outcome.kind !== 'provisioned') {
    throw new Error(`provisioning did not succeed: ${JSON.stringify(outcome)}`);
  }
  await env.worker.deliverActivations();
  const link = env.notifications.lastInvitationFor(ready.email);
  const password = syntheticPassword(ready.email);
  await env.activation.activate(
    { hotelId: outcome.hotelId, token: link?.token ?? '', password },
    request(),
  );
  const admin = await actorFor(env.iam, {
    membershipId: '',
    accountId: '',
    email: ready.email,
    password,
  });
  const status = await env.subscriptions.status(outcome.hotelId, admin, request());
  if (status === undefined) throw new Error('no subscription');
  return {
    hotelId: outcome.hotelId,
    applicationId: ready.applicationId,
    admin,
    email: ready.email,
    phone: ready.phone,
    reg: ready.registrationNumber,
    expiresAt: status.expiresAt,
  };
}

async function payBilling(
  hotel: Hotel,
  quote: { intentId: string; providerInvoiceId: string },
  options: { provider?: 'QPAY' | 'KHAAN'; feeMnt?: bigint } = {},
) {
  const provider = options.provider ?? 'QPAY';
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  const paymentId = gateway.pay(quote.providerInvoiceId, new Date(), undefined, options.feeMnt);
  return env.subscriptions.applyBillingCallback(
    hotel.hotelId,
    callbackFor(provider, quote.providerInvoiceId, paymentId),
    request(),
  );
}

/**
 * Revokes the Primary Admin's live scope grant: the membership revision moves,
 * exactly as a suspension, a role change or a termination moves it, and every
 * session grant issued at the old revision is stale. (The Primary Admin row
 * itself is guarded against a direct state change, so the revision is the
 * revocation every path shares.)
 */
async function suspendPrimaryAdmin(hotelId: string): Promise<void> {
  await env.admin.query(
    `UPDATE platform.staff_membership
        SET membership_revision = membership_revision + 1
      WHERE hotel_id = $1 AND is_primary_admin`,
    [hotelId],
  );
}

async function installTrap(
  table: string,
  when: 'INSERT' | 'UPDATE',
  errcode = 'P0001',
): Promise<() => Promise<void>> {
  const name = `rm2_trap_${unique()}`;
  await env.admin.query(`
    CREATE OR REPLACE FUNCTION platform.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'remediation two trap' USING ERRCODE = '${errcode}'; END $$;
    CREATE TRIGGER ${name} BEFORE ${when} ON platform.${table}
      FOR EACH ROW EXECUTE FUNCTION platform.${name}();`);
  return async () => {
    await env.admin.query(
      `DROP TRIGGER IF EXISTS ${name} ON platform.${table}; DROP FUNCTION IF EXISTS platform.${name}();`,
    );
  };
}

// ============================================================== 1 — invoices

describe('1 — invoice and quote correctness', () => {
  it('replays a completed onboarding invoice after the payment, without re-judging eligibility', async () => {
    // Control flow on the base: `openInvoice` runs `assertInvoiceable` before it
    // looks at the idempotency claim, so the retry of a request that already
    // succeeded is refused with CONFLICT once the application has been paid.
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    const key = `rm2-replay-${unique()}`;
    const first = await payAndConfirm(ready.applicationId, { idempotencyKey: key });
    const again = await env.onboarding.openInvoice(
      { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: key },
      request(),
    );
    expect(again.providerInvoiceId).toBe(first.invoiceId);
    expect(again.attemptId).toBe(first.attemptId);
  });

  it('replays a completed upgrade quote after it was paid, without re-pricing it', async () => {
    const hotel = await provisionedHotel();
    const key = `rm2-up-replay-${unique()}`;
    const quote = await env.subscriptions.quoteUpgrade(
      { hotelId: hotel.hotelId, targetPackage: 'P25', provider: 'QPAY', idempotencyKey: key },
      hotel.admin,
      request(),
    );
    const paid = await payBilling(hotel, quote);
    expect(['upgrade_pending', 'upgrade_applied']).toContain(paid.kind);
    // The same request again: the stored answer, not a fresh pricing decision
    // against a subscription that now already has this upgrade.
    const again = await env.subscriptions.quoteUpgrade(
      { hotelId: hotel.hotelId, targetPackage: 'P25', provider: 'QPAY', idempotencyKey: key },
      hotel.admin,
      request(),
    );
    expect(again.intentId).toBe(quote.intentId);
    expect(again.providerInvoiceId).toBe(quote.providerInvoiceId);
    expect(again.amountMnt).toBe(quote.amountMnt);
  });

  it('replay still requires authorization: a suspended admin gets NOT_FOUND, not the stored body', async () => {
    const hotel = await provisionedHotel();
    const key = `rm2-authz-replay-${unique()}`;
    await env.subscriptions.quoteRenewal(
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
    await suspendPrimaryAdmin(hotel.hotelId);
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'NOT_FOUND',
    );
  });

  it('persists a stale-quote outcome and the provider invoice it left behind', async () => {
    // Control flow on the base: the stale check in the finalizing transaction
    // completes the idempotency claim with a 409 and then throws inside the same
    // transaction, so the completion is rolled back, the retry re-executes, and
    // the provider invoice that was created is recorded nowhere.
    const hotel = await provisionedHotel();
    const key = `rm2-stale-${unique()}`;
    const release = env.qpay.blockNext();
    const renewal = env.subscriptions.quoteRenewal(
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
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const upgrade = await env.subscriptions.quoteUpgrade(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P25',
          provider: 'KHAAN',
          idempotencyKey: `rm2-stale-up-${unique()}`,
        },
        hotel.admin,
        request(),
      );
      await payBilling(hotel, upgrade, { provider: 'KHAAN' });
    } finally {
      release();
    }
    await expectApiError(renewal, 'CONFLICT');

    // The outcome is durable: the same key replays the refusal instead of
    // quoting again.
    const before = env.qpay.invoiceCount;
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'CONFLICT',
    );
    expect(env.qpay.invoiceCount).toBe(before);

    // And the invoice the provider created is tracked, never live, never
    // payable, with the snapshot it was priced from.
    const orphan = await env.admin.query<{
      state: string;
      provider_invoice_id: string | null;
      amount_mnt: string;
    }>(
      `SELECT state, provider_invoice_id, amount_mnt FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND kind = 'RENEWAL'`,
      [hotel.hotelId],
    );
    expect(orphan.rows).toHaveLength(1);
    expect(orphan.rows[0]?.state).toBe('ABANDONED');
    expect(orphan.rows[0]?.provider_invoice_id).not.toBeNull();
    expect(env.qpay.invoice(orphan.rows[0]?.provider_invoice_id ?? '')).toBeDefined();
    expect(orphan.rows[0]?.amount_mnt).toBe('20000');
  });

  it('never re-prices an old provider invoice under the same key after the row moved', async () => {
    // A renewal whose acknowledgement was lost, then an upgrade that moves the
    // package floor above the renewal's target. The retry must not persist a
    // freshly priced intent against the invoice the provider already holds.
    const hotel = await provisionedHotel();
    const key = `rm2-lost-${unique()}`;
    env.qpay.loseNextAcknowledgement();
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'DEPENDENCY_UNAVAILABLE',
    );
    const upgrade = await env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'KHAAN',
        idempotencyKey: `rm2-lost-up-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    await payBilling(hotel, upgrade, { provider: 'KHAAN' });
    const invoices = env.qpay.invoiceCount;
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'QPAY',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'CONFLICT',
    );
    expect(env.qpay.invoiceCount).toBe(invoices);
    const live = await env.admin.query<{ state: string; amount_mnt: string }>(
      `SELECT state, amount_mnt FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND kind = 'RENEWAL'`,
      [hotel.hotelId],
    );
    for (const row of live.rows) {
      expect(row.state).not.toBe('PENDING');
      expect(row.amount_mnt).toBe('20000');
    }
  });

  it('a payment callback takes the subscription lock before the intent lock', async () => {
    // Deterministic: an outside transaction holds the subscription row. A
    // callback in flight must be waiting on that row without holding the intent
    // row — the order the replacement quote uses — so a third connection can
    // lock the intent with NOWAIT. On the base the callback locks the intent
    // first and this refuses with 55P03, the shape of the deadlock.
    const hotel = await provisionedHotel();
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `rm2-lock-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const paymentId = env.qpay.pay(quote.providerInvoiceId, new Date());
    const holder = await env.admin.connect();
    const probe = await env.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM platform.hotel_subscription WHERE hotel_id = $1 FOR UPDATE`,
        [hotel.hotelId],
      );
      const callback = env.subscriptions.applyBillingCallback(
        hotel.hotelId,
        callbackFor('QPAY', quote.providerInvoiceId, paymentId),
        request(),
      );
      // Wait until the callback is blocked on a row lock.
      const until = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < until && waiting === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        waiting = await count(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()
              AND query LIKE '%hotel_subscription%' AND pid <> pg_backend_pid()`,
        );
      }
      expect(waiting).toBeGreaterThan(0);
      await probe.query('BEGIN');
      const locked = await probe
        .query(
          `SELECT 1 FROM platform.subscription_billing_intent WHERE intent_id = $1 FOR UPDATE NOWAIT`,
          [quote.intentId],
        )
        .then(
          () => 'free',
          (error: unknown) => (error as { code?: string }).code ?? 'error',
        );
      await probe.query('ROLLBACK');
      await holder.query('ROLLBACK');
      const outcome = await callback;
      expect(outcome.kind).toBe('renewed');
      expect(locked).toBe('free');
    } finally {
      holder.release();
      probe.release();
    }
  });
});

// ======================================================= 2 — ownership proofs

describe('2 — ownership-proof recovery', () => {
  async function collidingAfterPayment(): Promise<{
    first: Hotel;
    second: { applicationId: string; phone: string };
  }> {
    // The second application resolves to NEW while the first is unprovisioned,
    // pays, and then meets the owner the first application created.
    const firstReady = await verified({ packageCode: 'P20', termMonths: 12 });
    await env.onboarding.resolveOwner(firstReady.applicationId, request());
    await payAndConfirm(firstReady.applicationId);
    const second = await verified({
      registrationNumber: firstReady.registrationNumber,
      contactPhone: '+97699000777',
      subscriptionContactPhone: '+97699000777',
    });
    const resolved = await env.onboarding.resolveOwner(second.applicationId, request());
    expect(resolved.ownerResolution).toBe('NEW');
    await payAndConfirm(second.applicationId);
    const built = await env.provisioning.provision(
      firstReady.applicationId,
      `rm2-first-${firstReady.applicationId}`,
      request(),
    );
    if (built.kind !== 'provisioned') throw new Error(JSON.stringify(built));
    await env.worker.deliverActivations();
    const link = env.notifications.lastInvitationFor(firstReady.email);
    const password = syntheticPassword(firstReady.email);
    await env.activation.activate(
      { hotelId: built.hotelId, token: link?.token ?? '', password },
      request(),
    );
    const admin = await actorFor(env.iam, {
      membershipId: '',
      accountId: '',
      email: firstReady.email,
      password,
    });
    const status = await env.subscriptions.status(built.hotelId, admin, request());
    return {
      first: {
        hotelId: built.hotelId,
        applicationId: firstReady.applicationId,
        admin,
        email: firstReady.email,
        phone: firstReady.phone,
        reg: firstReady.registrationNumber,
        expiresAt: status?.expiresAt ?? new Date(),
      },
      second: { applicationId: second.applicationId, phone: second.phone },
    };
  }

  it('recovers a collision discovered at claim time: binds the owner, challenges the stored contact, provisions on the original payment', async () => {
    // Control flow on the base: the claim-time race opens a PENDING proof with
    // no challenge digest; `resolveOwner` then sees a pending proof and returns
    // without delivering anything, and `proveOwnership` can never match.
    const { first, second } = await collidingAfterPayment();
    const raced = await env.provisioning.provision(
      second.applicationId,
      `rm2-race-${unique()}`,
      request(),
    );
    expect(raced).toEqual({ kind: 'blocked', state: 'PAID_OWNER_VERIFICATION_REQUIRED' });

    const resolved = await env.onboarding.resolveOwner(second.applicationId, request());
    expect(resolved).toMatchObject({
      state: 'PAID_OWNER_VERIFICATION_REQUIRED',
      proofRequired: true,
    });
    const challenge = env.phone.deliveries.filter(
      (message) => message.subjectRef === `${second.applicationId}:owner-proof`,
    );
    expect(challenge).toHaveLength(1);
    expect(challenge[0]?.phone).toBe(first.phone);
    expect(challenge[0]?.phone).not.toBe(second.phone);

    const proved = await env.onboarding.proveOwnership(
      second.applicationId,
      challenge[0]?.code ?? '',
      request(),
    );
    expect(proved.state).toBe('PAID_PENDING_PROVISIONING');
    const paidAttempt = await env.admin.query<{ paid_attempt_id: string }>(
      `SELECT paid_attempt_id FROM platform.onboarding_application WHERE application_id = $1`,
      [second.applicationId],
    );
    const outcome = await env.provisioning.provision(
      second.applicationId,
      `rm2-race2-${unique()}`,
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'provisioned' });
    const after = await env.admin.query<{
      owner_id: string;
      paid_attempt_id: string;
      owners: string;
    }>(
      `SELECT a.owner_id, a.paid_attempt_id,
              (SELECT count(*)::text FROM platform.subscription_owner o
                WHERE o.identifier_lookup_token = a.owner_identifier_lookup_token) AS owners
         FROM platform.onboarding_application a WHERE a.application_id = $1`,
      [second.applicationId],
    );
    expect(after.rows[0]?.paid_attempt_id).toBe(paidAttempt.rows[0]?.paid_attempt_id);
    expect(after.rows[0]?.owners).toBe('1');
    const link = await env.admin.query<{ owner_id: string }>(
      `SELECT owner_id FROM platform.hotel_owner_link WHERE hotel_id = $1`,
      [first.hotelId],
    );
    expect(after.rows[0]?.owner_id).toBe(link.rows[0]?.owner_id);
  });

  it('recovers a collision refused inside the provisioning transaction', async () => {
    // A deterministic interleaving that reaches the SQL boundary: the owner
    // appears in the same transaction that claims the row — after the
    // claim-time probe has answered "nobody" — so the boundary itself meets the
    // collision and raises P0501. The appearance is an AFTER INSERT trigger on
    // the claim's own `provisioning_started` event, running as the database
    // owner, inserting an owner that carries this application's identifier and
    // a stored verified contact of its own (remediation 3, finding 3).
    const ready = await verified({ packageCode: 'P20', termMonths: 12 });
    const resolved = await env.onboarding.resolveOwner(ready.applicationId, request());
    expect(resolved.ownerResolution).toBe('NEW');
    const paid = await payAndConfirm(ready.applicationId);
    const storedContact = '+97699000555';
    const trap = `rm3_collide_${unique()}`;
    await env.admin.query(`
      CREATE OR REPLACE FUNCTION platform.${trap}() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW.reason = 'provisioning_started' AND NEW.application_id = '${ready.applicationId}' THEN
          INSERT INTO platform.subscription_owner
            (owner_type, display_name, identity_type, country_code, identifier_ciphertext,
             identifier_wrapped_dek, identifier_key_version, identifier_lookup_token,
             identifier_lookup_key_version, verified_phone)
          SELECT a.owner_type, 'colliding owner', a.owner_identity_type, a.owner_country_code,
                 decode('00', 'hex'), decode('00', 'hex'), 'v1', a.owner_identifier_lookup_token,
                 a.owner_identifier_lookup_key_version, '${storedContact}'
            FROM platform.onboarding_application a WHERE a.application_id = NEW.application_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${trap} AFTER INSERT ON platform.onboarding_event
        FOR EACH ROW EXECUTE FUNCTION platform.${trap}();`);
    let raced;
    try {
      raced = await env.provisioning.provision(
        ready.applicationId,
        `rm3-p0501-${unique()}`,
        request(),
      );
    } finally {
      await env.admin.query(
        `DROP TRIGGER IF EXISTS ${trap} ON platform.onboarding_event; DROP FUNCTION IF EXISTS platform.${trap}();`,
      );
    }
    // The boundary refused — not the claim-time probe: the failure is recorded
    // against the claimed attempt with the boundary's own reason.
    expect(raced).toEqual({ kind: 'blocked', state: 'PAID_OWNER_VERIFICATION_REQUIRED' });
    const refusal = await env.admin.query<{ from_state: string; to_state: string; reason: string }>(
      `SELECT from_state, to_state, reason FROM platform.onboarding_event
        WHERE application_id = $1 AND reason = 'existing_owner_detected' ORDER BY event_id`,
      [ready.applicationId],
    );
    expect(refusal.rows.map((r) => `${r.from_state}>${r.to_state}`)).toEqual([
      'PROVISIONING>PROVISIONING_FAILED',
      'PROVISIONING_FAILED>PAID_OWNER_VERIFICATION_REQUIRED',
    ]);
    const owner = await env.admin.query<{ owner_id: string }>(
      `SELECT owner_id FROM platform.subscription_owner WHERE display_name = 'colliding owner'
          AND identifier_lookup_token = (SELECT owner_identifier_lookup_token
                                            FROM platform.onboarding_application WHERE application_id = $1)`,
      [ready.applicationId],
    );
    expect(owner.rows).toHaveLength(1);
    const state = await env.admin.query<{
      state: string;
      owner_id: string | null;
      last_error: string | null;
    }>(
      `SELECT state, owner_id, provision_last_error AS last_error
         FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(state.rows[0]).toEqual({
      state: 'PAID_OWNER_VERIFICATION_REQUIRED',
      owner_id: owner.rows[0]?.owner_id,
      last_error: 'existing_owner_detected',
    });
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.hotel_owner_link WHERE application_id = $1',
        [ready.applicationId],
      ),
    ).toBe(0);

    // The challenge goes to the owner's stored verified contact, never to the
    // application's own phone.
    const again = await env.onboarding.resolveOwner(ready.applicationId, request());
    expect(again).toMatchObject({ state: 'PAID_OWNER_VERIFICATION_REQUIRED', proofRequired: true });
    const challenge = env.phone.deliveries.filter(
      (message) => message.subjectRef === `${ready.applicationId}:owner-proof`,
    );
    expect(challenge).toHaveLength(1);
    expect(challenge[0]?.phone).toBe(storedContact);
    expect(challenge[0]?.phone).not.toBe(ready.phone);
    const proved = await env.onboarding.proveOwnership(
      ready.applicationId,
      challenge[0]?.code ?? '',
      request(),
    );
    expect(proved.state).toBe('PAID_PENDING_PROVISIONING');

    // Recovery on the original payment: the same attempt, the owner it named.
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `rm3-p0501b-${unique()}`,
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'provisioned' });
    const after = await env.admin.query<{
      paid_attempt_id: string;
      link_owner: string;
      owners: string;
    }>(
      `SELECT a.paid_attempt_id,
              (SELECT l.owner_id FROM platform.hotel_owner_link l WHERE l.application_id = a.application_id) AS link_owner,
              (SELECT count(*)::text FROM platform.subscription_owner o
                WHERE o.identifier_lookup_token = a.owner_identifier_lookup_token) AS owners
         FROM platform.onboarding_application a WHERE a.application_id = $1`,
      [ready.applicationId],
    );
    expect(after.rows[0]).toEqual({
      paid_attempt_id: paid.attemptId,
      link_owner: owner.rows[0]?.owner_id,
      owners: '1',
    });
  });

  it('an expired challenge is persisted as expired before the refusal, and a fresh one is issued', async () => {
    // Control flow on the base: `proveOwnership` settles the proof EXPIRED and
    // throws inside the same transaction, so the row stays PENDING and
    // `resolveOwner` keeps answering "pending" with no new code.
    const first = await provisionedHotel();
    const second = await verified({
      registrationNumber: first.reg,
      contactPhone: '+97699000778',
      subscriptionContactPhone: '+97699000778',
    });
    await env.onboarding.resolveOwner(second.applicationId, request());
    const codes = env.phone.deliveries.filter(
      (m) => m.subjectRef === `${second.applicationId}:owner-proof`,
    );
    expect(codes).toHaveLength(1);
    await env.admin.query(
      `UPDATE platform.onboarding_owner_proof
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE application_id = $1 AND state = 'PENDING'`,
      [second.applicationId],
    );
    await expectApiError(
      env.onboarding.proveOwnership(second.applicationId, codes[0]?.code ?? '', request()),
      'CONFLICT',
    );
    const proofs = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.onboarding_owner_proof WHERE application_id = $1 ORDER BY created_at`,
      [second.applicationId],
    );
    expect(proofs.rows.map((r) => r.state)).toEqual(['EXPIRED']);

    const again = await env.onboarding.resolveOwner(second.applicationId, request());
    expect(again.proofRequired).toBe(true);
    const fresh = env.phone.deliveries.filter(
      (m) => m.subjectRef === `${second.applicationId}:owner-proof`,
    );
    expect(fresh).toHaveLength(2);
    expect(fresh[1]?.phone).toBe(first.phone);
    const proved = await env.onboarding.proveOwnership(
      second.applicationId,
      fresh[1]?.code ?? '',
      request(),
    );
    expect(proved.state).toBe('OWNER_VERIFICATION_REQUIRED');
  });

  it('a wrong code is refused and the refusal is persisted', async () => {
    const first = await provisionedHotel();
    const second = await verified({
      registrationNumber: first.reg,
      contactPhone: '+97699000779',
      subscriptionContactPhone: '+97699000779',
    });
    await env.onboarding.resolveOwner(second.applicationId, request());
    await expectApiError(
      env.onboarding.proveOwnership(second.applicationId, '000000', request()),
      'NOT_FOUND',
    );
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit.platform_event
          WHERE action = 'onboarding.owner.proof_failed' AND target_ref = $1`,
        [second.applicationId],
      ),
    ).toBe(1);
  });
});

// ============================================================ 3 — provisioning

describe('3 — provisioning execution', () => {
  async function paidWithExistingOwnerAndAccount(): Promise<{
    applicationId: string;
    first: Hotel;
  }> {
    // An application whose boundary call needs no minted material: the owner
    // exists and is proved, the admin account exists and is bound.
    const first = await provisionedHotel();
    const second = await verified({
      registrationNumber: first.reg,
      adminEmail: first.email,
      contactPhone: '+97699000780',
      subscriptionContactPhone: '+97699000780',
    });
    await env.onboarding.resolveOwner(second.applicationId, request());
    const code = env.phone.deliveries
      .filter((m) => m.subjectRef === `${second.applicationId}:owner-proof`)
      .at(-1)?.code;
    await env.onboarding.proveOwnership(second.applicationId, code ?? '', request());
    await env.onboarding.bindExistingAccount(second.applicationId, first.admin, request());
    await payAndConfirm(second.applicationId);
    return { applicationId: second.applicationId, first };
  }

  it('the boundary is fenced on the claim token and an unexpired lease', async () => {
    // Control flow on the base: `provision_paid_hotel` checks only that the row
    // is PROVISIONING. A worker whose lease lapsed, and whose job another worker
    // has since claimed, can still run the boundary and build the hotel.
    const { applicationId } = await paidWithExistingOwnerAndAccount();
    const stale = randomUUID();
    const replacement = randomUUID();
    await env.admin.query(
      `UPDATE platform.onboarding_application
          SET state = 'PROVISIONING', state_changed_at = now(), state_reason = 'provisioning_started',
              provision_claim_token = $2, provision_claimed_until = now() + interval '2 minutes',
              provision_attempts = 2, revision = revision + 1
        WHERE application_id = $1`,
      [applicationId, replacement],
    );
    const hotelsBefore = await count('SELECT count(*)::text AS n FROM platform.hotel');
    const worker = await env.workerDb.connect();
    try {
      await worker.query('BEGIN');
      await worker.query(
        `SELECT set_config('app.hotel_id', '00000000-0000-0000-0000-000000000000', true)`,
      );
      await worker.query(`SELECT set_config('app.realm', 'hotel', true)`);
      await worker.query(`SELECT set_config('app.actor_ref', 'stale-worker', true)`);
      await worker.query(`SELECT set_config('app.onboarding_ref', $1, true)`, [applicationId]);
      await expect(
        worker.query(
          `SELECT platform.provision_paid_hotel($1, 'rm2-stale-worker-key', NULL, NULL, NULL, NULL,
                                                NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2)`,
          [applicationId, stale],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined);
      worker.release();
    }
    expect(await count('SELECT count(*)::text AS n FROM platform.hotel')).toBe(hotelsBefore);

    // And the stale worker cannot settle the replacement's claim either.
    const row = await env.admin.query<{ token: string; state: string; attempts: number }>(
      `SELECT provision_claim_token AS token, state, provision_attempts AS attempts
         FROM platform.onboarding_application WHERE application_id = $1`,
      [applicationId],
    );
    expect(row.rows[0]).toEqual({ token: replacement, state: 'PROVISIONING', attempts: 2 });

    // With the replacement's lease expired the row is recoverable by anyone.
    await env.admin.query(
      `UPDATE platform.onboarding_application
          SET provision_claimed_until = now() - interval '1 second', revision = revision + 1
        WHERE application_id = $1`,
      [applicationId],
    );
    const outcome = await env.provisioning.provision(
      applicationId,
      `rm2-after-stale-${unique()}`,
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'provisioned' });
  });

  it('a signal-driven claim honours the persisted backoff', async () => {
    // Control flow on the base: `claimProvisioning` does not consult
    // `provision_available_at`, so a signal right after a failed attempt claims
    // the row again immediately.
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    await payAndConfirm(ready.applicationId);
    const untrap = await installTrap('cash_location', 'INSERT');
    try {
      const failed = await env.worker.provisionOne(ready.applicationId);
      expect(failed).toMatchObject({ kind: 'failed', attempts: 1 });
      const immediately = await env.worker.provisionOne(ready.applicationId);
      expect(immediately.kind).toBe('deferred');
      const row = await env.admin.query<{ attempts: number; due: boolean }>(
        `SELECT provision_attempts AS attempts, provision_available_at <= now() AS due
           FROM platform.onboarding_application WHERE application_id = $1`,
        [ready.applicationId],
      );
      expect(row.rows[0]).toEqual({ attempts: 1, due: false });
    } finally {
      await untrap();
    }
  });

  it('an expired final automatic attempt becomes operator-visible without a sixth attempt', async () => {
    // Control flow on the base: the sweep's discovery excludes a PROVISIONING
    // row whose attempts reached the cap, so a crash on the fifth attempt leaves
    // the row PROVISIONING forever, visible to nobody.
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    await payAndConfirm(ready.applicationId);
    await env.admin.query(
      `UPDATE platform.onboarding_application
          SET state = 'PROVISIONING', state_changed_at = now(), state_reason = 'crash',
              provision_attempts = 5, provision_claim_token = gen_random_uuid(),
              provision_claimed_until = now() - interval '1 second',
              provision_available_at = now(), revision = revision + 1
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    await env.worker.provisionDue();
    const row = await env.admin.query<{
      state: string;
      attempts: number;
      claim: string | null;
      error: string | null;
    }>(
      `SELECT state, provision_attempts AS attempts, provision_claim_token AS claim,
              provision_last_error AS error
         FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(row.rows[0]).toEqual({
      state: 'PROVISIONING_FAILED',
      attempts: 5,
      claim: null,
      error: 'lease_expired',
    });
    expect(await env.worker.provisionOne(ready.applicationId)).toEqual({
      kind: 'exhausted',
      attempts: 5,
    });
    expect(
      await count('SELECT count(*)::text AS n FROM platform.hotel WHERE display_name = $1', [
        `Remediation Two Hotel ${ready.applicationId.slice(0, 0)}`,
      ]),
    ).toBe(0);
  });
});

// ============================================================ 4 — receipts

describe('4 — receipt delivery', () => {
  async function issuedReceipt(): Promise<{ hotel: Hotel; issuanceId: string; paymentId: string }> {
    const hotel = await provisionedHotel();
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `rm2-rcpt-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const paid = await payBilling(hotel, quote);
    if (paid.kind !== 'renewed') throw new Error(JSON.stringify(paid));
    const payment = await env.admin.query<{ payment_id: string; issuance_id: string }>(
      `SELECT p.payment_id, e.issuance_id FROM platform.subscription_payment p
         JOIN platform.ebarimt_issuance e ON e.hotel_id = p.hotel_id AND e.payment_id = p.payment_id
        WHERE p.hotel_id = $1 AND p.purpose = 'RENEWAL'`,
      [hotel.hotelId],
    );
    const row = payment.rows[0];
    if (row === undefined) throw new Error('no issuance');
    return { hotel, issuanceId: row.issuance_id, paymentId: row.payment_id };
  }

  async function deliveryRow(issuanceId: string) {
    const row = await env.admin.query<{
      state: string;
      delivery_state: string;
      receipt_number: string | null;
    }>(
      `SELECT state, delivery_state, receipt_number FROM platform.ebarimt_issuance WHERE issuance_id = $1`,
      [issuanceId],
    );
    return row.rows[0];
  }

  function receiptMails(issuanceId: string) {
    return env.notifications
      .all()
      .filter((m) => m.kind === 'ebarimt_receipt' && m.deliveryId === `ebarimt-${issuanceId}`);
  }

  it('retries the email after a notification outage, reusing the issued receipt', async () => {
    // Control flow on the base: a failed send marks the delivery FAILED and
    // nothing ever picks it up again; the receipt is issued and never sent.
    const { hotel, issuanceId } = await issuedReceipt();
    const receipts = env.receipts.receiptCount;
    env.notifications.failNext();
    await env.ebarimt.processOne(hotel.hotelId, issuanceId, request());
    const failed = await deliveryRow(issuanceId);
    expect(failed).toMatchObject({ state: 'ISSUED', delivery_state: 'FAILED' });
    expect(env.receipts.receiptCount).toBe(receipts + 1);
    await env.admin.query(
      `UPDATE platform.ebarimt_issuance SET delivery_available_at = now(), revision = revision + 1 WHERE issuance_id = $1`,
      [issuanceId],
    );
    await env.worker.issueReceipts();
    // The drain covers every hotel's queue, so the receipt is checked by its
    // own number rather than by a global count: it is the one that was issued.
    expect(await deliveryRow(issuanceId)).toMatchObject({
      state: 'ISSUED',
      delivery_state: 'SENT',
      receipt_number: failed?.receipt_number,
    });
    expect(receiptMails(issuanceId)).toHaveLength(1);
  });

  it('a lost acknowledgement resends under the same delivery identity and the recipient sees one mail', async () => {
    const { hotel, issuanceId } = await issuedReceipt();
    env.notifications.failAcknowledgementNext();
    await env.ebarimt.processOne(hotel.hotelId, issuanceId, request());
    expect(await deliveryRow(issuanceId)).toMatchObject({ delivery_state: 'FAILED' });
    await env.admin.query(
      `UPDATE platform.ebarimt_issuance SET delivery_available_at = now(), revision = revision + 1 WHERE issuance_id = $1`,
      [issuanceId],
    );
    await env.worker.issueReceipts();
    expect(await deliveryRow(issuanceId)).toMatchObject({ delivery_state: 'SENT' });
    expect(receiptMails(issuanceId)).toHaveLength(1);
  });

  it('a crash between the issuance commit and the send is recovered by the drain, without a second receipt', async () => {
    const { hotel, issuanceId } = await issuedReceipt();
    await env.ebarimt.processOne(hotel.hotelId, issuanceId, request());
    const issued = await deliveryRow(issuanceId);
    expect(issued).toMatchObject({ state: 'ISSUED', delivery_state: 'SENT' });
    // The process died after the receipt committed and before the send: the row
    // says PENDING and the provider may or may not have the message.
    await env.admin.query(
      `UPDATE platform.ebarimt_issuance
          SET delivery_state = 'PENDING', delivered_at = NULL, delivery_available_at = now(),
              revision = revision + 1
        WHERE issuance_id = $1`,
      [issuanceId],
    );
    await env.worker.issueReceipts();
    const after = await deliveryRow(issuanceId);
    expect(after).toMatchObject({
      state: 'ISSUED',
      delivery_state: 'SENT',
      receipt_number: issued?.receipt_number,
    });
    expect(receiptMails(issuanceId)).toHaveLength(1);
  });
});

// ========================================================== 5 — authorization

describe('5 — authorization at the final mutation', () => {
  it('a quote whose admin was suspended during the provider call is refused and changes no billing state', async () => {
    // Control flow on the base: the scope and permission are checked before the
    // provider call and never again; the finalizing transaction persists the
    // intent for a principal that no longer holds the hotel.
    const hotel = await provisionedHotel();
    const existing = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `rm2-gap-rn-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const release = env.khaan.blockNext();
    const upgrade = env.subscriptions.quoteUpgrade(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P25',
        provider: 'KHAAN',
        idempotencyKey: `rm2-gap-up-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await suspendPrimaryAdmin(hotel.hotelId);
    } finally {
      release();
    }
    await expectApiError(upgrade, 'NOT_FOUND');
    const intents = await env.admin.query<{ kind: string; state: string; intent_id: string }>(
      `SELECT kind, state, intent_id FROM platform.subscription_billing_intent WHERE hotel_id = $1 ORDER BY created_at`,
      [hotel.hotelId],
    );
    const pending = intents.rows.filter((r) => r.state === 'PENDING');
    expect(pending).toEqual([{ kind: 'RENEWAL', state: 'PENDING', intent_id: existing.intentId }]);
    for (const row of intents.rows.filter((r) => r.kind === 'UPGRADE')) {
      expect(row.state).toBe('ABANDONED');
    }
  });

  it('reconciliation closure authorizes and mutates in one transaction', async () => {
    // Control flow on the base: the Operation authorization and its audit
    // commit in one transaction and the intent changes in a second one; a
    // failure of the second leaves an audited decision with no effect.
    const hotel = await provisionedHotel();
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `rm2-rec-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    // Make the quote stale, then pay it: a reconciliation case.
    await env.admin.query(
      `UPDATE platform.hotel_subscription SET billing_revision = billing_revision + 1, revision = revision + 1 WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    const paid = await payBilling(hotel, quote);
    expect(paid.kind).toBe('requires_reconciliation');
    const operator = await env.operationActor({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['SUBSCRIPTION_PAYMENT_RECONCILE'],
    });
    const untrap = await installTrap('subscription_billing_intent', 'UPDATE');
    try {
      await expect(
        env.subscriptions.closeReconciliation(
          {
            hotelId: hotel.hotelId,
            intentId: quote.intentId,
            outcome: 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL',
            reference: 'QPAY-REV-0001',
            reason: 'the remediation two trap, described at length',
          },
          operator.actor,
          request(),
        ),
      ).rejects.toThrow(/remediation two trap/);
    } finally {
      await untrap();
    }
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit.platform_event
          WHERE action = 'subscription.payment.reconcile_requested' AND target_ref = $1`,
        [quote.intentId],
      ),
    ).toBe(0);
    const closed = await env.subscriptions.closeReconciliation(
      {
        hotelId: hotel.hotelId,
        intentId: quote.intentId,
        outcome: 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL',
        reference: 'QPAY-REV-0001',
        reason: 'externally voided by the provider, recorded in full',
      },
      operator.actor,
      request(),
    );
    expect(closed).toBeUndefined();
  });

  it('an eBarimt retry authorizes and reopens in one transaction', async () => {
    const hotel = await provisionedHotel();
    const quote = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'QPAY',
        idempotencyKey: `rm2-eb-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    const paid = await payBilling(hotel, quote);
    if (paid.kind !== 'renewed') throw new Error(JSON.stringify(paid));
    const found = await env.admin.query<{ issuance_id: string }>(
      `SELECT issuance_id FROM platform.ebarimt_issuance WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    const issuance = { issuanceId: found.rows[0]?.issuance_id ?? '' };
    env.receipts.failNext('permanent');
    await env.ebarimt.processOne(hotel.hotelId, issuance?.issuanceId ?? '', request());
    const operator = await env.operationActor({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['SUBSCRIPTION_EBARIMT_RETRY'],
    });
    const untrap = await installTrap('ebarimt_issuance', 'UPDATE');
    try {
      await expect(
        env.ebarimt.retry(hotel.hotelId, issuance?.issuanceId ?? '', operator.actor, request()),
      ).rejects.toThrow(/remediation two trap/);
    } finally {
      await untrap();
    }
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit.platform_event
          WHERE action = 'subscription.ebarimt.retry_requested' AND target_ref = $1`,
        [issuance?.issuanceId ?? ''],
      ),
    ).toBe(0);
    const outcome = await env.ebarimt.retry(
      hotel.hotelId,
      issuance?.issuanceId ?? '',
      operator.actor,
      request(),
    );
    expect(outcome.kind).toBe('issued');
  });
});

// ============================================================== 6 — fee facts

describe('6 — payment fee facts', () => {
  it('records an unavailable fee as unknown and a confirmed zero fee as zero', async () => {
    // Control flow on the base: `providerFeeMnt ?? 0n` in the port mapping and
    // in the simulator, and NOT NULL DEFAULT 0 columns, turn "the provider did
    // not say" into "the fee was zero" and derive a net amount from it.
    const unknown = await provisionedHotel();
    const zero = await provisionedHotel({}, { feeMnt: 0n });
    const rows = await env.admin.query<{
      hotel_id: string;
      fee: string | null;
      net: string | null;
      gross: string;
    }>(
      `SELECT hotel_id, provider_fee_mnt AS fee, net_amount_mnt AS net, gross_amount_mnt AS gross
         FROM platform.subscription_payment WHERE hotel_id = ANY($1::uuid[])`,
      [[unknown.hotelId, zero.hotelId]],
    );
    const byHotel = new Map(rows.rows.map((r) => [r.hotel_id, r]));
    expect(byHotel.get(unknown.hotelId)).toMatchObject({ fee: null, net: null });
    expect(byHotel.get(zero.hotelId)).toMatchObject({ fee: '0' });
    expect(byHotel.get(zero.hotelId)?.net).toBe(byHotel.get(zero.hotelId)?.gross);
    const attempts = await env.admin.query<{ fee: string | null }>(
      `SELECT provider_fee_mnt AS fee FROM platform.onboarding_payment_attempt WHERE application_id = $1`,
      [unknown.applicationId],
    );
    expect(attempts.rows[0]?.fee).toBeNull();
  });
});

// ================================================== remediation 3 — closeout

describe('remediation 3 — provider refusals and the payments reader', () => {
  /** The kernel stores a non-2xx outcome as `failed` with its status: that is the durable refusal. */
  async function idempotencyRow(operation: string, key: string) {
    const row = await env.admin.query<{ state: string; response_status: number | null }>(
      `SELECT state, response_status FROM platform.idempotency_key
        WHERE operation = $1 AND idempotency_key = $2`,
      [operation, key],
    );
    return row.rows[0];
  }

  it('an onboarding invoice the provider refuses is a durable refusal the same key replays', async () => {
    // Control flow on the base: the refusal abandons the prepared attempt with
    // no invoice, which violates the 0005 invoice-once-live check; the stored
    // refusal rolls back with it, the caller sees the constraint error, and a
    // retry calls the provider again.
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    const key = `rm3-refused-${unique()}`;
    const invoices = env.qpay.invoiceCount;
    env.qpay.failNext({ kind: 'REJECTED', providerCode: 'SIMULATED_REFUSAL' });
    await expectApiError(
      env.onboarding.openInvoice(
        { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: key },
        request(),
      ),
      'CONFLICT',
    );
    expect(await idempotencyRow('onboarding.invoice.open', key)).toEqual({
      state: 'failed',
      response_status: 409,
    });
    const attempts = await env.admin.query<{ state: string; provider_invoice_id: string | null }>(
      `SELECT state, provider_invoice_id FROM platform.onboarding_payment_attempt WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(attempts.rows).toEqual([{ state: 'REFUSED', provider_invoice_id: null }]);
    expect(env.qpay.invoiceCount).toBe(invoices);

    // The same key replays the refusal: no provider call, no second attempt.
    await expectApiError(
      env.onboarding.openInvoice(
        { applicationId: ready.applicationId, provider: 'QPAY', idempotencyKey: key },
        request(),
      ),
      'CONFLICT',
    );
    expect(env.qpay.invoiceCount).toBe(invoices);
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.onboarding_payment_attempt WHERE application_id = $1',
        [ready.applicationId],
      ),
    ).toBe(1);
    // And a new key opens a live invoice: the refusal weakened nothing.
    const opened = await env.onboarding.openInvoice(
      {
        applicationId: ready.applicationId,
        provider: 'QPAY',
        idempotencyKey: `rm3-fresh-${unique()}`,
      },
      request(),
    );
    expect(opened.providerInvoiceId).toBeDefined();
    const live = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.onboarding_payment_attempt WHERE application_id = $1 ORDER BY created_at`,
      [ready.applicationId],
    );
    expect(live.rows.map((r) => r.state)).toEqual(['REFUSED', 'PENDING']);
  });

  it('a renewal quote the provider refuses is a durable refusal the same key replays', async () => {
    const hotel = await provisionedHotel();
    const key = `rm3-refused-rn-${unique()}`;
    const invoices = env.khaan.invoiceCount;
    env.khaan.failNext({ kind: 'REJECTED', providerCode: 'SIMULATED_REFUSAL' });
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'KHAAN',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'CONFLICT',
    );
    expect(await idempotencyRow('subscription.renewal', key)).toEqual({
      state: 'failed',
      response_status: 409,
    });
    const intents = await env.admin.query<{ state: string; provider_invoice_id: string | null }>(
      `SELECT state, provider_invoice_id FROM platform.subscription_billing_intent WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(intents.rows).toEqual([{ state: 'REFUSED', provider_invoice_id: null }]);
    expect(env.khaan.invoiceCount).toBe(invoices);
    await expectApiError(
      env.subscriptions.quoteRenewal(
        {
          hotelId: hotel.hotelId,
          targetPackage: 'P20',
          termMonths: 1,
          provider: 'KHAAN',
          idempotencyKey: key,
        },
        hotel.admin,
        request(),
      ),
      'CONFLICT',
    );
    expect(env.khaan.invoiceCount).toBe(invoices);
    expect(
      await count(
        'SELECT count(*)::text AS n FROM platform.subscription_billing_intent WHERE hotel_id = $1',
        [hotel.hotelId],
      ),
    ).toBe(1);
    const quoted = await env.subscriptions.quoteRenewal(
      {
        hotelId: hotel.hotelId,
        targetPackage: 'P20',
        termMonths: 1,
        provider: 'KHAAN',
        idempotencyKey: `rm3-fresh-rn-${unique()}`,
      },
      hotel.admin,
      request(),
    );
    expect(quoted.providerInvoiceId).toBeDefined();
  });

  it('the payments reader preserves an unknown fee and distinguishes it from zero and nonzero', async () => {
    // Control flow on the base: `payments()` converts the fee and net columns
    // with BigInt(), which throws on NULL.
    const unknown = await provisionedHotel();
    const zero = await provisionedHotel({}, { feeMnt: 0n });
    const nonzero = await provisionedHotel({}, { feeMnt: 300n });
    const read = (hotelId: string) =>
      withTenantTransaction(env.api, hotelScope(hotelId, request()), (uow) =>
        new SubscriptionRepository(uow).payments(),
      );
    const [u, z, n] = await Promise.all([
      read(unknown.hotelId),
      read(zero.hotelId),
      read(nonzero.hotelId),
    ]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ purpose: 'ONBOARDING', providerFeeMnt: null, netAmountMnt: null });
    expect(z[0]).toMatchObject({ providerFeeMnt: 0n, netAmountMnt: z[0]?.grossAmountMnt });
    expect(n[0]).toMatchObject({ providerFeeMnt: 300n });
    expect(n[0]?.netAmountMnt).toBe((n[0]?.grossAmountMnt ?? 0n) - 300n);
  });
});
