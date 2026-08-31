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
import {
  OPEN_WORK,
  RESTAURANT_DIRECTORY,
  STAFF_NOTIFICATION,
  SUBSCRIPTION_STATE,
} from './iam.tokens';

/**
 * Phase 04 remediation 3.
 *
 * R1-A derived idempotency keys that overflowed the column they were written
 * to; R1-B discovery markers that outlived the state they described; R4 a reset
 * queue that could be processed twice, gave up permanently on a transient
 * failure, and delivered from inside the transaction that recorded it.
 */

let db: TestDatabase;
let env: IamHarness;
let app: NestFastifyApplication;
let baseUrl: string;
let appStaff: StaffService;

let hotelA: string;
let adminA: SeededMembership;

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `rem3-${prefix}-${String(key).padStart(6, '0')}`;
}

/** A client key at the documented maximum. Legal, and previously fatal. */
function maximalKey(label: string): string {
  const seed = `rem3-max-${label}-`;
  return seed + 'k'.repeat(200 - seed.length);
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

async function countItems(subjectRef: string): Promise<number> {
  const rows = await env.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform.work_handoff_item
      WHERE hotel_id = $1 AND subject_ref = $2`,
    [hotelA, subjectRef],
  );
  return Number(rows.rows[0]?.count ?? '0');
}

async function countEvents(subjectRef: string): Promise<number> {
  const rows = await env.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform.work_handoff_event e
       JOIN platform.work_handoff_item i ON i.item_id = e.item_id
      WHERE i.hotel_id = $1 AND i.subject_ref = $2`,
    [hotelA, subjectRef],
  );
  return Number(rows.rows[0]?.count ?? '0');
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

beforeAll(async () => {
  db = await provisionIamDatabase('iam_remediation3');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-iam-remediation3-seed',
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
  expect(subscription).toBeInstanceOf(SimulatedSubscriptionState);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  expect(openWork).toBeInstanceOf(SimulatedOpenWork);
  expect(restaurants).toBeInstanceOf(SimulatedRestaurantDirectory);
  env = attachIamHarness(db, 'iam_remediation3', {
    subscription,
    notifications,
    openWork,
    restaurants,
  });

  hotelA = await env.createHotel('Remediation Three Hotel', 'P30');
  adminA = await env.seedMembership({
    hotelId: hotelA,
    email: 'admin@rem3.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await env?.close();
}, 60000);

// -------------------------------------------------------------------- R1-A
describe('R1-A — a derived idempotency key is always a legal key', () => {
  it('completes inline for a client key at the documented maximum', async () => {
    const member = await onboard('r1a-inline@rem3.test', ['RECEPTION']);
    const subjectRef = '33333333-3333-4333-8333-000000000001';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);

    const clientKey = maximalKey('inline');
    expect(clientKey.length).toBe(200);

    const suspended = await setState(member.membershipId, 'SUSPENDED', 'maximal key', clientKey);
    expectOk(suspended);
    expect(suspended.body['handoffDiscovery']).toBe('COMPLETED');
    expect((suspended.body['handoffItems'] as string[]).length).toBe(1);
    expect(await countItems(subjectRef)).toBe(1);
  }, 60000);

  it('recovers a maximal-key suspension through manual reconciliation', async () => {
    const member = await onboard('r1a-recover@rem3.test', ['RECEPTION']);
    const subjectRef = '33333333-3333-4333-8333-000000000002';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);

    const clientKey = maximalKey('recover');
    const suspended = await setState(member.membershipId, 'SUSPENDED', 'provider down', clientKey);
    expectOk(suspended);
    expect(suspended.body['handoffDiscovery']).toBe('PENDING');

    env.openWork.recoverFor(hotelA, member.membershipId);
    const first = await reconcile(maximalKey('reconcile-a'));
    expectOk(first);
    expect(first.body['resolved']).toBe(1);
    expect(await countItems(subjectRef)).toBe(1);
    expect(await countEvents(subjectRef)).toBe(1);

    // Repeating it creates neither a second item nor a second event.
    expectOk(await reconcile(maximalKey('reconcile-b')));
    expect(await countItems(subjectRef)).toBe(1);
    expect(await countEvents(subjectRef)).toBe(1);
  }, 90000);
});

// -------------------------------------------------------------------- R1-B
describe('R1-B — a discovery marker describes one revision of one membership', () => {
  it('hands off nothing once the membership has been reactivated', async () => {
    const member = await onboard('r1b-stale@rem3.test', ['RECEPTION']);
    const subjectRef = '33333333-3333-4333-8333-000000000003';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);

    expectOk(await setState(member.membershipId, 'SUSPENDED', 'down', idem('r1b-suspend')));
    expectOk(await setState(member.membershipId, 'ACTIVE', 'cleared', idem('r1b-reactivate')));

    env.openWork.recoverFor(hotelA, member.membershipId);
    const result = await reconcile(idem('r1b-reconcile'));
    expectOk(result);
    // The person is working again. Their shift is theirs.
    expect(result.body['resolved']).toBe(0);
    expect(await countItems(subjectRef)).toBe(0);

    const settled = await markers(member.membershipId);
    expect(settled.map((row) => row.state)).toEqual(['SUPERSEDED']);
  }, 90000);

  it('opens a new revision-bound marker for a later termination', async () => {
    const member = await onboard('r1b-again@rem3.test', ['RECEPTION']);
    const subjectRef = '33333333-3333-4333-8333-000000000004';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);

    expectOk(await setState(member.membershipId, 'SUSPENDED', 'down', idem('r1b-s2')));
    expectOk(await setState(member.membershipId, 'ACTIVE', 'cleared', idem('r1b-a2')));
    expectOk(await setState(member.membershipId, 'TERMINATED', 'left', idem('r1b-t2')));

    const rows = await markers(member.membershipId);
    expect(rows.length).toBe(2);
    expect(rows[0]?.state).toBe('SUPERSEDED');
    expect(rows[0]?.opened_reason).toBe('suspension');
    expect(rows[1]?.state).toBe('PENDING');
    expect(rows[1]?.opened_reason).toBe('termination');
    // Its own revision, not the suspension's.
    expect(Number(rows[1]?.membership_revision)).toBeGreaterThan(
      Number(rows[0]?.membership_revision),
    );

    env.openWork.recoverFor(hotelA, member.membershipId);
    expectOk(await reconcile(idem('r1b-r2')));
    expect(await countItems(subjectRef)).toBe(1);
  }, 90000);

  it('refuses to hand off work while a reactivation is committing', async () => {
    const member = await onboard('r1b-race@rem3.test', ['RECEPTION']);
    const subjectRef = '33333333-3333-4333-8333-000000000005';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);
    expectOk(await setState(member.membershipId, 'SUSPENDED', 'down', idem('r1b-race-s')));
    env.openWork.recoverFor(hotelA, member.membershipId);

    // A reactivation holding the membership row, and a reconciliation arriving
    // while it is held. Whichever order the two commit in, the membership is
    // ACTIVE at the end and its work was never handed to anybody.
    const [, reconciled] = await Promise.all([
      setState(member.membershipId, 'ACTIVE', 'back', idem('r1b-race-a')),
      reconcile(idem('r1b-race-r')),
    ]);
    expectOk(reconciled);

    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.staff_membership WHERE membership_id = $1`,
      [member.membershipId],
    );
    expect(state.rows[0]?.state).toBe('ACTIVE');
    expect(await countItems(subjectRef)).toBe(0);
  }, 90000);
});

// ---------------------------------------------------------------------- R4
describe('R4 — the reset queue is leased, retryable and delivered once', () => {
  async function queue(email: string): Promise<void> {
    const response = await call('POST', '/auth/password-reset/request', { body: { email } });
    expect(response.status).toBe(202);
  }

  async function intakeRows(): Promise<
    {
      intake_id: string;
      state: string;
      outcome: string | null;
      attempts: string;
      claim_token: string | null;
    }[]
  > {
    const rows = await env.admin.query<{
      intake_id: string;
      state: string;
      outcome: string | null;
      attempts: string;
      claim_token: string | null;
    }>(
      `SELECT intake_id::text AS intake_id, state, outcome, attempts::text AS attempts,
              claim_token::text AS claim_token
         FROM platform.password_reset_intake
        WHERE email_normalized = ANY($1::text[]) ORDER BY requested_at`,
      [[...scoped]],
    );
    return rows.rows;
  }

  /**
   * The addresses the current case queued.
   *
   * Nothing is deleted between cases — a settled queue entry is evidence and the
   * guard refuses to remove it — so each case declares what it owns and asserts
   * only on that.
   */
  let scoped: readonly string[] = [];

  function clearQueue(...addresses: readonly string[]): void {
    scoped = addresses;
    env.notifications.reset();
  }

  it('lets exactly one of two concurrent drains own a single intake', async () => {
    const member = await onboard('r4-race@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);

    const [a, b] = await Promise.all([
      appStaff.drainPasswordResetIntake(8),
      appStaff.drainPasswordResetIntake(8),
    ]);
    expect(a + b).toBe(1);
    expect(Math.min(a, b)).toBe(0);

    const intake = await intakeRows();
    const settlements = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit.platform_event
        WHERE action = 'iam.password.reset_intake_settled' AND target_ref = $1`,
      [intake[0]?.intake_id],
    );
    expect(settlements.rows[0]?.count).toBe('1');
    expect(
      env.notifications.all().filter((message) => message.kind === 'password_reset').length,
    ).toBe(1);
  }, 90000);

  it('reclaims a lease a stopped worker never settled', async () => {
    const member = await onboard('r4-lease@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);

    const claimed = await appStaff.claimResetIntakeForTest(4);
    expect(claimed.length).toBe(1);
    const rowsWhileHeld = await intakeRows();
    expect(rowsWhileHeld[0]?.state).toBe('CLAIMED');
    expect(rowsWhileHeld[0]?.claim_token).not.toBeNull();

    // The worker stops. Nothing settles it, so a second drain finds it still
    // leased and must not touch it…
    expect(await appStaff.drainPasswordResetIntake(8)).toBe(0);
    // …until the lease has expired.
    await env.admin.query(
      `UPDATE platform.password_reset_intake SET lease_expires_at = now() - interval '1 minute'
        WHERE email_normalized = ANY($1::text[]) AND state = 'CLAIMED'`,
      [[...scoped]],
    );
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    const settled = await intakeRows();
    expect(settled[0]?.state).toBe('PROCESSED');
    expect(settled[0]?.outcome).toBe('sent');
  }, 90000);

  it('keeps a transient provider failure retryable and succeeds on recovery', async () => {
    const member = await onboard('r4-retry@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);

    env.notifications.failNext();
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    const afterFailure = await intakeRows();
    // Retryable, not terminal: an unreachable provider is not a decision.
    expect(afterFailure[0]?.state).toBe('PENDING');
    expect(afterFailure[0]?.outcome).toBe('unavailable');
    expect(Number(afterFailure[0]?.attempts)).toBe(1);

    await env.admin.query(
      `UPDATE platform.password_reset_intake SET next_attempt_at = now()
        WHERE email_normalized = ANY($1::text[]) AND state = 'PENDING'`,
      [[...scoped]],
    );
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    const afterRecovery = await intakeRows();
    expect(afterRecovery[0]?.state).toBe('PROCESSED');
    expect(afterRecovery[0]?.outcome).toBe('sent');
    expect(
      env.notifications.all().filter((message) => message.kind === 'password_reset').length,
    ).toBe(1);
  }, 90000);

  it('retries a delivered-but-unsettled intake under the same delivery identity', async () => {
    const member = await onboard('r4-ack@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);

    // Claim and deliver, then lose the acknowledgement.
    const claimed = await appStaff.claimResetIntakeForTest(4);
    expect(claimed.length).toBe(1);
    const outcome = await appStaff.processClaimedIntakeForTest(claimed[0]!);
    expect(outcome).toBe('sent');
    const firstDelivery = env.notifications.lastResetForEmail(member.email);
    expect(firstDelivery).toBeDefined();

    await env.admin.query(
      `UPDATE platform.password_reset_intake SET lease_expires_at = now() - interval '1 minute'
        WHERE email_normalized = ANY($1::text[]) AND state = 'CLAIMED'`,
      [[...scoped]],
    );
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);

    // Same delivery identity, and the recipient saw one message.
    const secondDelivery = env.notifications.lastResetForEmail(member.email);
    expect(secondDelivery?.deliveryId).toBe(firstDelivery?.deliveryId);
    expect(env.notifications.visibleCount()).toBe(1);
  }, 90000);

  it('dead-letters an address the provider never accepts, and says so to nobody', async () => {
    const member = await onboard('r4-dead@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);

    const attempts = env.parameters.passwordResetDeliveryMaxAttempts;
    expect(attempts).toBeGreaterThan(1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      env.notifications.failNext();
      await env.admin.query(
        `UPDATE platform.password_reset_intake SET next_attempt_at = now()
        WHERE email_normalized = ANY($1::text[]) AND state = 'PENDING'`,
        [[...scoped]],
      );
      expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);
    }
    const dead = await intakeRows();
    expect(dead[0]?.state).toBe('DEAD_LETTER');
    expect(dead[0]?.outcome).toBe('dead_letter');
  }, 120000);

  it('is indistinguishable at the public boundary for every address', async () => {
    const member = await onboard('r4-oracle@rem3.test', ['MANAGER']);
    const disabled = await onboard('r4-oracle-off@rem3.test', ['MANAGER']);
    await env.admin.query(
      `UPDATE platform.user_account SET state = 'DISABLED' WHERE account_id = $1`,
      [disabled.accountId],
    );
    const addresses = [member.email, disabled.email, 'r4-nobody@rem3.test'];
    clearQueue(...addresses);

    const seen: string[] = [];
    for (const email of [member.email, disabled.email, 'r4-nobody@rem3.test', member.email]) {
      const response = await call('POST', '/auth/password-reset/request', { body: { email } });
      expect(response.status).toBe(202);
      seen.push(response.text);
    }
    expect(new Set(seen).size).toBe(1);

    await appStaff.drainPasswordResetIntake(16);
    const outcomes = (await intakeRows()).map((row) => row.outcome);
    // The outcomes differ — that is the operator's view, not the caller's.
    expect(outcomes).toEqual(['sent', 'ignored', 'ignored', 'throttled']);
  }, 120000);

  it('stores no plaintext reset token anywhere a reader can reach', async () => {
    const member = await onboard('r4-secret@rem3.test', ['MANAGER']);
    clearQueue(member.email);
    await queue(member.email);
    expect(await appStaff.drainPasswordResetIntake(8)).toBeGreaterThan(0);

    const delivered = env.notifications.lastResetForEmail(member.email);
    const token = delivered?.token as string;
    expect(token.length).toBeGreaterThan(20);

    for (const [table, column] of [
      ['platform.password_reset_intake', "coalesce(last_error, '')"],
      ['platform.password_reset_request', 'token_hash'],
      ['platform.password_reset_request', "coalesce(secret_ciphertext, '')"],
      ['platform.outbox_event', 'payload::text'],
      ['audit.platform_event', 'payload::text'],
    ] as const) {
      const hits = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE position($1 in ${column}) > 0`,
        [token],
      );
      expect({ table, column, count: hits.rows[0]?.count }).toEqual({
        table,
        column,
        count: '0',
      });
    }

    // And the link still works, which is what makes the ciphertext recoverable
    // rather than merely absent.
    const confirmed = await call('POST', '/auth/password-reset/confirm', {
      body: { token, password: syntheticPassword('r4-secret-new') },
    });
    expectOk(confirmed);
  }, 90000);
});
