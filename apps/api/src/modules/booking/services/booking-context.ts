import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { PaymentGateways } from '@prsystem/ports';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type { TariffService } from '../../catalog/services/tariff.service';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { SettlementPort } from '../contracts/settlement';

/**
 * The two transaction shapes the booking module runs in (doc 09 §§7–10).
 *
 * **A command runs in the hotel's own scope.** A booking is a tenant row: it
 * belongs to the hotel that will honour it, and the inventory it takes is that
 * hotel's. The hotel is resolved on the server from the category being booked —
 * never from the request — and the authenticated Guest travels as the account,
 * not as the tenant. A Guest therefore never holds a scope over hotel tables;
 * what they hold is an account the command checks the booking against.
 *
 * **A read of "my bookings" runs in the account scope.** Under the platform
 * sentinel every tenant policy matches nothing, and `own_booking_read` matches
 * exactly the rows whose booker is the authenticated account. One guest cannot
 * see another's, and neither can see anything else of the hotel's.
 */

export interface BookingDependencies {
  readonly pool: Pool;
  /** The price, from the module that owns it. Snapshotted at confirmation. */
  readonly tariffs: TariffService;
  /** EXT-03 / EXT-04. Simulated outside production; disabled in it. */
  readonly payments: PaymentGateways;
  /**
   * The money a booking makes, from the module that owns the ledger (Phase 14).
   * A confirmation that cannot reach it does not confirm.
   */
  readonly settlement: SettlementPort;
  /**
   * The package and subscription gate the Phase 04 pipeline evaluates for the
   * hotel-staff commands of doc 18 §3.3 — no-show and hotel cancellation.
   */
  readonly subscription: SubscriptionStatePort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export type { CommandActor, HotelGate };

export interface RequestContext {
  readonly correlationId: string;
  /** The authenticated Guest. Bound by the server from the session. */
  readonly accountId?: string;
}

export function newBookingRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/** The hotel's own scope, for the commands that write its inventory. */
export function hotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'guest',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/**
 * The hotel's own scope for a *staff* command (doc 18 §3.3).
 *
 * A no-show and a hotel cancellation are the hotel's actions, not the guest's,
 * so they run in the hotel realm and are evaluated by the Phase 04 pipeline
 * against a named permission — never by the guest-realm scope a booking command
 * uses.
 */
export function staffScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'system',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/** The account scope, for a Guest reading their own bookings and nothing else. */
export function bookerScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'guest',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
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

/** The hotel-local time zone every hotel carries (doc 05 §6). */
export async function hotelTimeZone(uow: UnitOfWork): Promise<string> {
  const result = await uow.query<{ timezone: string }>(
    `SELECT timezone FROM platform.hotel WHERE hotel_id = $1`,
    [uow.context.hotelId],
  );
  return result.rows[0]?.timezone ?? 'Asia/Ulaanbaatar';
}

export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The constraint that refuses the unit past capacity, by name. */
export const OVERBOOKING_CONSTRAINT = 'category_night_inventory_within_capacity';

export function isOverbookingRefusal(error: unknown): boolean {
  if (sqlState(error) !== '23514') return false;
  const constraint = (error as { constraint?: unknown }).constraint;
  return constraint === OVERBOOKING_CONSTRAINT;
}

export abstract class BookingServiceBase {
  protected constructor(protected readonly deps: BookingDependencies) {}

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  protected inBookerScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, bookerScope(request), work);
  }

  /**
   * A hotel-staff command, gated the way every other module gates one: the
   * Phase 04 pipeline evaluated against the named action *inside* the
   * transaction that applies the effect, on the rows it has just locked
   * (CLAUDE.md §4).
   */
  protected async runAuthorizedHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string },
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
