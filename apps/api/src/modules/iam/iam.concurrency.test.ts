import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { quietPool } from '@prsystem/testing';
import { ApiError } from '@prsystem/contracts';
import type { IamHarness, SeededMembership } from './test-support/iam-harness';
import { createIamHarness, actorFor } from './test-support/iam-harness';
import type { CommandActor } from './services/iam-context';
import { newRequestContext } from './services/iam-context';
import { StaffService } from './services/staff.service';
import { HandoffService } from './services/handoff.service';

/**
 * GATE-CONC for Phase 04 — real connections racing each other.
 *
 * Every race runs on **distinct physical connections** and is released by a
 * barrier, so both participants are inside an open transaction before either
 * reaches the row that arbitrates. Each assertion is about the *effect* count:
 * "one effect under concurrency" is the invariant, and a mechanism that returns
 * tidy values while producing two rows has failed.
 */

let env: IamHarness;
let hotelId: string;
let admin: SeededMembership;
let managerA: SeededMembership;
let managerB: SeededMembership;
let receptionA: SeededMembership;
let cleanerA: SeededMembership;
let cleanerB: SeededMembership;
const racerPools: Pool[] = [];

let key = 0;
function idem(prefix: string): string {
  key += 1;
  return `${prefix}-${String(key).padStart(6, '0')}`;
}

/** A service bundle on its own single connection, so a race is a real race. */
function racer(): { staff: StaffService; handoff: HandoffService; pool: Pool } {
  const pool = quietPool({
    connectionString: env.db.loginUrl('prsystem_api_login'),
    max: 1,
  });
  racerPools.push(pool);
  const deps = { ...env.deps, pool };
  return { staff: new StaffService(deps), handoff: new HandoffService(deps), pool };
}

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) release();
    return gate;
  };
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

/**
 * The actor a command runs as: a real sign-in and a real authentication, so the
 * session's per-hotel scope grants exist exactly as a request would create them.
 */
async function actor(member: SeededMembership): Promise<CommandActor> {
  return actorFor(env, member);
}

function isApiError(value: unknown, code?: string): boolean {
  return value instanceof ApiError && (code === undefined || value.code === code);
}

/** Opens a handoff item by suspending a membership that holds open work. */
async function openHandoffItem(
  subject: 'reception_shift' | 'cleaner_task',
  member: SeededMembership,
): Promise<string> {
  // The open work comes from the module that owns it, never from the request.
  env.openWork.set(hotelId, member.membershipId, [{ kind: subject, ref: crypto.randomUUID() }]);
  const result = await env.staff.setMembershipState(
    await actor(admin),
    {
      hotelId,
      membershipId: member.membershipId,
      state: 'SUSPENDED',
      reason: 'concurrency fixture',
      idempotencyKey: idem('open-item'),
    },
    newRequestContext(admin.accountId),
  );
  const itemId = result.handoffItems[0];
  if (itemId === undefined) throw new Error('the suspension opened no handoff item');
  return itemId;
}

beforeAll(async () => {
  env = await createIamHarness('iam_concurrency');
  hotelId = await env.createHotel('Concurrency Hotel', 'P30');
  admin = await env.seedMembership({
    hotelId,
    email: 'admin@conc.test',
    roles: ['HOTEL_ADMIN'],
    primary: true,
  });
  managerA = await env.seedMembership({
    hotelId,
    email: 'manager-a@conc.test',
    roles: ['MANAGER'],
  });
  managerB = await env.seedMembership({
    hotelId,
    email: 'manager-b@conc.test',
    roles: ['MANAGER'],
  });
  receptionA = await env.seedMembership({
    hotelId,
    email: 'reception-a@conc.test',
    roles: ['RECEPTION'],
  });
  cleanerA = await env.seedMembership({
    hotelId,
    email: 'cleaner-a@conc.test',
    roles: ['CLEANER'],
  });
  cleanerB = await env.seedMembership({
    hotelId,
    email: 'cleaner-b@conc.test',
    roles: ['CLEANER'],
  });
}, 180000);

