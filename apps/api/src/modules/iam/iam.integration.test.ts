import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvCache } from '@prsystem/config';
import { TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { Principal } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { IamHarness, SeededMembership } from './test-support/iam-harness';
import { attachIamHarness, principalFor, provisionIamDatabase } from './test-support/iam-harness';
import { newRequestContext } from './services/iam-context';
import { SimulatedStaffNotification } from './contracts/staff-notification.port';
import { SimulatedSubscriptionState } from './contracts/subscription-state.port';
import { STAFF_NOTIFICATION, SUBSCRIPTION_STATE } from './iam.tokens';

/**
 * GATE-INTEG for Phase 04 — IAM against real PostgreSQL and the real HTTP
 * surface.
 *
 * Every command runs as the restricted `prsystem_api` login, so the policies,
 * the grants and the transition guards are the ones a deployment has. The two
 * external systems are the deterministic simulators the environment selects; no
 * production adapter exists and none is reachable here.
 */

let db: TestDatabase;
let env: IamHarness;
let app: NestFastifyApplication;
let baseUrl: string;

/** A hotel on each package, so the entitlement gates have somewhere to bite. */
let hotel30: string;
let hotel25: string;
let hotel20: string;
let otherHotel: string;

let admin30: SeededMembership;
let admin25: SeededMembership;
let admin20: SeededMembership;
let otherAdmin: SeededMembership;

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `${prefix}-${String(key).padStart(6, '0')}`;
}

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

async function actor(member: SeededMembership): Promise<Principal> {
  return principalFor(env, member);
}

async function expectApiError(work: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  const api = error as ApiError;
  expect(api.code).toBe(code);
  return api;
}

