import type { HotelRole, PackageCode, Principal } from '@prsystem/authz';
import { authorize, isRoleAssignableIn } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import { AccountRepository, normaliseEmail } from '../repositories/account.repository';
import type { InvitationRow, MembershipRow } from '../repositories/membership.repository';
import { MembershipRepository } from '../repositories/membership.repository';
import { authorizeCommand, resolvePrincipal } from './authorization.service';
import type { IamDependencies, RequestContext } from './iam-context';
import { IamServiceBase } from './iam-context';
import { HandoffService } from './handoff.service';
import { assertPasswordAcceptable, derivePassword } from './password.service';

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
    actor: Principal,
    input: InvitationInput,
    request: RequestContext,
  ): Promise<InvitationCreated> {
    const email = normaliseEmail(input.email);
    const restaurantId = input.restaurantId ?? null;
    const permission = invitePermissionFor(input.roles, restaurantId);

    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claim(uow, 'iam.invitation.create', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as InvitationCreated;

      const decision = await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission,
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(restaurantId === null ? {} : { restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
      });

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
          createdByAccountId: actor.accountId,
        }));

      if (existing !== undefined && existing.state !== 'PENDING') {
        // doc 19 §4: a scope already holds a canonical membership. Re-inviting an
        // active, suspended or terminated person is the reactivation of §8, not a
        // second membership row.
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
        actorAccountId: actor.accountId,
        action: 'iam.invitation.created',
      });

      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, created);
      return created;
    });
  }

  /**
   * Resends: the live token is superseded and a new one issued, in one
   * transaction (doc 19 §4 rule 6). The old link stops working the moment this
   * commits, which is the whole point of `SUPERSEDED` being a state.
   */
  async resendInvitation(
    actor: Principal,
    input: { hotelId: string; membershipId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<InvitationCreated> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claim(uow, 'iam.invitation.resend', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as InvitationCreated;

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

      const decision = await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: invitePermissionFor(roles, membership.restaurantId),
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(membership.restaurantId === null ? {} : { restaurantId: membership.restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });
      const entitled = decision.effectivePackage;
      if (entitled === undefined) throw new ApiError('INTERNAL_ERROR', 'no package was resolved');

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
        actorAccountId: actor.accountId,
        action: 'iam.invitation.resent',
        supersede: live.invitationId,
      });

      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, created);
      return created;
    });
  }

  /** Revokes the live invitation. The membership stays `PENDING` and unarmed. */
  async revokeInvitation(
    actor: Principal,
    input: { hotelId: string; membershipId: string; reason: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ revoked: boolean }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claim(uow, 'iam.invitation.revoke', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { revoked: boolean };

      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: 'hotel.staff.invite_suspend',
        principal: actor,
        target: { hotelId: input.hotelId },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

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
      this.runHotelCommand(input.hotelId, request, async (uow) => {
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

    return this.terminalisingExpiry(request, () =>
      this.runHotelCommand(input.hotelId, request, async (uow) => {
        const claimed = await this.claim(uow, 'iam.invitation.accept', input.idempotencyKey, {
          hotelId: input.hotelId,
          // The token is hashed into the request digest, never stored: the record
          // must distinguish two different accepts without holding either secret.
          token: 'redacted',
          accountId: input.accountId ?? null,
        });
        if (claimed.replay !== undefined) {
          return claimed.replay as { membershipId: string; accountId: string };
        }

        const { invitation, membership } = await this.resolveInvitation(
          uow,
          input.hotelId,
          input.token,
          { lock: true },
        );
        if (membership.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'this invitation can no longer be accepted');
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
    actor: Principal,
    input: { hotelId: string; membershipId: string; role: HotelRole; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ granted: boolean }> {
    return this.changeRole(actor, input, 'add', request);
  }

  async removeRole(
    actor: Principal,
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
    actor: Principal,
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
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const operation = `iam.role.${direction}`;
      const claimed = await this.claim(uow, operation, input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { granted: boolean };

      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission:
          membership.restaurantId === null
            ? 'hotel.staff.role_manage'
            : 'hotel.restaurant.manager_invite',
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(membership.restaurantId === null ? {} : { restaurantId: membership.restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });
      const entitled = decision.effectivePackage;
      if (entitled === undefined) throw new ApiError('INTERNAL_ERROR', 'no package was resolved');

      if (direction === 'add') {
        // The package gate applies to the *assignment*, not only to the action:
        // a Manager Plus grant on a 25,000₮ hotel is refused here as well as at
        // every API the role would have opened (doc 18 §4).
        assertRolesEntitled([input.role], entitled);
        if (input.role === 'HOTEL_ADMIN' && membership.isPrimaryAdmin) {
          throw new ApiError('CONFLICT', 'the Primary Hotel Admin already holds this role');
        }
      }

      const changed =
        direction === 'add'
          ? await memberships.grantRole(membership.membershipId, input.role, actor.accountId)
          : await memberships.revokeRole(
              membership.membershipId,
              input.role,
              actor.accountId,
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
    actor: Principal,
    input: {
      hotelId: string;
      membershipId: string;
      state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE';
      reason: string;
      /** Open work the owning module reports, as opaque references. */
      openWork?: readonly {
        kind: 'reception_shift' | 'cleaner_task' | 'restaurant_order';
        ref: string;
        movementStarted?: boolean;
        restaurantId?: string;
      }[];
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ state: string; handoffItems: readonly string[] }> {
    if (input.reason.trim().length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'a state change needs a reason');
    }

    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claim(uow, 'iam.membership.state', input.idempotencyKey, input);
      if (claimed.replay !== undefined) {
        return claimed.replay as { state: string; handoffItems: readonly string[] };
      }

      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: 'hotel.staff.invite_suspend',
        principal: actor,
        target: { hotelId: input.hotelId },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

      assertNotSelfAction(actor, membership, input.state);
      assertPrimaryProtected(membership, input.state);

      const moved = await memberships.transition({
        membershipId: membership.membershipId,
        expectedRevision: membership.membershipRevision,
        state: input.state,
        reason: input.reason,
      });
      if (!moved) throw new ApiError('REVISION_MISMATCH', 'the membership changed concurrently');

      const handoffItems: string[] = [];
      if (input.state === 'SUSPENDED' || input.state === 'TERMINATED') {
        // Immediately: the scope's sessions, and every role the membership held
        // if this is a termination.
        await memberships.revokeScopeGrants(membership.membershipId, input.state.toLowerCase());
        if (input.state === 'TERMINATED') {
          await memberships.revokeAllRoles(
            membership.membershipId,
            actor.accountId,
            'membership_terminated',
          );
        }
        for (const work of input.openWork ?? []) {
          const item = await this.handoff.openForMembership(uow, {
            membership,
            work,
            reason: input.state === 'SUSPENDED' ? 'suspension' : 'termination',
            idempotencyKey: `${input.idempotencyKey}:${work.kind}:${work.ref}`,
          });
          handoffItems.push(item);
        }
      }

      if (input.state === 'ACTIVE') {
        // doc 19 §8: reactivation is explicit, carries a reason, and never
        // restores an old session — the scope grants stay revoked and the holder
        // signs in again.
        await memberships.revokeScopeGrants(membership.membershipId, 'reactivated');
      }

      await recordPlatformAudit(uow, {
        action: `iam.membership.${input.state.toLowerCase()}`,
        outcome: 'allowed',
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
        reason: input.reason,
        payload: { previousState: membership.state, handoffItems },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'staff_membership',
        aggregateId: membership.membershipId,
        eventType: `iam.membership.${input.state.toLowerCase()}`,
        payload: { membershipId: membership.membershipId, state: input.state },
      });

      const result = { state: input.state, handoffItems };
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
    await this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      const account = await accounts.findByEmail('hotel', email);
      if (account === undefined || account.state !== 'ACTIVE') return;
      await this.issueReset(uow, account.accountId, account.emailNormalized, 'self', null);
    });
  }

  /**
   * A Hotel Admin asks for the reset email to be sent again (doc 19 §6).
   *
   * The link goes to the account's own registered address; the initiator never
   * chooses the address and never sees the token or either password.
   */
  async initiatePasswordReset(
    actor: Principal,
    input: { hotelId: string; membershipId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ initiated: boolean }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claim(uow, 'iam.reset.initiate', input.idempotencyKey, input);
      if (claimed.replay !== undefined) return claimed.replay as { initiated: boolean };

      const memberships = new MembershipRepository(uow);
      const membership = await memberships.lock(input.membershipId);
      if (membership === undefined || membership.accountId === null) {
        throw new ApiError('NOT_FOUND', 'not found');
      }

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: 'hotel.staff.invite_suspend',
        principal: actor,
        target: { hotelId: input.hotelId },
        subscription: this.deps.subscription,
        targetType: 'staff_membership',
        targetRef: membership.membershipId,
      });

      const accounts = new AccountRepository(uow);
      const account = await accounts.findById(membership.accountId);
      if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await this.issueReset(
        uow,
        account.accountId,
        account.emailNormalized,
        'hotel_admin',
        actor.accountId,
      );

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
      await new MembershipRepository(uow).revokeAllScopeGrantsForAccount(
        account.accountId,
        'password_reset',
      );
      await accounts.markEmailVerified(account.accountId);

      await recordPlatformAudit(uow, {
        action: 'iam.password.reset_completed',
        outcome: 'allowed',
        targetType: 'user_account',
        targetRef: account.accountId,
        payload: { sessionsClosed },
      });

      return { accountId: account.accountId, sessionsClosed };
    });
  }

  // ------------------------------------------------------------------ helpers
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

  private async issueReset(
    uow: UnitOfWork,
    accountId: string,
    emailNormalized: string,
    initiatedBy: 'self' | 'hotel_admin',
    initiatedByAccountId: string | null,
  ): Promise<void> {
    const accounts = new AccountRepository(uow);
    const live = await accounts.activeResetFor(accountId);
    if (live !== undefined) {
      const sinceLast = uow.serverNow.getTime() - live.createdAt.getTime();
      if (sinceLast < this.parameters.passwordResetResendIntervalSeconds * 1000) {
        throw new ApiError('RATE_LIMITED', 'a reset link was requested too recently');
      }
      await accounts.terminaliseReset(live.resetId, 'SUPERSEDED', 'superseded_by_new_request');
    }

    const issued = await this.tokens.issue('password_reset', RESET_TOKEN_SUBJECT);
    const resetId = await accounts.createReset({
      accountId,
      tokenHash: issued.tokenHash,
      tokenKeyVersion: issued.keyVersion,
      ttlSeconds: this.parameters.passwordResetTtlSeconds,
      initiatedBy,
      initiatedByAccountId,
    });

    await recordPlatformAudit(uow, {
      action: 'iam.password.reset_requested',
      outcome: 'allowed',
      targetType: 'password_reset_request',
      targetRef: resetId,
      payload: { accountId, initiatedBy },
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'password_reset_request',
      aggregateId: resetId,
      eventType: 'iam.password_reset.email_requested',
      payload: { resetId, accountId, emailNormalized, initiatedBy },
    });
    await this.deps.notifications.deliver({
      kind: 'password_reset',
      accountId,
      resetId,
      emailNormalized,
      expiresAt: new Date(uow.serverNow.getTime() + this.parameters.passwordResetTtlSeconds * 1000),
      token: issued.token,
    });
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
      const account = await accounts.findById(input.accountId);
      if (
        account === undefined ||
        account.state !== 'ACTIVE' ||
        account.emailNormalized !== invitation.emailNormalized
      ) {
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
  actor: Principal,
  membership: MembershipRow,
  state: 'SUSPENDED' | 'TERMINATED' | 'ACTIVE',
): void {
  if (state === 'ACTIVE') return;
  if (membership.accountId !== null && membership.accountId === actor.accountId) {
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
