import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from './test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from './test-support/iam-harness';
import { StaffService } from './services/staff.service';
import { SimulatedStaffNotification } from './contracts/staff-notification.port';
import { SimulatedSubscriptionState } from './contracts/subscription-state.port';
import { SimulatedOpenWork } from './contracts/open-work.port';
import { SimulatedRestaurantDirectory } from './contracts/restaurant-directory.port';
import type { AuthSecurityParameters } from './contracts/security-parameters';
import {
  AUTH_PARAMETERS,
  OPEN_WORK,
  RESTAURANT_DIRECTORY,
  STAFF_NOTIFICATION,
  SUBSCRIPTION_STATE,
} from './iam.tokens';

/**
 * Phase 04 remediation 4.
 *
 * F1 a lock order that could deadlock, and a termination that reused a
 * suspension's marker; F2 a dead letter a runtime could reopen; F3 an intake
 * with no reset of its own; F4 a lost acknowledgement modelled as a failure to
 * send; F5 an expired link that would still have been delivered.
 */

let db: TestDatabase;
let env: IamHarness;
let app: NestFastifyApplication;
let baseUrl: string;
let appStaff: StaffService;
/**
 * The parameter set the running application reads.
 *
 * The harness holds a copy of its own, and a copy is no use here: the drain runs
 * through the application's service, so a TTL a test wants it to honour has to
 * be the application's.
 */
let appParameters: AuthSecurityParameters;

let hotelA: string;
let adminA: SeededMembership;

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `rem4-${prefix}-${String(key).padStart(6, '0')}`;
}

function syntheticPassword(label: string): string {
  return ['synthetic', label, 'passphrase'].join('-');
}

interface Json {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<Json> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body, text };
}

function expectOk(result: Json): Json {
  expect([200, 201, 202], result.text).toContain(result.status);
  return result;
}

async function signIn(member: SeededMembership): Promise<string> {
  const result = await call('POST', '/auth/sign-in', {
    body: { email: member.email, password: member.password },
  });
  expect(result.status, result.text).toBe(200);
  return result.body['token'] as string;
}

async function onboard(email: string, roles: readonly string[]): Promise<SeededMembership> {
  const created = await call('POST', `/hotels/${hotelA}/staff/invitations`, {
    token: await signIn(adminA),
    key: idem('invite'),
    body: { email, roles },
  });
  expectOk(created);
  const delivered = env.notifications.lastInvitationFor(email);
  const password = syntheticPassword(email.split('@')[0] ?? 'member');
  const accepted = await call('POST', `/hotels/${hotelA}/staff/invitations/accept`, {
    key: idem('accept'),
    body: { token: delivered?.token, password },
  });
  expectOk(accepted);
  return {
    membershipId: created.body['membershipId'] as string,
    accountId: accepted.body['accountId'] as string,
    email,
    password,
  };
}

async function setState(
  membershipId: string,
  state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE',
  reason: string,
  idempotencyKey: string,
): Promise<Json> {
  return call('POST', `/hotels/${hotelA}/staff/memberships/${membershipId}/state`, {
    token: await signIn(adminA),
    key: idempotencyKey,
    body: { state, reason },
  });
}

async function reconcile(idempotencyKey: string): Promise<Json> {
  return call('POST', `/hotels/${hotelA}/staff/handoff/discovery/reconcile`, {
    token: await signIn(adminA),
    key: idempotencyKey,
    body: {},
  });
}

/** Waits, on the database's own view, until a backend is blocked on a lock. */
async function waitForBlockedBackend(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(rows.rows[0]?.count ?? '0') > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend ever blocked on a lock');
}

