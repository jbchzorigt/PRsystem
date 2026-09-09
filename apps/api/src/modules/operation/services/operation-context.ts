import type { Pool } from 'pg';
import type { AuthzRealm, SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import {
  PLATFORM_SCOPE,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
  withTenantTransaction,
} from '@prsystem/db';
import type { KeyManagementPort, SmsPort, StaffNotificationPort } from '@prsystem/ports';
import type {
  CommandActor,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import type { HotelGate } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import { TokenService } from '../../iam/services/token.service';
import type { OperationAccountPort } from '../contracts/operation-accounts';
import type { OperationParameters } from '../contracts/operation-parameters';
import { OPERATION_PARAMETERS } from '../contracts/operation-parameters';

/**
 * The two transaction shapes Platform Operation runs in (doc 14 §2).
 *
 * An **Operation** transaction carries the operation realm at the platform
 * sentinel. Every action of doc 18 §5 runs there, and which account may do it
 * is the Phase 04 pipeline's decision against the named permission, the realm
 * role and a step-up no older than ten minutes — never RLS alone. The tables it
 * writes across a hotel boundary carry the realm-gated policy Phase 05
 * established, so the decision that was permitted is the decision that commits.
 *
 * A **hotel** transaction is the ordinary tenant one. Exactly one flow here
 * uses it, and it belongs to the hotel rather than to the platform: doc 14 §2.3
 * gives the *Primary Hotel Admin* the contact change, and an Operation account
 * may not perform it at all — only approve an exception to one of its two
 * challenges.
 */

export interface OperationDependencies {
  readonly pool: Pool;
  /** The account kernel, from the module that owns it (CLAUDE.md §3). */
  readonly accounts: OperationAccountPort;
  /** The authoritative entitlement gate every hotel-realm command reads. */
  readonly subscription: SubscriptionStatePort;
  readonly keys: KeyManagementPort;
  /** `EXT-05`. Disabled in production until CallPro is contracted (doc 14 §5.6). */
  readonly sms: SmsPort;
  /** Reused from Phase 04: there is one email delivery port in the process. */
  readonly notifications: StaffNotificationPort;
  readonly parameters?: OperationParameters;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newOperationRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export function operationScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'operation',
    actorRef: request.accountId ?? 'operation',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
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
 * The unauthenticated scope the Operation sign-in and the enrolment redemption
 * run in.
 *
 * Neither has a principal yet — that is the point of both — so they reach only
 * the account tables, which carry no tenant policy, at the platform sentinel.
 */
export function anonymousOperationScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'operation',
    actorRef: 'anonymous',
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

/** doc 18 §5: the action ids this module's commands run under. */
export const OPERATION_READ = 'operation.hotel_subscription_list';
export const REMINDER_SEND = 'operation.subscription_reminder_send';
export const RESET_INITIATE = 'operation.hotel_admin_password_reset_initiate';
export const PROVISION_RETRY = 'operation.onboarding_provision_retry';
export const EBARIMT_RETRY = 'operation.ebarimt_retry';
export const PAYMENT_RECONCILE = 'operation.subscription_payment_reconcile';
export const SUSPEND = 'operation.subscription_suspend';
export const CONTACT_EXCEPTION = 'operation.subscription_contact_change_approve';
export const ACCESS_MANAGE = 'operation.access_user_manage';
export const PERMISSION_MANAGE = 'operation.access_permission_manage';
export const RECOVERY_APPROVE = 'operation.account_ownership_recovery_approve';

/** doc 18 §3: the hotel-side row a subscription contact change runs under. */
export const HOTEL_PROFILE_MANAGE = 'hotel.profile.manage';

/** An Operation action targets no hotel, so stage 5 never consults a subscription. */
const NO_SUBSCRIPTION: SubscriptionStatePort = {
  snapshot: () => Promise.resolve(undefined),
};

export abstract class OperationServiceBase {
  protected readonly tokens: TokenService;

  protected constructor(protected readonly deps: OperationDependencies) {
    this.tokens = new TokenService(deps.keys);
  }

  protected get parameters(): OperationParameters {
    return this.deps.parameters ?? OPERATION_PARAMETERS;
  }

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected wallClock(): Date {
    return this.deps.clock === undefined ? new Date() : this.deps.clock();
  }

  protected inOperationScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, operationScope(request), work);
  }

  protected inAnonymousScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, anonymousOperationScope(request), work);
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  /**
   * An Operation action: realm, role column, explicitly granted named
   * permission and recent step-up, all evaluated by the Phase 04 pipeline
   * against server state inside the transaction that applies the effect
   * (`OPS-DEC-015`). A denial is audited in its own transaction, so the record
   * of the attempt survives the rollback the denial causes.
   */
  protected async runOperationCommand<T>(
    actor: CommandActor,
    permission: string,
    target: { targetType: string; targetRef: string },
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    try {
      return await this.inOperationScope(iamRequest, async (uow) => {
        await authorizeCommand({
          uow,
          endpointRealm: 'operation' satisfies AuthzRealm,
          permission,
          principal: actor.principal,
          target: {},
          subscription: NO_SUBSCRIPTION,
          sessionId: actor.sessionId,
          ...(actor.principal.stepUpAt === undefined ? {} : { stepUpAt: actor.principal.stepUpAt }),
          targetType: target.targetType,
          targetRef: target.targetRef,
        });
        return work(uow);
      });
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, PLATFORM_SCOPE, iamRequest, error);
      }
      throw error;
    }
  }

  /**
   * A hotel-staff command, gated the way every other module gates one: the
   * actor's live scope in the hotel is resolved before the hotel is bound, and
   * the pipeline is then evaluated inside the transaction that does the work.
   */
  protected async runHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permission: string,
    request: RequestContext,
    work: (uow: UnitOfWork, gate: HotelGate, authorize: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    try {
      return await this.inHotelScope(target.hotelId, iamRequest, (uow) =>
        work(uow, gate, async () => {
          await authorizeCommand({
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
        }),
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, target.hotelId, iamRequest, error);
      }
      throw error;
    }
  }

  /** Records the response a replay of this key will be answered with. */
  protected complete(uow: UnitOfWork, idempotencyId: string, body: unknown): Promise<void> {
    return completeIdempotencyKey(uow, idempotencyId, 200, body);
  }

  /** The one audit helper this module uses, so every action records the same shape. */
  protected async audit(
    uow: UnitOfWork,
    entry: {
      action: string;
      outcome: 'allowed' | 'denied';
      targetType: string;
      targetRef?: string;
      reason?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await recordPlatformAudit(uow, entry);
  }
}
