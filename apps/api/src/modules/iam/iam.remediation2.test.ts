import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from './test-support/iam-harness';
import { StaffService } from './services/staff.service';
import { attachIamHarness, provisionIamDatabase } from './test-support/iam-harness';
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
 * Phase 04 remediation 2 — four bounded defects.
 *
 * R1 a suspension that a provider failure rolled back; R2 a session realm no
 * key bound to its account; R3 an unverified address accepting an invitation;
 * R4 a reset endpoint that did account-specific work only for known addresses.
 */

let db: TestDatabase;
let env: IamHarness;
let app: NestFastifyApplication;
let baseUrl: string;
/**
 * The application's own staff service.
 *
 * Draining the reset queue must run with the key material the running
 * application holds: the harness has its own, so a token minted by one and
 * redeemed through the other would never match — the keyed digest is bound to
 * the key, which is the point of it.
 */
let appStaff: StaffService;

let hotelA: string;
let adminA: SeededMembership;

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `rem2-${prefix}-${String(key).padStart(6, '0')}`;
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

async function invite(
  token: string,
  hotelId: string,
  email: string,
  roles: readonly string[],
): Promise<{ membershipId: string }> {
  const created = await call('POST', `/hotels/${hotelId}/staff/invitations`, {
    token,
    key: idem('invite'),
    body: { email, roles },
  });
  expectOk(created);
  return { membershipId: created.body['membershipId'] as string };
}

async function onboard(
  hotelId: string,
  email: string,
  roles: readonly string[],
): Promise<SeededMembership> {
  const { membershipId } = await invite(await signIn(adminA), hotelId, email, roles);
  const delivered = env.notifications.lastInvitationFor(email);
  expect(delivered).toBeDefined();
  const password = syntheticPassword(email.split('@')[0] ?? 'member');
  const accepted = await call('POST', `/hotels/${hotelId}/staff/invitations/accept`, {
    key: idem('accept'),
    body: { token: delivered?.token, password },
  });
  expectOk(accepted);
  return { membershipId, accountId: accepted.body['accountId'] as string, email, password };
}

beforeAll(async () => {
  db = await provisionIamDatabase('iam_remediation2');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-iam-remediation2-seed',
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
  // The deterministic simulators, not a production adapter that happened to be
  // selected: none of the four has one.
  expect(subscription).toBeInstanceOf(SimulatedSubscriptionState);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  expect(openWork).toBeInstanceOf(SimulatedOpenWork);
  expect(restaurants).toBeInstanceOf(SimulatedRestaurantDirectory);
  env = attachIamHarness(db, 'iam_remediation2', {
    subscription,
    notifications,
    openWork,
    restaurants,
  });

  hotelA = await env.createHotel('Remediation Hotel', 'P30');
  adminA = await env.seedMembership({
    hotelId: hotelA,
    email: 'admin@rem2.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await env?.close();
}, 60000);

// ---------------------------------------------------------------------- R1
describe('R1 — a suspension is not undone by an unreachable work provider', () => {
  async function membershipState(membershipId: string): Promise<string | undefined> {
    const rows = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.staff_membership WHERE membership_id = $1`,
      [membershipId],
    );
    return rows.rows[0]?.state;
  }

  async function liveScopes(accountId: string): Promise<number> {
    const rows = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.session_scope_grant
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    return Number(rows.rows[0]?.count ?? '0');
  }

  it('commits the security effect even when open-work discovery fails', async () => {
    const member = await onboard(hotelA, 'r1-suspend@rem2.test', ['RECEPTION']);
    const bearer = await signIn(member);
    expect(await liveScopes(member.accountId)).toBeGreaterThan(0);

    // The module that owns this person's work is unreachable.
    env.openWork.set(hotelA, member.membershipId, [
      { kind: 'reception_shift', ref: '22222222-2222-4222-8222-000000000001' },
    ]);
    env.openWork.failFor(hotelA, member.membershipId);

    const suspended = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`,
      {
        token: await signIn(adminA),
        key: idem('r1-suspend'),
        body: { state: 'SUSPENDED', reason: 'provider down' },
      },
    );
    expectOk(suspended);

    // The security effect stands on its own.
    expect(await membershipState(member.membershipId)).toBe('SUSPENDED');
    expect(await liveScopes(member.accountId)).toBe(0);
    expect(
      (await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: bearer })).status,
    ).toBe(404);

    // The unfinished work is not silently gone: a durable, retryable marker says
    // discovery has not happened yet.
    expect(suspended.body['handoffDiscovery']).toBe('PENDING');
    const pending = await env.admin.query<{ state: string; attempts: string }>(
      `SELECT state, attempts::text AS attempts FROM platform.work_handoff_discovery
        WHERE hotel_id = $1 AND membership_id = $2`,
      [hotelA, member.membershipId],
    );
    expect(pending.rows[0]?.state).toBe('PENDING');
    expect(Number(pending.rows[0]?.attempts ?? '0')).toBeGreaterThan(0);

    // No item was invented from nothing.
    const before = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.work_handoff_item WHERE hotel_id = $1`,
      [hotelA],
    );
    expect(before.rows[0]?.count).toBe('0');
  }, 60000);

  it('creates the handoff exactly once when the provider comes back', async () => {
    const member = await onboard(hotelA, 'r1-recover@rem2.test', ['RECEPTION']);
    const subjectRef = '22222222-2222-4222-8222-000000000002';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);
    env.openWork.failFor(hotelA, member.membershipId);

    expectOk(
      await call('POST', `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`, {
        token: await signIn(adminA),
        key: idem('r1-recover'),
        body: { state: 'SUSPENDED', reason: 'provider down' },
      }),
    );

    env.openWork.recoverFor(hotelA, member.membershipId);

    const countItems = async (): Promise<number> => {
      const rows = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.work_handoff_item
          WHERE hotel_id = $1 AND subject_ref = $2`,
        [hotelA, subjectRef],
      );
      return Number(rows.rows[0]?.count ?? '0');
    };

    const first = await call('POST', `/hotels/${hotelA}/staff/handoff/discovery/reconcile`, {
      token: await signIn(adminA),
      key: idem('r1-reconcile-a'),
      body: {},
    });
    expectOk(first);
    expect(first.body['resolved']).toBe(1);
    expect(await countItems()).toBe(1);

    // Running it again is a no-op: no second item, and no second open marker.
    const second = await call('POST', `/hotels/${hotelA}/staff/handoff/discovery/reconcile`, {
      token: await signIn(adminA),
      key: idem('r1-reconcile-b'),
      body: {},
    });
    expectOk(second);
    expect(await countItems()).toBe(1);

    const marker = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.work_handoff_discovery
        WHERE hotel_id = $1 AND membership_id = $2`,
      [hotelA, member.membershipId],
    );
    expect(marker.rows.map((row) => row.state)).toEqual(['COMPLETED']);
  }, 90000);

  it('still opens the handoff inline when the provider answers', async () => {
    const member = await onboard(hotelA, 'r1-happy@rem2.test', ['RECEPTION']);
    const subjectRef = '22222222-2222-4222-8222-000000000003';
    env.openWork.set(hotelA, member.membershipId, [{ kind: 'reception_shift', ref: subjectRef }]);

    const suspended = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`,
      {
        token: await signIn(adminA),
        key: idem('r1-happy'),
        body: { state: 'SUSPENDED', reason: 'ordinary' },
      },
    );
    expectOk(suspended);
    expect((suspended.body['handoffItems'] as string[]).length).toBe(1);
    expect(suspended.body['handoffDiscovery']).toBe('COMPLETED');
  }, 60000);
});

