import type { Pool } from 'pg';
import type { Principal, ResolvedMembership, SubscriptionStatePort } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, recordPlatformAudit, withTenantTransaction } from '@prsystem/db';
import { AuthorizationDenied, resolvePrincipal } from './authorization.service';
import { MembershipRepository } from '../repositories/membership.repository';
import { newCorrelationId } from '@prsystem/contracts';
import type { StaffNotificationPort } from '../contracts/staff-notification.port';
import type { OpenWorkPort } from '../contracts/open-work.port';
import type { RestaurantDirectoryPort } from '../contracts/restaurant-directory.port';
import type { AuthSecurityParameters } from '../contracts/security-parameters';
import { AUTH_SECURITY_PARAMETERS } from '../contracts/security-parameters';
import { TokenService } from './token.service';
import type { KeyManagementPort } from '@prsystem/ports';

/**
 * The two transaction shapes IAM runs in.
 *
 * A **hotel-scoped** transaction is the ordinary one: the scope was resolved
 * from membership at pipeline stage 4, and every tenant policy applies.
 *
 * An **account-scoped** transaction runs under the platform sentinel, for the
 * work that belongs to an account rather than to one hotel — signing in,
 * changing a password, logging out of every device (doc 19 §10). No hotel
 * carries the sentinel as its id, so every tenant policy matches nothing there;
 * the account policies carry exactly the principal's own rows.
 */

export interface IamDependencies {
  readonly pool: Pool;
  readonly keys: KeyManagementPort;
  readonly subscription: SubscriptionStatePort;
  readonly notifications: StaffNotificationPort;
  /** The authoritative source of a suspended member's unfinished work. */
  readonly openWork: OpenWorkPort;
  /** The authoritative hotel → restaurant linkage (Phase 15 owns the aggregate). */
  readonly restaurants: RestaurantDirectoryPort;
  /**
   * The security parameter set in force.
   *
   * Injected rather than imported so the values are genuinely configurable —
   * which is what doc 19 §14 asks for while the P1 numbers stay open — and so a
   * test can exercise an expiry or a resend interval without waiting for one.
   */
  readonly parameters?: AuthSecurityParameters;
}

export interface RequestContext {
  readonly correlationId: string;
  /** The authenticated account, where there is one. */
  readonly accountId?: string;
}

/**
 * The authenticated actor a command runs as.
 *
 * The session id travels with the principal because authority inside a hotel is
 * the session's scope grant (doc 19 §10) — a principal alone says who the person
 * is, not what this device may still do.
 */
export interface CommandActor {
  readonly principal: Principal;
  readonly sessionId: string;
}

/** What the scope gate proved, and what the command may rely on. */
export interface HotelGate {
  readonly principal: Principal;
  readonly membership: ResolvedMembership;
  readonly sessionId: string;
}

/** The exact restaurant scope sorts before the hotel-wide one. */
function scopeRank(membership: ResolvedMembership, target: { restaurantId?: string }): number {
  if (target.restaurantId !== undefined && membership.restaurantId === target.restaurantId) {
    return 0;
  }
  return 1;
}

export function newRequestContext(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export function accountScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'hotel',
    // Opaque: an account id, never an email or a name (ADR-0017 §3).
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

export function hotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/**
 * Establishes the account scope inside a transaction that began without one.
 *
 * Authentication is the one flow where the account is not known when the
 * transaction opens: the token identifies the session, and only then is there an
 * account to scope by. The value is derived from the verified session row, never
 * from anything the caller sent, and `set_config(..., true)` keeps it
 * transaction-local exactly like the scope the unit of work applies.
 */
export async function establishAccountScope(uow: UnitOfWork, accountId: string): Promise<void> {
  await uow.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
}

/** Base class for the IAM services, so the plumbing is written once. */
export abstract class IamServiceBase {
  protected readonly tokens: TokenService;

  protected constructor(protected readonly deps: IamDependencies) {
    this.tokens = new TokenService(deps.keys);
  }

  protected get parameters(): AuthSecurityParameters {
    return this.deps.parameters ?? AUTH_SECURITY_PARAMETERS;
  }

  /**
   * Resolves the scope a session actually holds in a hotel — before any hotel
   * RLS context is bound (doc 06 §2, `RBAC-DEC-006`).
   *
   * This runs in the **account** scope, where the only rows visible are the
   * principal's own. It answers one question: does this account hold an active
   * membership covering the requested target, and does *this session* still hold
   * a live scope grant on it at its current revision? Nothing about the target
   * resource is read, locked or claimed until it does.
   *
   * A `hotel_id` in a URL therefore never binds tenant authority. It selects
   * which of the actor's own memberships to look for, and if there is none the
   * refusal is the same `NOT_FOUND` a missing hotel gets — so a foreign hotel
   * that exists is indistinguishable from one that does not, and no lock is ever
   * taken on another tenant's rows.
   */
  protected gateHotelScope(
    actor: CommandActor,
    target: { hotelId: string; restaurantId?: string },
    request: RequestContext,
  ): Promise<HotelGate> {
    return gateHotelScope(this.deps.pool, actor, target, request);
  }

  /**
   * Runs a hotel-scoped command behind that gate, and records a denial that the
   * command's own transaction could not.
   *
   * doc 05 §7 requires a denied high-risk attempt to be audited, and a denial
   * aborts the transaction it was detected in — so an audit written there rolls
   * back with it and there is no record at all. The denial is therefore written
   * in a transaction of its own, under the platform scope, naming the hotel that
   * was targeted. The effect stays refused either way; what changes is that the
   * attempt leaves a trace.
   */
  protected async runHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string; restaurantId?: string },
    request: RequestContext,
    work: (uow: UnitOfWork, gate: HotelGate) => Promise<T>,
  ): Promise<T> {
    const gate = await this.gateHotelScope(actor, target, request);
    try {
      return await this.inHotelScope(target.hotelId, request, (uow) => work(uow, gate));
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await this.recordDenial(target.hotelId, request, error);
      }
      throw error;
    }
  }

  /**
   * A hotel-scoped transaction a **token** rather than a membership admits.
   *
   * Invitation inspection and acceptance are the two flows whose whole purpose
   * is that the actor is not yet a member, so there is no membership to gate
   * them with. The one-time secret is the gate, and it is checked before
   * anything else is read, locked or claimed.
   */
  protected async runTokenGatedCommand<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.inHotelScope(hotelId, request, work);
    } catch (error) {
      if (error instanceof AuthorizationDenied) await this.recordDenial(hotelId, request, error);
      throw error;
    }
  }

  private recordDenial(
    hotelId: string,
    request: RequestContext,
    denial: AuthorizationDenied,
  ): Promise<void> {
    return recordAuthorizationDenial(this.deps.pool, hotelId, request, denial);
  }

  protected inAccountScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, accountScope(request), work);
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }
}

