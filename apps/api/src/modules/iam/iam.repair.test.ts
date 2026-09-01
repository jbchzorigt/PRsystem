import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from './test-support/iam-harness';
import { StaffService } from './services/staff.service';
import { attachIamHarness, provisionIamDatabase } from './test-support/iam-harness';
import { authorize } from '@prsystem/authz';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import { newCorrelationId as newId } from '@prsystem/contracts';
import { resolvePrincipal } from './services/authorization.service';
import { SimulatedStaffNotification } from './contracts/staff-notification.port';
import { DatabaseSubscriptionState } from '../onboarding/contracts/subscription-state.adapter';
import { SimulatedOpenWork } from './contracts/open-work.port';
import { SimulatedRestaurantDirectory } from './contracts/restaurant-directory.port';
import {
  OPEN_WORK,
  RESTAURANT_DIRECTORY,
  STAFF_NOTIFICATION,
  SUBSCRIPTION_STATE,
} from './iam.tokens';

/**
 * The Phase 04 repair regressions.
 *
 * Each block is one repair group of the brief, and every case here failed
 * against the behaviour at `62fd743` for the reason its name states. They are
 * driven over the real HTTP surface and the restricted `prsystem_api` login
 * wherever the defect is reachable that way, because that is where the defect
 * was reachable.
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
let hotelB: string;
let adminA: SeededMembership;
let adminB: SeededMembership;

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `repair-${prefix}-${String(key).padStart(6, '0')}`;
}

function syntheticPassword(label: string): string {
  return ['synthetic', label, 'passphrase'].join('-');
}

interface Json {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

/** Nest answers a POST 201 and a GET 200; both mean the command ran. */
function expectOk(result: Json): Json {
  expect([200, 201], result.text).toContain(result.status);
  return result;
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

async function signIn(member: SeededMembership): Promise<string> {
  const result = await call('POST', '/auth/sign-in', {
    body: { email: member.email, password: member.password },
  });
  expect(result.status, result.text).toBe(200);
  return result.body['token'] as string;
}

/** Runs one statement as the restricted runtime login, in a chosen scope. */
async function asRuntime<T>(
  scope: { hotelId: string; accountId?: string },
  work: (query: (sql: string, values?: unknown[]) => Promise<{ rows: T[] }>) => Promise<void>,
): Promise<void> {
  const client = await env.api.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', scope.hotelId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
    if (scope.accountId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', scope.accountId]);
    }
    await work(async (sql, values) => {
      const result = await client.query(sql, values as never[]);
      return { rows: result.rows as T[] };
    });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function invite(
  token: string,
  hotelId: string,
  email: string,
  roles: readonly string[],
  restaurantId?: string,
): Promise<{ membershipId: string; invitationId: string }> {
  const created = await call('POST', `/hotels/${hotelId}/staff/invitations`, {
    token,
    key: idem('invite'),
    body: { email, roles, ...(restaurantId === undefined ? {} : { restaurantId }) },
  });
  expectOk(created);
  return {
    membershipId: created.body['membershipId'] as string,
    invitationId: created.body['invitationId'] as string,
  };
}

/** Invites, accepts with a new password, and returns the working credentials. */
async function onboard(
  token: string,
  hotelId: string,
  email: string,
  roles: readonly string[],
  options: { restaurantId?: string; existing?: SeededMembership } = {},
): Promise<SeededMembership> {
  const { membershipId } = await invite(token, hotelId, email, roles, options.restaurantId);
  const delivered = env.notifications.lastInvitationFor(email);
  expect(delivered).toBeDefined();
  const existing = options.existing;
  const password = existing?.password ?? syntheticPassword(email.split('@')[0] ?? 'member');
  // An address that already has an account accepts as itself, with its bearer;
  // a new one supplies the password it chooses (doc 19 §5).
  const accepted = await call('POST', `/hotels/${hotelId}/staff/invitations/accept`, {
    key: idem('accept'),
    ...(existing === undefined ? { body: { token: delivered?.token, password } } : {}),
    ...(existing === undefined
      ? {}
      : { token: await signIn(existing), body: { token: delivered?.token } }),
  });
  expectOk(accepted);
  return {
    membershipId,
    accountId: accepted.body['accountId'] as string,
    email,
    password,
  };
}

beforeAll(async () => {
  db = await provisionIamDatabase('iam_repair');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-iam-repair-seed',
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

  // The very instances the running application holds. A second set would let a
  // test seed work or a restaurant the application never sees.
  const subscription = app.get<DatabaseSubscriptionState>(SUBSCRIPTION_STATE);
  const notifications = app.get<SimulatedStaffNotification>(STAFF_NOTIFICATION);
  const openWork = app.get<SimulatedOpenWork>(OPEN_WORK);
  const restaurants = app.get<SimulatedRestaurantDirectory>(RESTAURANT_DIRECTORY);
  appStaff = app.get<StaffService>(StaffService);
  // Subscription state is the authoritative database adapter — Phase 05 replaced
  // the port that answered nothing — and the other three are the deterministic
  // simulators, not a production adapter that happened to be selected: no such
  // adapter exists for any of them.
  expect(subscription).toBeInstanceOf(DatabaseSubscriptionState);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  expect(openWork).toBeInstanceOf(SimulatedOpenWork);
  expect(restaurants).toBeInstanceOf(SimulatedRestaurantDirectory);
  env = attachIamHarness(db, 'iam_repair', {
    notifications,
    openWork,
    restaurants,
  });

  hotelA = await env.createHotel('Repair Hotel A', 'P30');
  hotelB = await env.createHotel('Repair Hotel B', 'P30');
  adminA = await env.seedMembership({
    hotelId: hotelA,
    email: 'admin@repair-a.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  adminB = await env.seedMembership({
    hotelId: hotelB,
    email: 'admin@repair-b.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await env?.close();
}, 60000);

// ---------------------------------------------------------------------- B
describe('B — the tenant context is server-derived', () => {
  it('never locks another tenant’s row for a caller with no membership there', async () => {
    const tokenB = await signIn(adminB);
    // A concurrent holder of hotel A's Primary membership row. If the command
    // bound RLS to the URL's hotel before proving membership, its `FOR UPDATE`
    // would queue behind this and the request would block — which is itself the
    // disclosure: a foreign row that exists behaves differently from one that
    // does not.
    const holder = await env.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelA]);
      await holder.query(
        'SELECT membership_id FROM platform.staff_membership WHERE membership_id = $1 FOR UPDATE',
        [adminA.membershipId],
      );

      const started = Date.now();
      const denied = await call(
        'POST',
        `/hotels/${hotelA}/staff/memberships/${adminA.membershipId}/state`,
        { token: tokenB, key: idem('cross-lock'), body: { state: 'SUSPENDED', reason: 'probe' } },
      );
      const elapsed = Date.now() - started;

      expect(denied.status).toBe(404);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30000);

  it('shows a hotel-scoped transaction nothing from the account’s other hotels', async () => {
    const shared = await onboard(await signIn(adminA), hotelA, 'shared@repair.test', ['RECEPTION']);
    // The same person, a second membership in hotel B.
    await env.seedMembership({
      hotelId: hotelB,
      email: shared.email,
      roles: ['RECEPTION'],
    });

    await asRuntime<{ hotel_id: string }>(
      { hotelId: hotelA, accountId: shared.accountId },
      async (query) => {
        const rows = await query('SELECT hotel_id FROM platform.staff_membership');
        expect([...new Set(rows.rows.map((row) => row.hotel_id))]).toEqual([hotelA]);
      },
    );
  }, 30000);
});

// ---------------------------------------------------------------------- C
describe('C — a scope session is real authority, not a record', () => {
  it('refuses an old bearer once a role is added, and honours a fresh one', async () => {
    // An item only a Manager can see: doc 18 §3.2 confines Reception's view of
    // the queue to the items assigned to it as a replacement.
    const suspended = await onboard(await signIn(adminA), hotelA, 'roleadd-work@repair.test', [
      'RECEPTION',
    ]);
    env.openWork.set(hotelA, suspended.membershipId, [
      { kind: 'reception_shift', ref: '11111111-1111-4111-8111-000000000010' },
    ]);
    expectOk(
      await call('POST', `/hotels/${hotelA}/staff/memberships/${suspended.membershipId}/state`, {
        token: await signIn(adminA),
        key: idem('roleadd-open'),
        body: { state: 'SUSPENDED', reason: 'role add fixture' },
      }),
    );

    const member = await onboard(await signIn(adminA), hotelA, 'roleadd@repair.test', [
      'RECEPTION',
    ]);
    const stale = await signIn(member);
    const before = await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: stale });
    expectOk(before);
    expect((before.body['items'] as unknown[]).length).toBe(0);

    expectOk(
      await call('POST', `/hotels/${hotelA}/staff/memberships/${member.membershipId}/roles`, {
        token: await signIn(adminA),
        key: idem('roleadd'),
        body: { role: 'MANAGER' },
      }),
    );

    // The old token must not pick the new role up: its scope grant was revoked
    // and the revision it was stamped with is no longer current.
    expect(
      (await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: stale })).status,
    ).toBe(404);

    const fresh = await signIn(member);
    const after = await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: fresh });
    expectOk(after);
    expect((after.body['items'] as unknown[]).length).toBeGreaterThan(0);
  }, 60000);

  it('keeps an old bearer invalid after a suspension is reversed', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'suspend@repair.test', ['MANAGER']);
    const stale = await signIn(member);
    expect(
      (await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: stale })).status,
    ).toBe(200);

    for (const state of ['SUSPENDED', 'ACTIVE'] as const) {
      const moved = await call(
        'POST',
        `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`,
        { token: await signIn(adminA), key: idem('reactivate'), body: { state, reason: 'test' } },
      );
      expectOk(moved);
    }

    expect(
      (await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: stale })).status,
    ).toBe(404);
    const fresh = await signIn(member);
    expect(
      (await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token: fresh })).status,
    ).toBe(200);
  }, 40000);

  it('leaves the same session’s authority in another hotel untouched', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'twohotels@repair.test', [
      'MANAGER',
    ]);
    const inB = await onboard(await signIn(adminB), hotelB, 'twohotels@repair.test', ['MANAGER'], {
      existing: member,
    });
    expect(inB.accountId).toBe(member.accountId);

    const token = await signIn(member);
    expect((await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token })).status).toBe(
      200,
    );
    expect((await call('GET', `/hotels/${hotelB}/staff/handoff/items`, { token })).status).toBe(
      200,
    );

    const suspended = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`,
      {
        token: await signIn(adminA),
        key: idem('one-hotel'),
        body: { state: 'SUSPENDED', reason: 'test' },
      },
    );
    expectOk(suspended);

    expect((await call('GET', `/hotels/${hotelA}/staff/handoff/items`, { token })).status).toBe(
      404,
    );
    expect((await call('GET', `/hotels/${hotelB}/staff/handoff/items`, { token })).status).toBe(
      200,
    );
  }, 60000);

  it('revokes every scope grant when the password is reset', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'resetscope@repair.test', [
      'MANAGER',
    ]);
    await signIn(member);

    const live = async (): Promise<number> => {
      const result = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.session_scope_grant
          WHERE account_id = $1 AND revoked_at IS NULL`,
        [member.accountId],
      );
      return Number(result.rows[0]?.count ?? '0');
    };
    expect(await live()).toBeGreaterThan(0);

    const requested = await call('POST', '/auth/password-reset/request', {
      body: { email: member.email },
    });
    expect(requested.status).toBe(202);
    // The public request only queues; the link is minted and delivered when the
    // queue is drained, which is what keeps the endpoint's work identical for
    // every address.
    expect(await appStaff.drainPasswordResetIntake(16)).toBeGreaterThan(0);
    const delivered = env.notifications.lastResetForEmail(member.email);
    expect(delivered).toBeDefined();
    const confirmed = await call('POST', '/auth/password-reset/confirm', {
      body: { token: delivered?.token, password: syntheticPassword('reset-scope') },
    });
    expectOk(confirmed);
    expect(await live()).toBe(0);
  }, 40000);

  it('refreshes idle expiry without pushing it past the absolute expiry', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'nearexpiry@repair.test', [
      'MANAGER',
    ]);
    // A session issued with an absolute life shorter than one idle window. The
    // row is never edited to arrange this: `server_session` refuses a rewrite of
    // its own absolute expiry, which is the point of the guard.
    const parameters = env.parameters as { sessionAbsoluteSeconds: number };
    const original = parameters.sessionAbsoluteSeconds;
    parameters.sessionAbsoluteSeconds = 30;
    let token: string;
    try {
      token = await signIn(member);
    } finally {
      parameters.sessionAbsoluteSeconds = original;
    }

    // The refresh a request performs must not push idle past absolute — the
    // row's own CHECK refuses that, so without LEAST an ordinary request near
    // the end of a session fails with a constraint violation.
    const session = await call('GET', '/auth/session', { token });
    expect(session.status, session.text).toBe(200);

    const rows = await env.admin.query<{ ok: boolean }>(
      `SELECT (idle_expires_at <= absolute_expires_at) AS ok FROM platform.server_session
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [member.accountId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.ok)).toBe(true);
  }, 40000);
});

// ---------------------------------------------------------------------- D
describe('D — invitation and role lifecycle', () => {
  it('lets an existing account accept a second invitation with its bearer', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'existing@repair.test', [
      'RECEPTION',
    ]);
    await invite(await signIn(adminB), hotelB, member.email, ['RECEPTION']);
    const delivered = env.notifications.lastInvitationFor(member.email);

    const accepted = await call('POST', `/hotels/${hotelB}/staff/invitations/accept`, {
      token: await signIn(member),
      key: idem('existing-accept'),
      body: { token: delivered?.token },
    });
    expectOk(accepted);
    expect(accepted.body['accountId']).toBe(member.accountId);
  }, 40000);

  it('lets a hotel-scoped Manager Plus invite the first Restaurant Manager', async () => {
    const plus = await onboard(await signIn(adminA), hotelA, 'plus@repair.test', ['MANAGER_PLUS']);
    const restaurantId = '77777777-7777-4777-8777-777777777777';
    env.restaurants.register(hotelA, restaurantId);
    const created = await call('POST', `/hotels/${hotelA}/staff/invitations`, {
      token: await signIn(plus),
      key: idem('rm-invite'),
      body: { email: 'rm@repair.test', roles: ['RESTAURANT_MANAGER'], restaurantId },
    });
    expectOk(created);
  }, 40000);

  it('refuses a Restaurant Manager role on a hotel-wide membership at the database', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'wrongscope@repair.test', [
      'RECEPTION',
    ]);
    const refused = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${member.membershipId}/roles`,
      {
        token: await signIn(adminA),
        key: idem('wrongscope'),
        body: { role: 'RESTAURANT_MANAGER' },
      },
    );
    expect([200, 201]).not.toContain(refused.status);

    const direct = await env.admin
      .query(
        `INSERT INTO platform.membership_role_grant (hotel_id, membership_id, role)
         VALUES ($1, $2, 'RESTAURANT_MANAGER')`,
        [hotelA, member.membershipId],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as Error).message,
      );
    expect(direct).not.toBe('accepted');
  }, 40000);

  it('keeps the Primary Hotel Admin’s HOTEL_ADMIN grant against the API and raw SQL', async () => {
    const removed = await call(
      'DELETE',
      `/hotels/${hotelA}/staff/memberships/${adminA.membershipId}/roles/HOTEL_ADMIN`,
      { token: await signIn(adminA), key: idem('primary-role') },
    );
    expect([200, 201]).not.toContain(removed.status);

    const broad = await env.admin
      .query(
        `UPDATE platform.membership_role_grant
            SET revoked_at = now(), revoked_by_account_id = $1, revoked_reason = 'broad'
          WHERE hotel_id = $2 AND revoked_at IS NULL`,
        [adminA.accountId, hotelA],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as Error).message,
      );
    expect(broad).not.toBe('accepted');

    const live = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.membership_role_grant
        WHERE hotel_id = $1 AND membership_id = $2 AND role = 'HOTEL_ADMIN' AND revoked_at IS NULL`,
      [hotelA, adminA.membershipId],
    );
    expect(live.rows[0]?.count).toBe('1');
  }, 40000);
});

// ---------------------------------------------------------------------- E
describe('E — secrets never travel in a URL, a key or an oracle', () => {
  it('exposes no invitation inspection that carries the token in a query string', async () => {
    const { membershipId } = await invite(await signIn(adminA), hotelA, 'inspect@repair.test', [
      'RECEPTION',
    ]);
    expect(membershipId).toBeDefined();
    const delivered = env.notifications.lastInvitationFor('inspect@repair.test');
    const viaUrl = await call(
      'GET',
      `/hotels/${hotelA}/staff/invitations/inspect?token=${encodeURIComponent(
        delivered?.token ?? '',
      )}`,
    );
    expect([404, 405]).toContain(viaUrl.status);

    const viaBody = await call('POST', `/hotels/${hotelA}/staff/invitations/inspect`, {
      body: { token: delivered?.token },
    });
    expect(viaBody.status, viaBody.text).toBe(200);
    expect(viaBody.body['emailNormalized']).toBe('inspect@repair.test');
  }, 40000);

  it('treats two different invitation tokens under one key as key reuse', async () => {
    const first = await invite(await signIn(adminA), hotelA, 'keyreuse-a@repair.test', [
      'RECEPTION',
    ]);
    const second = await invite(await signIn(adminA), hotelA, 'keyreuse-b@repair.test', [
      'RECEPTION',
    ]);
    expect(first.membershipId).not.toBe(second.membershipId);
    const tokenA = env.notifications.lastInvitationFor('keyreuse-a@repair.test')?.token;
    const tokenB = env.notifications.lastInvitationFor('keyreuse-b@repair.test')?.token;

    const shared = idem('key-reuse');
    const accepted = await call('POST', `/hotels/${hotelA}/staff/invitations/accept`, {
      key: shared,
      body: { token: tokenA, password: syntheticPassword('keyreuse-a') },
    });
    expectOk(accepted);

    const replayed = await call('POST', `/hotels/${hotelA}/staff/invitations/accept`, {
      key: shared,
      body: { token: tokenB, password: syntheticPassword('keyreuse-b') },
    });
    expect(replayed.status).toBe(409);
    expect((replayed.body['error'] as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  }, 40000);

  it('answers a reset request identically whatever the address is', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'oracle@repair.test', ['MANAGER']);
    const disabled = await onboard(await signIn(adminA), hotelA, 'oracle-off@repair.test', [
      'MANAGER',
    ]);
    await env.admin.query(
      `UPDATE platform.user_account SET state = 'DISABLED' WHERE account_id = $1`,
      [disabled.accountId],
    );

    const seen: { status: number; text: string }[] = [];
    for (const email of [member.email, disabled.email, 'nobody@repair.test']) {
      const response = await call('POST', '/auth/password-reset/request', { body: { email } });
      seen.push({ status: response.status, text: response.text });
    }
    // A second request for the registered address, inside the resend interval.
    const throttled = await call('POST', '/auth/password-reset/request', {
      body: { email: member.email },
    });
    seen.push({ status: throttled.status, text: throttled.text });

    // Everything queued so far settles, and nothing the caller saw depended on
    // how it settled.
    await appStaff.drainPasswordResetIntake(32);
    expect(env.notifications.lastResetForEmail(disabled.email)).toBeUndefined();
    expect(env.notifications.lastResetForEmail('nobody@repair.test')).toBeUndefined();

    // And once more with the provider refusing — the failure happens during the
    // drain, long after the caller was answered, and is invisible to them.
    const unreachable = await onboard(await signIn(adminA), hotelA, 'oracle-3@repair.test', [
      'MANAGER',
    ]);
    const unavailable = await call('POST', '/auth/password-reset/request', {
      body: { email: unreachable.email },
    });
    seen.push({ status: unavailable.status, text: unavailable.text });
    env.notifications.failNext();
    await appStaff.drainPasswordResetIntake(32);
    expect(env.notifications.lastResetForEmail(unreachable.email)).toBeUndefined();

    expect(new Set(seen.map((entry) => entry.status))).toEqual(new Set([202]));
    expect(new Set(seen.map((entry) => entry.text))).toEqual(new Set([seen[0]?.text]));
  }, 60000);
});

// ---------------------------------------------------------------------- F
describe('F — the handoff queue hands over work, not authority', () => {
  async function openItem(
    subjectRef: string,
    kind: 'reception_shift' | 'cleaner_task',
  ): Promise<{ itemId: string; suspended: SeededMembership }> {
    const role = kind === 'reception_shift' ? 'RECEPTION' : 'CLEANER';
    const suspended = await onboard(await signIn(adminA), hotelA, `${idem('hand')}@repair.test`, [
      role,
    ]);
    env.openWork.set(hotelA, suspended.membershipId, [{ kind, ref: subjectRef }]);
    const moved = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${suspended.membershipId}/state`,
      {
        token: await signIn(adminA),
        key: idem('open-item'),
        body: { state: 'SUSPENDED', reason: 'handoff test' },
      },
    );
    expectOk(moved);
    const items = (moved.body['handoffItems'] as string[] | undefined) ?? [];
    expect(items.length).toBe(1);
    return { itemId: items[0] as string, suspended };
  }

  it('shows a Reception member only the items assigned to them', async () => {
    const { itemId } = await openItem('11111111-1111-4111-8111-000000000001', 'reception_shift');
    const bystander = await onboard(await signIn(adminA), hotelA, 'bystander@repair.test', [
      'RECEPTION',
    ]);
    const listed = await call('GET', `/hotels/${hotelA}/staff/handoff/items`, {
      token: await signIn(bystander),
    });
    expect(listed.status, listed.text).toBe(200);
    const ids = (listed.body['items'] as { itemId: string }[]).map((item) => item.itemId);
    expect(ids).not.toContain(itemId);
  }, 60000);

  it('refuses a second Manager the assignment of an item another claimed', async () => {
    const { itemId } = await openItem('11111111-1111-4111-8111-000000000002', 'reception_shift');
    const one = await onboard(await signIn(adminA), hotelA, 'mgr-one@repair.test', ['MANAGER']);
    const two = await onboard(await signIn(adminA), hotelA, 'mgr-two@repair.test', ['MANAGER']);
    const replacement = await onboard(await signIn(adminA), hotelA, 'replacement@repair.test', [
      'RECEPTION',
    ]);

    const claimed = await call('POST', `/hotels/${hotelA}/staff/handoff/items/${itemId}/claim`, {
      token: await signIn(one),
      key: idem('claim-one'),
    });
    expectOk(claimed);

    const stolen = await call('POST', `/hotels/${hotelA}/staff/handoff/items/${itemId}/assign`, {
      token: await signIn(two),
      key: idem('assign-two'),
      body: { replacementMembershipId: replacement.membershipId },
    });
    expect(stolen.status).toBe(409);

    const assigned = await call('POST', `/hotels/${hotelA}/staff/handoff/items/${itemId}/assign`, {
      token: await signIn(one),
      key: idem('assign-one'),
      body: { replacementMembershipId: replacement.membershipId },
    });
    expectOk(assigned);

    // The movement history names the account that acted, not the person the
    // work was taken from.
    const events = await env.admin.query<{ actor_membership_id: string; kind: string }>(
      `SELECT kind, actor_membership_id FROM platform.work_handoff_event
        WHERE hotel_id = $1 AND item_id = $2 ORDER BY seq`,
      [hotelA, itemId],
    );
    const assignedEvent = events.rows.find((row) => row.kind === 'assigned');
    expect(assignedEvent?.actor_membership_id).toBe(one.membershipId);
  }, 90000);

  it('ignores open work a caller supplies in the request body', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'fabricated@repair.test', [
      'RECEPTION',
    ]);
    const moved = await call(
      'POST',
      `/hotels/${hotelA}/staff/memberships/${member.membershipId}/state`,
      {
        token: await signIn(adminA),
        key: idem('fabricated'),
        body: {
          state: 'SUSPENDED',
          reason: 'fabricated work',
          openWork: [{ kind: 'cleaner_task', ref: '11111111-1111-4111-8111-000000000003' }],
        },
      },
    );
    expectOk(moved);
    expect(moved.body['handoffItems']).toEqual([]);
  }, 60000);
});

