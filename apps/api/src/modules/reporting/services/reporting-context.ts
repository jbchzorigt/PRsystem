import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type { ObjectStoragePort } from '@prsystem/ports';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { RegistryFactsPort } from '../contracts/registry-facts';
import type {
  ExpenseFactsPort,
  MinibarFactsPort,
  SalesFactsPort,
} from '../contracts/financial-facts';

/**
 * Every command in this module is a hotel-staff command, and every one of them
 * is gated by the Phase 04 pipeline against a named action (doc 12 §2,
 * doc 23 §9).
 *
 * There is no guest surface and no public one: doc 12 §9 says a guest list is
 * not public information, and doc 23 §10 says a financial query runs only in
 * its actor's own `hotel_id` scope. Both are true here because there is no
 * other kind of transaction in the module.
 *
 * The permissions themselves are doc 18 §3's, and the split matters: the
 * registry is Hotel Admin, Manager and — on the 30,000₮ package — Manager Plus,
 * while the whole financial surface is **Hotel Admin alone** (`FIN-DEC-010`).
 */

export interface ReportingDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  /** doc 12: the registry rows, from the module that owns a stay. */
  readonly registry: RegistryFactsPort;
  /** doc 23 §2: charges, payments and deposits, from the module that owns them. */
  readonly sales: SalesFactsPort;
  /** doc 23 §3.1: what was sold and what it cost. */
  readonly minibar: MinibarFactsPort;
  /** doc 23 §4: what was actually paid out, and under which kind. */
  readonly expenses: ExpenseFactsPort;
  /** doc 12 §7: the private temporary store a completed export file lives in. */
  readonly storage: ObjectStoragePort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newReportingRequest(accountId?: string): RequestContext {
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

/** doc 18 §3: the four named actions this module's commands run under. */
export const REGISTRY_VIEW = 'hotel.registry.list_view';
export const REGISTRY_EXPORT = 'hotel.registry.export';
export const DASHBOARD_FULL = 'hotel.finance.dashboard_full';
export const ROOM_EXCEL = 'hotel.finance.room_excel';
export const MINIBAR_EXCEL = 'hotel.finance.minibar_excel';
export const CATEGORY_MANAGE = 'hotel.expense.category_manage';

/** The hotel-local timezone every report is read in (doc 12 §8, doc 23 §6.1). */
export async function hotelTimeZone(uow: UnitOfWork): Promise<string> {
  const result = await uow.query<{ timezone: string }>(
    `SELECT timezone FROM platform.hotel WHERE hotel_id = $1`,
    [uow.context.hotelId],
  );
  return result.rows[0]?.timezone ?? 'Asia/Ulaanbaatar';
}

export abstract class ReportingServiceBase {
  protected constructor(protected readonly deps: ReportingDependencies) {}

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
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  /**
   * A hotel-staff command, gated the way every other module gates one.
   *
   * The authorization runs inside the transaction that does the work, so a
   * membership suspended or a package downgraded between the request and the
   * read is suspended for the read too — which matters more here than almost
   * anywhere, because what these commands return is the hotel's guests and its
   * money.
   */
  protected async runAuthorizedHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permission: string,
    request: RequestContext,
    work: (
      uow: UnitOfWork,
      gate: HotelGate,
      /**
       * Runs the gate. The permission defaults to the one this command was
       * declared with; a command whose action depends on the row it is about
       * — the export download, whose permission is the export's kind —
       * passes the resolved one instead, after reading that row inside this
       * same transaction and therefore inside this same tenant scope.
       */
      authorize: (permission?: string) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    try {
      return await withTenantTransaction(
        this.deps.pool,
        hotelScope(target.hotelId, iamRequest),
        (uow) =>
          work(uow, gate, async (override) => {
            await authorizeCommand({
              uow,
              endpointRealm: 'hotel',
              permission: override ?? permission,
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