/** Waits, on the database clock, until the row's expiry has passed. */
async function waitUntilExpired(resetId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await env.admin.query<{ expired: boolean }>(
      `SELECT (now() > expires_at) AS expired FROM platform.password_reset_request
        WHERE reset_id = $1`,
      [resetId],
    );
    if (rows.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the reset never expired');
}

async function markers(
  membershipId: string,
): Promise<{ state: string; opened_reason: string; membership_revision: string }[]> {
  const rows = await env.admin.query<{
    state: string;
    opened_reason: string;
    membership_revision: string;
  }>(
    `SELECT state, opened_reason, membership_revision::text AS membership_revision
       FROM platform.work_handoff_discovery
      WHERE hotel_id = $1 AND membership_id = $2
      ORDER BY created_at`,
    [hotelA, membershipId],
  );
  return rows.rows;
}

async function resetRows(accountId: string): Promise<
  {
    reset_id: string;
    intake_id: string | null;
    state: string;
    delivery_id: string;
    initiated_by: string;
    delivered_at: string | null;
    secret_ciphertext: string | null;
  }[]
> {
  const rows = await env.admin.query<{
    reset_id: string;
    intake_id: string | null;
    state: string;
    delivery_id: string;
    initiated_by: string;
    delivered_at: string | null;
    secret_ciphertext: string | null;
  }>(
    `SELECT reset_id, intake_id::text AS intake_id, state, delivery_id::text AS delivery_id,
            initiated_by, delivered_at::text AS delivered_at, secret_ciphertext
       FROM platform.password_reset_request
      WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return rows.rows;
}

/**
 * Nothing is deleted between cases: a reset request is terminalised, never
 * removed, and the guard is right to refuse. Each case uses its own address and
 * asserts only on that address's rows.
 */
async function intakeRows(
  email: string,
): Promise<{ intake_id: string; state: string; outcome: string | null; initiated_by: string }[]> {
  const rows = await env.admin.query<{
    intake_id: string;
    state: string;
    outcome: string | null;
    initiated_by: string;
  }>(
    `SELECT intake_id::text AS intake_id, state, outcome, initiated_by
       FROM platform.password_reset_intake
      WHERE email_normalized = $1 ORDER BY requested_at`,
    [email],
  );
  return rows.rows;
}

/** Puts one address's queue entries back in reach of the next drain. */
async function releaseQueue(email: string): Promise<void> {
  await env.admin.query(
    `UPDATE platform.password_reset_intake SET next_attempt_at = now()
      WHERE email_normalized = $1 AND state = 'PENDING'`,
    [email],
  );
}

beforeAll(async () => {
  db = await provisionIamDatabase('iam_remediation4');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-iam-remediation4-seed',
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

  const subscription = app.get<SimulatedSubscriptionState>(SUBSCRIPTION_STATE);
  const notifications = app.get<SimulatedStaffNotification>(STAFF_NOTIFICATION);
  const openWork = app.get<SimulatedOpenWork>(OPEN_WORK);
  const restaurants = app.get<SimulatedRestaurantDirectory>(RESTAURANT_DIRECTORY);
  appStaff = app.get<StaffService>(StaffService);
  appParameters = app.get<AuthSecurityParameters>(AUTH_PARAMETERS);
  expect(subscription).toBeInstanceOf(SimulatedSubscriptionState);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  expect(openWork).toBeInstanceOf(SimulatedOpenWork);
  expect(restaurants).toBeInstanceOf(SimulatedRestaurantDirectory);
  env = attachIamHarness(db, 'iam_remediation4', {
    subscription,
    notifications,
    openWork,
    restaurants,
  });

  hotelA = await env.createHotel('Remediation Four Hotel', 'P30');
  adminA = await env.seedMembership({
    hotelId: hotelA,
    email: 'admin@rem4.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await env?.close();
}, 60000);

// ---------------------------------------------------------------------- F1
describe('F1 — one lock order for membership and discovery', () => {
  it('does not deadlock when a reactivation holds the membership', async () => {
    const member = await onboard('f1-deadlock@rem4.test', ['RECEPTION']);
    const subjectRef = '44444444-4444-4444-8444-000000000001';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);
    expectOk(await setState(member.membershipId, 'SUSPENDED', 'down', idem('f1-suspend')));
    env.openWork.recoverFor(hotelA, member.membershipId);

    // A transaction standing in for a reactivation: it takes the membership row
    // first, exactly as `setMembershipState` does.
    const holder = await env.api.connect();
    let holderError: string | undefined;
    let reconciled: Json | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelA]);
      await holder.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
      await holder.query(
        `SELECT membership_id FROM platform.staff_membership
          WHERE hotel_id = $1 AND membership_id = $2 FOR UPDATE`,
        [hotelA, member.membershipId],
      );

      // Reconciliation starts while that lock is held.
      const pending = reconcile(idem('f1-reconcile'));
      await waitForBlockedBackend();

      // …and the holder now needs the marker, which reconciliation must not be
      // sitting on. If it is, the two wait on each other and PostgreSQL kills
      // one of them with 40P01.
      holderError = await holder
        .query(
          `UPDATE platform.work_handoff_discovery
              SET state = 'SUPERSEDED', settled_at = now(), settled_reason = 'reactivated',
                  updated_at = now()
            WHERE hotel_id = $1 AND membership_id = $2 AND state = 'PENDING'`,
          [hotelA, member.membershipId],
        )
        .then(
          () => undefined,
          (error: unknown) => (error as { code?: string }).code ?? 'error',
        );
      await holder.query(holderError === undefined ? 'COMMIT' : 'ROLLBACK');
      reconciled = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    expect(holderError).toBeUndefined();
    expect(reconciled?.status, reconciled?.text).toBe(200);
    expect((reconciled?.body['error'] as { code?: string } | undefined)?.code).toBeUndefined();
    // The marker was settled by the other transaction, so nothing was handed
    // off under a revision that had already moved on.
    expect(reconciled?.body['resolved']).toBe(0);
    const items = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND subject_ref = $2`,
      [hotelA, subjectRef],
    );
    expect(items.rows[0]?.count).toBe('0');
  }, 120000);

  it('supersedes and replaces a pending marker on a direct termination', async () => {
    const member = await onboard('f1-terminate@rem4.test', ['RECEPTION']);
    const subjectRef = '44444444-4444-4444-8444-000000000002';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);
    expectOk(await setState(member.membershipId, 'SUSPENDED', 'down', idem('f1-t-suspend')));

    // Straight from SUSPENDED to TERMINATED, with the suspension's question
    // still unanswered.
    env.openWork.recoverFor(hotelA, member.membershipId);
    expectOk(await setState(member.membershipId, 'TERMINATED', 'left', idem('f1-t-terminate')));

    const rows = await markers(member.membershipId);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ state: 'SUPERSEDED', opened_reason: 'suspension' });
    expect(rows[1]?.opened_reason).toBe('termination');
    expect(['PENDING', 'COMPLETED']).toContain(rows[1]?.state);
    expect(Number(rows[1]?.membership_revision)).toBeGreaterThan(
      Number(rows[0]?.membership_revision),
    );

    const membership = await env.admin.query<{ revision: string }>(
      `SELECT membership_revision::text AS revision FROM platform.staff_membership
        WHERE membership_id = $1`,
      [member.membershipId],
    );
    expect(rows[1]?.membership_revision).toBe(membership.rows[0]?.revision);
  }, 120000);
});