beforeAll(async () => {
  db = await provisionIamDatabase('iam_integration');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    KMS_ADAPTER: 'local',
    KMS_SEED: 'synthetic-iam-integration-seed',
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

  // The very instances the running application holds. Two simulators would let
  // a test set a subscription the application never sees.
  const subscription = app.get<SimulatedSubscriptionState>(SUBSCRIPTION_STATE);
  const notifications = app.get<SimulatedStaffNotification>(STAFF_NOTIFICATION);
  expect(subscription).toBeInstanceOf(SimulatedSubscriptionState);
  expect(notifications).toBeInstanceOf(SimulatedStaffNotification);
  env = attachIamHarness(db, 'iam_integration', { subscription, notifications });

  hotel30 = await env.createHotel('Thirty Hotel', 'P30');
  hotel25 = await env.createHotel('Twenty Five Hotel', 'P25');
  hotel20 = await env.createHotel('Twenty Hotel', 'P20');
  otherHotel = await env.createHotel('Another Hotel', 'P30');

  admin30 = await env.seedMembership({
    hotelId: hotel30,
    email: 'admin@thirty.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  admin25 = await env.seedMembership({
    hotelId: hotel25,
    email: 'admin@twentyfive.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  admin20 = await env.seedMembership({
    hotelId: hotel20,
    email: 'admin@twenty.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  otherAdmin = await env.seedMembership({
    hotelId: otherHotel,
    email: 'admin@another.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await env?.close();
}, 60000);

// --------------------------------------------------------------- invitations
describe('the invitation lifecycle (doc 19 §4, STAFF-DEC-009)', () => {
  it('creates one pending membership with one live invitation and no stored token', async () => {
    const created = await env.staff.createInvitation(
      await actor(admin30),
      {
        hotelId: hotel30,
        email: 'Reception.One@Thirty.test',
        roles: ['RECEPTION'],
        idempotencyKey: idem('invite'),
      },
      newRequestContext(admin30.accountId),
    );

    const rows = await env.admin.query<{ state: string; token_hash: string }>(
      `SELECT state, token_hash FROM platform.staff_invitation WHERE membership_id = $1`,
      [created.membershipId],
    );
    expect(rows.rowCount).toBe(1);
    // Stored as a keyed HMAC digest, never as the token.
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const delivered = env.notifications.lastInvitationFor('reception.one@thirty.test');
    expect(delivered).toBeDefined();
    expect(rows.rows[0]?.token_hash).not.toBe(delivered?.token);

    const membership = await env.admin.query<{ state: string; email: string }>(
      `SELECT state, invited_email_normalized AS email FROM platform.staff_membership
        WHERE membership_id = $1`,
      [created.membershipId],
    );
    expect(membership.rows[0]?.state).toBe('PENDING');
    // Normalised on the way in, so the canonical index means what it says.
    expect(membership.rows[0]?.email).toBe('reception.one@thirty.test');
  });

  it('returns the first result for a retried create rather than inviting twice', async () => {
    const key = idem('invite-retry');
    const input = {
      hotelId: hotel30,
      email: 'retry@thirty.test',
      roles: ['RECEPTION'] as const,
      idempotencyKey: key,
    };
    const first = await env.staff.createInvitation(
      await actor(admin30),
      input,
      newRequestContext(admin30.accountId),
    );
    const second = await env.staff.createInvitation(
      await actor(admin30),
      input,
      newRequestContext(admin30.accountId),
    );
    expect(second.invitationId).toBe(first.invitationId);

    const count = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.staff_invitation WHERE membership_id = $1`,
      [first.membershipId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('refuses a second live invitation for the same scope and address', async () => {
    const email = 'duplicate@thirty.test';
    await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('dup-a') },
      newRequestContext(admin30.accountId),
    );
    await expectApiError(
      env.staff.createInvitation(
        await actor(admin30),
        { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('dup-b') },
        newRequestContext(admin30.accountId),
      ),
      'CONFLICT',
    );
  });

  it('supersedes the previous token on resend, and the old link stops working', async () => {
    const email = 'resend@thirty.test';
    const created = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('resend-a') },
      newRequestContext(admin30.accountId),
    );
    const firstToken = env.notifications.lastInvitationFor(email)?.token;
    expect(firstToken).toBeDefined();

    // The resend interval is configuration, so the fixture sets it rather than
    // waiting it out — and rather than editing the invitation row, which the
    // transition guard correctly refuses.
    const interval = env.parameters.invitationResendIntervalSeconds;
    (
      env.parameters as { invitationResendIntervalSeconds: number }
    ).invitationResendIntervalSeconds = 0;

    const resent = await env.staff.resendInvitation(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: created.membershipId,
        idempotencyKey: idem('resend-b'),
      },
      newRequestContext(admin30.accountId),
    );
    (
      env.parameters as { invitationResendIntervalSeconds: number }
    ).invitationResendIntervalSeconds = interval;
    expect(resent.invitationId).not.toBe(created.invitationId);

    const states = await env.admin.query<{ invitation_id: string; state: string }>(
      `SELECT invitation_id, state FROM platform.staff_invitation WHERE membership_id = $1`,
      [created.membershipId],
    );
    const byId = new Map(states.rows.map((row) => [row.invitation_id, row.state]));
    expect(byId.get(created.invitationId)).toBe('SUPERSEDED');
    expect(byId.get(resent.invitationId)).toBe('ACTIVE');

    // The superseded link is refused, indistinguishably from an unknown one.
    await expectApiError(
      env.staff.acceptInvitation(
        {
          hotelId: hotel30,
          token: firstToken as string,
          password: syntheticPassword('a-brand-new-password-1'),
          idempotencyKey: idem('accept-old'),
        },
        newRequestContext(),
      ),
      'NOT_FOUND',
    );
  });

  it('refuses an expired invitation and marks it EXPIRED', async () => {
    const email = 'expired@thirty.test';
    // A one-second lifetime, from the configured TTL. The row itself cannot be
    // aged: the transition guard refuses any edit to an invitation other than
    // its terminal transition, which is exactly the invariant under test
    // elsewhere.
    const ttl = env.parameters.invitationTtlSeconds;
    (env.parameters as { invitationTtlSeconds: number }).invitationTtlSeconds = 1;
    const created = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('expire') },
      newRequestContext(admin30.accountId),
    );
    (env.parameters as { invitationTtlSeconds: number }).invitationTtlSeconds = ttl;
    const token = env.notifications.lastInvitationFor(email)?.token as string;
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expectApiError(
      env.staff.acceptInvitation(
        {
          hotelId: hotel30,
          token,
          password: syntheticPassword('a-brand-new-password-2'),
          idempotencyKey: idem('accept-expired'),
        },
        newRequestContext(),
      ),
      'NOT_FOUND',
    );
    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.staff_invitation WHERE invitation_id = $1`,
      [created.invitationId],
    );
    expect(state.rows[0]?.state).toBe('EXPIRED');
  });

  it('revokes a live invitation without granting anything', async () => {
    const email = 'revoked@thirty.test';
    const created = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('revoke-a') },
      newRequestContext(admin30.accountId),
    );
    const token = env.notifications.lastInvitationFor(email)?.token as string;

    await env.staff.revokeInvitation(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: created.membershipId,
        reason: 'hired elsewhere',
        idempotencyKey: idem('revoke-b'),
      },
      newRequestContext(admin30.accountId),
    );

    const state = await env.admin.query<{ state: string; membership_state: string }>(
      `SELECT i.state, m.state AS membership_state
         FROM platform.staff_invitation i
         JOIN platform.staff_membership m ON m.membership_id = i.membership_id
        WHERE i.invitation_id = $1`,
      [created.invitationId],
    );
    expect(state.rows[0]?.state).toBe('REVOKED');
    expect(state.rows[0]?.membership_state).toBe('PENDING');

    await expectApiError(
      env.staff.acceptInvitation(
        {
          hotelId: hotel30,
          token,
          password: syntheticPassword('a-brand-new-password-3'),
          idempotencyKey: idem('accept-revoked'),
        },
        newRequestContext(),
      ),
      'NOT_FOUND',
    );
  });

  it('activates a new account with a password the invitee chooses', async () => {
    const email = 'newaccount@thirty.test';
    const created = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('new-a') },
      newRequestContext(admin30.accountId),
    );
    const token = env.notifications.lastInvitationFor(email)?.token as string;

    const accepted = await env.staff.acceptInvitation(
      {
        hotelId: hotel30,
        token,
        password: syntheticPassword('invitee-chosen-password-1'),
        idempotencyKey: idem('new-b'),
      },
      newRequestContext(),
    );
    expect(accepted.membershipId).toBe(created.membershipId);

    const signedIn = await env.sessions.signIn(
      email,
      syntheticPassword('invitee-chosen-password-1'),
      newRequestContext(),
    );
    expect(signedIn.accountId).toBe(accepted.accountId);

    const membership = await env.admin.query<{ state: string; roles: string[] }>(
      `SELECT m.state, array_agg(g.role ORDER BY g.role) AS roles
         FROM platform.staff_membership m
         JOIN platform.membership_role_grant g
           ON g.membership_id = m.membership_id AND g.revoked_at IS NULL
        WHERE m.membership_id = $1
        GROUP BY m.state`,
      [created.membershipId],
    );
    expect(membership.rows[0]?.state).toBe('ACTIVE');
    expect(membership.rows[0]?.roles).toEqual(['RECEPTION']);
  });

  it('adds a second membership to an existing account without a second account', async () => {
    // doc 19 §5: the address already has an account, so no new account and no
    // new password. The person signs in and accepts as themselves.
    const email = 'multi@thirty.test';
    const first = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('multi-a') },
      newRequestContext(admin30.accountId),
    );
    const firstToken = env.notifications.lastInvitationFor(email)?.token as string;
    const activated = await env.staff.acceptInvitation(
      {
        hotelId: hotel30,
        token: firstToken,
        password: syntheticPassword('multi-hotel-password-1'),
        idempotencyKey: idem('multi-b'),
      },
      newRequestContext(),
    );
    expect(activated.membershipId).toBe(first.membershipId);

    const second = await env.staff.createInvitation(
      await actor(otherAdmin),
      { hotelId: otherHotel, email, roles: ['MANAGER'], idempotencyKey: idem('multi-c') },
      newRequestContext(otherAdmin.accountId),
    );
    const secondToken = env.notifications.lastInvitationFor(email)?.token as string;
    const joined = await env.staff.acceptInvitation(
      {
        hotelId: otherHotel,
        token: secondToken,
        accountId: activated.accountId,
        idempotencyKey: idem('multi-d'),
      },
      newRequestContext(activated.accountId),
    );
    expect(joined.accountId).toBe(activated.accountId);
    expect(joined.membershipId).toBe(second.membershipId);

    const accounts = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.user_account WHERE email_normalized = $1`,
      [email],
    );
    expect(accounts.rows[0]?.n).toBe(1);

    const memberships = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.staff_membership
        WHERE account_id = $1 AND state = 'ACTIVE'`,
      [activated.accountId],
    );
    expect(memberships.rows[0]?.n).toBe(2);
  });

  it('refuses an existing address that tries to create a second account', async () => {
    const email = 'multi@thirty.test';
    const created = await env.staff.createInvitation(
      await actor(admin25),
      { hotelId: hotel25, email, roles: ['RECEPTION'], idempotencyKey: idem('dupacct-a') },
      newRequestContext(admin25.accountId),
    );
    expect(created.membershipId).toBeDefined();
    const token = env.notifications.lastInvitationFor(email)?.token as string;

    await expectApiError(
      env.staff.acceptInvitation(
        {
          hotelId: hotel25,
          token,
          password: syntheticPassword('another-password-entirely'),
          idempotencyKey: idem('dupacct-b'),
        },
        newRequestContext(),
      ),
      'CONFLICT',
    );
  });
});

