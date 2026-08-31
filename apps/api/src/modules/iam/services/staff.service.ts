import type { HotelRole, PackageCode } from '@prsystem/authz';
import { authorize, isRoleAssignableIn } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import type { ResetIntakeOutcome, ResetIntakeRow } from '../repositories/account.repository';
import { AccountRepository, normaliseEmail } from '../repositories/account.repository';
import type { InvitationRow, MembershipRow } from '../repositories/membership.repository';
import { MembershipRepository } from '../repositories/membership.repository';
import { authorizeCommand, resolvePrincipal } from './authorization.service';
import type { CommandActor, HotelGate, IamDependencies, RequestContext } from './iam-context';
import { IamServiceBase, establishAccountScope, newRequestContext } from './iam-context';
import { HandoffService } from './handoff.service';
import { HandoffDiscoveryRepository } from '../repositories/handoff.repository';
import { derivedIdempotencyKey } from './derived-key';
import { assertPasswordAcceptable, derivePassword } from './password.service';
import { randomUUID } from 'node:crypto';
import type { KeyScope } from '@prsystem/ports';
import { decryptValue, encryptValue } from '@prsystem/ports';

/**
 * The staff lifecycle (doc 19, `STAFF-DEC-001`…`009`).
 *
 * Every command in this file follows the same shape, and the shape is the
 * requirement:
 *
 *  1. one transaction;
 *  2. an idempotency claim, so a retry creates no second effect;
 *  3. the membership row locked and its revision read;
 *  4. **authorization re-evaluated against the state that was just locked**,
 *     not against what the request handler saw;
 *  5. the effect, applied with a compare-and-set on `membership_revision`;
 *  6. an audit event and, where another module must react, an outbox event —
 *     both in the same transaction, so an effect that cannot be attributed
 *     simply does not happen.
 */

export interface InvitationInput {
  readonly hotelId: string;
  readonly restaurantId?: string;
  readonly email: string;
  readonly roles: readonly HotelRole[];
  readonly idempotencyKey: string;
}

export interface InvitationCreated {
  readonly invitationId: string;
  readonly membershipId: string;
  readonly expiresAt: Date;
}

/**
 * An invitation that has lapsed.
 *
 * Carried as its own error because the terminal `EXPIRED` write cannot happen
 * in the transaction that refuses the request: that transaction rolls back, and
 * the marking would roll back with it. The refusal the caller sees is still the
 * same indistinguishable `NOT_FOUND`.
 */
class InvitationExpiredError extends Error {
  override readonly name = 'InvitationExpiredError';

  constructor(
    readonly hotelId: string,
    readonly invitationId: string,
  ) {
    super('the invitation has expired');
  }
}

/**
 * What a suspension or termination reports.
 *
 * `handoffDiscovery` is the honest half: `COMPLETED` when the owning modules
 * answered and the items exist, `PENDING` when the question is queued and
 * durable, `NOT_REQUIRED` for a reactivation. The security effect is unrelated
 * to all three — it has already committed by the time this is built.
 */
export interface MembershipStateResult {
  readonly state: string;
  readonly handoffItems: readonly string[];
  readonly handoffDiscovery: 'COMPLETED' | 'PENDING' | 'NOT_REQUIRED';
}

export interface AcceptInvitationInput {
  readonly hotelId: string;
  readonly token: string;
  /** Present when the invitee is creating their first account. */
  readonly password?: string;
  /** Present when an existing verified account is accepting. */
  readonly accountId?: string;
  readonly idempotencyKey: string;
}

export class StaffService extends IamServiceBase {
  private readonly handoff: HandoffService;

  constructor(deps: IamDependencies) {
    super(deps);
    this.handoff = new HandoffService(deps);
  }

