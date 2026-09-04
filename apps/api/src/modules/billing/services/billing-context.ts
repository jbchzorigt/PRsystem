import type { Pool } from 'pg';
import type { AuthzRealm, SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type { PaymentGateways } from '@prsystem/ports';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { CashPostingsPort } from '../contracts/cash-postings';
import type { TransactionRow } from '../repositories/billing.repository';
import type { StayService } from '../../stay/services/stay.service';
import type { MinibarReportService } from '../../stay/services/report.service';

/**
 * The one transaction shape the billing module runs in.
 *
 * A hotel command is the Phase 04 pipeline evaluated against the named action
 * inside the transaction that moves the money, on the rows it has just locked.
 * A reconciliation command is a Platform Operation action — its own realm, its
 * own explicitly granted permission and a recent step-up — applied inside the
 * tenant scope of the hotel whose deposit it is resolving, because the row it
 * touches is that hotel's (doc 20 §3.2, `DEP-DEC-010`).
 *
 * The module's in-process dependencies are contracts of earlier phases: the
 * stay's own billing facts (Phase 08) and the settled minibar charge
 * (Phase 09). Its external one is the payment gateway port, whose production
 * adapters stay disabled outside local, CI and test.
 */

export interface BillingDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  readonly stays: StayService;
  readonly reports: MinibarReportService;
  /**
   * The payment providers, by name. A QPay movement is confirmed against QPay
   * and a card-gateway one against the bank; the channel decides which
   * (`RC-DEC-006`).
   */
  readonly gateways: PaymentGateways;
  /**
   * The drawer side of a cash transaction, from the module that owns the cash
   * ledger (Phase 11). Every cash-channel movement this module writes is
   * mirrored through it in the same transaction (doc 24 §4).
   */
  readonly cash: CashPostingsPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newBillingRequest(accountId?: string): RequestContext {
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

/**
 * A Platform Operation account acting on one hotel's row: the realm of the
 * authorization is `operation`, the scope of the transaction is the hotel's.
 */
export function operationOnHotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'operation',
    actorRef: request.accountId ?? 'operation',
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
export function serverNow(deps: BillingDependencies, uow: UnitOfWork): Date {
  return deps.clock === undefined ? uow.serverNow : deps.clock();
}

/** An Operation action targets no hotel, so stage 5 never consults a subscription. */
const NO_SUBSCRIPTION: SubscriptionStatePort = {
  snapshot: () => Promise.resolve(undefined),
};

export abstract class BillingServiceBase {
  protected constructor(protected readonly deps: BillingDependencies) {}

  /**
   * doc 24 §4: cash that reaches a folio reaches a drawer, in this same
   * transaction. A non-cash channel moves no drawer and mirrors nothing
   * (`CASH-DEC-005`).
   */
  protected async mirrorCash(
    uow: UnitOfWork,
    transaction: TransactionRow,
    accountId: string,
  ): Promise<void> {
    if (transaction.channel !== 'CASH') return;
    // A late refund the hotel covers from the deposit moved no drawer: the
    // provider paid the guest, and the deposit absorbed it (doc 20 §7).
    if (transaction.kind === 'LATE_REFUND_COVERED') return;
    await this.deps.cash.record(uow, {
      transactionId: transaction.transactionId,
      kind: transaction.kind,
      direction: transaction.direction,
      amountMnt: transaction.amountMnt,
      shiftId: transaction.shiftId,
      accountId,
      at: transaction.occurredAt,
      ...(transaction.reason === null ? {} : { reason: transaction.reason }),
    });
  }

  /** `RC-DEC-006`: the channel names the provider that must confirm it. */
  protected gatewayFor(channel: 'CASH' | 'QPAY' | 'CARD_GATEWAY' | 'MANUAL_POS') {
    return this.deps.gateways.gateway(channel === 'CARD_GATEWAY' ? 'KHAAN' : 'QPAY');
  }

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

  /**
   * `DEP-DEC-010`: the reconciliation of a released refund belongs to a
   * Platform Operation account with `operation.deposit_refund_reconcile` and a
   * recent step-up. No hotel role reaches it, and the transaction still runs in
   * the hotel's own tenant scope so the row it resolves is the hotel's.
   */
  protected async runOperationCommand<T>(
    actor: CommandActor,
    permission: string,
    hotelId: string,
    target: { targetType: string; targetRef: string },
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    try {
      return await withTenantTransaction(
        this.deps.pool,
        operationOnHotelScope(hotelId, iamRequest),
        async (uow) => {
          await authorizeCommand({
            uow,
            endpointRealm: 'operation' satisfies AuthzRealm,
            permission,
            principal: actor.principal,
            target: {},
            subscription: NO_SUBSCRIPTION,
            sessionId: actor.sessionId,
            ...(actor.principal.stepUpAt === undefined
              ? {}
              : { stepUpAt: actor.principal.stepUpAt }),
            targetType: target.targetType,
            targetRef: target.targetRef,
          });
          return work(uow);
        },
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, hotelId, iamRequest, error);
      }
      throw error;
    }
  }
}