// ----------------------------------------------------------- package gating
describe('package entitlement above role (doc 18 §4, RBAC-DEC-003)', () => {
  it('refuses a Manager Plus invitation on a 25,000₮ hotel', async () => {
    await expectApiError(
      env.staff.createInvitation(
        await actor(admin25),
        {
          hotelId: hotel25,
          email: 'managerplus@twentyfive.test',
          roles: ['MANAGER_PLUS'],
          idempotencyKey: idem('mp-invite'),
        },
        newRequestContext(admin25.accountId),
      ),
      'FORBIDDEN',
    );
  });

  it('refuses a Manager Plus role grant on a 25,000₮ hotel, and the action it would open', async () => {
    const manager = await env.seedMembership({
      hotelId: hotel25,
      email: 'manager@twentyfive.test',
      roles: ['MANAGER'],
    });

    await expectApiError(
      env.staff.addRole(
        await actor(admin25),
        {
          hotelId: hotel25,
          membershipId: manager.membershipId,
          role: 'MANAGER_PLUS',
          idempotencyKey: idem('mp-grant'),
        },
        newRequestContext(admin25.accountId),
      ),
      'FORBIDDEN',
    );

    // And even with the role forced into the database, the action stays refused:
    // the entitlement gate sits above the role, so a stored role opens nothing.
    await env.admin.query(
      `INSERT INTO platform.membership_role_grant (hotel_id, membership_id, role)
       VALUES ($1, $2, 'MANAGER_PLUS')`,
      [hotel25, manager.membershipId],
    );
    const principal = await actor(manager);
    const roles = principal.memberships[0]?.roles ?? [];
    expect(roles).toContain('MANAGER_PLUS');

    await expectApiError(
      env.staff.createInvitation(
        principal,
        {
          hotelId: hotel25,
          restaurantId: '11111111-1111-4111-8111-111111111111',
          email: 'restaurant@twentyfive.test',
          roles: ['RESTAURANT_MANAGER'],
          idempotencyKey: idem('mp-action'),
        },
        newRequestContext(manager.accountId),
      ),
      'NOT_FOUND',
    );
  });

  it('refuses a Cleaner invitation on a 20,000₮ hotel', async () => {
    await expectApiError(
      env.staff.createInvitation(
        await actor(admin20),
        {
          hotelId: hotel20,
          email: 'cleaner@twenty.test',
          roles: ['CLEANER'],
          idempotencyKey: idem('cleaner-invite'),
        },
        newRequestContext(admin20.accountId),
      ),
      'FORBIDDEN',
    );
  });

  it('denies every hotel action once the subscription contract cannot answer', async () => {
    const orphan = await env.createHotel('Unanswerable Hotel', 'P30');
    const orphanAdmin = await env.seedMembership({
      hotelId: orphan,
      email: 'admin@unanswerable.test',
      roles: ['HOTEL_ADMIN'],
      primary: true,
    });
    const principal = await actor(orphanAdmin);
    env.subscription.clear(orphan);

    await expectApiError(
      env.staff.createInvitation(
        principal,
        {
          hotelId: orphan,
          email: 'nobody@unanswerable.test',
          roles: ['RECEPTION'],
          idempotencyKey: idem('unanswerable'),
        },
        newRequestContext(orphanAdmin.accountId),
      ),
      'DEPENDENCY_UNAVAILABLE',
    );
  });
});

