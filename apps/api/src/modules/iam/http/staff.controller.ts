import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from './session.guard';
import { OptionalSessionGuard, SessionGuard, actorOf, principalOf } from './session.guard';
import { StaffService } from '../services/staff.service';
import { HandoffService } from '../services/handoff.service';
import { newRequestContext } from '../services/iam-context';
import {
  body,
  idempotencyKey,
  optionalUuid,
  requireMembershipState,
  requireRole,
  requireRoles,
  requireString,
  requireUuid,
} from './validation';

/**
 * The staff lifecycle surface (doc 19).
 *
 * `hotelId` is in the path because a request has to name its target; it grants
 * nothing. Every handler passes it to the command, which resolves the actor's
 * membership for that hotel and refuses with the same `NOT_FOUND` a caller
 * outside the tenant would see (doc 06 §2, §5).
 */
@ApiTags('iam')
@Controller('hotels/:hotelId/staff')
export class StaffController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(HandoffService) private readonly handoff: HandoffService,
  ) {}

  @Post('invitations')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Invite a staff member into a hotel or restaurant scope' })
  @ApiResponse({ status: 201, description: 'A pending membership and a one-time invitation exist' })
  @ApiResponse({ status: 403, description: 'The package does not include one of the roles' })
  async invite(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ invitationId: string; membershipId: string; expiresAt: string }> {
    const hotelId = requireUuid(hotelIdParam, 'hotelId');
    const payload = body(request);
    const restaurantId = optionalUuid(payload['restaurantId'], 'restaurantId');
    const created = await this.staff.createInvitation(
      actorOf(request),
      {
        hotelId,
        ...(restaurantId === undefined ? {} : { restaurantId }),
        email: requireString(payload['email'], 'email'),
        roles: requireRoles(payload['roles'], 'roles'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principalOf(request).accountId),
    );
    reply.status(201);
    return {
      invitationId: created.invitationId,
      membershipId: created.membershipId,
      expiresAt: new Date(created.expiresAt).toISOString(),
    };
  }

  @Post('memberships/:membershipId/invitation/resend')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Supersede the live invitation and issue a new one' })
  async resend(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ invitationId: string; expiresAt: string }> {
    const principal = principalOf(request);
    const created = await this.staff.resendInvitation(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
    return {
      invitationId: created.invitationId,
      expiresAt: new Date(created.expiresAt).toISOString(),
    };
  }

  @Post('memberships/:membershipId/invitation/revoke')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Revoke the live invitation without touching the membership' })
  async revoke(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revoked: boolean }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.staff.revokeInvitation(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        reason: requireString(payload['reason'], 'reason', 500),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  /**
   * Unauthenticated: the recipient has no account yet. The token proves nothing
   * beyond itself, and the response carries no token and no other hotel's data.
   *
   * A POST with the secret in the body, never a GET with it in the query string.
   * A URL is logged by the server, by every proxy in front of it, by the
   * browser's history and by the `Referer` of whatever the page loads next —
   * CLAUDE.md §8 puts one-time secrets out of all of those, and "it is only a
   * read" does not change where the token ends up.
   */
  @Post('invitations/inspect')
  @HttpCode(200)
  @ApiOperation({ summary: 'What an invitation link points at, before accepting it' })
  async inspect(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{
    invitationId: string;
    emailNormalized: string;
    roles: readonly string[];
    expiresAt: string;
    accountExists: boolean;
  }> {
    const payload = body(request);
    const result = await this.staff.inspectInvitation(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        token: requireString(payload['token'], 'token', 4096),
      },
      newRequestContext(),
    );
    return { ...result, expiresAt: new Date(result.expiresAt).toISOString() };
  }

  /**
   * Accepting.
   *
   * A new account supplies a password it chooses itself; an address that already
   * has one signs in first and accepts with that account (doc 19 §5). The
   * platform never issues a password either way.
   */
  @Post('invitations/accept')
  @HttpCode(200)
  @UseGuards(OptionalSessionGuard)
  @ApiOperation({ summary: 'Accept an invitation, creating an account or using an existing one' })
  @ApiResponse({ status: 200, description: 'The membership is active' })
  @ApiResponse({ status: 409, description: 'The invitation can no longer be accepted' })
  async accept(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ membershipId: string; accountId: string }> {
    const payload = body(request);
    const password = payload['password'];
    // An existing account accepts as itself, which requires a session; a new one
    // has none. `OptionalSessionGuard` is what makes the first path reachable:
    // it verifies a bearer when one is presented and leaves the request
    // anonymous when none is, so this value is a resolved session or nothing —
    // never an unpopulated field that silently made every acceptance anonymous.
    const existingAccountId = request.principal?.accountId;
    return this.staff.acceptInvitation(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        token: requireString(payload['token'], 'token', 4096),
        ...(typeof password === 'string' ? { password } : {}),
        ...(existingAccountId === undefined ? {} : { accountId: existingAccountId }),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(existingAccountId),
    );
  }

  @Post('memberships/:membershipId/roles')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Grant a role on one membership' })
  async addRole(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ granted: boolean }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.staff.addRole(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        role: requireRole(payload['role'], 'role'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Delete('memberships/:membershipId/roles/:role')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Revoke a role on one membership' })
  async removeRole(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Param('role') roleParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ granted: boolean }> {
    const principal = principalOf(request);
    return this.staff.removeRole(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        role: requireRole(roleParam, 'role'),
        reason: 'role_removed',
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  /**
   * Suspension, termination and explicit reactivation (doc 19 §8).
   *
   * The security effect commits immediately. Open work the owning module reports
   * becomes handoff items in the same transaction and never delays it.
   */
  @Post('memberships/:membershipId/state')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Suspend, terminate or explicitly reactivate a membership' })
  async setState(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ state: string; handoffItems: readonly string[] }> {
    const principal = principalOf(request);
    const payload = body(request);
    // `openWork` is deliberately not read from the body. What work a suspended
    // member still holds is asked of the modules that own it (doc 19 §8.1); a
    // caller who could name it could also omit it.
    return this.staff.setMembershipState(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        state: requireMembershipState(payload['state']),
        reason: requireString(payload['reason'], 'reason', 500),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  /** doc 19 §6: a Hotel Admin may send the link, and never sees it. */
  @Post('memberships/:membershipId/password-reset')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Send a staff member a password reset link' })
  @ApiResponse({ status: 202, description: 'A link was sent to the registered address' })
  async initiateReset(
    @Param('hotelId') hotelIdParam: string,
    @Param('membershipId') membershipIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ initiated: boolean }> {
    const principal = principalOf(request);
    const result = await this.staff.initiatePasswordReset(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        membershipId: requireUuid(membershipIdParam, 'membershipId'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
    reply.status(202);
    return result;
  }

  // ------------------------------------------------------------- handoff queue
  @Get('handoff/items')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open takeover and reassignment items for this hotel' })
  async listHandoff(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const principal = principalOf(request);
    const items = await this.handoff.list(
      actorOf(request),
      requireUuid(hotelIdParam, 'hotelId'),
      newRequestContext(principal.accountId),
    );
    return { items: items.map((item) => ({ ...item })) };
  }

  /**
   * Finishes a suspension whose open-work enumeration could not run.
   *
   * doc 19 §8.1: the security effect never waits for the owning modules, so when
   * they are unreachable the suspension commits with a durable marker and this
   * turns those markers into handoff items once they answer. Safe to call at any
   * time: it settles what it can and leaves the rest queued.
   */
  @Post('handoff/discovery/reconcile')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Enumerate the open work a suspension could not reach' })
  async reconcileDiscovery(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ resolved: number; pending: number; items: readonly string[] }> {
    const principal = principalOf(request);
    return this.handoff.reconcileDiscovery(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Post('handoff/items/:itemId/claim')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Claim one open item; exactly one claimant wins' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ claimed: boolean; claimantMembershipId: string }> {
    const principal = principalOf(request);
    return this.handoff.claim(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        itemId: requireUuid(itemIdParam, 'itemId'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Post('handoff/items/:itemId/release')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Give up a claim, so another Manager may take the item on' })
  async release(
    @Param('hotelId') hotelIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ released: boolean }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.handoff.release(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        itemId: requireUuid(itemIdParam, 'itemId'),
        reason: requireString(payload['reason'], 'reason', 500),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Post('handoff/items/:itemId/assign')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Assign an active replacement that already holds the operational role' })
  async assign(
    @Param('hotelId') hotelIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ assigned: boolean; assigneeMembershipId: string }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.handoff.assign(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        itemId: requireUuid(itemIdParam, 'itemId'),
        replacementMembershipId: requireUuid(
          payload['replacementMembershipId'],
          'replacementMembershipId',
        ),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Post('handoff/items/:itemId/continuation')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create the linked continuation for partially completed Cleaner work' })
  async continuation(
    @Param('hotelId') hotelIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ continuationItemId: string }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.handoff.createContinuation(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        itemId: requireUuid(itemIdParam, 'itemId'),
        replacementMembershipId: requireUuid(
          payload['replacementMembershipId'],
          'replacementMembershipId',
        ),
        subjectRef: requireUuid(payload['subjectRef'], 'subjectRef'),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }

  @Post('handoff/items/:itemId/unassignable')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Record that no eligible replacement exists; the blocker stays' })
  async unassignable(
    @Param('hotelId') hotelIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ state: string }> {
    const principal = principalOf(request);
    const payload = body(request);
    return this.handoff.markUnassignable(
      actorOf(request),
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        itemId: requireUuid(itemIdParam, 'itemId'),
        reason: requireString(payload['reason'], 'reason', 500),
        idempotencyKey: idempotencyKey(request),
      },
      newRequestContext(principal.accountId),
    );
  }
}