// ---------------------------------------------------------------------- F2
describe('F2 — both intake terminal states are terminal', () => {
  async function seedIntake(state: 'PROCESSED' | 'DEAD_LETTER'): Promise<string> {
    const rows = await env.admin.query<{ intake_id: string }>(
      `INSERT INTO platform.password_reset_intake
         (email_normalized, state, attempts, outcome, processed_at)
       VALUES ($1, $2, 3, $3, now())
       RETURNING intake_id`,
      [
        `f2-${state.toLowerCase()}@rem4.test`,
        state,
        state === 'PROCESSED' ? 'sent' : 'dead_letter',
      ],
    );
    return rows.rows[0]?.intake_id as string;
  }

  async function asRuntime(sql: string, values: readonly unknown[]): Promise<string> {
    return env.api.query(sql, values as never[]).then(
      () => 'accepted',
      (error: unknown) => (error as { code?: string }).code ?? 'error',
    );
  }

  it('refuses the restricted runtime any reopening of either terminal state', async () => {
    for (const state of ['PROCESSED', 'DEAD_LETTER'] as const) {
      const intakeId = await seedIntake(state);

      expect({
        state,
        outcome: await asRuntime(
          `UPDATE platform.password_reset_intake
              SET state = 'PENDING', processed_at = NULL, outcome = NULL
            WHERE intake_id = $1`,
          [intakeId],
        ),
      }).not.toEqual({ state, outcome: 'accepted' });

      expect({
        state,
        outcome: await asRuntime(
          `UPDATE platform.password_reset_intake
              SET state = 'CLAIMED', claim_token = gen_random_uuid(),
                  lease_expires_at = now() + interval '1 minute'
            WHERE intake_id = $1`,
          [intakeId],
        ),
      }).not.toEqual({ state, outcome: 'accepted' });

      expect({
        state,
        outcome: await asRuntime(
          `UPDATE platform.password_reset_intake SET outcome = 'sent' WHERE intake_id = $1`,
          [intakeId],
        ),
      }).not.toEqual({ state, outcome: 'accepted' });

      expect({
        state,
        outcome: await asRuntime(
          `DELETE FROM platform.password_reset_intake WHERE intake_id = $1`,
          [intakeId],
        ),
      }).not.toEqual({ state, outcome: 'accepted' });

      const after = await env.admin.query<{ state: string }>(
        `SELECT state FROM platform.password_reset_intake WHERE intake_id = $1`,
        [intakeId],
      );
      expect(after.rows[0]?.state).toBe(state);
    }
  }, 60000);

  it('still allows the owned transition a worker legitimately makes', async () => {
    const member = await onboard('f2-normal@rem4.test', ['MANAGER']);
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    expect((await intakeRows(member.email))[0]).toMatchObject({
      state: 'PROCESSED',
      outcome: 'sent',
    });
  }, 60000);
});