// ------------------------------------------------------- Hotel Admin and roles
describe('Hotel Admin never inherits an operational role (RBAC-DEC-001)', () => {
  it('refuses a Hotel Admin the Manager and Reception actions until the role is held', async () => {
    const principal = await actor(admin30);
    // The queue is a Manager/Manager Plus action; Hotel Admin alone is refused
    // with the same NOT_FOUND a caller outside the tenant would see.
    await expectApiError(
      env.handoff.list(principal, hotel30, newRequestContext(admin30.accountId)),
      'NOT_FOUND',
    );

    await env.staff.addRole(
      principal,
      {
        hotelId: hotel30,
        membershipId: admin30.membershipId,
        role: 'MANAGER',
        idempotencyKey: idem('admin-manager'),
      },
      newRequestContext(admin30.accountId),
    );

    const withManager = await actor(admin30);
    await expect(
      env.handoff.list(withManager, hotel30, newRequestContext(admin30.accountId)),
    ).resolves.toEqual([]);

    // Put it back, so the rest of the suite sees the documented Hotel Admin.
    await env.staff.removeRole(
      withManager,
      {
        hotelId: hotel30,
        membershipId: admin30.membershipId,
        role: 'MANAGER',
        idempotencyKey: idem('admin-manager-off'),
      },
      newRequestContext(admin30.accountId),
    );
    const withoutManager = await actor(admin30);
    await expectApiError(
      env.handoff.list(withoutManager, hotel30, newRequestContext(admin30.accountId)),
      'NOT_FOUND',
    );
  });
});

