import { Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { effectiveHotelPermissions } from '@prsystem/authz';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from './session.guard';
import { SessionGuard, principalOf, sessionIdOf } from './session.guard';
import { SessionService } from '../services/session.service';
import { StaffService } from '../services/staff.service';
import { AUTH_SECURITY_PARAMETERS } from '../contracts/security-parameters';
import { newRequestContext } from '../services/iam-context';
import { body, requireString } from './validation';
import type { SubscriptionStatePort } from '../contracts/subscription-state.port';
import { SUBSCRIPTION_STATE } from '../iam.tokens';

/**
 * The Hotel-realm authentication surface.
 *
 * Sign-in, sign-out, all-device logout and the self-service password reset. All
 * of it is account-scoped: it belongs to a person rather than to one hotel, and
 * it runs under the platform scope where no tenant policy matches anything.
 */
@ApiTags('iam')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(SUBSCRIPTION_STATE) private readonly subscription: SubscriptionStatePort,
  ) {}

  @Post('sign-in')
  @ApiOperation({ summary: 'Exchange an email and password for a server-side session' })
  @ApiResponse({ status: 200, description: 'A session was created' })
  @ApiResponse({ status: 401, description: 'The email address or password is incorrect' })
  async signIn(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const payload = body(request);
    const result = await this.sessions.signIn(
      requireString(payload['email'], 'email'),
      requireString(payload['password'], 'password', 4096),
      newRequestContext(),
    );
    reply.status(200);
    return {
      token: result.token,
      expiresInSeconds: AUTH_SECURITY_PARAMETERS.sessionAbsoluteSeconds,
    };
  }

  /**
   * What this session can currently do, per membership.
   *
   * Computed rather than stored: the effective set is the union of the roles on
   * **one** membership intersected with that hotel's package entitlement, and it
   * is never merged across hotels (doc 05 §3, doc 06 §6).
   */
  @Get('session')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The current principal, its memberships and effective permissions' })
  async session(@Req() request: AuthenticatedRequest): Promise<{
    accountId: string;
    realm: string;
    memberships: {
      membershipId: string;
      hotelId: string;
      restaurantId?: string;
      state: string;
      roles: readonly string[];
      effectivePermissions: readonly string[];
      subscriptionState: string | null;
    }[];
  }> {
    const principal = principalOf(request);
    const now = new Date();
    const memberships = [];
    for (const membership of principal.memberships) {
      const snapshot = await this.subscription.snapshot(membership.hotelId, now);
      memberships.push({
        membershipId: membership.membershipId,
        hotelId: membership.hotelId,
        ...(membership.restaurantId === undefined ? {} : { restaurantId: membership.restaurantId }),
        state: membership.state,
        roles: membership.roles,
        effectivePermissions:
          snapshot === undefined
            ? []
            : [...effectiveHotelPermissions(membership.roles, snapshot.effectivePackage)].sort(),
        subscriptionState: snapshot?.state ?? null,
      });
    }
    return { accountId: principal.accountId, realm: principal.realm, memberships };
  }

  @Post('sign-out')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close this session on the server' })
  async signOut(@Req() request: AuthenticatedRequest): Promise<{ ok: true }> {
    await this.sessions.signOut(sessionIdOf(request), newRequestContext());
    return { ok: true };
  }

  /** doc 19 §10: closes every session of the account, on every device. */
  @Post('sign-out-all')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close every session this account holds' })
  async signOutAll(@Req() request: AuthenticatedRequest): Promise<{ closed: number }> {
    const principal = principalOf(request);
    const closed = await this.sessions.signOutEverywhere(
      principal.accountId,
      newRequestContext(principal.accountId),
    );
    return { closed };
  }

  /**
   * Requests a reset link.
   *
   * Always 202, whether or not the address is registered: the surface must not
   * be usable to discover who has an account.
   */
  @Post('password-reset/request')
  @ApiOperation({ summary: 'Send a password reset link to a registered address' })
  @ApiResponse({ status: 202, description: 'Accepted, whether or not the address is registered' })
  async requestReset(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accepted: true }> {
    const payload = body(request);
    await this.staff.requestPasswordReset(
      requireString(payload['email'], 'email'),
      newRequestContext(),
    );
    reply.status(202);
    return { accepted: true };
  }

  @Post('password-reset/confirm')
  @ApiOperation({ summary: 'Redeem a reset link and choose a new password' })
  @ApiResponse({ status: 200, description: 'The password was replaced and every session closed' })
  async confirmReset(@Req() request: AuthenticatedRequest): Promise<{ sessionsClosed: number }> {
    const payload = body(request);
    const result = await this.staff.confirmPasswordReset(
      {
        token: requireString(payload['token'], 'token', 4096),
        password: requireString(payload['password'], 'password', 4096),
      },
      newRequestContext(),
    );
    return { sessionsClosed: result.sessionsClosed };
  }
}