// ---------------------------------------------------------------------- F3
describe('F3 — an intake owns its reset and its attribution', () => {
  it('binds every reset to the intake that created it', async () => {
    const member = await onboard('f3-bind@rem4.test', ['MANAGER']);
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);

    const intakes = await intakeRows(member.email);
    const rows = await resetRows(member.accountId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.intake_id).toBe(intakes[0]?.intake_id);
  }, 60000);

  it('never lets one intake adopt another’s reset or attribution', async () => {
    const member = await onboard('f3-attr@rem4.test', ['MANAGER']);

    // A Hotel Admin sends the link, and the member asks for one themselves.
    expectOk(
      await call(
        'POST',
        `/hotels/${hotelA}/staff/memberships/${member.membershipId}/password-reset`,
        {
          token: await signIn(adminA),
          key: idem('f3-admin'),
          body: {},
        },
      ),
    );
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);

    await appStaff.drainPasswordResetIntake(8);
    const rows = await resetRows(member.accountId);
    // Whichever ran first owns the live link; the other never adopts it, and no
    // reset carries an attribution its own intake did not have.
    const queued = await intakeRows(member.email);
    expect(queued.length).toBe(2);
    expect(new Set(queued.map((row) => row.initiated_by))).toEqual(
      new Set(['hotel_admin', 'self']),
    );
    const byIntake = new Map(queued.map((row) => [row.intake_id, row.initiated_by]));
    for (const row of rows) {
      expect(row.intake_id).not.toBeNull();
      expect(byIntake.get(row.intake_id as string)).toBe(row.initiated_by);
    }
  }, 90000);
});

// ---------------------------------------------------------------------- F4
describe('F4 — a lost acknowledgement is not a failure to send', () => {
  it('retries under the same delivery identity and sends one message', async () => {
    const member = await onboard('f4-ack@rem4.test', ['MANAGER']);
    env.notifications.reset();
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);

    // The provider records the message, then throws.
    env.notifications.failAcknowledgementNext();
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    expect((await intakeRows(member.email))[0]).toMatchObject({
      state: 'PENDING',
      outcome: 'unavailable',
    });

    await releaseQueue(member.email);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    expect((await intakeRows(member.email))[0]).toMatchObject({
      state: 'PROCESSED',
      outcome: 'sent',
    });

    const attempts = env.notifications.attempts();
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((message) => message.deliveryId)).size).toBe(1);
    expect(env.notifications.visibleCount()).toBe(1);

    const rows = await resetRows(member.accountId);
    expect(rows.length).toBe(1);
  }, 90000);

  it('settles a delivered intake whose settlement was lost, without sending again', async () => {
    const member = await onboard('f4-settle@rem4.test', ['MANAGER']);
    env.notifications.reset();
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);

    // Delivered and recorded as delivered — then the worker dies before settling.
    const claimed = await appStaff.claimResetIntakeForTest(4);
    expect(claimed.length).toBe(1);
    expect(await appStaff.processClaimedIntakeForTest(claimed[0]!)).toBe('sent');
    const firstDelivery = env.notifications.lastResetForEmail(member.email);
    expect(firstDelivery).toBeDefined();

    // The lease expires well past the resend interval, so a resend would look
    // permissible to anything that reasoned about the account rather than the
    // intake.
    await env.admin.query(
      `UPDATE platform.password_reset_intake
          SET lease_expires_at = now() - interval '1 hour'
        WHERE email_normalized = $1 AND state = 'CLAIMED'`,
      [member.email],
    );
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    expect((await intakeRows(member.email))[0]).toMatchObject({
      state: 'PROCESSED',
      outcome: 'sent',
    });
    expect(env.notifications.visibleCount()).toBe(1);
    const rows = await resetRows(member.accountId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.delivery_id).toBe(firstDelivery?.deliveryId);
  }, 90000);
});