  // ------------------------------------------------------------- invitations
  /**
   * Creates a membership in `PENDING` and its single ACTIVE invitation.
   *
   * A duplicate create returns the existing pending membership and its live
   * invitation rather than a second one (doc 19 §4 rule 3): the canonical
   * membership index and the one-ACTIVE-invitation index both refuse the
   * duplicate, and the idempotency record makes the retry return the first
   * result instead of an error.
   */
  async createInvitation(
    actor: CommandActor,
    input: InvitationInput,
    request: RequestContext,
  ): Promise<InvitationCreated> {
    const email = normaliseEmail(input.email);
    const restaurantId = input.restaurantId ?? null;
    const permission = invitePermissionFor(input.roles, restaurantId);
    assertScopeAllowsRoles(input.roles, restaurantId);

    return this.runHotelCommand(
      actor,
      { hotelId: input.hotelId, ...(restaurantId === null ? {} : { restaurantId }) },
      request,
      async (uow, gate) => {
        // doc 19 §3: the restaurant must be one this hotel registered. Phase 15
        // owns that aggregate, so the linkage is a contract — and a contract
        // that cannot answer refuses rather than assuming.
        if (restaurantId !== null) {
          const belongs = await this.deps.restaurants.belongsToHotel(input.hotelId, restaurantId);
          if (!belongs) throw new ApiError('NOT_FOUND', 'not found');
        }

        const decision = await this.authorize(gate, {
          uow,
          permission,
          hotelId: input.hotelId,
          restaurantId,
          targetType: 'staff_membership',
        });

        const claimed = await this.claim(uow, 'iam.invitation.create', input.idempotencyKey, input);
        if (claimed.replay !== undefined) return claimed.replay as InvitationCreated;

        const entitled = decision.effectivePackage;
        if (entitled === undefined) throw new ApiError('INTERNAL_ERROR', 'no package was resolved');
        // `STAFF-DEC-006`: nothing here can create a Primary Hotel Admin.
        // `is_primary_admin` is a column no invitation path writes, and the
        // partial unique index means a hotel could not acquire a second one even
        // if a path did.
        assertRolesEntitled(input.roles, entitled);

        const memberships = new MembershipRepository(uow);
        const existing = await memberships.findByScopeEmail(restaurantId, email);
        const membership =
          existing ??
          (await memberships.create({
            restaurantId,
            invitedEmailNormalized: email,
            createdByAccountId: gate.principal.accountId,
          }));

        if (existing !== undefined && existing.state !== 'PENDING') {
          // doc 19 §4: a scope already holds a canonical membership. Re-inviting
          // an active, suspended or terminated person is the reactivation of §8,
          // not a second membership row.
          throw new ApiError(
            'CONFLICT',
            `this scope already holds a ${existing.state.toLowerCase()} membership for that address`,
          );
        }
        if (existing !== undefined && (await memberships.activeInvitation(existing.membershipId))) {
          throw new ApiError('CONFLICT', 'this membership already has a live invitation');
        }

        const created = await this.issueInvitation(uow, {
          hotelId: input.hotelId,
          membership,
          email,
          roles: input.roles,
          actorAccountId: gate.principal.accountId,
          action: 'iam.invitation.created',
        });

        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, created);
        return created;
      },
    );
  }

  /**
   * Resends: the live token is superseded and a new one issued, in one
   * transaction (doc 19 §4 rule 6). The old link stops working the moment this
   * commits, which is the whole point of `SUPERSEDED` being a state.
   */
  async resendInvitation(
    actor: CommandActor,
    input: { hotelId: string; membershipId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<InvitationCreated> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined || membership.state !== 'PENDING') {
        throw new ApiError('NOT_FOUND', 'not found');
      }

      const live = await memberships.activeInvitation(membership.membershipId);
      if (live === undefined) {
        throw new ApiError('CONFLICT', 'there is no live invitation to resend');
      }
      const roles = await memberships.invitationRoles(live.invitationId);

      const decision = await this.authorize(gate, {
        uow,
        permission: invitePermissionFor(roles, membership.restaurantId),
        hotelId: input.hotelId,
        restaurantId: membership.restaurantId,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });
      const entitled = decision.effectivePackage;
      if (entitled === undefined) throw new ApiError('INTERNAL_ERROR', 'no package was resolved');

      const claimed = await this.claim(uow, 'iam.invitation.resend', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as InvitationCreated;

      assertRolesEntitled(roles, entitled);

      const sinceLast = uow.serverNow.getTime() - live.createdAt.getTime();
      if (sinceLast < this.parameters.invitationResendIntervalSeconds * 1000) {
        throw new ApiError('RATE_LIMITED', 'this invitation was sent too recently');
      }

      const created = await this.issueInvitation(uow, {
        hotelId: input.hotelId,
        membership,
        email: membership.invitedEmailNormalized,
        roles,
        actorAccountId: gate.principal.accountId,
        action: 'iam.invitation.resent',
        supersede: live.invitationId,
      });

      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, created);
      return created;
    });
  }

  /** Revokes the live invitation. The membership stays `PENDING` and unarmed. */
  async revokeInvitation(
    actor: CommandActor,
    input: { hotelId: string; membershipId: string; reason: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ revoked: boolean }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await this.authorize(gate, {
        uow,
        permission: 'hotel.staff.invite_suspend',
        hotelId: input.hotelId,
        restaurantId: null,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

      const claimed = await this.claim(uow, 'iam.invitation.revoke', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { revoked: boolean };

      const live = await memberships.activeInvitation(membership.membershipId);
      if (live === undefined)
        throw new ApiError('CONFLICT', 'there is no live invitation to revoke');

      await memberships.terminaliseInvitation(live.invitationId, 'REVOKED', input.reason);
      const moved = await memberships.transition({
        membershipId: membership.membershipId,
        expectedRevision: membership.membershipRevision,
      });
      if (!moved) throw new ApiError('REVISION_MISMATCH', 'the membership changed concurrently');

      await recordPlatformAudit(uow, {
        action: 'iam.invitation.revoked',
        outcome: 'allowed',
        targetType: 'staff_invitation',
        targetRef: live.invitationId,
        reason: input.reason,
        payload: { membershipId: membership.membershipId },
      });

      const result = { revoked: true };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  /**
   * What a recipient sees before deciding to accept: the hotel scope, the roles
   * and whether the address already has an account. Never the token, and never
   * anything about a hotel the token does not belong to.
   */
  async inspectInvitation(
    input: { hotelId: string; token: string },
    request: RequestContext,
  ): Promise<{
    invitationId: string;
    emailNormalized: string;
    roles: readonly HotelRole[];
    expiresAt: Date;
    accountExists: boolean;
  }> {
    return this.terminalisingExpiry(request, () =>
      this.runTokenGatedCommand(input.hotelId, request, async (uow) => {
        const { invitation } = await this.resolveInvitation(uow, input.hotelId, input.token);
        const memberships = new MembershipRepository(uow);
        const roles = await memberships.invitationRoles(invitation.invitationId);
        const account = await new AccountRepository(uow).findByEmail(
          'hotel',
          invitation.emailNormalized,
        );
        return {
          invitationId: invitation.invitationId,
          emailNormalized: invitation.emailNormalized,
          roles,
          expiresAt: invitation.expiresAt,
          accountExists: account !== undefined,
        };
      }),
    );
  }

  /**
   * Runs `work`, and terminalises a lapsed invitation in a transaction of its
   * own before reporting the same refusal any unknown token gets.
   */
  private async terminalisingExpiry<T>(
    request: RequestContext,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof InvitationExpiredError)) throw error;
      await this.inHotelScope(error.hotelId, request, async (uow) => {
        await new MembershipRepository(uow).terminaliseInvitation(
          error.invitationId,
          'EXPIRED',
          'expired',
        );
      });
      throw new ApiError('NOT_FOUND', 'not found');
    }
  }

  /**
   * Accepts an invitation.
   *
   * Everything the document requires is rechecked **inside the commit
   * transaction**, after the membership row is locked (doc 19 §5): the
   * membership is still `PENDING`, the token is still the live one, the account
   * and the invited address match, the inviter still holds the authority they
   * used, the package still entitles the roles, and the revision is the one that
   * was read. A suspension that commits first therefore wins, and this returns
   * `CONFLICT` rather than reviving the membership.
   */
  async acceptInvitation(
    input: AcceptInvitationInput,
    request: RequestContext,
  ): Promise<{ membershipId: string; accountId: string }> {
    if (input.password === undefined && input.accountId === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'a new account needs a password to be created');
    }
    if (input.password !== undefined) assertPasswordAcceptable(input.password);

    // The idempotency record must tell two different tokens apart without ever
    // holding either. A keyed digest of the presented token does exactly that:
    // a genuine retry carries the same secret and replays; a second, different
    // invitation under the same key is a key reuse, not a replay, and must be
    // refused rather than answered with the first invitation's result.
    const presented = await this.tokens.digest('invitation', ACCEPT_DIGEST_SUBJECT, input.token);

    return this.terminalisingExpiry(request, () =>
      this.runTokenGatedCommand(input.hotelId, request, async (uow) => {
        // The token is the gate here — there is no membership to gate with, and
        // that is the point of the flow. Nothing is claimed or locked until it
        // has resolved to a live invitation in this hotel.
        const { invitation, membership } = await this.resolveInvitation(
          uow,
          input.hotelId,
          input.token,
          { lock: true },
        );
        if (membership.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'this invitation can no longer be accepted');
        }

        const claimed = await this.claim(uow, 'iam.invitation.accept', input.idempotencyKey, {
          hotelId: input.hotelId,
          tokenDigest: presented.tokenHash,
          accountId: input.accountId ?? null,
        });
        if (claimed.replay !== undefined) {
          return claimed.replay as { membershipId: string; accountId: string };
        }

        const memberships = new MembershipRepository(uow);
        const roles = await memberships.invitationRoles(invitation.invitationId);

        // The inviter's authority, re-evaluated now. A Hotel Admin who was
        // suspended between sending the invitation and its acceptance did not
        // authorise this membership.
        await this.assertInviterStillAuthorised(uow, input.hotelId, invitation.invitationId, roles);

        const snapshot = await this.deps.subscription.snapshot(input.hotelId, uow.serverNow);
        if (snapshot === undefined) {
          throw new ApiError(
            'DEPENDENCY_UNAVAILABLE',
            'the subscription state cannot be determined',
          );
        }
        assertRolesEntitled(roles, snapshot.effectivePackage);
        assertScopeAllowsRoles(roles, membership.restaurantId);

        const accounts = new AccountRepository(uow);
        const accountId = await this.resolveAcceptingAccount(uow, accounts, invitation, input);

        const moved = await memberships.transition({
          membershipId: membership.membershipId,
          expectedRevision: membership.membershipRevision,
          state: 'ACTIVE',
          accountId,
          reason: null,
        });
        if (!moved) throw new ApiError('CONFLICT', 'the membership changed concurrently');

        for (const role of roles) {
          // Attributed to the inviter, who is the account that decided the role
          // set. The invitee grants themselves nothing.
          await memberships.grantRole(membership.membershipId, role, invitation.createdByAccountId);
        }
        await memberships.terminaliseInvitation(invitation.invitationId, 'ACCEPTED', 'accepted');

        await recordPlatformAudit(uow, {
          action: 'iam.invitation.accepted',
          outcome: 'allowed',
          targetType: 'staff_membership',
          targetRef: membership.membershipId,
          payload: { accountId, roles: [...roles] },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'staff_membership',
          aggregateId: membership.membershipId,
          eventType: 'iam.membership.activated',
          payload: { membershipId: membership.membershipId, accountId, roles: [...roles] },
        });

        const result = { membershipId: membership.membershipId, accountId };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      }),
    );
  }

  // ------------------------------------------------------------- role changes
  async addRole(
    actor: CommandActor,
    input: { hotelId: string; membershipId: string; role: HotelRole; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ granted: boolean }> {
    return this.changeRole(actor, input, 'add', request);
  }

  async removeRole(
    actor: CommandActor,
    input: {
      hotelId: string;
      membershipId: string;
      role: HotelRole;
      reason?: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ granted: boolean }> {
    return this.changeRole(actor, input, 'remove', request);
  }

  private async changeRole(
    actor: CommandActor,
    input: {
      hotelId: string;
      membershipId: string;
      role: HotelRole;
      reason?: string;
      idempotencyKey: string;
    },
    direction: 'add' | 'remove',
    request: RequestContext,
  ): Promise<{ granted: boolean }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission:
          membership.restaurantId === null
            ? 'hotel.staff.role_manage'
            : 'hotel.restaurant.manager_invite',
        hotelId: input.hotelId,
        restaurantId: membership.restaurantId,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });
      const entitled = decision.effectivePackage;
      if (entitled === undefined) throw new ApiError('INTERNAL_ERROR', 'no package was resolved');

      const operation = `iam.role.${direction}`;
      const claimed = await this.claim(uow, operation, input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { granted: boolean };

      if (direction === 'add') {
        // The package gate applies to the *assignment*, not only to the action:
        // a Manager Plus grant on a 25,000₮ hotel is refused here as well as at
        // every API the role would have opened (doc 18 §4).
        assertRolesEntitled([input.role], entitled);
        // …and the scope gate applies too: doc 19 §3 gives a restaurant-scoped
        // membership exactly one role, and gives that role to nobody else.
        assertScopeAllowsRoles([input.role], membership.restaurantId);
        if (input.role === 'HOTEL_ADMIN' && membership.isPrimaryAdmin) {
          throw new ApiError('CONFLICT', 'the Primary Hotel Admin already holds this role');
        }
      }
      if (direction === 'remove' && input.role === 'HOTEL_ADMIN' && membership.isPrimaryAdmin) {
        // `STAFF-DEC-006`. Refused here so the caller gets a reason, and refused
        // again by the role-grant guard so no other path can do it either.
        throw new ApiError(
          'FORBIDDEN',
          'the Primary Hotel Admin keeps the HOTEL_ADMIN role; the transfer is the Platform process',
        );
      }

      const changed =
        direction === 'add'
          ? await memberships.grantRole(
              membership.membershipId,
              input.role,
              gate.principal.accountId,
            )
          : await memberships.revokeRole(
              membership.membershipId,
              input.role,
              gate.principal.accountId,
              input.reason ?? 'role_removed',
            );

      // doc 19 §7: the change takes effect in that scope at once, and the scope's
      // sessions are closed so the holder signs in again with the new set.
      const moved = await memberships.transition({
        membershipId: membership.membershipId,
        expectedRevision: membership.membershipRevision,
      });
      if (!moved) throw new ApiError('REVISION_MISMATCH', 'the membership changed concurrently');
      await memberships.revokeScopeGrants(membership.membershipId, `role_${direction}`);

      await recordPlatformAudit(uow, {
        action: `iam.role.${direction === 'add' ? 'granted' : 'revoked'}`,
        outcome: 'allowed',
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        payload: { role: input.role, changed },
      });

      const result = { granted: changed };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  // ------------------------------------------------ suspension and termination
  /**
   * Suspends or terminates a membership.
   *
   * The security effect commits immediately and is never delayed by open work
   * (`STAFF-DEC-007`): permissions, the scope's sessions and the scope's
   * permission cache all die in this transaction, and the unfinished work
   * becomes a handoff item in the same one.
   */
  async setMembershipState(
    actor: CommandActor,
    input: {
      hotelId: string;
      membershipId: string;
      state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE';
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<MembershipStateResult> {
    if (input.reason.trim().length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'a state change needs a reason');
    }

    const committed = await this.applyMembershipState(actor, input, request);
    if (committed.handoffDiscovery !== 'PENDING') return committed;

    // The security effect is already committed and cannot be undone from here.
    // This is the same reconciliation a later call performs, run once
    // immediately because the provider is usually up — and when it is not, the
    // marker stays and the caller is told so.
    try {
      const reconciled = await this.handoff.reconcileDiscovery(
        actor,
        {
          hotelId: input.hotelId,
          membershipId: input.membershipId,
          idempotencyKey: derivedIdempotencyKey('handoff.discovery', input.idempotencyKey),
        },
        request,
      );
      if (reconciled.resolved === 0) return committed;
      return { ...committed, handoffItems: reconciled.items, handoffDiscovery: 'COMPLETED' };
    } catch {
      // Reconciliation is retryable and its marker is durable. A failure here
      // changes nothing about the suspension, which is the point.
      return committed;
    }
  }

  private async applyMembershipState(
    actor: CommandActor,
    input: {
      hotelId: string;
      membershipId: string;
      state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE';
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<MembershipStateResult> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await this.authorize(gate, {
        uow,
        permission: 'hotel.staff.invite_suspend',
        hotelId: input.hotelId,
        restaurantId: null,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

      assertNotSelfAction(gate.principal.accountId, membership, input.state);
      assertPrimaryProtected(membership, input.state);

      const claimed = await this.claim(uow, 'iam.membership.state', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as MembershipStateResult;

      const moved = await memberships.transition({
        membershipId: membership.membershipId,
        expectedRevision: membership.membershipRevision,
        state: input.state,
        reason: input.reason,
      });
      if (!moved) throw new ApiError('REVISION_MISMATCH', 'the membership changed concurrently');

      let discoveryOpened = false;
      if (input.state === 'SUSPENDED' || input.state === 'TERMINATED') {
        // Immediately: the scope's sessions, and every role the membership held
        // if this is a termination.
        await memberships.revokeScopeGrants(membership.membershipId, input.state.toLowerCase());
        if (input.state === 'TERMINATED') {
          await memberships.revokeAllRoles(
            membership.membershipId,
            gate.principal.accountId,
            'membership_terminated',
          );
        }
        // What work this person still holds is asked of the modules that own it
        // (doc 19 §8.1) — and that question is *not* asked here. It is a call to
        // another system, and a call to another system can fail; asking it
        // inside this transaction meant a provider outage rolled the suspension
        // back and left the member active with live sessions.
        //
        // So this transaction records that the question exists, atomically with
        // the security effect it belongs to, and answering it is a separate
        // retryable step. The marker is what keeps the third possibility — an
        // unreachable provider quietly meaning "no open work" — off the table.
        //
        // Bound to the revision this very transition produced, and to the state
        // it produced. `transition` advances the revision by exactly one, so a
        // later reactivation or termination makes this marker recognisably
        // stale rather than silently applicable to whatever the membership
        // became.
        // A transition supersedes whatever question the previous one left open
        // and asks its own. A direct SUSPENDED → TERMINATED otherwise reused the
        // suspension's marker — its reason, its revision and its seed — and so
        // enumerated the termination's work under the wrong transition.
        const discovery = new HandoffDiscoveryRepository(uow);
        await discovery.supersedeOpen(membership.membershipId, 'superseded_by_new_transition');
        await discovery.open({
          membershipId: membership.membershipId,
          openedReason: input.state === 'SUSPENDED' ? 'suspension' : 'termination',
          expectedState: input.state,
          membershipRevision: membership.membershipRevision + 1,
          idempotencySeed: input.idempotencyKey,
        });
        discoveryOpened = true;
      }

      if (input.state === 'ACTIVE') {
        // doc 19 §8: reactivation is explicit, carries a reason, and never
        // restores an old session — the scope grants stay revoked and the holder
        // signs in again.
        await memberships.revokeScopeGrants(membership.membershipId, 'reactivated');
        // And the suspension's unanswered question is closed in the same
        // transaction. The person is working; their work is theirs.
        await new HandoffDiscoveryRepository(uow).supersedeOpen(
          membership.membershipId,
          'membership_reactivated',
        );
      }

      await recordPlatformAudit(uow, {
        action: `iam.membership.${input.state.toLowerCase()}`,
        outcome: 'allowed',
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
        reason: input.reason,
        payload: { previousState: membership.state, handoffDiscovery: discoveryOpened },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'staff_membership',
        aggregateId: membership.membershipId,
        eventType: `iam.membership.${input.state.toLowerCase()}`,
        payload: { membershipId: membership.membershipId, state: input.state },
      });

      // The recorded result is the *security* transition, which is all this
      // transaction decided. What discovery then found is added to the live
      // response below; a retry of this key replays the transition and does not
      // re-apply it, which is what an idempotency record is for.
      const result: MembershipStateResult = {
        state: input.state,
        handoffItems: [],
        handoffDiscovery: discoveryOpened ? 'PENDING' : 'NOT_REQUIRED',
      };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  // ---------------------------------------------------------- password resets
  /**
   * Requests a reset link for a registered address.
   *
   * The response never says whether the address is known. A live request is
   * superseded rather than duplicated, so the most recent link is the only one
   * that works.
   */
  async requestPasswordReset(email: string, request: RequestContext): Promise<void> {
    // One bounded write, and nothing else.
    //
    // Normalising the status and the body was necessary but not sufficient: the
    // previous shape still looked the address up, derived a keyed token and
    // waited on a notification provider — but only when the account existed. A
    // caller who could not read the response could still *time* it, and an
    // unreachable or merely slow provider widened that gap from microseconds to
    // seconds. The work itself has to be identical, so the account-specific part
    // moves behind a durable queue and this path never touches KMS, the account
    // tables, or the provider.
    const normalized = normaliseEmail(email);
    await this.inAccountScope(request, async (uow) => {
      const intakeId = await new AccountRepository(uow).queueResetIntake(normalized);
      // Audited without an account reference, because none has been resolved —
      // and resolving one to write a nicer audit row would be the oracle again.
      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_queued',
        outcome: 'allowed',
        targetType: 'password_reset_intake',
        targetRef: intakeId,
      });
    });
  }

  /**
   * Drains the queued public reset requests.
   *
   * Everything the public path deliberately does not do: resolve the address,
   * apply the resend interval, record the reset and its delivery intent, hand
   * the link to the provider and acknowledge it. Each entry is *owned* through a
   * lease before any of that starts, and every settlement is a compare-and-set
   * on the lease token, so two workers can drain at once and one entry is still
   * processed once.
   *
   * Invoked by the scheduled worker that lands with the email provider; until
   * then the only sender is a simulator and `INT-MAIL-01` still records the gap.
   */
  async drainPasswordResetIntake(limit = 32): Promise<number> {
    const request = newRequestContext();
    const parameters = this.parameters;
    const claimed = await this.inAccountScope(request, (uow) =>
      new AccountRepository(uow).claimResetIntake(limit, parameters.passwordResetLeaseSeconds),
    );

    let processed = 0;
    for (const entry of claimed) {
      const outcome = await this.processResetIntake(entry, request);
      await this.settleResetIntake(entry, outcome, request);
      processed += 1;
    }
    return processed;
  }

  /**
   * Settles one owned entry: terminal for a decision, retryable for an outage.
   *
   * A provider that could not be reached says nothing about the request, so it
   * must not end it. What it does end is patience: after the configured number
   * of attempts the entry becomes a dead letter an operator can see, because an
   * address the provider never accepts should stop consuming retries and start
   * being a fact somebody knows.
   */
  private async settleResetIntake(
    entry: ResetIntakeRow,
    outcome: ResetIntakeOutcome,
    request: RequestContext,
  ): Promise<void> {
    const parameters = this.parameters;
    const retryable = outcome === 'unavailable';
    // `dead_letter` arrives already decided — an intent that expired with no
    // retry budget left — so it is terminal without another attempt.
    const exhausted =
      outcome === 'dead_letter' || entry.attempts >= parameters.passwordResetDeliveryMaxAttempts;

    await this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      let settled: boolean;
      let recorded: ResetIntakeOutcome = outcome;

      if (retryable && !exhausted) {
        settled = await accounts.retryResetIntake(
          entry.intakeId,
          entry.claimToken,
          outcome,
          backoffSeconds(entry.attempts, parameters),
          'the notification provider did not accept the delivery',
        );
      } else if (retryable || outcome === 'dead_letter') {
        recorded = 'dead_letter';
        settled = await accounts.settleResetIntake(
          entry.intakeId,
          entry.claimToken,
          recorded,
          'DEAD_LETTER',
        );
      } else {
        settled = await accounts.settleResetIntake(entry.intakeId, entry.claimToken, outcome);
      }

      // The lease is the only thing that entitles this worker to settle. If it
      // was reclaimed while the delivery was in flight, the row belongs to
      // somebody else and this worker writes nothing — including no second
      // settlement audit.
      if (!settled) {
        throw new ApiError('CONFLICT', 'the reset intake lease is no longer held');
      }

      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_intake_settled',
        outcome: 'allowed',
        targetType: 'password_reset_intake',
        targetRef: entry.intakeId,
        reason: recorded,
        payload: { attempts: entry.attempts, retryable: retryable && !exhausted },
      });
    });
  }

  /**
   * Resolves one queued address and delivers its link.
   *
   * The reset and its delivery intent are committed **before** the provider is
   * contacted, and the one-time secret is held under envelope encryption until
   * it has been. Delivering from inside the recording transaction was the
   * failure this avoids: a provider that accepted a link the transaction then
   * failed to commit sent a link to nothing.
   */
  private async processResetIntake(
    entry: ResetIntakeRow,
    request: RequestContext,
  ): Promise<ResetIntakeOutcome> {
    let intent: PreparedDelivery | 'ignored' | 'throttled' | 'already_delivered' | 'dead_letter';
    try {
      intent = await this.prepareResetDelivery(entry, request);
    } catch {
      return 'unavailable';
    }
    if (intent === 'ignored' || intent === 'throttled' || intent === 'dead_letter') return intent;
    // Already in the recipient's hands: settle, and send nothing.
    if (intent === 'already_delivered') return 'sent';

    try {
      await this.deps.notifications.deliver({
        kind: 'password_reset',
        // Stable across retries, so a provider that already sent this message
        // recognises the repeat and does not send a second visible one.
        deliveryId: intent.deliveryId,
        accountId: intent.accountId,
        resetId: intent.resetId,
        emailNormalized: intent.emailNormalized,
        expiresAt: intent.expiresAt,
        token: intent.token,
      });
    } catch {
      return 'unavailable';
    }

    try {
      await this.inAccountScope(request, async (uow) => {
        await establishAccountScope(uow, intent.accountId);
        await new AccountRepository(uow).markResetDelivered(intent.resetId);
      });
    } catch {
      // The provider took it; the acknowledgement did not land. The entry stays
      // retryable and the next attempt recovers the same intent, so the
      // recipient still sees one message.
      return 'unavailable';
    }
    return 'sent';
  }

  /**
   * Commits the reset and the delivery intent, or says why there is none.
   *
   * An intent that is already recorded and not yet delivered is *reused* — that
   * is what a retry after a lost acknowledgement finds — and the resend interval
   * is not consulted for it, because it is the same request, not a new one.
   */
  private async prepareResetDelivery(
    entry: ResetIntakeRow,
    request: RequestContext,
  ): Promise<PreparedDelivery | 'ignored' | 'throttled' | 'already_delivered' | 'dead_letter'> {
    return this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      const account = await accounts.findByEmail('hotel', entry.emailNormalized);
      if (account === undefined || account.state !== 'ACTIVE') return 'ignored';
      await establishAccountScope(uow, account.accountId);

      // The intent this queue entry owns, if it has one.
      const bound = await accounts.resetForIntake(entry.intakeId);
      if (bound !== undefined) {
        if (bound.deliveredAt !== null) {
          // The provider took it and the row says so; only the settlement was
          // lost. Settle the entry — do not mint or send anything.
          return 'already_delivered';
        }
        if (bound.state !== 'ACTIVE') return 'ignored';

        // Expiry is checked against the database clock, before the secret is
        // decrypted and long before a provider is contacted. Reusing an intent
        // without this sent a link that was already dead on arrival.
        if (bound.expiresAt <= uow.serverNow) {
          await accounts.terminaliseReset(bound.resetId, 'EXPIRED', 'expired_before_delivery');
          if (entry.attempts >= this.parameters.passwordResetDeliveryMaxAttempts) {
            return 'dead_letter';
          }
          // …and fall through to mint a replacement for this same entry.
        } else {
          const ciphertext = bound.ciphertext;
          const wrappedDek = bound.wrappedDek;
          const keyVersion = bound.keyVersion;
          if (ciphertext === null || wrappedDek === null || keyVersion === null) {
            // Undelivered, live, and holding no secret: nothing can be sent from
            // this row and nothing may be invented for it.
            return 'ignored';
          }
          const token = await decryptValue(
            this.deps.keys,
            DELIVERY_SECRET_SCOPE,
            {
              ciphertext: Buffer.from(ciphertext, 'base64'),
              wrappedDek: Buffer.from(wrappedDek, 'base64'),
              keyVersion,
            },
            deliveryAad(bound.resetId),
          );
          return {
            accountId: account.accountId,
            emailNormalized: account.emailNormalized,
            resetId: bound.resetId,
            deliveryId: bound.deliveryId,
            expiresAt: bound.expiresAt,
            token,
          };
        }
      }

      const live = await accounts.activeResetFor(account.accountId);
      if (live !== undefined) {
        const sinceLast = uow.serverNow.getTime() - live.createdAt.getTime();
        if (sinceLast < this.parameters.passwordResetResendIntervalSeconds * 1000) {
          return 'throttled';
        }
        await accounts.terminaliseReset(live.resetId, 'SUPERSEDED', 'superseded_by_new_request');
      }

      const resetId = randomUUID();
      const issued = await this.tokens.issue('password_reset', RESET_TOKEN_SUBJECT);
      const sealed = await encryptValue(
        this.deps.keys,
        DELIVERY_SECRET_SCOPE,
        issued.token,
        deliveryAad(resetId),
      );
      const created = await accounts.createReset({
        resetId,
        intakeId: entry.intakeId,
        accountId: account.accountId,
        tokenHash: issued.tokenHash,
        tokenKeyVersion: issued.keyVersion,
        ttlSeconds: this.parameters.passwordResetTtlSeconds,
        initiatedBy: entry.initiatedBy,
        initiatedByAccountId: entry.initiatedByAccountId,
        secret: {
          ciphertext: Buffer.from(sealed.ciphertext).toString('base64'),
          wrappedDek: Buffer.from(sealed.wrappedDek).toString('base64'),
          keyVersion: sealed.keyVersion,
        },
      });

      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_requested',
        outcome: 'allowed',
        targetType: 'password_reset_request',
        targetRef: created.resetId,
        payload: { accountId: account.accountId, initiatedBy: entry.initiatedBy },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'password_reset_request',
        aggregateId: created.resetId,
        eventType: 'iam.password_reset.email_requested',
        payload: {
          resetId: created.resetId,
          deliveryId: created.deliveryId,
          accountId: account.accountId,
          emailNormalized: account.emailNormalized,
          initiatedBy: entry.initiatedBy,
        },
      });

      return {
        accountId: account.accountId,
        emailNormalized: account.emailNormalized,
        resetId: created.resetId,
        deliveryId: created.deliveryId,
        expiresAt: created.expiresAt,
        token: issued.token,
      };
    });
  }

  /** Claims entries without processing them. Test surface for the lease. */
  claimResetIntakeForTest(limit: number): Promise<readonly ResetIntakeRow[]> {
    return this.inAccountScope(newRequestContext(), (uow) =>
      new AccountRepository(uow).claimResetIntake(limit, this.parameters.passwordResetLeaseSeconds),
    );
  }

  /** Processes one claimed entry without settling it. Test surface for a lost ack. */
  processClaimedIntakeForTest(entry: ResetIntakeRow): Promise<ResetIntakeOutcome> {
    return this.processResetIntake(entry, newRequestContext());
  }

  /**
   * A Hotel Admin asks for the reset email to be sent again (doc 19 §6).
   *
   * The link goes to the account's own registered address; the initiator never
   * chooses the address and never sees the token or either password.
   */
  async initiatePasswordReset(
    actor: CommandActor,
    input: { hotelId: string; membershipId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ initiated: boolean }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined || membership.accountId === null) {
        throw new ApiError('NOT_FOUND', 'not found');
      }

      await this.authorize(gate, {
        uow,
        permission: 'hotel.staff.invite_suspend',
        hotelId: input.hotelId,
        restaurantId: null,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

      const claimed = await this.claim(uow, 'iam.reset.initiate', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { initiated: boolean };

      const accounts = new AccountRepository(uow);
      const account = await accounts.findById(membership.accountId);
      if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

      // Queued through the same durable path the public request uses, so one
      // delivery mechanism carries both and a Hotel Admin cannot produce a
      // second live link by another route. What differs is what the initiator
      // may see: they are authenticated, hold the permission and already know
      // this member exists, so an operational failure here is information they
      // are entitled to rather than an oracle — and queueing failing is one.
      await new AccountRepository(uow).queueResetIntake(account.emailNormalized, {
        by: 'hotel_admin',
        accountId: gate.principal.accountId,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_queued',
        outcome: 'allowed',
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
        reason: 'hotel_admin',
      });

      const result = { initiated: true };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 202, result);
      return result;
    });
  }

  /**
   * Redeems a reset link.
   *
   * On success the credential is replaced, the account epoch is bumped and every
   * session on every device and in every membership is closed (`STAFF-DEC-003`).
   * Role, membership and subscription state are untouched.
   */
  async confirmPasswordReset(
    input: { token: string; password: string },
    request: RequestContext,
  ): Promise<{ accountId: string; sessionsClosed: number }> {
    assertPasswordAcceptable(input.password);

    return this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      const invalid = new ApiError('NOT_FOUND', 'not found');

      // The digest is bound to the account, which is not known yet, so the
      // lookup is by the account-bound digest of every candidate — in practice
      // the token itself carries no account, so the row is found by trying the
      // digest bound to each account the token could belong to. Binding to the
      // reset id instead keeps that a single lookup.
      const bare = await this.tokens.digest('password_reset', RESET_TOKEN_SUBJECT, input.token);
      const reset = await accounts.findResetByHash(bare.tokenHash);
      if (reset === undefined || reset.state !== 'ACTIVE') throw invalid;
      if (reset.expiresAt <= uow.serverNow) {
        await accounts.terminaliseReset(reset.resetId, 'EXPIRED', 'expired');
        throw invalid;
      }

      const account = await accounts.lockById(reset.accountId);
      if (account === undefined || account.state !== 'ACTIVE') throw invalid;

      const derived = await derivePassword(input.password);
      await accounts.upsertPassword(account.accountId, derived.secretHash, derived.paramsVersion);
      await accounts.terminaliseReset(reset.resetId, 'USED', 'redeemed');

      const sessionsClosed = await accounts.revokeAllSessions(account.accountId, 'password_reset');
      const bumped = await accounts.bumpAuthEpoch(account.accountId, account.revision);
      if (!bumped) throw new ApiError('REVISION_MISMATCH', 'the account changed concurrently');

      // The scope grants are the account's own rows, and `own_account_scope`
      // carries them only to a transaction that has said which account it is
      // acting as. The reset arrives unauthenticated — the token is what
      // identifies the account — so the context is established from the *reset
      // row* before the revocation, and the result is asserted: without this the
      // UPDATE matched nothing and reported success, leaving every scoped
      // session alive after a password change (doc 19 §10, `STAFF-DEC-003`).
      await establishAccountScope(uow, account.accountId);
      const memberships = new MembershipRepository(uow);
      const live = await memberships.liveScopeGrantCountForAccount(account.accountId);
      const scopesClosed = await memberships.revokeAllScopeGrantsForAccount(
        account.accountId,
        'password_reset',
      );
      if (scopesClosed !== live) {
        throw new ApiError('INTERNAL_ERROR', 'the scope revocation did not cover every grant');
      }
      await accounts.markEmailVerified(account.accountId);

      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_completed',
        outcome: 'allowed',
        targetType: 'user_account',
        targetRef: account.accountId,
        payload: { sessionsClosed, scopesClosed },
      });

      return { accountId: account.accountId, sessionsClosed };
    });
  }

  // ------------------------------------------------------------------ helpers
  /**
   * Commit-time authorization, against the state this transaction has locked.
   *
   * Everything the pipeline needs comes from the gate — the session, its
   * step-up recency, the account it proved — and nothing from the request. The
   * decision is re-derived here rather than carried over from the gate, so a
   * suspension or a role change that committed in between wins.
   */
  private authorize(
    gate: HotelGate,
    input: {
      uow: UnitOfWork;
      permission: string;
      hotelId: string;
      restaurantId: string | null;
      targetType?: string;
      targetRef?: string;
    },
  ): ReturnType<typeof authorizeCommand> {
    return authorizeCommand({
      uow: input.uow,
      endpointRealm: 'hotel',
      permission: input.permission,
      principal: gate.principal,
      sessionId: gate.sessionId,
      ...(gate.principal.stepUpAt === undefined ? {} : { stepUpAt: gate.principal.stepUpAt }),
      target: {
        hotelId: input.hotelId,
        ...(input.restaurantId === null ? {} : { restaurantId: input.restaurantId }),
      },
      subscription: this.deps.subscription,
      ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
      ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    });
  }

  private async claim(
    uow: UnitOfWork,
    operation: string,
    key: string,
    payload: unknown,
  ): Promise<{ idempotencyId: string; replay?: unknown }> {
    const outcome = await claimIdempotencyKey(uow, {
      operation,
      key,
      clientRef: 'iam',
      payload,
    });
    switch (outcome.kind) {
      case 'claimed':
        return { idempotencyId: outcome.idempotencyId };
      case 'replay':
        return { idempotencyId: '', replay: outcome.body };
      case 'in_progress':
        throw new ApiError('IDEMPOTENT_REQUEST_IN_PROGRESS', 'the same request is still running');
      default:
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'the key was used with a different request');
    }
  }

  private async issueInvitation(
    uow: UnitOfWork,
    input: {
      hotelId: string;
      membership: MembershipRow;
      email: string;
      roles: readonly HotelRole[];
      actorAccountId: string;
      action: string;
      supersede?: string;
    },
  ): Promise<InvitationCreated> {
    const memberships = new MembershipRepository(uow);
    const ttl = this.parameters.invitationTtlSeconds;

    // The digest is bound to the membership, so a token minted for one
    // membership can never be redeemed against another.
    const issued = await this.tokens.issue('invitation', input.membership.membershipId);
    if (input.supersede !== undefined) {
      await memberships.terminaliseInvitation(input.supersede, 'SUPERSEDED', 'resent');
    }
    const invitation = await memberships.createInvitation({
      membershipId: input.membership.membershipId,
      tokenHash: issued.tokenHash,
      tokenKeyVersion: issued.keyVersion,
      emailNormalized: input.email,
      createdByAccountId: input.actorAccountId,
      ttlSeconds: ttl,
      roles: input.roles,
    });

    const moved = await memberships.transition({
      membershipId: input.membership.membershipId,
      expectedRevision: input.membership.membershipRevision,
    });
    if (!moved) throw new ApiError('REVISION_MISMATCH', 'the membership changed concurrently');

    await recordPlatformAudit(uow, {
      action: input.action,
      outcome: 'allowed',
      targetType: 'staff_invitation',
      targetRef: invitation.invitationId,
      payload: {
        membershipId: input.membership.membershipId,
        roles: [...input.roles],
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });
    // A durable delivery intent, carrying no secret: the token reaches the
    // notification port and nothing else (CLAUDE.md §8).
    await appendOutboxEvent(uow, {
      aggregateType: 'staff_invitation',
      aggregateId: invitation.invitationId,
      eventType: 'iam.invitation.email_requested',
      payload: {
        invitationId: invitation.invitationId,
        membershipId: input.membership.membershipId,
        emailNormalized: input.email,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });

    // Delivery is part of the transaction: a link that could not be handed over
    // is an invitation that was never issued (CLAUDE.md §9, fail closed).
    await this.deps.notifications.deliver({
      kind: 'staff_invitation',
      hotelId: input.hotelId,
      invitationId: invitation.invitationId,
      emailNormalized: input.email,
      expiresAt: invitation.expiresAt,
      token: issued.token,
    });

    return {
      invitationId: invitation.invitationId,
      membershipId: input.membership.membershipId,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Finds the invitation a token belongs to, inside one hotel scope.
   *
   * The digest is bound to the membership, so it cannot be computed without
   * knowing which membership the token was minted for: every live invitation in
   * this hotel is a candidate and the comparison is on digests, in constant
   * time, so a wrong token is indistinguishable from an unknown one. The hotel
   * comes from the link, not from a search — a token cannot be probed across
   * tenants because the whole transaction runs under one hotel's scope.
   */
  private async resolveInvitation(
    uow: UnitOfWork,
    hotelId: string,
    token: string,
    options: { lock?: boolean } = {},
  ): Promise<{ invitation: InvitationRow; membership: MembershipRow }> {
    const memberships = new MembershipRepository(uow);
    const invalid = new ApiError('NOT_FOUND', 'not found');

    const candidates = await uow.query<{ membership_id: string }>(
      `SELECT i.membership_id
         FROM platform.staff_invitation i
        WHERE i.hotel_id = $1 AND i.state = 'ACTIVE'`,
      [hotelId],
    );

    for (const candidate of candidates.rows) {
      const digest = await this.tokens.digest('invitation', candidate.membership_id, token);
      const invitation = await memberships.findInvitationByHash(digest.tokenHash);
      if (invitation === undefined || invitation.state !== 'ACTIVE') continue;
      if (invitation.expiresAt <= uow.serverNow) {
        throw new InvitationExpiredError(hotelId, invitation.invitationId);
      }
      const membership =
        options.lock === true
          ? await memberships.lock(invitation.membershipId)
          : await memberships.find(invitation.membershipId);
      if (membership === undefined) throw invalid;
      return { invitation, membership };
    }
    throw invalid;
  }

  private async assertInviterStillAuthorised(
    uow: UnitOfWork,
    hotelId: string,
    invitationId: string,
    roles: readonly HotelRole[],
  ): Promise<void> {
    const creator = await uow.query<{
      created_by_account_id: string;
      restaurant_id: string | null;
    }>(
      `SELECT i.created_by_account_id, m.restaurant_id
         FROM platform.staff_invitation i
         JOIN platform.staff_membership m
           ON m.hotel_id = i.hotel_id AND m.membership_id = i.membership_id
        WHERE i.hotel_id = $1 AND i.invitation_id = $2`,
      [hotelId, invitationId],
    );
    const row = creator.rows[0];
    if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');

    const inviter = await resolvePrincipal(uow, row.created_by_account_id);
    if (inviter === undefined)
      throw new ApiError('CONFLICT', 'the inviter is no longer authorised');

    const snapshot = await this.deps.subscription.snapshot(hotelId, uow.serverNow);
    const decision = authorize({
      endpointRealm: 'hotel',
      permission: invitePermissionFor(roles, row.restaurant_id),
      principal: inviter,
      target: {
        hotelId,
        ...(row.restaurant_id === null ? {} : { restaurantId: row.restaurant_id }),
      },
      ...(snapshot === undefined ? {} : { subscription: snapshot }),
      now: uow.serverNow,
    });
    if (!decision.allowed) {
      throw new ApiError('CONFLICT', 'the inviter is no longer authorised');
    }
  }

  private async resolveAcceptingAccount(
    uow: UnitOfWork,
    accounts: AccountRepository,
    invitation: { emailNormalized: string },
    input: AcceptInvitationInput,
  ): Promise<string> {
    const existing = await accounts.findByEmail('hotel', invitation.emailNormalized);

    if (input.accountId !== undefined) {
      // doc 19 §5: an address that already has an account never gets a second
      // one, and the signed-in account's verified address must be the invited
      // one.
      // Active, the invited address, and an address this account has actually
      // proved. Without the last condition a membership could be bound to an
      // address nobody demonstrated control of: anyone who registered
      // `someone@else` and was never challenged could accept an invitation
      // addressed to the real holder. The identity is the session's, never the
      // request body's — `input.accountId` comes from the verified bearer.
      const account = await accounts.findById(input.accountId);
      if (
        account === undefined ||
        account.state !== 'ACTIVE' ||
        account.emailVerifiedAt === null ||
        account.emailNormalized !== invitation.emailNormalized
      ) {
        // The same refusal an unknown token gets: nothing here says which of
        // the four conditions failed, or that the account exists at all.
        throw new ApiError('NOT_FOUND', 'not found');
      }
      return account.accountId;
    }

    if (existing !== undefined) {
      throw new ApiError(
        'CONFLICT',
        'this address already has an account; sign in and accept the invitation',
      );
    }
    if (input.password === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'a new account needs a password to be created');
    }

    const created = await accounts.create('hotel', invitation.emailNormalized, true);
    const derived = await derivePassword(input.password);
    await accounts.upsertPassword(created.accountId, derived.secretHash, derived.paramsVersion);
    await recordPlatformAudit(uow, {
      action: 'iam.account.activated',
      outcome: 'allowed',
      targetType: 'user_account',
      targetRef: created.accountId,
    });
    return created.accountId;
  }
}

/** The reset token is looked up before its account is known. */
const RESET_TOKEN_SUBJECT = 'password_reset';

/**
 * The subject the accept-time idempotency digest is bound to.
 *
 * Distinct from the per-membership subject the invitation token itself is minted
 * under: this digest exists only to tell two presented secrets apart inside an
 * idempotency record, and binding it to a fixed subject means it can be computed
 * before the membership is known — while still never being the stored token
 * digest, so a leaked idempotency payload is not a usable invitation.
 */
const ACCEPT_DIGEST_SUBJECT = 'invitation_accept_request';

/**
 * Which permission an invitation needs.
 *
 * doc 19 §3: a Hotel Admin invites hotel staff; a Manager Plus invites a
 * Restaurant Manager into a restaurant it registered, and grants no general
 * hotel role there.
 */
function invitePermissionFor(roles: readonly HotelRole[], restaurantId: string | null): string {
  const restaurantOnly =
    restaurantId !== null && roles.every((role) => role === 'RESTAURANT_MANAGER');
  return restaurantOnly ? 'hotel.restaurant.manager_invite' : 'hotel.staff.invite_suspend';
}

/**
 * The scope gate on a role assignment (doc 19 §3, doc 06 §4.1).
 *
 * A restaurant-scoped membership holds exactly `RESTAURANT_MANAGER`, and that
 * role exists nowhere else. Refused here so the caller learns why, and refused
 * again by the role-grant and requested-role guards so no path can produce the
 * combination — including one a later phase writes.
 */
function assertScopeAllowsRoles(roles: readonly HotelRole[], restaurantId: string | null): void {
  for (const role of roles) {
    if (restaurantId === null && role === 'RESTAURANT_MANAGER') {
      throw new ApiError(
        'VALIDATION_FAILED',
        'RESTAURANT_MANAGER belongs to a restaurant scope, not to a hotel-wide membership',
      );
    }
    if (restaurantId !== null && role !== 'RESTAURANT_MANAGER') {
      throw new ApiError(
        'VALIDATION_FAILED',
        `a restaurant-scoped membership holds only RESTAURANT_MANAGER, not ${role}`,
      );
    }
  }
}

/**
 * The package gate on a role **assignment** (doc 18 §4).
 *
 * Distinct from the gate on the action: creating a Manager Plus role on a
 * 25,000₮ hotel is refused here, and every action that role would have opened is
 * refused again by the pipeline. Two independent refusals, deliberately.
 */
function assertRolesEntitled(roles: readonly HotelRole[], packageCode: PackageCode): void {
  for (const role of roles) {
    if (!isRoleAssignableIn(role, packageCode)) {
      throw new ApiError('FORBIDDEN', `the hotel package does not include the ${role} role`);
    }
  }
}

function assertNotSelfAction(
  actorAccountId: string,
  membership: MembershipRow,
  state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE',
): void {
  if (state === 'ACTIVE') return;
  if (membership.accountId !== null && membership.accountId === actorAccountId) {
    throw new ApiError('FORBIDDEN', 'an account cannot suspend or terminate its own membership');
  }
}

function assertPrimaryProtected(
  membership: MembershipRow,
  state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE',
): void {
  if (!membership.isPrimaryAdmin) return;
  if (state !== 'ACTIVE') {
    throw new ApiError(
      'FORBIDDEN',
      'the Primary Hotel Admin is transferred by the Platform offline process, not by a staff action',
    );
  }
}

/** The scope the one-time delivery secret is sealed under (ADR-0020 §5). */
const DELIVERY_SECRET_SCOPE: KeyScope = 'auth.delivery_secret';

/** Binds a sealed secret to its row, column and id (ADR-0020 §4). */
function deliveryAad(resetId: string): { table: string; column: string; rowRef: string } {
  return {
    table: 'platform.password_reset_request',
    column: 'secret_ciphertext',
    rowRef: resetId,
  };
}

/** A committed delivery intent, ready to hand to a provider. */
interface PreparedDelivery {
  readonly accountId: string;
  readonly emailNormalized: string;
  readonly resetId: string;
  readonly deliveryId: string;
  readonly expiresAt: Date;
  readonly token: string;
}

/** Exponential, capped. Provisional with the rest of P1-06. */
function backoffSeconds(
  attempts: number,
  parameters: {
    passwordResetRetryBackoffSeconds: number;
    passwordResetRetryBackoffCeilingSeconds: number;
  },
): number {
  const raw = parameters.passwordResetRetryBackoffSeconds * 2 ** Math.max(0, attempts - 1);
  return Math.min(raw, parameters.passwordResetRetryBackoffCeilingSeconds);
}
