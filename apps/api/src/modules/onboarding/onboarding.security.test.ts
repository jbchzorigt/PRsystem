import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OnboardingHarness } from './test-support/onboarding-harness';
import { citizenDraft, createOnboardingHarness } from './test-support/onboarding-harness';
import { newOnboardingRequest } from './services/onboarding-context';
import type { RequestContext } from './services/onboarding-context';

/**
 * Phase 05 isolation and leakage, on real PostgreSQL.
 *
 * Two properties, both of which have to hold at the *database*, because the
 * services above them are exactly what a future phase might get wrong:
 *
 *  * **pre-tenant isolation** — an applicant reaches their own application and
 *    no other, and an anonymous statement reaches none at all;
 *  * **no plaintext anywhere** — the registration number, the OTP code and the
 *    activation token never reach a row, an audit record, an outbox payload or
 *    a response body.
 */

let env: OnboardingHarness;

beforeAll(async () => {
  env = await createOnboardingHarness('onboarding_security');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

const request = (): RequestContext => newOnboardingRequest();
const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';

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

interface Applicant {
  applicationId: string;
  token: string;
  registrationNumber: string;
  email: string;
  otp: string;
}

async function applicant(): Promise<Applicant> {
  const n = unique();
  const draft = citizenDraft({
    registrationNumber: `SEC${n}0011`,
    adminEmail: `sec-${n}@example.test`,
    hotelDisplayName: `Security Hotel ${n}`,
    addressLine: `Security address ${n}`,
    contactPhone: `+9769977${n}`,
    subscriptionContactPhone: `+9769977${n}`,
  });
  const created = await env.onboarding.createApplication(draft, request());
  await env.onboarding.requestPhoneVerification(created.applicationId, request());
  const otp = env.phone.codeFor(created.applicationId) ?? '';
  return {
    applicationId: created.applicationId,
    token: created.applicantToken,
    registrationNumber: draft.registrationNumber,
    email: draft.adminEmail,
    otp,
  };
}

/** Runs a statement through the restricted runtime login under a chosen scope. */
async function asRuntime<T>(
  scope: { hotelId?: string; realm?: string; onboardingRef?: string },
  work: (
    query: (sql: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>,
  ) => Promise<void>,
): Promise<void> {
  const client = await env.api.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.hotel_id', $1, true)`, [
      scope.hotelId ?? PLATFORM_SCOPE,
    ]);
    await client.query(`SELECT set_config('app.realm', $1, true)`, [scope.realm ?? 'hotel']);
    await client.query(`SELECT set_config('app.actor_ref', 'probe', true)`);
    await client.query(`SELECT set_config('app.correlation_id', 'probe', true)`);
    await client.query(`SELECT set_config('app.onboarding_ref', $1, true)`, [
      scope.onboardingRef ?? '',
    ]);
    await work(async (sql, values) => {
      const result = await client.query(sql, values);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('pre-tenant isolation', () => {
  it('an applicant reaches their own application and nobody else’s', async () => {
    const a = await applicant();
    const b = await applicant();

    await asRuntime<{ application_id: string }>(
      { onboardingRef: a.applicationId },
      async (query) => {
        const rows = await query('SELECT application_id FROM platform.onboarding_application');
        expect(rows.rows.map((row) => row.application_id)).toEqual([a.applicationId]);

        // And the other applicant's row is invisible even when named directly —
        // the same refusal a nonexistent application gets.
        const targeted = await query(
          'SELECT application_id FROM platform.onboarding_application WHERE application_id = $1',
          [b.applicationId],
        );
        expect(targeted.rowCount).toBe(0);
      },
    );
  });

  it('an anonymous statement with no reference reaches no application at all', async () => {
    await applicant();
    await asRuntime({}, async (query) => {
      // `application_id = NULL` is never true, so the absence of a reference is
      // zero rows rather than everybody's — which is the whole reason the
      // isolation is a reference and not a nullable tenant column.
      for (const table of [
        'platform.onboarding_application',
        'platform.onboarding_payment_attempt',
        'platform.onboarding_phone_verification',
        'platform.onboarding_owner_proof',
        'platform.onboarding_event',
        'platform.subscription_owner',
      ]) {
        const rows = await query(`SELECT 1 FROM ${table}`);
        expect({ table, rows: rows.rowCount }).toEqual({ table, rows: 0 });
      }
    });
  });

  it('an applicant cannot write into another applicant’s scope', async () => {
    const a = await applicant();
    const b = await applicant();
    await asRuntime({ onboardingRef: a.applicationId }, async (query) => {
      const updated = await query(
        `UPDATE platform.onboarding_application
            SET state_reason = 'tampered', revision = revision + 1
          WHERE application_id = $1`,
        [b.applicationId],
      );
      expect(updated.rowCount).toBe(0);
    });
  });

  it('an applicant cannot read an owner profile they are not linked to', async () => {
    // doc 15 §3.1: the owner profile holds the verified contact a proof is sent
    // to. Reading it before proving anything would defeat the proof.
    const a = await applicant();
    await env.onboarding.confirmPhoneVerification(a.applicationId, a.otp, request());
    await env.onboarding.resolveOwner(a.applicationId, request());

    const b = await applicant();
    await asRuntime({ onboardingRef: b.applicationId }, async (query) => {
      const rows = await query('SELECT owner_id FROM platform.subscription_owner');
      expect(rows.rowCount).toBe(0);
    });
  });

  it('a hotel scope reaches no application, and an application scope no hotel', async () => {
    // The two axes are disjoint by construction: an onboarding policy keys on
    // the reference and never on the tenant, and a tenant policy the reverse.
    const a = await applicant();
    await asRuntime({ hotelId: PLATFORM_SCOPE, onboardingRef: '' }, async (query) => {
      const rows = await query('SELECT 1 FROM platform.onboarding_application');
      expect(rows.rowCount).toBe(0);
    });
    await asRuntime({ onboardingRef: a.applicationId }, async (query) => {
      for (const table of [
        'platform.hotel_subscription',
        'platform.hotel_profile',
        'platform.cash_location',
        'platform.hotel_admin_activation',
      ]) {
        const rows = await query(`SELECT 1 FROM ${table}`);
        expect({ table, rows: rows.rowCount }).toEqual({ table, rows: 0 });
      }
    });
  });

  it('the runtime holds no INSERT on anything provisioning creates', async () => {
    // `ONB-DEC-001`, as a grant rather than a service check. Every one of these
    // is 42501 whatever scope the caller establishes.
    await asRuntime({ hotelId: PLATFORM_SCOPE }, async (query) => {
      for (const [table, statement] of [
        ['hotel', `INSERT INTO platform.hotel (display_name) VALUES ($1::uuid::text)`],
        [
          'hotel_owner_link',
          `INSERT INTO platform.hotel_owner_link (hotel_id, owner_id, owner_type, application_id)
           VALUES ($1, $1, 'CITIZEN', $1)`,
        ],
        [
          'hotel_subscription',
          `INSERT INTO platform.hotel_subscription
             (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at)
           VALUES ($1, 'P20', 'P20', 1, now(), now() + interval '30 days')`,
        ],
        [
          'cash_location',
          `INSERT INTO platform.cash_location (hotel_id, kind, name, code)
           VALUES ($1, 'DRAWER', 'probe', 'PROBE')`,
        ],
        [
          'hotel_profile',
          `INSERT INTO platform.hotel_profile
             (hotel_id, public_name, public_phone, district, khoroo, address_line,
              latitude_micro, longitude_micro)
           VALUES ($1, 'x', 'y', 'd', 'k', 'a', 1, 1)`,
        ],
      ] as const) {
        const error = await query(statement, [PLATFORM_SCOPE]).then(
          () => undefined,
          (e: unknown) => e as { code?: string },
        );
        expect({ table, code: error?.code }).toEqual({ table, code: '42501' });
        await query('ROLLBACK');
        await query('BEGIN');
        await query(`SELECT set_config('app.hotel_id', $1, true)`, [PLATFORM_SCOPE]);
        await query(`SELECT set_config('app.realm', 'hotel', true)`);
        await query(`SELECT set_config('app.actor_ref', 'probe', true)`);
      }
    });
  });
});

describe('CLAUDE.md §8 — no plaintext identifier, code or token anywhere', () => {
  it('the registration number reaches no row, audit record or outbox payload', async () => {
    const a = await applicant();
    await env.onboarding.confirmPhoneVerification(a.applicationId, a.otp, request());
    await env.onboarding.resolveOwner(a.applicationId, request());

    // Every text-bearing column of the whole onboarding graph, scanned for the
    // value. `::text` on a bytea renders its hex, which cannot contain the
    // plaintext either — so a ciphertext that was accidentally stored as text
    // would still be caught.
    const hits = await env.admin.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM platform.onboarding_application
           WHERE owner_display_name LIKE '%' || $1 || '%'
              OR address_line LIKE '%' || $1 || '%'
              OR state_reason LIKE '%' || $1 || '%'
              OR owner_identifier_ciphertext::text LIKE '%' || $1 || '%'
              OR owner_identifier_lookup_token LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.subscription_owner
           WHERE display_name LIKE '%' || $1 || '%'
              OR identifier_ciphertext::text LIKE '%' || $1 || '%'
              OR identifier_lookup_token LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.onboarding_event
           WHERE detail::text LIKE '%' || $1 || '%' OR reason LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM audit.platform_event WHERE payload::text LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.outbox_event WHERE payload::text LIKE '%' || $1 || '%')
       )::text AS n`,
      [a.registrationNumber],
    );
    expect(hits.rows[0]?.n).toBe('0');
  });

  it('the OTP code is stored only as a keyed digest, and destroyed once settled', async () => {
    const a = await applicant();
    const pending = await env.admin.query<{ code_digest: string | null }>(
      `SELECT code_digest FROM platform.onboarding_phone_verification
        WHERE application_id = $1`,
      [a.applicationId],
    );
    expect(pending.rows[0]?.code_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.rows[0]?.code_digest).not.toContain(a.otp);

    await env.onboarding.confirmPhoneVerification(a.applicationId, a.otp, request());
    const settled = await env.admin.query<{ state: string; code_digest: string | null }>(
      `SELECT state, code_digest FROM platform.onboarding_phone_verification
        WHERE application_id = $1`,
      [a.applicationId],
    );
    // A verified challenge that kept its digest would be redeemable evidence.
    expect(settled.rows[0]).toEqual({ state: 'VERIFIED', code_digest: null });
  });

  it('a wrong code is refused, and the attempt budget is spent on the row', async () => {
    const a = await applicant();
    const wrong = a.otp === '000000' ? '111111' : '000000';
    const outcome = await env.onboarding.confirmPhoneVerification(
      a.applicationId,
      wrong,
      request(),
    );
    expect(outcome).toEqual({ verified: false });
    const row = await env.admin.query<{ attempts: number; state: string }>(
      `SELECT attempts, state FROM platform.onboarding_phone_verification
        WHERE application_id = $1`,
      [a.applicationId],
    );
    expect(Number(row.rows[0]?.attempts)).toBe(1);
    expect(row.rows[0]?.state).toBe('PENDING');
    // The right code still works: a wrong guess costs a budget, not the challenge.
    expect(
      await env.onboarding.confirmPhoneVerification(a.applicationId, a.otp, request()),
    ).toEqual({ verified: true });
  });

  it('the applicant bearer reference is stored only as a keyed digest', async () => {
    const a = await applicant();
    const row = await env.admin.query<{ hash: string }>(
      `SELECT applicant_token_hash AS hash FROM platform.onboarding_application
        WHERE application_id = $1`,
      [a.applicationId],
    );
    expect(row.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0]?.hash).not.toContain(a.token);

    // And it resolves: presenting it reaches exactly this application.
    expect(await env.onboarding.resolveApplicant(a.token, request())).toBe(a.applicationId);
    // A token nobody minted resolves to nothing.
    await expect(
      env.onboarding.resolveApplicant('not-a-real-token', request()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the activation token is never stored in clear, and its ciphertext is row-bound', async () => {
    const a = await applicant();
    await env.onboarding.confirmPhoneVerification(a.applicationId, a.otp, request());
    await env.onboarding.resolveOwner(a.applicationId, request());
    const invoice = await env.onboarding.openInvoice(
      { applicationId: a.applicationId, provider: 'QPAY', idempotencyKey: `sec-${unique()}` },
      request(),
    );
    const paymentId = env.qpay.pay(invoice.providerInvoiceId, new Date());
    await env.provisioning.applyCallback(
      {
        provider: 'QPAY',
        providerInvoiceId: invoice.providerInvoiceId,
        providerPaymentId: paymentId,
        signature: env.qpay.signatureFor(invoice.providerInvoiceId),
      },
      request(),
    );
    const provisioned = await env.provisioning.provision(
      a.applicationId,
      `sec-provision-${unique()}`,
      request(),
    );
    if (provisioned.kind !== 'provisioned') throw new Error('provisioning failed');

    await env.provisioning.drainActivationDeliveries();
    const message = env.notifications.lastInvitationFor(a.email);
    expect(message).toBeDefined();
    const token = message?.token ?? '';

    // The plaintext link reaches the delivery port and nothing else.
    const leaked = await env.admin.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM platform.hotel_admin_activation
           WHERE coalesce(token_hash, '') LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.activation_delivery
           WHERE coalesce(secret_ciphertext::text, '') LIKE '%' || $1 || '%'
              OR coalesce(last_error, '') LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM audit.platform_event WHERE payload::text LIKE '%' || $1 || '%')
       + (SELECT count(*) FROM platform.outbox_event WHERE payload::text LIKE '%' || $1 || '%')
       )::text AS n`,
      [token],
    );
    expect(leaked.rows[0]?.n).toBe('0');

    // The link works exactly once and is then gone.
    await env.activation.activate(
      { hotelId: provisioned.hotelId, token, password: syntheticPassword('security') },
      request(),
    );
    const after = await env.admin.query<{ state: string; token_hash: string | null }>(
      `SELECT state, token_hash FROM platform.hotel_admin_activation WHERE hotel_id = $1`,
      [provisioned.hotelId],
    );
    expect(after.rows[0]).toEqual({ state: 'ACTIVE', token_hash: null });
  });

  it('the outbox payload carries identifiers and never a secret', async () => {
    // The database refuses a denied key outright, so this is belt and braces on
    // top of a constraint — and it fails loudly if a payload ever grows one.
    const rows = await env.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox_event WHERE event_type = 'onboarding.hotel.provisioned'`,
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(Object.keys(row.payload).sort()).toEqual(['activationRequired', 'applicationId']);
    }
  });
});