// ---------------------------------------------------------------------- A/C
describe('the database refuses what the matrix and the lifecycle forbid', () => {
  it('refuses an unknown, denied, wrong-realm or non-grantable permission grant', async () => {
    const operation = await env.admin.query<{ account_id: string }>(
      `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
       VALUES ('operation', 'OPERATION_ADMIN', 'ops@repair.test', now())
       RETURNING account_id`,
    );
    const opsAccount = operation.rows[0]?.account_id as string;

    const attempt = async (permission: string, realm: string, role: string): Promise<string> =>
      env.admin
        .query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1, $2, $3, $4, $1)`,
          [opsAccount, realm, role, permission],
        )
        .then(
          () => 'accepted',
          (error: unknown) => (error as { code?: string }).code ?? 'error',
        );

    // A row the document refuses to both columns.
    expect(await attempt('CREDENTIAL_MATERIAL_VIEW', 'operation', 'OPERATION_ADMIN')).not.toBe(
      'accepted',
    );
    // A Platform-only permission for an Operation Admin.
    expect(await attempt('SUBSCRIPTION_SUSPEND', 'operation', 'OPERATION_ADMIN')).not.toBe(
      'accepted',
    );
    // A Police permission in the Operation realm.
    expect(await attempt('WANTED_CASE_EXPORT', 'operation', 'OPERATION_ADMIN')).not.toBe(
      'accepted',
    );
    // A realm and role the account does not hold.
    expect(await attempt('WANTED_CASE_EXPORT', 'police', 'POLICE_ADMIN')).not.toBe('accepted');
    // A dotted action id rather than the canonical permission name.
    expect(await attempt('operation.review_moderate', 'operation', 'OPERATION_ADMIN')).not.toBe(
      'accepted',
    );
    // And the one that is genuinely grantable.
    expect(await attempt('REVIEW_MODERATE', 'operation', 'OPERATION_ADMIN')).toBe('accepted');
  }, 40000);

  it('refuses to reopen a revoked session, scope grant or permission grant', async () => {
    const member = await onboard(await signIn(adminA), hotelA, 'terminal@repair.test', ['MANAGER']);
    const token = await signIn(member);
    expectOk(await call('POST', '/auth/sign-out-all', { token }));

    const revoked = await env.admin.query<{ sessions: string; scopes: string }>(
      `SELECT (SELECT count(*) FROM platform.server_session
                WHERE account_id = $1 AND revoked_at IS NOT NULL)::text AS sessions,
              (SELECT count(*) FROM platform.session_scope_grant
                WHERE account_id = $1 AND revoked_at IS NOT NULL)::text AS scopes`,
      [member.accountId],
    );
    expect(Number(revoked.rows[0]?.sessions ?? '0')).toBeGreaterThan(0);
    expect(Number(revoked.rows[0]?.scopes ?? '0')).toBeGreaterThan(0);

    const refused = async (
      scope: { hotelId: string } | undefined,
      sql: string,
      values: readonly unknown[],
    ): Promise<string> => {
      const client = await env.api.connect();
      try {
        await client.query('BEGIN');
        if (scope !== undefined) {
          await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', scope.hotelId]);
          await client.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
        }
        await client.query(sql, values as never[]);
        return 'accepted';
      } catch (error) {
        return (error as { code?: string }).code ?? 'error';
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };

    // The API role holds UPDATE on all three because it must be able to revoke.
    // What it must never be able to do is un-revoke.
    expect(
      await refused(
        undefined,
        `UPDATE platform.server_session SET revoked_at = NULL, revoked_reason = NULL
          WHERE account_id = $1 AND revoked_at IS NOT NULL`,
        [member.accountId],
      ),
    ).not.toBe('accepted');

    expect(
      await refused(
        { hotelId: hotelA },
        `UPDATE platform.session_scope_grant SET revoked_at = NULL, revoked_reason = NULL
          WHERE hotel_id = $1 AND revoked_at IS NOT NULL`,
        [hotelA],
      ),
    ).not.toBe('accepted');

    // …nor rewrite whose authority a revoked row recorded.
    expect(
      await refused(
        undefined,
        `UPDATE platform.server_session SET account_epoch = account_epoch + 1
          WHERE account_id = $1`,
        [member.accountId],
      ),
    ).not.toBe('accepted');

    const grant = await env.admin.query<{ permission_grant_id: string }>(
      `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
       VALUES ('operation', 'PLATFORM_SUPER_ADMIN', 'terminal-ops@repair.test', now())
       RETURNING account_id`,
    );
    const opsAccount = grant.rows[0] as unknown as { account_id: string };
    const granted = await env.admin.query<{ permission_grant_id: string }>(
      `INSERT INTO platform.account_permission_grant
         (account_id, realm, realm_role, permission, granted_by_account_id,
          revoked_at, revoked_by_account_id, revoked_reason)
       VALUES ($1, 'operation', 'PLATFORM_SUPER_ADMIN', 'SUBSCRIPTION_SUSPEND', $1,
               now(), $1, 'withdrawn')
       RETURNING permission_grant_id`,
      [opsAccount.account_id],
    );
    expect(
      await refused(
        undefined,
        `UPDATE platform.account_permission_grant
            SET revoked_at = NULL, revoked_by_account_id = NULL, revoked_reason = NULL
          WHERE permission_grant_id = $1`,
        [granted.rows[0]?.permission_grant_id],
      ),
    ).not.toBe('accepted');
  }, 60000);
});

// ---------------------------------------------------------------------- A
describe('A — the direct realms, end to end', () => {
  /** An Operation account with its matrix column and one named permission. */
  async function operationAccount(
    email: string,
    role: 'OPERATION_ADMIN' | 'PLATFORM_SUPER_ADMIN',
    permissions: readonly string[],
  ): Promise<string> {
    const created = await env.admin.query<{ account_id: string }>(
      `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
       VALUES ('operation', $1, $2, now())
       RETURNING account_id`,
      [role, email],
    );
    const accountId = created.rows[0]?.account_id as string;
    for (const permission of permissions) {
      await env.admin.query(
        `INSERT INTO platform.account_permission_grant
           (account_id, realm, realm_role, permission, granted_by_account_id)
         VALUES ($1, 'operation', $2, $3, $1)`,
        [accountId, role, permission],
      );
    }
    return accountId;
  }

  async function decide(
    accountId: string,
    permission: string,
    stepUpAt: Date | undefined,
  ): Promise<{ allowed: boolean; code?: string }> {
    return withTenantTransaction(
      env.api,
      { hotelId: PLATFORM_SCOPE, realm: 'operation', actorRef: accountId, correlationId: newId() },
      async (uow) => {
        const principal = await resolvePrincipal(uow, accountId, stepUpAt);
        if (principal === undefined) return { allowed: false, code: 'NO_PRINCIPAL' };
        const decision = authorize({
          endpointRealm: 'operation',
          permission,
          principal,
          target: {},
          now: uow.serverNow,
        });
        return decision.allowed ? { allowed: true } : { allowed: false, code: decision.code };
      },
    );
  }

  it('resolves the realm role and the canonical permission from server state', async () => {
    const admin = await operationAccount('ops-admin@repair.test', 'OPERATION_ADMIN', [
      'REVIEW_MODERATE',
    ]);
    // A moment ago, not "now": the pipeline compares against the database clock,
    // and a step-up stamped in the future is evidence that has not happened yet.
    const fresh = new Date(Date.now() - 5_000);

    // Held, and grantable to this column.
    expect(await decide(admin, 'operation.review_moderate', fresh)).toEqual({ allowed: true });
    // A Platform-only row, with the permission not held.
    expect(await decide(admin, 'operation.subscription_suspend', fresh)).toMatchObject({
      allowed: false,
    });
    // A row the document refuses to both columns.
    expect(await decide(admin, 'operation.credential_material_view', fresh)).toMatchObject({
      allowed: false,
    });
  }, 40000);

  it('keeps the authenticated session’s step-up rather than discarding it', async () => {
    const admin = await operationAccount('ops-stepup@repair.test', 'PLATFORM_SUPER_ADMIN', [
      'SUBSCRIPTION_SUSPEND',
    ]);
    const stale = new Date(Date.now() - 60 * 60 * 1000);

    // Every Operation row is step-up gated (doc 05 §5). A commit-time
    // re-resolution that dropped the session's recency would refuse all three
    // of these, and no fresh challenge could ever satisfy it.
    expect(
      await decide(admin, 'operation.subscription_suspend', new Date(Date.now() - 5_000)),
    ).toEqual({
      allowed: true,
    });
    expect(await decide(admin, 'operation.subscription_suspend', stale)).toMatchObject({
      allowed: false,
      code: 'STEP_UP_REQUIRED',
    });
    expect(await decide(admin, 'operation.subscription_suspend', undefined)).toMatchObject({
      allowed: false,
      code: 'STEP_UP_REQUIRED',
    });
  }, 40000);
});

// ------------------------------------------------------ the guards are load-bearing
describe('the repairs are load-bearing, not decorative', () => {
  it('widens a hotel transaction the moment the account policy loses its sentinel clause', async () => {
    const shared = await onboard(await signIn(adminA), hotelA, 'loadbearing@repair.test', [
      'RECEPTION',
    ]);
    await env.seedMembership({ hotelId: hotelB, email: shared.email, roles: ['RECEPTION'] });

    const hotelsVisible = async (): Promise<string[]> => {
      const seen: string[] = [];
      await asRuntime<{ hotel_id: string }>(
        { hotelId: hotelA, accountId: shared.accountId },
        async (query) => {
          const rows = await query('SELECT DISTINCT hotel_id FROM platform.staff_membership');
          seen.push(...rows.rows.map((row) => row.hotel_id));
        },
      );
      return seen.sort();
    };

    expect(await hotelsVisible()).toEqual([hotelA]);

    // Drop the sentinel guard, exactly as the accepted commit had it, and the
    // permissive-policy OR immediately returns the account's rows in the other
    // hotel to a transaction scoped to this one.
    await env.admin.query(`DROP POLICY own_membership_read ON platform.staff_membership`);
    await env.admin.query(
      `CREATE POLICY own_membership_read ON platform.staff_membership
         FOR SELECT USING (account_id = platform.current_account_id())`,
    );
    try {
      expect(await hotelsVisible()).toEqual([hotelA, hotelB].sort());
    } finally {
      await env.admin.query(`DROP POLICY own_membership_read ON platform.staff_membership`);
      await env.admin.query(
        `CREATE POLICY own_membership_read ON platform.staff_membership
           FOR SELECT USING (
             platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid
             AND account_id = platform.current_account_id()
           )`,
      );
    }
    expect(await hotelsVisible()).toEqual([hotelA]);
  }, 60000);

  it('keeps the invitation token out of every durable payload', async () => {
    const email = 'leak@repair.test';
    await invite(await signIn(adminA), hotelA, email, ['RECEPTION']);
    const token = env.notifications.lastInvitationFor(email)?.token as string;
    expect(token.length).toBeGreaterThan(20);

    const accepted = await call('POST', `/hotels/${hotelA}/staff/invitations/accept`, {
      key: idem('leak-accept'),
      body: { token, password: syntheticPassword('leak') },
    });
    expectOk(accepted);

    for (const [table, column] of [
      ['audit.platform_event', 'payload::text'],
      ['platform.outbox_event', 'payload::text'],
      ['platform.idempotency_key', 'request_hash'],
      ['platform.idempotency_key', "coalesce(response_body::text, '')"],
      ['platform.staff_invitation', 'token_hash'],
      ['platform.server_session', 'token_hash'],
    ] as const) {
      const hits = await env.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE position($1 in ${column}) > 0`,
        [token],
      );
      expect({ table, count: hits.rows[0]?.count }).toEqual({ table, count: '0' });
    }
  }, 60000);
});