// ---------------------------------------------------------------------- F5
describe('F5 — an expired intent is never delivered', () => {
  it('replaces an expired intent rather than sending it', async () => {
    const member = await onboard('f5-expired@rem4.test', ['MANAGER']);
    env.notifications.reset();

    const parameters = appParameters as { passwordResetTtlSeconds: number };
    const originalTtl = parameters.passwordResetTtlSeconds;
    parameters.passwordResetTtlSeconds = 1;
    try {
      expect(
        (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
          .status,
      ).toBe(202);
      // The provider is unreachable, so the intent is recorded and not delivered.
      env.notifications.failNext();
      expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    } finally {
      parameters.passwordResetTtlSeconds = originalTtl;
    }

    const first = await resetRows(member.accountId);
    expect(first.length).toBe(1);
    expect(first[0]?.secret_ciphertext).not.toBeNull();
    await waitUntilExpired(first[0]?.reset_id as string);

    await releaseQueue(member.email);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);

    const rows = await resetRows(member.accountId);
    expect(rows.length).toBe(2);
    // The expired one is terminal and holds no secret any more.
    const expired = rows.find((row) => row.reset_id === first[0]?.reset_id);
    expect(expired?.state).toBe('EXPIRED');
    expect(expired?.secret_ciphertext).toBeNull();
    // The replacement belongs to the same intake and the same attribution.
    const replacement = rows.find((row) => row.reset_id !== first[0]?.reset_id);
    expect(replacement?.intake_id).toBe(expired?.intake_id);
    expect(replacement?.initiated_by).toBe(expired?.initiated_by);
    expect(replacement?.delivery_id).not.toBe(expired?.delivery_id);

    // The link that was actually sent is live and completes the flow.
    const delivered = env.notifications.lastResetForEmail(member.email);
    expect(delivered).toBeDefined();
    expect((delivered?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    expectOk(
      await call('POST', '/auth/password-reset/confirm', {
        body: { token: delivered?.token, password: syntheticPassword('f5-new-password') },
      }),
    );
  }, 120000);

  it('keeps the encrypted secret complete, immutable and absent once terminal', async () => {
    const member = await onboard('f5-secret@rem4.test', ['MANAGER']);
    env.notifications.reset();
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);
    env.notifications.failNext();
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    const rows = await resetRows(member.accountId);
    const resetId = rows[0]?.reset_id as string;

    const asRuntime = async (sql: string, values: readonly unknown[]): Promise<string> =>
      env.api.query(sql, values as never[]).then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code ?? 'error',
      );

    // A partial secret is not representable.
    expect(
      await asRuntime(
        `UPDATE platform.password_reset_request SET secret_wrapped_dek = NULL WHERE reset_id = $1`,
        [resetId],
      ),
    ).not.toBe('accepted');
    // Nor is a rewritten one, or one attached to a row that never had it.
    expect(
      await asRuntime(
        `UPDATE platform.password_reset_request SET secret_ciphertext = 'AAAA' WHERE reset_id = $1`,
        [resetId],
      ),
    ).not.toBe('accepted');
    // Nor is rebinding the intent to a different intake.
    expect(
      await asRuntime(
        `UPDATE platform.password_reset_request SET intake_id = gen_random_uuid()
          WHERE reset_id = $1`,
        [resetId],
      ),
    ).not.toBe('accepted');
    // And a terminal row may not keep a secret.
    expect(
      await asRuntime(
        `UPDATE platform.password_reset_request
            SET state = 'REVOKED', terminal_at = now(), terminal_reason = 'probe'
          WHERE reset_id = $1`,
        [resetId],
      ),
    ).not.toBe('accepted');
  }, 90000);

  it('lets no plaintext token reach any durable surface', async () => {
    const member = await onboard('f5-plain@rem4.test', ['MANAGER']);
    env.notifications.reset();
    expect(
      (await call('POST', '/auth/password-reset/request', { body: { email: member.email } }))
        .status,
    ).toBe(202);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    const token = env.notifications.lastResetForEmail(member.email)?.token as string;
    expect(token.length).toBeGreaterThan(20);

    for (const [table, column] of [
      ['platform.password_reset_request', 'token_hash'],
      ['platform.password_reset_request', "coalesce(secret_ciphertext, '')"],
      ['platform.password_reset_intake', "coalesce(last_error, '')"],
      ['platform.outbox_event', 'payload::text'],
      ['audit.platform_event', 'payload::text'],
    ] as const) {
      const hits = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE position($1 in ${column}) > 0`,
        [token],
      );
      expect({ table, column, count: hits.rows[0]?.count }).toEqual({ table, column, count: '0' });
    }
  }, 90000);
});
