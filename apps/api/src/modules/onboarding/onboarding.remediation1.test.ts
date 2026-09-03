import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { actorFor } from '../iam/test-support/iam-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 remediation 1 — the acceptance blockers, reproduced on a real
 * database before they were fixed and kept as regressions afterwards.
 *
 * R2 owner and account resolution, R4 outbox atomicity, R8 activation
 * semantics and R9 observable state and the financial ledger. Every case ran
 * against the tree at `2ca6e26` first; the failure it produced there is quoted
 * in the phase record.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('onboarding_remediation1');
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

function fresh(overrides: Record<string, unknown> = {}): ReturnType<typeof citizenDraft> {
  const n = unique();
  return citizenDraft({
    registrationNumber: `REM${n}0011`,
    adminEmail: `rem-${n}@example.test`,
    hotelDisplayName: `Remediation Hotel ${n}`,
    addressLine: `Remediation address ${n}`,
    contactPhone: `+9769977${n}`,
    subscriptionContactPhone: `+9769977${n}`,
    ...overrides,
  });
}

async function verified(overrides: Record<string, unknown> = {}): Promise<{
  applicationId: string;
  token: string;
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
    token: created.applicantToken,
    email: draft.adminEmail,
    phone: draft.contactPhone,
    registrationNumber: draft.registrationNumber,
  };
}

async function payAndConfirm(
  applicationId: string,
  options: { provider?: 'QPAY' | 'KHAAN'; feeMnt?: bigint; confirmedAt?: Date } = {},
): Promise<{ invoiceId: string; paymentId: string }> {
  const provider = options.provider ?? 'QPAY';
  const invoice = await env.onboarding.openInvoice(
    { applicationId, provider, idempotencyKey: `rem-${unique()}-${applicationId}` },
    request(),
  );
  const gateway = provider === 'QPAY' ? env.qpay : env.khaan;
  const paymentId = gateway.pay(
    invoice.providerInvoiceId,
    options.confirmedAt ?? new Date(),
    undefined,
    options.feeMnt,
  );
  const outcome = await env.provisioning.applyCallback(
    {
      provider,
      providerInvoiceId: invoice.providerInvoiceId,
      providerPaymentId: paymentId,
      signature: gateway.signatureFor(invoice.providerInvoiceId),
    },
    request(),
  );
  if (outcome.kind !== 'paid') throw new Error(`not paid: ${JSON.stringify(outcome)}`);
  return { invoiceId: invoice.providerInvoiceId, paymentId };
}

/** The link the worker delivered for this address — nothing exists before the drain. */
async function deliveredLinkFor(email: string): Promise<string> {
  await env.worker.deliverActivations();
  const link = env.notifications.lastInvitationFor(email);
  if (link === undefined) throw new Error('no activation link was delivered');
  return link.token;
}

