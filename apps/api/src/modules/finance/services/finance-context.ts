import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';

import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { ShiftLookupPort } from '../../stay/contracts/shift-lookup';
import type { ExpenseClassificationPort } from '../contracts/expense-classification';

/**
 * The one transaction shape the finance module runs in.
 *
 * A hotel command is the Phase 04 pipeline evaluated against the named action
 * inside the transaction that moves the money, on the rows it has just locked.
 *
 * The module's in-process dependencies are contracts of earlier phases: the
 * stay's own billing facts (Phase 08) and the settled minibar charge
 * (Phase 09). Its external one is the payment gateway port, whose production
 * adapters stay disabled outside local, CI and test.
 */

export interface FinanceDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  /**
   * The Reception shift, from the module that owns the row (Phase 08): which
   * shift is active on a drawer, so a movement can name it. The finance module
   * never touches the shift table itself (CLAUDE.md §3).
   */
  readonly shifts: ShiftLookupPort;
  /**
   * What kind of cost an expense is, from the module that owns the categories
   * (Phase 17). Unprovisioned until that module is wired, which is why an
   * expense with no category is the operating cost it has always been.
   */
  readonly classification: ExpenseClassificationPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newFinanceRequest(accountId?: string): RequestContext {
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

export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The server's now for a command: the transaction's, unless a test moved the clock. */
export function serverNow(deps: FinanceDependencies, uow: UnitOfWork): Date {
  return deps.clock === undefined ? uow.serverNow : deps.clock();
}

export abstract class FinanceServiceBase {
  protected constructor(protected readonly deps: FinanceDependencies) {}

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

  protected async runAuthorizedHotelCommandAny<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permissions: readonly string[],
    request: RequestContext,
    work: (uow: UnitOfWork, gate: HotelGate, authorize: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    try {
      return await this.inHotelScope(target.hotelId, iamRequest, (uow) =>
        work(uow, gate, async () => {
          let denial: unknown;
          for (const permission of permissions) {
            try {
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
              return;
            } catch (error) {
              denial = error;
            }
          }
          throw denial;
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