/**
 * Resolves the scope a session actually holds in a hotel — before any hotel
 * RLS context is bound (doc 06 §2, `RBAC-DEC-006`).
 *
 * Exported as a function rather than kept as a method, because it is the one
 * gate every module that binds a `hotel_id` from a path has to pass through:
 * Phase 05's subscription surface takes it from here rather than growing a
 * second reading of what a live scope grant is.
 *
 * It runs in the **account** scope, where the only rows visible are the
 * principal's own. It answers one question: does this account hold an active
 * membership covering the requested target, and does *this session* still hold
 * a live scope grant on it at its current revision? Nothing about the target
 * resource is read, locked or claimed until it does. A `hotel_id` in a URL
 * therefore never binds tenant authority: a foreign hotel that exists is
 * indistinguishable from one that does not, and no lock is ever taken on another
 * tenant's rows. The refusal is audited in a transaction of its own (doc 05 §7).
 */
export async function gateHotelScope(
  pool: Pool,
  actor: CommandActor,
  target: { hotelId: string; restaurantId?: string },
  request: RequestContext,
): Promise<HotelGate> {
  const denied = (): AuthorizationDenied =>
    new AuthorizationDenied(
      new ApiError('NOT_FOUND', 'not found'),
      'hotel.scope',
      'account_and_membership',
      'NOT_AUTHORIZED',
      'hotel',
      target.hotelId,
    );

  const gate = await withTenantTransaction(
    pool,
    accountScope({ ...request, accountId: actor.principal.accountId }),
    async (uow) => {
      const principal = await resolvePrincipal(
        uow,
        actor.principal.accountId,
        actor.principal.stepUpAt,
      );
      if (principal === undefined || principal.accountState !== 'ACTIVE') return undefined;

      const covering = principal.memberships
        .filter(
          (membership) =>
            membership.hotelId === target.hotelId &&
            membership.state === 'ACTIVE' &&
            (membership.restaurantId === undefined ||
              membership.restaurantId === target.restaurantId),
        )
        .sort((left, right) => scopeRank(left, target) - scopeRank(right, target));
      if (covering.length === 0) return undefined;

      const memberships = new MembershipRepository(uow);
      for (const membership of covering) {
        const grant = await memberships.liveScopeGrantForAccount(
          actor.principal.accountId,
          actor.sessionId,
          membership.membershipId,
        );
        if (grant !== undefined && grant.membershipRevision === membership.revision) {
          return { principal, membership, sessionId: actor.sessionId };
        }
      }
      return undefined;
    },
  );

  if (gate === undefined) {
    const refusal = denied();
    await recordAuthorizationDenial(pool, target.hotelId, request, refusal);
    throw refusal;
  }
  return gate;
}

/**
 * Records a denial the command's own transaction could not.
 *
 * doc 05 §7 requires a denied high-risk attempt to be audited, and a denial
 * aborts the transaction it was detected in — so the record is written in a
 * transaction of its own, under the platform scope, naming the hotel that was
 * targeted. A failure to record it must not turn a denial into a different
 * error.
 */
export async function recordAuthorizationDenial(
  pool: Pool,
  hotelId: string,
  request: RequestContext,
  denial: AuthorizationDenied,
): Promise<void> {
  try {
    await withTenantTransaction(pool, accountScope(request), async (uow) => {
      await recordPlatformAudit(uow, {
        action: `authz.${denial.permission}`,
        outcome: 'denied',
        targetType: denial.targetType ?? 'authorization',
        ...(denial.targetRef === undefined ? {} : { targetRef: denial.targetRef }),
        reason: denial.denialCode,
        payload: {
          stage: denial.stage,
          permission: denial.permission,
          targetHotelId: hotelId,
        },
      });
    });
  } catch {
    // The refusal itself has already happened and is what the caller sees.
  }
}