async function provisioned(
  overrides: Record<string, unknown> = {},
  options: { feeMnt?: bigint } = {},
): Promise<{ applicationId: string; hotelId: string; email: string; phone: string; reg: string }> {
  const ready = await verified(overrides);
  await env.onboarding.resolveOwner(ready.applicationId, request());
  await payAndConfirm(ready.applicationId, options);
  const outcome = await env.provisioning.provision(
    ready.applicationId,
    `rem-provision-${ready.applicationId}`,
    request(),
  );
  if (outcome.kind !== 'provisioned') {
    throw new Error(`provisioning did not succeed: ${JSON.stringify(outcome)}`);
  }
  return {
    applicationId: ready.applicationId,
    hotelId: outcome.hotelId,
    email: ready.email,
    phone: ready.phone,
    reg: ready.registrationNumber,
  };
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

// ============================================================ R2 — owners

describe('R2 — the canonical owner exists only after payment', () => {
  it('a new registration number creates no subscription_owner row before provisioning', async () => {
    const ready = await verified();
    const resolved = await env.onboarding.resolveOwner(ready.applicationId, request());
    expect(resolved).toEqual({ state: 'DRAFT', proofRequired: false, ownerResolution: 'NEW' });

    const owners = await count(`SELECT count(*)::text AS n FROM platform.subscription_owner`);
    const before = await env.admin.query<{ owner_id: string | null }>(
      `SELECT owner_id FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(before.rows[0]?.owner_id).toBeNull();

    // Paid and unprovisioned: still no owner.
    await payAndConfirm(ready.applicationId);
    expect(await count(`SELECT count(*)::text AS n FROM platform.subscription_owner`)).toBe(owners);

    // Provisioning creates it, inside the graph transaction, with the phone
    // this flow actually verified as its stored channel.
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `r2-provision-${unique()}`,
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'provisioned' });
    const owner = await env.admin.query<{
      owner_id: string;
      verified_phone: string | null;
      verified_email_normalized: string | null;
      owner_xmin: string;
      hotel_xmin: string;
    }>(
      `SELECT o.owner_id, o.verified_phone, o.verified_email_normalized,
              o.xmin::text AS owner_xmin, h.xmin::text AS hotel_xmin
         FROM platform.onboarding_application a
         JOIN platform.subscription_owner o ON o.owner_id = a.owner_id
         JOIN platform.hotel h ON h.hotel_id = a.provisioned_hotel_id
        WHERE a.application_id = $1`,
      [ready.applicationId],
    );
    expect(owner.rows[0]?.verified_phone).toBe(ready.phone);
    expect(owner.rows[0]?.verified_email_normalized).toBeNull();
    expect(owner.rows[0]?.owner_xmin).toBe(owner.rows[0]?.hotel_xmin);
  });

  it('an existing owner is probed, never mutated, and never poisoned by an unpaid application', async () => {
    const first = await provisioned();
    const ownerBefore = await env.admin.query<Record<string, unknown>>(
      `SELECT o.* FROM platform.subscription_owner o
         JOIN platform.onboarding_application a ON a.owner_id = o.owner_id
        WHERE a.application_id = $1`,
      [first.applicationId],
    );

    // Somebody else's registration number, with a different contact phone.
    const attacker = await verified({
      registrationNumber: first.reg,
      contactPhone: '+97699000777',
      subscriptionContactPhone: '+97699000777',
    });
    const resolved = await env.onboarding.resolveOwner(attacker.applicationId, request());
    expect(resolved).toEqual({
      state: 'OWNER_VERIFICATION_REQUIRED',
      proofRequired: true,
      ownerResolution: 'EXISTING_PROOF_REQUIRED',
    });
    expect('challengeToken' in resolved).toBe(false);

    const ownerAfter = await env.admin.query<Record<string, unknown>>(
      `SELECT * FROM platform.subscription_owner WHERE owner_id = $1`,
      [ownerBefore.rows[0]?.['owner_id']],
    );
    expect(ownerAfter.rows[0]).toEqual(ownerBefore.rows[0]);
    // Exactly one owner carries this identifier: the attacker created none.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.subscription_owner o
          WHERE o.identifier_lookup_token = (SELECT owner_identifier_lookup_token
                                                FROM platform.onboarding_application
                                               WHERE application_id = $1)`,
        [first.applicationId],
      ),
    ).toBe(1);

    // No invoice while the proof is outstanding.
    await expectApiError(
      env.onboarding.openInvoice(
        {
          applicationId: attacker.applicationId,
          provider: 'QPAY',
          idempotencyKey: `r2-blk-${unique()}`,
        },
        request(),
      ),
      'PRECONDITION_FAILED',
    );
  });

  it('delivers the existing-owner challenge to the stored contact, not the new application’s', async () => {
    const first = await provisioned();
    const second = await verified({
      registrationNumber: first.reg,
      contactPhone: '+97699000888',
      subscriptionContactPhone: '+97699000888',
    });
    await env.onboarding.resolveOwner(second.applicationId, request());

    const challenge = env.phone.deliveries.filter(
      (message) => message.subjectRef === `${second.applicationId}:owner-proof`,
    );
    expect(challenge).toHaveLength(1);
    expect(challenge[0]?.phone).toBe(first.phone);
    expect(challenge[0]?.phone).not.toBe('+97699000888');

    // The secret is stored only as a digest, and redeeming it passes the proof.
    const stored = await env.admin.query<{
      challenge_digest: string | null;
      masked: string | null;
    }>(
      `SELECT challenge_digest, masked_destination AS masked
         FROM platform.onboarding_owner_proof WHERE application_id = $1`,
      [second.applicationId],
    );
    expect(stored.rows[0]?.challenge_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.challenge_digest).not.toBe(challenge[0]?.code);
    expect(stored.rows[0]?.masked).not.toBe(first.phone);

    const proved = await env.onboarding.proveOwnership(
      second.applicationId,
      challenge[0]?.code ?? '',
      request(),
    );
    expect(proved.state).toBe('OWNER_VERIFICATION_REQUIRED');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_owner_proof
          WHERE application_id = $1 AND state = 'PASSED'`,
        [second.applicationId],
      ),
    ).toBe(1);
  });

  it('proves ownership through an account already linked to the owner, and refuses a stranger', async () => {
    const first = await provisioned();
    // Activate the first hotel's Primary Admin so a session can exist.
    const token = await deliveredLinkFor(first.email);
    await env.activation.activate(
      { hotelId: first.hotelId, token, password: syntheticPassword('linked') },
      request(),
    );
    const owner = await actorFor(env.iam, {
      membershipId: '',
      accountId: '',
      email: first.email,
      password: syntheticPassword('linked'),
    });

    const second = await verified({ registrationNumber: first.reg });
    await env.onboarding.resolveOwner(second.applicationId, request());

    // A stranger with a session in some other hotel proves nothing.
    const strangerHotel = await env.iam.createHotel('Stranger Hotel', 'P20');
    const stranger = await env.iam.seedMembership({
      hotelId: strangerHotel,
      email: `stranger-${unique()}@example.test`,
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    await expectApiError(
      env.onboarding.proveOwnershipByAccount(
        second.applicationId,
        await actorFor(env.iam, stranger),
        request(),
      ),
      'NOT_FOUND',
    );

    const proved = await env.onboarding.proveOwnershipByAccount(
      second.applicationId,
      owner,
      request(),
    );
    expect(proved.state).toBe('OWNER_VERIFICATION_REQUIRED');
    const proof = await env.admin.query<{ method: string; state: string }>(
      `SELECT method, state FROM platform.onboarding_owner_proof
        WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [second.applicationId],
    );
    expect(proof.rows[0]).toEqual({ method: 'AUTHENTICATED_ACCOUNT', state: 'PASSED' });
  });

  it('the existing-email path binds the signed-in account through production code', async () => {
    // An account already exists for the admin email: the Primary Admin of
    // another hotel.
    const existingHotel = await env.iam.createHotel('Existing Email Hotel', 'P20');
    const member = await env.iam.seedMembership({
      hotelId: existingHotel,
      email: `existing-${unique()}@example.test`,
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    const ready = await verified({ adminEmail: member.email });
    await env.onboarding.resolveOwner(ready.applicationId, request());

    // No invoice until the account is proved.
    await expectApiError(
      env.onboarding.openInvoice(
        {
          applicationId: ready.applicationId,
          provider: 'QPAY',
          idempotencyKey: `r2-em-${unique()}`,
        },
        request(),
      ),
      'PRECONDITION_FAILED',
    );

    // A session for a *different* email proves nothing and sets nothing.
    const otherHotel = await env.iam.createHotel('Other Email Hotel', 'P20');
    const other = await env.iam.seedMembership({
      hotelId: otherHotel,
      email: `other-${unique()}@example.test`,
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    await expectApiError(
      env.onboarding.bindExistingAccount(
        ready.applicationId,
        await actorFor(env.iam, other),
        request(),
      ),
      'NOT_FOUND',
    );
    const unbound = await env.admin.query<{ existing_account_id: string | null }>(
      `SELECT existing_account_id FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(unbound.rows[0]?.existing_account_id).toBeNull();

    // The right session binds it.
    const bound = await env.onboarding.bindExistingAccount(
      ready.applicationId,
      await actorFor(env.iam, member),
      request(),
    );
    expect(bound.existingAccountId).toBe(member.accountId);

    await payAndConfirm(ready.applicationId);
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `r2-em-${unique()}`,
      request(),
    );
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind !== 'provisioned') return;

    const membership = await env.admin.query<{ state: string; account_id: string }>(
      `SELECT state, account_id FROM platform.staff_membership
        WHERE hotel_id = $1 AND is_primary_admin`,
      [outcome.hotelId],
    );
    expect(membership.rows[0]).toEqual({ state: 'ACTIVE', account_id: member.accountId });
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.activation_delivery WHERE hotel_id = $1`,
        [outcome.hotelId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.user_account WHERE email_normalized = $1`,
        [member.email],
      ),
    ).toBe(1);
  });

  it('revalidates the bound account inside the provisioning boundary', async () => {
    const existingHotel = await env.iam.createHotel('Revalidate Hotel', 'P20');
    const member = await env.iam.seedMembership({
      hotelId: existingHotel,
      email: `reval-${unique()}@example.test`,
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    const ready = await verified({ adminEmail: member.email });
    await env.onboarding.resolveOwner(ready.applicationId, request());
    await env.onboarding.bindExistingAccount(
      ready.applicationId,
      await actorFor(env.iam, member),
      request(),
    );
    await payAndConfirm(ready.applicationId);

    // The account is suspended between the proof and the provisioning run.
    await env.admin.query(
      `UPDATE platform.user_account SET state = 'SUSPENDED', revision = revision + 1
        WHERE account_id = $1`,
      [member.accountId],
    );
    const outcome = await env.provisioning.provision(
      ready.applicationId,
      `r2-rv-${unique()}`,
      request(),
    );
    expect(outcome.kind).toBe('failed');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.hotel_owner_link l
      JOIN platform.onboarding_application a ON a.application_id = l.application_id
      WHERE a.application_id = $1`,
        [ready.applicationId],
      ),
    ).toBe(0);
  });

  it('offline ownership verification is an Operation action with its permission and step-up', async () => {
    const first = await provisioned();
    const second = await verified({ registrationNumber: first.reg });
    await env.onboarding.resolveOwner(second.applicationId, request());

    const unpermitted = await env.operationActor({ permissions: ['OPERATION_READ'] });
    await expectApiError(
      env.onboarding.approveOfflineOwnership(
        second.applicationId,
        unpermitted.actor,
        'representative verified on paper',
        request(),
      ),
      'NOT_FOUND',
    );
    const stale = await env.operationActor({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['SUBSCRIPTION_CONTACT_CHANGE_APPROVE'],
      stepUpAgeSeconds: 20 * 60,
    });
    await expectApiError(
      env.onboarding.approveOfflineOwnership(
        second.applicationId,
        stale.actor,
        'representative verified on paper',
        request(),
      ),
      'PRECONDITION_FAILED',
    );
    const permitted = await env.operationActor({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['SUBSCRIPTION_CONTACT_CHANGE_APPROVE'],
    });
    const decided = await env.onboarding.approveOfflineOwnership(
      second.applicationId,
      permitted.actor,
      'representative verified on paper',
      request(),
    );
    expect(decided.state).toBe('OWNER_VERIFICATION_REQUIRED');
    const proof = await env.admin.query<{ decided_by_account_id: string | null; state: string }>(
      `SELECT decided_by_account_id, state FROM platform.onboarding_owner_proof
        WHERE application_id = $1 AND method = 'OFFLINE_VERIFICATION'`,
      [second.applicationId],
    );
    expect(proof.rows).toEqual([{ decided_by_account_id: permitted.accountId, state: 'PASSED' }]);
    // The superseded stored-contact challenge is closed, by the same decision.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_owner_proof
          WHERE application_id = $1 AND method = 'STORED_CONTACT_CHALLENGE' AND state = 'EXPIRED'`,
        [second.applicationId],
      ),
    ).toBe(1);
  });
});

// ============================================================ R4 — outbox

describe('R3 — the signal is best-effort; the row is the job', () => {
  it('a failing signal neither fails the paid callback nor loses the job', async () => {
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    const invoice = await env.onboarding.openInvoice(
      {
        applicationId: ready.applicationId,
        provider: 'QPAY',
        idempotencyKey: `r3-sig-${unique()}`,
      },
      request(),
    );
    const paymentId = env.qpay.pay(invoice.providerInvoiceId, new Date());

    env.signals.failNext();
    const outcome = await env.provisioning.applyCallback(
      {
        provider: 'QPAY',
        providerInvoiceId: invoice.providerInvoiceId,
        providerPaymentId: paymentId,
        signature: env.qpay.signatureFor(invoice.providerInvoiceId),
      },
      request(),
    );
    expect(outcome.kind).toBe('paid');
    expect(env.signals.signalled).not.toContain(ready.applicationId);

    // The job is on the row, due now, and the sweep finds it without a signal.
    const row = await env.admin.query<{ state: string; due: boolean }>(
      `SELECT state, provision_available_at <= now() AS due
         FROM platform.onboarding_application WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(row.rows[0]).toEqual({ state: 'PAID_PENDING_PROVISIONING', due: true });
    const sweep = await env.worker.provisionDue();
    expect(sweep.provisioned).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_application
          WHERE application_id = $1 AND state = 'PROVISIONED'`,
        [ready.applicationId],
      ),
    ).toBe(1);
  });
});

describe('R4 — the graph, the transition, the delivery intent and the event commit together', () => {
  it('writes the provisioned event in the same transaction as the hotel', async () => {
    const hotel = await provisioned();
    const rows = await env.admin.query<{ what: string; xmin: string }>(
      `SELECT 'hotel' AS what, xmin::text FROM platform.hotel WHERE hotel_id = $1
       UNION ALL
       SELECT 'event', xmin::text FROM platform.outbox_event
        WHERE hotel_id = $1 AND event_type = 'onboarding.hotel.provisioned'
       UNION ALL
       SELECT 'delivery', xmin::text FROM platform.activation_delivery WHERE hotel_id = $1
       UNION ALL
       SELECT 'application', xmin::text FROM platform.onboarding_application
        WHERE provisioned_hotel_id = $1 AND state = 'PROVISIONED'`,
      [hotel.hotelId],
    );
    const byWhat = new Map(rows.rows.map((row) => [row.what, row.xmin]));
    expect([...byWhat.keys()].sort()).toEqual(['application', 'delivery', 'event', 'hotel']);
    expect(new Set(byWhat.values()).size).toBe(1);
  });

  it('a failure after the graph committed never reports a provisioned hotel as failed', async () => {
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    await payAndConfirm(ready.applicationId);

    // The failure is injected at the first write after the graph committed:
    // the job's own settlement event, in its separate transaction.
    await env.admin.query(`
      CREATE OR REPLACE FUNCTION platform.remediation_settle_trap() RETURNS trigger
        LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reason = 'provisioning_settled' THEN
          RAISE EXCEPTION 'settlement trap' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER remediation_settle_trap BEFORE INSERT ON platform.onboarding_event
        FOR EACH ROW EXECUTE FUNCTION platform.remediation_settle_trap();`);
    let outcome: Awaited<ReturnType<typeof env.provisioning.provision>>;
    try {
      outcome = await env.provisioning.provision(
        ready.applicationId,
        `r4-provision-${unique()}`,
        request(),
      );
    } finally {
      await env.admin.query(`DROP TRIGGER remediation_settle_trap ON platform.onboarding_event;
        DROP FUNCTION platform.remediation_settle_trap();`);
    }
    expect(outcome).toMatchObject({ kind: 'provisioned' });
    const state = await env.admin.query<{ state: string; provision_attempts: number }>(
      `SELECT state, provision_attempts FROM platform.onboarding_application
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(state.rows[0]?.state).toBe('PROVISIONED');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.onboarding_event
          WHERE application_id = $1 AND to_state = 'PROVISIONING_FAILED'`,
        [ready.applicationId],
      ),
    ).toBe(0);
  });

  it('a crash between the graph commit and the job settlement is replayed without a second hotel', async () => {
    const ready = await verified();
    await env.onboarding.resolveOwner(ready.applicationId, request());
    await payAndConfirm(ready.applicationId);
    const first = await env.provisioning.provision(
      ready.applicationId,
      `r4-rp-${unique()}`,
      request(),
    );
    expect(first.kind).toBe('provisioned');

    // Put the row back into the shape a crash leaves: PROVISIONED, but the
    // claim never released.
    await env.admin.query(
      `UPDATE platform.onboarding_application
          SET provision_claim_token = gen_random_uuid(),
              provision_claimed_until = now() - interval '1 minute',
              revision = revision + 1
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    const replayed = await env.worker.provisionDue();
    expect(replayed.claimed).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.hotel h
      JOIN platform.onboarding_application a ON a.provisioned_hotel_id = h.hotel_id
      WHERE a.application_id = $1`,
        [ready.applicationId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.outbox_event o
           JOIN platform.onboarding_application a ON a.provisioned_hotel_id = o.hotel_id
          WHERE a.application_id = $1 AND o.event_type = 'onboarding.hotel.provisioned'`,
        [ready.applicationId],
      ),
    ).toBe(1);
    const settled = await env.admin.query<{ token: string | null; state: string }>(
      `SELECT provision_claim_token AS token, state FROM platform.onboarding_application
        WHERE application_id = $1`,
      [ready.applicationId],
    );
    expect(settled.rows[0]).toEqual({ token: null, state: 'PROVISIONED' });
  });
});

// ======================================================== R8 — activation

describe('R8 — activation semantics', () => {
  it('a new account and its Primary membership stay pending until the link is redeemed', async () => {
    const hotel = await provisioned();
    const before = await env.admin.query<{
      account_state: string;
      membership_state: string;
      auth_epoch: number;
      email_verified_at: Date | null;
    }>(
      `SELECT u.state AS account_state, m.state AS membership_state, u.auth_epoch,
              u.email_verified_at
         FROM platform.hotel_admin_activation x
         JOIN platform.user_account u ON u.account_id = x.account_id
         JOIN platform.staff_membership m ON m.hotel_id = x.hotel_id AND m.membership_id = x.membership_id
        WHERE x.hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(before.rows[0]).toMatchObject({
      account_state: 'PENDING_ACTIVATION',
      membership_state: 'PENDING',
      email_verified_at: null,
    });
    const epochBefore = Number(before.rows[0]?.auth_epoch);

    // Nobody can sign in before activation, credential or not.
    await expectApiError(
      env.iam.sessions.signIn(hotel.email, syntheticPassword('nothing'), request()),
      'UNAUTHENTICATED',
    );

    const token = await deliveredLinkFor(hotel.email);
    await env.activation.activate(
      { hotelId: hotel.hotelId, token, password: syntheticPassword('r8') },
      request(),
    );

    const after = await env.admin.query<{
      account_state: string;
      membership_state: string;
      auth_epoch: number;
      email_verified_at: Date | null;
      credential: string | null;
      token_hash: string | null;
      activation_state: string;
    }>(
      `SELECT u.state AS account_state, m.state AS membership_state, u.auth_epoch,
              u.email_verified_at, c.secret_hash AS credential, x.token_hash, x.state AS activation_state
         FROM platform.hotel_admin_activation x
         JOIN platform.user_account u ON u.account_id = x.account_id
         JOIN platform.staff_membership m ON m.hotel_id = x.hotel_id AND m.membership_id = x.membership_id
         LEFT JOIN platform.account_credential c ON c.account_id = u.account_id AND c.kind = 'password'
        WHERE x.hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(after.rows[0]).toMatchObject({
      account_state: 'ACTIVE',
      membership_state: 'ACTIVE',
      token_hash: null,
      activation_state: 'ACTIVE',
    });
    expect(after.rows[0]?.email_verified_at).not.toBeNull();
    expect(after.rows[0]?.credential).not.toBeNull();
    // The auth-epoch CAS was checked and applied exactly once — the stale
    // revision after `markEmailVerified` used to make it silently a no-op.
    expect(Number(after.rows[0]?.auth_epoch)).toBe(epochBefore + 1);

    // And the person can now sign in.
    const signedIn = await env.iam.sessions.signIn(hotel.email, syntheticPassword('r8'), request());
    expect(signedIn.accountId).toBeDefined();
  });

  it('two simultaneous redemptions activate once; the loser sees the link gone', async () => {
    const hotel = await provisioned();
    const token = await deliveredLinkFor(hotel.email);
    const redeem = (label: string) =>
      env.activation
        .activate({ hotelId: hotel.hotelId, token, password: syntheticPassword(label) }, request())
        .then(
          () => 'activated',
          (error: unknown) => (error as ApiError).code,
        );
    const [a, b] = await Promise.all([redeem('race-a'), redeem('race-b')]);
    expect([a, b].filter((r) => r === 'activated')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'NOT_FOUND')).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM platform.account_credential c
           JOIN platform.hotel_admin_activation x ON x.account_id = c.account_id
          WHERE x.hotel_id = $1`,
        [hotel.hotelId],
      ),
    ).toBe(1);
  });

  it('a failure inside activation rolls every write back and keeps the link redeemable', async () => {
    const hotel = await provisioned();
    const token = await deliveredLinkFor(hotel.email);

    // A trap on the very last write: the activation row's own settlement.
    await env.admin.query(`
      CREATE OR REPLACE FUNCTION platform.remediation_trap() RETURNS trigger
        LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state = 'ACTIVE' THEN RAISE EXCEPTION 'remediation trap' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER remediation_trap BEFORE UPDATE ON platform.hotel_admin_activation
        FOR EACH ROW EXECUTE FUNCTION platform.remediation_trap();`);
    try {
      await expect(
        env.activation.activate(
          { hotelId: hotel.hotelId, token, password: syntheticPassword('trap') },
          request(),
        ),
      ).rejects.toThrow(/remediation trap/);
    } finally {
      await env.admin.query(`DROP TRIGGER remediation_trap ON platform.hotel_admin_activation;
        DROP FUNCTION platform.remediation_trap();`);
    }

    const state = await env.admin.query<{
      account_state: string;
      membership_state: string;
      credential: string | null;
      token_hash: string | null;
    }>(
      `SELECT u.state AS account_state, m.state AS membership_state, c.secret_hash AS credential,
              x.token_hash
         FROM platform.hotel_admin_activation x
         JOIN platform.user_account u ON u.account_id = x.account_id
         JOIN platform.staff_membership m ON m.hotel_id = x.hotel_id AND m.membership_id = x.membership_id
         LEFT JOIN platform.account_credential c ON c.account_id = u.account_id
        WHERE x.hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(state.rows[0]).toMatchObject({
      account_state: 'PENDING_ACTIVATION',
      membership_state: 'PENDING',
      credential: null,
    });
    expect(state.rows[0]?.token_hash).not.toBeNull();

    // And the link still works.
    await env.activation.activate(
      { hotelId: hotel.hotelId, token, password: syntheticPassword('after') },
      request(),
    );
  });
});

// ============================================== R9 — observable state and money

describe('R9 — the observable application state and the financial ledger', () => {
  it('reports the canonical state and minimal safe progress, never an identifier or a secret', async () => {
    const ready = await verified();
    const draft = await env.onboarding.applicationState(ready.applicationId, request());
    expect(draft).toMatchObject({
      applicationId: ready.applicationId,
      state: 'DRAFT',
      phoneVerified: true,
      ownerResolution: 'UNRESOLVED',
      existingAccount: 'NONE',
      payment: null,
      provisioning: { attempts: 0 },
    });
    await env.onboarding.resolveOwner(ready.applicationId, request());
    const paid = await payAndConfirm(ready.applicationId);
    const afterPayment = await env.onboarding.applicationState(ready.applicationId, request());
    expect(afterPayment.state).toBe('PAID_PENDING_PROVISIONING');
    expect(afterPayment.ownerResolution).toBe('NEW');
    expect(afterPayment.payment).toMatchObject({ provider: 'QPAY', state: 'PAID' });
    const serialised = JSON.stringify(afterPayment);
    expect(serialised).not.toContain(paid.paymentId);
    expect(serialised).not.toContain(ready.registrationNumber);
    expect(serialised).not.toContain(ready.token);
  });

  it('records the provider fee and the net amount the provider actually reported', async () => {
    const hotel = await provisioned({}, { feeMnt: 300n });
    const payment = await env.admin.query<{
      gross_amount_mnt: string;
      provider_fee_mnt: string;
      net_amount_mnt: string;
    }>(
      `SELECT gross_amount_mnt, provider_fee_mnt, net_amount_mnt
         FROM platform.subscription_payment WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(payment.rows[0]).toEqual({
      gross_amount_mnt: '20000',
      provider_fee_mnt: '300',
      net_amount_mnt: '19700',
    });
  });
});
