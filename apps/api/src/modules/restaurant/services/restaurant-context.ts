import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type { KeyManagementPort, PaymentGateways } from '@prsystem/ports';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { StayFactsPort } from '../contracts/stay-facts';

/**
 * The three transaction shapes the restaurant module runs in (doc 08 §§2, 7).
 *
 * **A staff command runs in the hotel's own scope**, gated by the Phase 04
 * pipeline against a named action *and a restaurant*: the pipeline compares
 * `target.restaurantId` with the membership's own, so a Restaurant Manager of
 * one restaurant is refused another's menu by the same machinery that refuses a
 * Cleaner a drawer. The 30,000₮ entitlement is in the permission's own cell, so
 * a hotel on a smaller package is refused before any row is read.
 *
 * **A guest command runs in the hotel's scope with the stay bound by the
 * server.** A restaurant guest is not an account — they are whoever holds the
 * room's QR and a one-time code — so what confines them is `app.guest_stay_id`
 * and the restrictive policies that read it. The session is resolved from the
 * token they present; the request never names a room, a stay or a hotel.
 *
 * **Redeeming a code runs in the hotel's scope with no stay at all**, because
 * the stay is what the redemption is about to establish. It reads one code, by
 * hash, and writes one session.
 */

export interface RestaurantDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  /** EXT-03: the *restaurant's own* merchant. The platform settles nothing. */
  readonly payments: PaymentGateways;
  /** Keyed hashing for the QR token, the one-time code and the session token. */
  readonly keys: KeyManagementPort;
  /** What the module needs to know about a stay, from the module that owns it. */
  readonly stays: StayFactsPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newRestaurantRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/** The hotel's own scope, for a staff command. */
export function staffScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'system',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/**
 * A guest's scope: the hotel, and the stay their session is bound to.
 *
 * The stay is never taken from the request. It comes from the session the
 * server resolved out of the presented token, which is what makes doc 08 §7's
 * "the guest does not choose a room" true of the data and not only of the UI.
 */
export function guestScope(
  hotelId: string,
  stayId: string,
  request: RequestContext,
): TenantContext {
  return {
    hotelId,
    realm: 'guest',
    actorRef: `guest-session:${stayId}`,
    guestStayId: stayId,
    correlationId: request.correlationId,
  };
}

/** The redemption scope: a hotel, and no stay yet. */
export function redemptionScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'guest',
    actorRef: 'guest-access',
    correlationId: request.correlationId,
  };
}

export type Claim =
  | { readonly kind: 'claimed'; readonly idempotencyId: string }
  | { readonly kind: 'replay'; readonly body: unknown };

/** Claims a client key, or replays what the first attempt stored (CLAUDE.md §6). */
export async function claim(
  uow: UnitOfWork,
  operation: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<Claim> {
  const outcome = await claimIdempotencyKey(uow, {
    operation,
    key,
    clientRef: uow.context.actorRef,
    payload,
  });
  switch (outcome.kind) {
    case 'claimed':
      return { kind: 'claimed', idempotencyId: outcome.idempotencyId };
    case 'replay':
      if (outcome.status >= 400) throw new ApiError('CONFLICT', 'the original request was refused');
      return { kind: 'replay', body: outcome.body };
    case 'in_progress':
      throw new ApiError('CONFLICT', 'the same request is already in progress');
    case 'key_reused_with_different_payload':
      throw new ApiError('CONFLICT', 'the idempotency key was reused with a different request');
  }
}

export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The constraint that refuses a sixth device (`RC-DEC-027`), by name. */
export const GUEST_ACCESS_CONSTRAINT = 'stay_guest_access_within_limit';

export function isAccessLimitRefusal(error: unknown): boolean {
  if (sqlState(error) !== '23514') return false;
  return (error as { constraint?: unknown }).constraint === GUEST_ACCESS_CONSTRAINT;
}

export abstract class RestaurantServiceBase {
  protected constructor(protected readonly deps: RestaurantDependencies) {}

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected wallClock(): Date {
    return this.deps.clock === undefined ? new Date() : this.deps.clock();
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, staffScope(hotelId, request), work);
  }

  protected inGuestScope<T>(
    hotelId: string,
    stayId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, guestScope(hotelId, stayId, request), work);
  }

  protected inRedemptionScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, redemptionScope(hotelId, request), work);
  }

  /**
   * A staff command, gated the way every other module gates one — plus the
   * restaurant, which the Phase 04 pipeline compares against the membership's
   * own scope (doc 18 §3, `RBAC-DEC-016`).
   */
  protected async runAuthorizedHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string; restaurantId?: string },
    permission: string,
    request: RequestContext,
    work: (uow: UnitOfWork, gate: HotelGate, authorize: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    try {
      return await withTenantTransaction(
        this.deps.pool,
        staffScope(target.hotelId, iamRequest),
        (uow) =>
          work(uow, gate, async () => {
            await authorizeCommand({
              uow,
              endpointRealm: 'hotel',
              permission,
              principal: gate.principal,
              target,
              subscription: this.deps.subscription,
              sessionId: gate.sessionId,
              ...(gate.principal.stepUpAt === undefined
                ? {}
                : { stepUpAt: gate.principal.stepUpAt }),
              targetType: 'hotel',
              targetRef: target.hotelId,
            });
          }),
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, target.hotelId, iamRequest, error);
      }
      throw error;
    }
  }
}

/** The hotel-local timezone, read inside the hotel's own scope. */
export async function hotelTimeZone(uow: UnitOfWork): Promise<string> {
  const result = await uow.query<{ timezone: string }>(
    `SELECT timezone FROM platform.hotel WHERE hotel_id = $1`,
    [uow.context.hotelId],
  );
  return result.rows[0]?.timezone ?? 'Asia/Ulaanbaatar';
}