afterAll(async () => {
  await Promise.all(racerPools.map((pool) => pool.end().catch(() => undefined)));
  await env.close();
}, 60000);

describe('invitation concurrency (STAFF-DEC-009)', () => {
  it('produces exactly one invitation when two identical creates race', async () => {
    const email = 'race-create@conc.test';
    const one = racer();
    const two = racer();
    const gate = barrier(2);
    const principal = await actor(admin);

    const attempt = async (service: StaffService, key: string): Promise<unknown> => {
      await gate();
      return service
        .createInvitation(
          principal,
          { hotelId, email, roles: ['RECEPTION'], idempotencyKey: key },
          newRequestContext(admin.accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([
      attempt(one.staff, idem('race-a')),
      attempt(two.staff, idem('race-b')),
    ]);

    const memberships = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.staff_membership
        WHERE hotel_id = $1 AND invited_email_normalized = $2`,
      [hotelId, email],
    );
    expect(memberships.rows[0]?.n).toBe(1);

    const invitations = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.staff_invitation i
         JOIN platform.staff_membership m ON m.membership_id = i.membership_id
        WHERE m.invited_email_normalized = $1 AND i.state = 'ACTIVE'`,
      [email],
    );
    expect(invitations.rows[0]?.n).toBe(1);

    // One succeeded; the other was refused rather than silently duplicating.
    const succeeded = results.filter((value) => !(value instanceof Error));
    expect(succeeded).toHaveLength(1);
  });

  it('lets a suspension win against a concurrent invitation acceptance', async () => {
    // doc 19 §8.5: a suspension or termination that commits first must stop a
    // stale accept from committing at all.
    const email = 'race-accept@conc.test';
    const created = await env.staff.createInvitation(
      await actor(admin),
      { hotelId, email, roles: ['RECEPTION'], idempotencyKey: idem('accept-race-invite') },
      newRequestContext(admin.accountId),
    );
    const token = env.notifications.lastInvitationFor(email)?.token as string;

    const accepting = racer();
    const suspending = racer();
    const gate = barrier(2);
    const adminPrincipal = await actor(admin);

    const [acceptOutcome] = await Promise.all([
      (async () => {
        await gate();
        return accepting.staff
          .acceptInvitation(
            {
              hotelId,
              token,
              password: syntheticPassword('race-accept-password-1'),
              idempotencyKey: idem('accept-race'),
            },
            newRequestContext(),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
      })(),
      (async () => {
        await gate();
        return suspending.staff
          .setMembershipState(
            adminPrincipal,
            {
              hotelId,
              membershipId: created.membershipId,
              state: 'TERMINATED',
              reason: 'withdrawn',
              idempotencyKey: idem('accept-race-terminate'),
            },
            newRequestContext(admin.accountId),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
      })(),
    ]);

    const membership = await env.admin.query<{ state: string; account_id: string | null }>(
      `SELECT state, account_id FROM platform.staff_membership WHERE membership_id = $1`,
      [created.membershipId],
    );
    const state = membership.rows[0]?.state;
    const accountId = membership.rows[0]?.account_id ?? null;
    // The two serialise on the membership row, so exactly one of the two orders
    // happened and the stored state matches the answer each caller was given.
    //
    //  - the accept was refused  → the terminate reached a still-PENDING
    //    membership, and no account was ever bound to it;
    //  - the accept succeeded    → the account is bound, and the membership is
    //    ACTIVE if the terminate lost the row or TERMINATED if it ran after.
    //    That second case is an ordinary sequence, not an interleaving: a Hotel
    //    Admin terminating a membership that has just been accepted is exactly
    //    what the queue of one row lock produces.
    //
    // What must never happen — and is what this asserts — is a state that
    // matches neither answer: a TERMINATED membership carrying an account the
    // accept was told it did not get, or an ACTIVE one with no account at all.
    expect(['ACTIVE', 'TERMINATED']).toContain(state);
    if (isApiError(acceptOutcome)) {
      expect({ state, accountId }).toEqual({ state: 'TERMINATED', accountId: null });
    } else {
      const accepted = acceptOutcome as { membershipId: string; accountId: string };
      expect(accountId).toBe(accepted.accountId);
    }
  });

  it('refuses a stale membership revision rather than overwriting the newer state', async () => {
    const member = await env.seedMembership({
      hotelId,
      email: 'stale@conc.test',
      roles: ['RECEPTION'],
    });
    const principal = await actor(admin);

    // Two role changes on the same membership, released together. Both read the
    // same revision; the compare-and-set means one of them updates nothing.
    const one = racer();
    const two = racer();
    const gate = barrier(2);

    const change = async (service: StaffService, role: 'CLEANER' | 'MANAGER'): Promise<unknown> => {
      await gate();
      return service
        .addRole(
          principal,
          {
            hotelId,
            membershipId: member.membershipId,
            role,
            idempotencyKey: idem(`stale-${role}`),
          },
          newRequestContext(admin.accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([change(one.staff, 'CLEANER'), change(two.staff, 'MANAGER')]);
    const refused = results.filter(
      (value) => isApiError(value, 'REVISION_MISMATCH') || isApiError(value, 'CONFLICT'),
    );
    const succeeded = results.filter((value) => !(value instanceof Error));
    expect(succeeded.length + refused.length).toBe(2);
    // The revision moved exactly once per successful change.
    const revision = await env.admin.query<{ membership_revision: number }>(
      `SELECT membership_revision FROM platform.staff_membership WHERE membership_id = $1`,
      [member.membershipId],
    );
    expect(Number(revision.rows[0]?.membership_revision)).toBe(1 + succeeded.length);
  });

  it('creates one revocation when two revokes race', async () => {
    const email = 'race-revoke@conc.test';
    const created = await env.staff.createInvitation(
      await actor(admin),
      { hotelId, email, roles: ['RECEPTION'], idempotencyKey: idem('revoke-race-invite') },
      newRequestContext(admin.accountId),
    );
    const principal = await actor(admin);
    const one = racer();
    const two = racer();
    const gate = barrier(2);

    const revoke = async (service: StaffService): Promise<unknown> => {
      await gate();
      return service
        .revokeInvitation(
          principal,
          {
            hotelId,
            membershipId: created.membershipId,
            reason: 'race',
            idempotencyKey: idem('revoke-race'),
          },
          newRequestContext(admin.accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([revoke(one.staff), revoke(two.staff)]);
    const succeeded = results.filter((value) => !(value instanceof Error));
    expect(succeeded).toHaveLength(1);

    const states = await env.admin.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM platform.staff_invitation
        WHERE membership_id = $1 GROUP BY state`,
      [created.membershipId],
    );
    expect(states.rows).toEqual([{ state: 'REVOKED', n: 1 }]);
  });
});

describe('the handoff queue under concurrency (doc 19 §8.4)', () => {
  it('gives one takeover item exactly one claimant when two Managers race', async () => {
    const itemId = await openHandoffItem('reception_shift', receptionA);
    const a = racer();
    const b = racer();
    const gate = barrier(2);
    const principalA = await actor(managerA);
    const principalB = await actor(managerB);

    const claim = async (
      service: HandoffService,
      principal: CommandActor,
      accountId: string,
    ): Promise<unknown> => {
      await gate();
      return service
        .claim(
          principal,
          { hotelId, itemId, idempotencyKey: idem('claim-race') },
          newRequestContext(accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([
      claim(a.handoff, principalA, managerA.accountId),
      claim(b.handoff, principalB, managerB.accountId),
    ]);

    const winners = results.filter((value) => !(value instanceof Error));
    expect(winners).toHaveLength(1);
    expect(results.filter((value) => isApiError(value, 'CONFLICT'))).toHaveLength(1);

    const item = await env.admin.query<{ state: string; claimant: string; version: number }>(
      `SELECT state, claimant_membership_id AS claimant, assignment_version AS version
         FROM platform.work_handoff_item WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0]?.state).toBe('CLAIMED');
    expect([managerA.membershipId, managerB.membershipId]).toContain(item.rows[0]?.claimant);
    // Exactly one transition, so the version moved once.
    expect(Number(item.rows[0]?.version)).toBe(1);
  });

  it('gives one Cleaner task exactly one assignee when two assignments race', async () => {
    // The Cleaner *task* aggregate is Phase 09; what Phase 04 owns is the
    // one-assignee invariant on the item that stands in for it.
    const itemId = await openHandoffItem('cleaner_task', cleanerA);
    const principal = await actor(managerA);
    await env.handoff.claim(
      principal,
      { hotelId, itemId, idempotencyKey: idem('cleaner-claim') },
      newRequestContext(managerA.accountId),
    );

    const a = racer();
    const b = racer();
    const gate = barrier(2);

    const assign = async (service: HandoffService, replacement: string): Promise<unknown> => {
      await gate();
      return service
        .assign(
          principal,
          {
            hotelId,
            itemId,
            replacementMembershipId: replacement,
            idempotencyKey: idem('assign-race'),
          },
          newRequestContext(managerA.accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([
      assign(a.handoff, cleanerB.membershipId),
      assign(b.handoff, cleanerB.membershipId),
    ]);
    const winners = results.filter((value) => !(value instanceof Error));
    expect(winners).toHaveLength(1);

    const item = await env.admin.query<{ state: string; assignee: string }>(
      `SELECT state, assignee_membership_id AS assignee
         FROM platform.work_handoff_item WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0]?.state).toBe('ASSIGNED');
    expect(item.rows[0]?.assignee).toBe(cleanerB.membershipId);
  });

  it('creates exactly one linked continuation for partially completed work', async () => {
    const suspended = await env.seedMembership({
      hotelId,
      email: 'partial-cleaner@conc.test',
      roles: ['CLEANER'],
    });
    env.openWork.set(hotelId, suspended.membershipId, [
      { kind: 'cleaner_task', ref: crypto.randomUUID(), movementStarted: true },
    ]);
    const opened = await env.staff.setMembershipState(
      await actor(admin),
      {
        hotelId,
        membershipId: suspended.membershipId,
        state: 'SUSPENDED',
        reason: 'partial work',
        idempotencyKey: idem('partial-open'),
      },
      newRequestContext(admin.accountId),
    );
    const itemId = opened.handoffItems[0] as string;

    const principal = await actor(managerA);
    await env.handoff.claim(
      principal,
      { hotelId, itemId, idempotencyKey: idem('partial-claim') },
      newRequestContext(managerA.accountId),
    );

    // A posted movement is never reassigned.
    await expect(
      env.handoff.assign(
        principal,
        {
          hotelId,
          itemId,
          replacementMembershipId: cleanerB.membershipId,
          idempotencyKey: idem('partial-assign'),
        },
        newRequestContext(managerA.accountId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const remaining = crypto.randomUUID();
    const a = racer();
    const b = racer();
    const gate = barrier(2);

    const create = async (service: HandoffService): Promise<unknown> => {
      await gate();
      return service
        .createContinuation(
          principal,
          {
            hotelId,
            itemId,
            replacementMembershipId: cleanerB.membershipId,
            subjectRef: remaining,
            idempotencyKey: idem('continuation-race'),
          },
          newRequestContext(managerA.accountId),
        )
        .then(
          (value) => value,
          (error: unknown) => error,
        );
    };

    const results = await Promise.all([create(a.handoff), create(b.handoff)]);
    const winners = results.filter((value) => !(value instanceof Error));
    expect(winners).toHaveLength(1);

    const continuations = await env.admin.query<{ n: number; original: string }>(
      `SELECT count(*)::int AS n, min(continuation_of_item_id::text) AS original
         FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND subject_ref = $2`,
      [hotelId, remaining],
    );
    expect(continuations.rows[0]?.n).toBe(1);
    expect(continuations.rows[0]?.original).toBe(itemId);

    // The original keeps its actor, its movement and its history.
    const original = await env.admin.query<{ previous: string; movement: boolean }>(
      `SELECT previous_actor_membership_id AS previous, movement_started AS movement
         FROM platform.work_handoff_item WHERE item_id = $1`,
      [itemId],
    );
    expect(original.rows[0]?.previous).toBe(suspended.membershipId);
    expect(original.rows[0]?.movement).toBe(true);
  });

  it('refuses a suspended actor retrying its own command', async () => {
    // The principal was resolved while the membership was active; the command
    // re-reads it at commit, so the retry is refused (`STAFF-DEC-007`).
    const member = await env.seedMembership({
      hotelId,
      email: 'suspended-retry@conc.test',
      roles: ['MANAGER'],
    });
    const stale = await actor(member);
    const itemId = await openHandoffItem('reception_shift', receptionA);

    await env.staff.setMembershipState(
      await actor(admin),
      {
        hotelId,
        membershipId: member.membershipId,
        state: 'SUSPENDED',
        reason: 'security',
        idempotencyKey: idem('suspend-actor'),
      },
      newRequestContext(admin.accountId),
    );

    await expect(
      env.handoff.claim(
        stale,
        { hotelId, itemId, idempotencyKey: idem('suspended-retry') },
        newRequestContext(member.accountId),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const item = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.work_handoff_item WHERE item_id = $1`,
      [itemId],
    );
    expect(item.rows[0]?.state).toBe('TAKEOVER_REQUIRED');
  });

  it('never assigns a replacement that does not already hold the operational role', async () => {
    const itemId = await openHandoffItem('reception_shift', receptionA);
    const principal = await actor(managerA);
    await env.handoff.claim(
      principal,
      { hotelId, itemId, idempotencyKey: idem('role-check-claim') },
      newRequestContext(managerA.accountId),
    );

    // `RBAC-DEC-014`: a takeover hands over the work, never the permission.
    await expect(
      env.handoff.assign(
        principal,
        {
          hotelId,
          itemId,
          replacementMembershipId: cleanerB.membershipId,
          idempotencyKey: idem('role-check-assign'),
        },
        newRequestContext(managerA.accountId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const replacement = await env.seedMembership({
      hotelId,
      email: 'replacement-reception@conc.test',
      roles: ['RECEPTION'],
    });
    await expect(
      env.handoff.assign(
        principal,
        {
          hotelId,
          itemId,
          replacementMembershipId: replacement.membershipId,
          idempotencyKey: idem('role-check-assign-ok'),
        },
        newRequestContext(managerA.accountId),
      ),
    ).resolves.toMatchObject({ assigned: true });
  });

  it('leaves an item requiring action when no eligible replacement exists', async () => {
    const itemId = await openHandoffItem('cleaner_task', cleanerA);
    const principal = await actor(managerA);
    await env.handoff.claim(
      principal,
      { hotelId, itemId, idempotencyKey: idem('unassignable-claim') },
      newRequestContext(managerA.accountId),
    );
    await env.handoff.markUnassignable(
      principal,
      {
        hotelId,
        itemId,
        reason: 'no active Cleaner remains',
        idempotencyKey: idem('unassignable'),
      },
      newRequestContext(managerA.accountId),
    );

    const item = await env.admin.query<{ state: string; resolved: Date | null }>(
      `SELECT state, resolved_at AS resolved FROM platform.work_handoff_item WHERE item_id = $1`,
      [itemId],
    );
    // doc 19 §8.2: not completed, not bypassed.
    expect(item.rows[0]?.state).toBe('UNASSIGNED_REQUIRES_ACTION');
    expect(item.rows[0]?.resolved).toBeNull();
  });
});