// ---------------------------------------------------------------------- R2
describe('R2 — a session realm is bound to its account realm', () => {
  it('refuses a Police session for a Hotel account through the runtime login', async () => {
    const member = await onboard(hotelA, 'r2-realm@rem2.test', ['RECEPTION']);
    const outcome = await env.api
      .query(
        `INSERT INTO platform.server_session
           (account_id, realm, token_hash, token_key_version, account_epoch,
            idle_expires_at, absolute_expires_at)
         VALUES ($1, 'police', repeat('b', 64), 'fixture-v1', 0,
                 now() + interval '30 minutes', now() + interval '8 hours')`,
        [member.accountId],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code ?? 'error',
      );
    expect(outcome).toBe('23503');
  }, 60000);

  it('still accepts a session in the account’s own realm', async () => {
    const member = await onboard(hotelA, 'r2-ok@rem2.test', ['RECEPTION']);
    const outcome = await env.api
      .query(
        `INSERT INTO platform.server_session
           (account_id, realm, token_hash, token_key_version, account_epoch,
            idle_expires_at, absolute_expires_at)
         VALUES ($1, 'hotel', repeat('c', 64), 'fixture-v1', 0,
                 now() + interval '30 minutes', now() + interval '8 hours')`,
        [member.accountId],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code ?? 'error',
      );
    expect(outcome).toBe('accepted');
  }, 60000);
});

