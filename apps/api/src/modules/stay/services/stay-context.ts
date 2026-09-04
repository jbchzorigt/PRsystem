import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type { KeyManagementPort, XypIdentityPort } from '@prsystem/ports';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { LifecycleResolutionPort } from '../../catalog/contracts/lifecycle-resolution';
import type { TariffService } from '../../catalog/services/tariff.service';
import type { ConfigurationService } from '../../minibar/services/configuration.service';
import type { ConfirmedBookingsPort } from '../contracts/confirmed-bookings';
import type { PaymentAttemptsPort } from '../contracts/payment-attempts';
import type { DepositsPort } from '../contracts/deposits';
import type { CashLedgerPort } from '../contracts/cash-ledger';

/**
 * The one transaction shape the stay module runs in — the catalog's and the
 * minibar's discipline restated: an ordinary hotel scope, the Phase 04 pipeline
 * evaluated against the named action inside the transaction that applies the
 * effect, on the rows it has just locked.
 *
 * The module's in-process dependencies are contracts of earlier phases: the
 * tariff snapshot (Phase 06), the minibar's check-in blockers and scheduled
 * changes (Phase 07), the lifecycle hand-off (Phase 06); its external ones are
 * ports (XYP, key management). The server's now is the transaction's own
 * server time unless a test moves the clock; a client's time is never read.
 */

export interface StayDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  readonly tariffs: TariffService;
  readonly minibar: ConfigurationService;
  readonly lifecycle: LifecycleResolutionPort;
  readonly keys: KeyManagementPort;
  readonly xyp: XypIdentityPort;
  readonly bookings: ConfirmedBookingsPort;
  /**
   * What the provider says about a payment attempt, from the module that will
   * own payments (Phase 10). Only its answer may release a locked report
   * version (`CHK-DEC-004`).
   */
  readonly payments: PaymentAttemptsPort;
  /**
   * The deposit a confirmed walk-in owes, from the module that owns the money
   * (Phase 10). A hotel with no configured deposit cannot confirm a walk-in
   * (`DEP-DEC-001`).
   */
  readonly deposits: DepositsPort;
  /**
   * The cash ledger behind the drawer a shift is opened over, from the module
   * that owns it (Phase 11): which drawer, the shift's expected cash, and
   * whether a transfer still blocks its close (`CASH-DEC-001`, `-006`).
   */
  readonly cash: CashLedgerPort;
  /**
   * The server's now for a command. Absent in production, where every command
   * reads the transaction's own server time; a test supplies one to move the
   * clock past a planned checkout. Never a client's time.
   */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newStayRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export function hotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'system',
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
      if (outcome.status >= 400) {
        throw new ApiError('CONFLICT', 'the original request was refused');
      }
      return { kind: 'replay', body: outcome.body };
    case 'in_progress':
      throw new ApiError('CONFLICT', 'the same request is already in progress');
    case 'key_reused_with_different_payload':
      throw new ApiError('CONFLICT', 'the idempotency key was reused with a different request');
  }
}

/** A PostgreSQL error carrying a SQLSTATE. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The server's now for this command: the transaction's, unless a test moved the clock. */
export function serverNow(deps: StayDependencies, uow: UnitOfWork): Date {
  return deps.clock === undefined ? uow.serverNow : deps.clock();
}

/** The hotel-local time zone every hotel carries (`Asia/Ulaanbaatar` for now, doc 05 §6). */
export async function hotelTimeZone(uow: UnitOfWork): Promise<string> {
  const result = await uow.query<{ timezone: string }>(
    `SELECT timezone FROM platform.hotel WHERE hotel_id = $1`,
    [uow.context.hotelId],
  );
  return result.rows[0]?.timezone ?? 'Asia/Ulaanbaatar';
}

export abstract class StayServiceBase {
  protected constructor(protected readonly deps: StayDependencies) {}

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  protected async runAuthorizedHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permission: string,
    request: RequestContext,
    work: (uow: UnitOfWork, gate: HotelGate, authorize: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.runAuthorizedHotelCommandAny(actor, target, [permission], request, work);
  }

  /**
   * The permissions are tried in order and the first the pipeline allows opens
   * the surface; `authorize` may be called more than once with different
   * permissions inside `work` through `authorizeAlso`, for a command that
   * requires two named actions at once (a backdated check-in).
   */
  protected async runAuthorizedHotelCommandAny<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permissions: readonly string[],
    request: RequestContext,
    work: (
      uow: UnitOfWork,
      gate: HotelGate,
      authorize: () => Promise<void>,
      authorizeAlso: (permission: string) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    const evaluate = (uow: UnitOfWork, permission: string): Promise<unknown> =>
      authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission,
        principal: gate.principal,
        target,
        subscription: this.deps.subscription,
        sessionId: gate.sessionId,
        ...(gate.principal.stepUpAt === undefined ? {} : { stepUpAt: gate.principal.stepUpAt }),
        targetType: 'hotel',
        targetRef: target.hotelId,
      });
    try {
      return await this.inHotelScope(target.hotelId, iamRequest, (uow) =>
        work(
          uow,
          gate,
          async () => {
            let denial: unknown;
            for (const permission of permissions) {
              try {
                await evaluate(uow, permission);
                return;
              } catch (error) {
                denial = error;
              }
            }
            throw denial;
          },
          async (permission) => {
            await evaluate(uow, permission);
          },
        ),
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, target.hotelId, iamRequest, error);
      }
      throw error;
    }
  }
}