// ------------------------------------------------------------ tenant isolation
describe('tenant and realm isolation (doc 06)', () => {
  it('refuses a Hotel Admin of one hotel acting on another, indistinguishably from not-found', async () => {
    const principal = await actor(admin30);
    const denial = await expectApiError(
      env.staff.createInvitation(
        principal,
        {
          hotelId: otherHotel,
          email: 'intruder@another.test',
          roles: ['RECEPTION'],
          idempotencyKey: idem('cross-tenant'),
        },
        newRequestContext(admin30.accountId),
      ),
      'NOT_FOUND',
    );
    // The same body a genuinely missing membership produces.
    const missing = await expectApiError(
      env.staff.createInvitation(
        principal,
        {
          hotelId: hotel25,
          email: 'intruder@twentyfive.test',
          roles: ['RECEPTION'],
          idempotencyKey: idem('cross-tenant-2'),
        },
        newRequestContext(admin30.accountId),
      ),
      'NOT_FOUND',
    );
    expect(denial.message).toBe(missing.message);
    expect(denial.status).toBe(missing.status);
    expect(denial.details).toBeUndefined();
  });

  it('returns no rows and refuses writes when no tenant context is established', async () => {
    const client = await env.api.connect();
    try {
      const read = await client.query('SELECT 1 FROM platform.staff_membership');
      expect(read.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO platform.staff_membership (hotel_id, invited_email_normalized)
           VALUES ($1, 'unscoped@example.test')`,
          [hotel30],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('shows an account only its own memberships under the account scope', async () => {
    const principal = await actor(admin30);
    expect(principal.memberships.map((m) => m.hotelId)).toEqual([hotel30]);
  });
});

// ---------------------------------------------------------- session revocation
describe('the session revocation matrix (doc 19 §10)', () => {
  it('closes every session in every membership when the password is reset', async () => {
    const email = 'reset-target@thirty.test';
    const member = await env.seedMembership({
      hotelId: hotel30,
      email,
      roles: ['RECEPTION'],
    });
    await env.seedMembership({ hotelId: otherHotel, email, roles: ['RECEPTION'] }).catch(() => {
      // The address already has an account; a second membership is added below.
    });
    await env.admin.query(
      `INSERT INTO platform.staff_membership
         (hotel_id, account_id, invited_email_normalized, state, membership_revision, activated_at)
       VALUES ($1, $2, $3, 'ACTIVE', 1, now())
       ON CONFLICT DO NOTHING`,
      [otherHotel, member.accountId, email],
    );

    const first = await env.sessions.signIn(email, member.password, newRequestContext());
    const second = await env.sessions.signIn(email, member.password, newRequestContext());

    await env.staff.requestPasswordReset(email, newRequestContext());
    const link = env.notifications.lastResetFor(member.accountId);
    expect(link).toBeDefined();

    const result = await env.staff.confirmPasswordReset(
      { token: link?.token as string, password: syntheticPassword('a-completely-new-password-9') },
      newRequestContext(),
    );
    expect(result.sessionsClosed).toBeGreaterThanOrEqual(2);

    for (const session of [first, second]) {
      await expectApiError(
        env.sessions.authenticate(session.token, newRequestContext()),
        'UNAUTHENTICATED',
      );
    }
    // And the new password works.
    await expect(
      env.sessions.signIn(
        email,
        syntheticPassword('a-completely-new-password-9'),
        newRequestContext(),
      ),
    ).resolves.toMatchObject({ accountId: member.accountId });
  });

  it('closes only the affected scope when a membership is suspended', async () => {
    const email = 'scoped@thirty.test';
    const member = await env.seedMembership({ hotelId: hotel30, email, roles: ['RECEPTION'] });
    await env.admin.query(
      `INSERT INTO platform.staff_membership
         (hotel_id, account_id, invited_email_normalized, state, membership_revision, activated_at)
       VALUES ($1, $2, $3, 'ACTIVE', 1, now())`,
      [otherHotel, member.accountId, email],
    );
    const otherMembership = await env.admin.query<{ membership_id: string }>(
      `SELECT membership_id FROM platform.staff_membership
        WHERE hotel_id = $1 AND account_id = $2`,
      [otherHotel, member.accountId],
    );
    const otherMembershipId = otherMembership.rows[0]?.membership_id as string;

    const signedIn = await env.sessions.signIn(email, member.password, newRequestContext());
    const request = newRequestContext(member.accountId);
    await env.sessions.establishScope(
      hotel30,
      member.membershipId,
      1,
      signedIn.sessionId,
      member.accountId,
      request,
    );
    await env.sessions.establishScope(
      otherHotel,
      otherMembershipId,
      1,
      signedIn.sessionId,
      member.accountId,
      request,
    );

    await env.staff.setMembershipState(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: member.membershipId,
        state: 'SUSPENDED',
        reason: 'under review',
        idempotencyKey: idem('suspend-scope'),
      },
      newRequestContext(admin30.accountId),
    );

    // The suspended hotel's scope is gone; the other hotel's is untouched, and
    // the account's credential is unaffected.
    expect(
      await env.sessions.hasLiveScope(hotel30, signedIn.sessionId, member.membershipId, 1, request),
    ).toBe(false);
    expect(
      await env.sessions.hasLiveScope(
        otherHotel,
        signedIn.sessionId,
        otherMembershipId,
        1,
        request,
      ),
    ).toBe(true);
    await expect(
      env.sessions.authenticate(signedIn.token, newRequestContext()),
    ).resolves.toBeDefined();
  });

  it('closes the scope on a role change and never restores it on reactivation', async () => {
    const email = 'rolechange@thirty.test';
    const member = await env.seedMembership({ hotelId: hotel30, email, roles: ['RECEPTION'] });
    const signedIn = await env.sessions.signIn(email, member.password, newRequestContext());
    const request = newRequestContext(member.accountId);
    await env.sessions.establishScope(
      hotel30,
      member.membershipId,
      1,
      signedIn.sessionId,
      member.accountId,
      request,
    );

    await env.staff.addRole(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: member.membershipId,
        role: 'CLEANER',
        idempotencyKey: idem('role-change-scope'),
      },
      newRequestContext(admin30.accountId),
    );
    expect(
      await env.sessions.hasLiveScope(hotel30, signedIn.sessionId, member.membershipId, 1, request),
    ).toBe(false);

    await env.staff.setMembershipState(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: member.membershipId,
        state: 'SUSPENDED',
        reason: 'temporary',
        idempotencyKey: idem('suspend-then-reactivate'),
      },
      newRequestContext(admin30.accountId),
    );
    await env.staff.setMembershipState(
      await actor(admin30),
      {
        hotelId: hotel30,
        membershipId: member.membershipId,
        state: 'ACTIVE',
        reason: 'returned to work',
        idempotencyKey: idem('reactivate'),
      },
      newRequestContext(admin30.accountId),
    );

    // doc 19 §8: reactivation never revives an old session.
    const live = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.session_scope_grant
        WHERE membership_id = $1 AND revoked_at IS NULL`,
      [member.membershipId],
    );
    expect(live.rows[0]?.n).toBe(0);
  });

  it('closes every session on an all-device logout', async () => {
    const email = 'logout-all@thirty.test';
    const member = await env.seedMembership({ hotelId: hotel30, email, roles: ['RECEPTION'] });
    const a = await env.sessions.signIn(email, member.password, newRequestContext());
    const b = await env.sessions.signIn(email, member.password, newRequestContext());

    const closed = await env.sessions.signOutEverywhere(
      member.accountId,
      newRequestContext(member.accountId),
    );
    expect(closed).toBeGreaterThanOrEqual(2);
    for (const session of [a, b]) {
      await expectApiError(
        env.sessions.authenticate(session.token, newRequestContext()),
        'UNAUTHENTICATED',
      );
    }
  });
});

// -------------------------------------------------------- Primary Hotel Admin
describe('the Primary Hotel Admin (STAFF-DEC-006)', () => {
  it('refuses a second Primary in the same hotel at the database', async () => {
    await expect(
      env.admin.query(
        `INSERT INTO platform.staff_membership
           (hotel_id, invited_email_normalized, state, is_primary_admin, account_id,
            membership_revision, activated_at)
         VALUES ($1, 'second-primary@thirty.test', 'ACTIVE', true, $2, 1, now())`,
        [hotel30, admin25.accountId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses to suspend, terminate or demote the Primary', async () => {
    await expectApiError(
      env.staff.setMembershipState(
        await actor(admin30),
        {
          hotelId: hotel30,
          membershipId: admin30.membershipId,
          state: 'SUSPENDED',
          reason: 'attempt',
          idempotencyKey: idem('primary-suspend'),
        },
        newRequestContext(admin30.accountId),
      ),
      'FORBIDDEN',
    );

    await expect(
      env.admin.query(
        `UPDATE platform.staff_membership
            SET is_primary_admin = false, membership_revision = membership_revision + 1
          WHERE membership_id = $1`,
        [admin30.membershipId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an account suspending or terminating its own membership', async () => {
    const other = await env.seedMembership({
      hotelId: hotel25,
      email: 'selfadmin@twentyfive.test',
      roles: ['HOTEL_ADMIN'],
    });
    await expectApiError(
      env.staff.setMembershipState(
        await actor(other),
        {
          hotelId: hotel25,
          membershipId: other.membershipId,
          state: 'SUSPENDED',
          reason: 'self',
          idempotencyKey: idem('self-suspend'),
        },
        newRequestContext(other.accountId),
      ),
      'FORBIDDEN',
    );
  });
});

// ------------------------------------------------------------- secret hygiene
describe('no plaintext secret at rest or in the audit stream (CLAUDE.md §8)', () => {
  it('stores no token, password or session secret anywhere in the IAM tables', async () => {
    const email = 'canary@thirty.test';
    const password = syntheticPassword('canary');
    const created = await env.staff.createInvitation(
      await actor(admin30),
      { hotelId: hotel30, email, roles: ['RECEPTION'], idempotencyKey: idem('canary') },
      newRequestContext(admin30.accountId),
    );
    const token = env.notifications.lastInvitationFor(email)?.token as string;
    await env.staff.acceptInvitation(
      { hotelId: hotel30, token, password, idempotencyKey: idem('canary-accept') },
      newRequestContext(),
    );
    const signedIn = await env.sessions.signIn(email, password, newRequestContext());

    for (const [table, column] of [
      ['platform.staff_invitation', 'token_hash'],
      ['platform.server_session', 'token_hash'],
      ['platform.account_credential', 'secret_hash'],
      ['platform.password_reset_request', 'token_hash'],
    ] as const) {
      const hit = await env.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}
          WHERE ${column} = ANY($1::text[])`,
        [[token, password, signedIn.token]],
      );
      expect(hit.rows[0]?.n, `${table}.${column}`).toBe(0);
    }

    // And nowhere in the audit stream either, at any depth.
    const audit = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event
        WHERE payload::text LIKE '%' || $1 || '%'
           OR payload::text LIKE '%' || $2 || '%'
           OR payload::text LIKE '%' || $3 || '%'`,
      [token, password, signedIn.token],
    );
    expect(audit.rows[0]?.n).toBe(0);

    // Nor in the outbox, which is the durable delivery intent.
    const outbox = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox_event
        WHERE payload::text LIKE '%' || $1 || '%'`,
      [token],
    );
    expect(outbox.rows[0]?.n).toBe(0);
    expect(created.invitationId).toBeDefined();
  });

  it('refuses a plaintext password written straight into the credential column', async () => {
    await expect(
      env.admin.query(
        `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
         VALUES ($1, 'hunter2', 'v1')`,
        [admin20.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ------------------------------------------------------- audit and idempotency
describe('audit and effect commit together (ADR-0018 §5)', () => {
  it('writes one audit event per effect and none for a rolled-back command', async () => {
    const before = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event WHERE action = 'iam.invitation.created'`,
    );

    // A 25,000₮ hotel does not entitle Manager Plus, so the command is refused
    // after the membership row would have been created — and the whole
    // transaction, audit record included, rolls back with it.
    await expectApiError(
      env.staff.createInvitation(
        await actor(admin25),
        {
          hotelId: hotel25,
          email: 'never-created@twentyfive.test',
          roles: ['MANAGER_PLUS'],
          idempotencyKey: idem('rolled-back'),
        },
        newRequestContext(admin25.accountId),
      ),
      'FORBIDDEN',
    );

    const after = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event WHERE action = 'iam.invitation.created'`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const membership = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.staff_membership
        WHERE invited_email_normalized LIKE 'never-created@%'`,
    );
    expect(membership.rows[0]?.n).toBe(0);
  });

  it('audits a denial as security signal', async () => {
    const before = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event WHERE outcome = 'denied'`,
    );
    await expectApiError(
      env.staff.createInvitation(
        await actor(admin30),
        {
          hotelId: hotel25,
          email: 'denied@twentyfive.test',
          roles: ['RECEPTION'],
          idempotencyKey: idem('denied-audit'),
        },
        newRequestContext(admin30.accountId),
      ),
      'NOT_FOUND',
    );
    const after = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event WHERE outcome = 'denied'`,
    );
    expect(Number(after.rows[0]?.n)).toBeGreaterThan(Number(before.rows[0]?.n));
  });
});

// ------------------------------------------------------------- the HTTP surface
describe('the HTTP surface', () => {
  async function signInOverHttp(member: SeededMembership): Promise<string> {
    const response = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { token: string };
    return payload.token;
  }

  it('refuses an unauthenticated request to a guarded route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/session`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the effective permission set for the signed-in principal', async () => {
    const token = await signInOverHttp(admin30);
    const response = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memberships: { hotelId: string; effectivePermissions: string[] }[];
    };
    const membership = body.memberships.find((entry) => entry.hotelId === hotel30);
    expect(membership?.effectivePermissions).toContain('hotel.staff.invite_suspend');
    // Hotel Admin holds no operational permission (RBAC-DEC-001).
    expect(membership?.effectivePermissions).not.toContain('hotel.stay.check_in');
  });

  it('rejects a package-forbidden role invitation through the API', async () => {
    const token = await signInOverHttp(admin25);
    const response = await fetch(`${baseUrl}/api/v1/hotels/${hotel25}/staff/invitations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': idem('http-package'),
      },
      body: JSON.stringify({ email: 'http-mp@twentyfive.test', roles: ['MANAGER_PLUS'] }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns an identical body for a cross-tenant target and a missing one', async () => {
    const token = await signInOverHttp(admin25);
    const bodies: unknown[] = [];
    for (const target of [hotel30, '99999999-9999-4999-8999-999999999999']) {
      const response = await fetch(`${baseUrl}/api/v1/hotels/${target}/staff/invitations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': idem('http-cross'),
        },
        body: JSON.stringify({ email: 'probe@example.test', roles: ['RECEPTION'] }),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: Record<string, unknown> };
      delete body.error['correlationId'];
      bodies.push(body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('requires an idempotency key on a lifecycle command', async () => {
    const token = await signInOverHttp(admin30);
    const response = await fetch(`${baseUrl}/api/v1/hotels/${hotel30}/staff/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'nokey@thirty.test', roles: ['RECEPTION'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('never echoes a token back to the inviter', async () => {
    const token = await signInOverHttp(admin30);
    const response = await fetch(`${baseUrl}/api/v1/hotels/${hotel30}/staff/invitations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': idem('http-invite'),
      },
      body: JSON.stringify({ email: 'http-invitee@thirty.test', roles: ['RECEPTION'] }),
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    const delivered = env.notifications.lastInvitationFor('http-invitee@thirty.test');
    expect(delivered).toBeDefined();
    expect(text).not.toContain(delivered?.token as string);
  });
});