// ---------------------------------------------------------------------- R3
describe('R3 — an existing account accepts only with a verified address', () => {
  it('refuses an active signed-in account whose address is not verified', async () => {
    const member = await onboard(hotelA, 'r3-verify@rem2.test', ['RECEPTION']);
    const second = await env.createHotel('Remediation Hotel Two', 'P30');
    const adminTwo = await env.seedMembership({
      hotelId: second,
      email: 'admin@rem2-two.test',
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    await invite(await signIn(adminTwo), second, member.email, ['RECEPTION']);
    const delivered = env.notifications.lastInvitationFor(member.email);

    // The address has an account and a live session, but has never been proved.
    await env.admin.query(
      `UPDATE platform.user_account SET email_verified_at = NULL WHERE account_id = $1`,
      [member.accountId],
    );

    const refused = await call('POST', `/hotels/${second}/staff/invitations/accept`, {
      token: await signIn(member),
      key: idem('r3-unverified'),
      body: { token: delivered?.token },
    });
    expect(refused.status).toBe(404);
    // Indistinguishable from an unknown token: no enumeration.
    expect((refused.body['error'] as { message: string }).message).toBe('not found');

    // Once the address is verified the same invitation is accepted, once.
    await env.admin.query(
      `UPDATE platform.user_account SET email_verified_at = now() WHERE account_id = $1`,
      [member.accountId],
    );
    const accepted = await call('POST', `/hotels/${second}/staff/invitations/accept`, {
      token: await signIn(member),
      key: idem('r3-verified'),
      body: { token: delivered?.token },
    });
    expectOk(accepted);
    expect(accepted.body['accountId']).toBe(member.accountId);

    const memberships = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.staff_membership
        WHERE hotel_id = $1 AND account_id = $2`,
      [second, member.accountId],
    );
    expect(memberships.rows[0]?.count).toBe('1');
  }, 90000);
});

// ---------------------------------------------------------------------- R4
describe('R4 — the public reset boundary does the same work for every address', () => {
  it('does no account-specific work while answering, known or unknown', async () => {
    const member = await onboard(hotelA, 'r4-known@rem2.test', ['MANAGER']);

    // The provider is held open for the whole of both requests. If the public
    // path delivered synchronously, the known-address request could not return.
    const release = env.notifications.blockNext();
    try {
      const known = await call('POST', '/auth/password-reset/request', {
        body: { email: member.email },
      });
      const unknown = await call('POST', '/auth/password-reset/request', {
        body: { email: 'r4-nobody@rem2.test' },
      });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.text).toBe(unknown.text);

      // Neither request minted a token or wrote a reset row.
      const resets = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.password_reset_request
          WHERE account_id = $1`,
        [member.accountId],
      );
      expect(resets.rows[0]?.count).toBe('0');

      // Both left the same durable intake shape behind.
      const intake = await env.admin.query<{ email_normalized: string; state: string }>(
        `SELECT email_normalized, state FROM platform.password_reset_intake
          WHERE email_normalized = ANY($1::text[])
          ORDER BY requested_at`,
        [[member.email, 'r4-nobody@rem2.test']],
      );
      expect(intake.rows.map((row) => row.state)).toEqual(['PENDING', 'PENDING']);
      expect(intake.rows.map((row) => row.email_normalized)).toEqual([
        member.email,
        'r4-nobody@rem2.test',
      ]);
    } finally {
      release();
    }
  }, 90000);

  it('sends only for the eligible address when the intake is processed', async () => {
    const known = await onboard(hotelA, 'r4-drain@rem2.test', ['MANAGER']);
    const disabled = await onboard(hotelA, 'r4-disabled@rem2.test', ['MANAGER']);
    await env.admin.query(
      `UPDATE platform.user_account SET state = 'DISABLED' WHERE account_id = $1`,
      [disabled.accountId],
    );
    // Nothing is deleted: a settled queue entry is evidence, and the guard
    // refuses. Each case queues its own addresses and asserts only on those.
    const addresses = [known.email, disabled.email, 'r4-missing@rem2.test'];
    env.notifications.reset();

    for (const email of addresses) {
      expect((await call('POST', '/auth/password-reset/request', { body: { email } })).status).toBe(
        202,
      );
    }

    // The queue is shared with the cases before this one, so what matters is
    // that these three settled — not that nothing else did.
    const processed = await appStaff.drainPasswordResetIntake(16);
    expect(processed).toBeGreaterThanOrEqual(3);

    expect(env.notifications.lastResetForEmail(known.email)).toBeDefined();
    expect(env.notifications.lastResetForEmail(disabled.email)).toBeUndefined();
    expect(env.notifications.lastResetForEmail('r4-missing@rem2.test')).toBeUndefined();

    const states = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.password_reset_intake
        WHERE email_normalized = ANY($1::text[]) ORDER BY requested_at`,
      [addresses],
    );
    expect(states.rows.map((row) => row.state)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);

    // Exactly one live token, and it belongs to the eligible account.
    const live = await env.admin.query<{ account_id: string }>(
      `SELECT account_id FROM platform.password_reset_request
        WHERE state = 'ACTIVE' AND account_id = ANY($1::uuid[])`,
      [[known.accountId, disabled.accountId]],
    );
    expect(live.rows.map((row) => row.account_id)).toEqual([known.accountId]);
  }, 90000);

  it('keeps the resend interval, and never lets it reach the caller', async () => {
    const member = await onboard(hotelA, 'r4-throttle@rem2.test', ['MANAGER']);
    env.notifications.reset();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call('POST', '/auth/password-reset/request', {
        body: { email: member.email },
      });
      expect(response.status).toBe(202);
    }
    expect(await appStaff.drainPasswordResetIntake(16)).toBeGreaterThanOrEqual(2);

    // The second is inside the resend interval, so it neither supersedes the
    // first nor sends a second link.
    const live = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.password_reset_request
        WHERE account_id = $1 AND state = 'ACTIVE'`,
      [member.accountId],
    );
    expect(live.rows[0]?.count).toBe('1');
    expect(
      env.notifications.all().filter((message) => message.kind === 'password_reset').length,
    ).toBe(1);
  }, 90000);
});
