import type { Pool } from 'pg';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type {
  EBarimtPort,
  KeyManagementPort,
  PaymentGateways,
  PhoneVerificationPort,
  PortContext,
  PortError,
  StaffNotificationPort,
} from '@prsystem/ports';
import type { AuthzRealm, SubscriptionStatePort } from '@prsystem/authz';
import { TokenService } from '../../iam/services/token.service';
import type {
  CommandActor,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import type { HotelGate } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { OnboardingParameters } from '../contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from '../contracts/onboarding-parameters';
import type { ProvisioningSignalPort } from '../contracts/provisioning-signal';

/**
 * The three transaction shapes Phase 05 runs in.
 *
 * A **pre-tenant** transaction carries `app.onboarding_ref` and no hotel. It is
 * how an applicant — or the worker acting on one application — reaches that
 * draft and nothing else: the reference is established from the bearer secret
 * the applicant presented, or from the job the worker claimed, and unset it is
 * NULL, so every onboarding policy matches zero rows.
 *
 * An **Operation** transaction carries the operation realm and the platform
 * scope. Review, provisioning retry and reconciliation run there; which
 * Operation accounts may act is decided by the Phase 04 pipeline against the
 * named permission, the realm role and a recent step-up — never by RLS alone.
 *
 * A **hotel** transaction is the ordinary tenant one, used once a hotel exists,
 * and every Hotel-realm route reaches it only through the scope gate.
 */

export interface OnboardingDependencies {
  readonly pool: Pool;
  readonly keys: KeyManagementPort;
  readonly gateways: PaymentGateways;
  readonly ebarimt: EBarimtPort;
  readonly phone: PhoneVerificationPort;
  /** Reused from Phase 04: there is one email delivery port, not two. */
  readonly notifications: StaffNotificationPort;
  /** The best-effort "work is due" message to the worker (R3). */
  readonly signals: ProvisioningSignalPort;
  readonly parameters?: OnboardingParameters;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newOnboardingRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/** The context every port call carries. */
export function portContext(request: RequestContext): PortContext {
  return { correlationId: request.correlationId };
}

/**
 * The pre-tenant scope.
 *
 * The hotel id is the platform sentinel because `TenantContext` requires one and
 * every tenant policy must match nothing here — but the sentinel grants no
 * access to an onboarding row. The onboarding policies key on
 * `app.onboarding_ref` alone, so the sentinel is the absence of a tenant rather
 * than a scope that stands in for one.
 */
export function onboardingScope(
  applicationId: string | undefined,
  request: RequestContext,
): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'hotel',
    actorRef: request.accountId ?? 'applicant',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
    ...(applicationId === undefined ? {} : { onboardingRef: applicationId }),
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
 * A port error, as the caller sees it.
 *
 * `DISABLED`, `UNAVAILABLE` and `TIMEOUT` are the dependency's problem and say
 * so; a `REJECTED`, `MISMATCH` or `INVALID_SIGNATURE` on a call *we* made is
 * a defect in the request and is reported as one.
 */
export function portFailure(error: PortError, what: string): ApiError {
  switch (error.kind) {
    case 'DISABLED':
      return new ApiError('DEPENDENCY_UNAVAILABLE', `${what} is not available (${error.gate})`);
    case 'UNAVAILABLE':
    case 'TIMEOUT':
      return new ApiError('DEPENDENCY_UNAVAILABLE', `${what} did not answer`);
    case 'REJECTED':
      return new ApiError('CONFLICT', `${what} was refused by the provider`);
    case 'MISMATCH':
    case 'INVALID_SIGNATURE':
      return new ApiError('VALIDATION_FAILED', `${what} did not match`);
  }
}

/** Base class for the Phase 05 services, so the plumbing is written once. */
export abstract class OnboardingServiceBase {
  protected readonly tokens: TokenService;

  protected constructor(protected readonly deps: OnboardingDependencies) {
    this.tokens = new TokenService(deps.keys);
  }

  protected get parameters(): OnboardingParameters {
    return this.deps.parameters ?? ONBOARDING_PARAMETERS;
  }

  protected inOnboardingScope<T>(
    applicationId: string | undefined,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, onboardingScope(applicationId, request), work);
  }

  protected inOperationScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, operationScope(request), work);
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  /**
   * Resolves the actor's live scope in a hotel **before** the hotel is bound
   * (doc 06 §2), then runs the command inside the hotel transaction with the
   * Phase 04 pipeline evaluated against the named permission at commit time.
   *
   * `subscription` is the port the pipeline's stage 5 and 6 read. A command
   * that has already locked the authoritative row passes a port that answers
   * from that row, so the entitlement it commits against is the one it locked.
   */
  protected async runAuthorizedHotelCommand<T>(
    actor: CommandActor,
    target: { hotelId: string },
    permission: string,
    request: RequestContext,
    work: (
      uow: UnitOfWork,
      gate: HotelGate,
      authorize: (subscription: SubscriptionStatePort) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    const gate = await gateHotelScope(this.deps.pool, actor, target, iamRequest);
    try {
      return await this.inHotelScope(target.hotelId, iamRequest, (uow) =>
        work(uow, gate, async (subscription) => {
          await authorizeCommand({
            uow,
            endpointRealm: 'hotel',
            permission,
            principal: gate.principal,
            target,
            subscription,
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

  /**
   * An Operation action: realm, role column, explicitly granted named permission
   * and recent step-up, all evaluated by the Phase 04 pipeline against server
   * state inside the transaction that applies the effect (doc 18 §5,
   * `OPS-DEC-015`, `OPS-DEC-016`). A denial is audited in its own transaction.
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
}

/** An Operation action targets no hotel, so stage 5 never consults a subscription. */
const NO_SUBSCRIPTION: SubscriptionStatePort = {
  snapshot: () => Promise.resolve(undefined),
};

/**
 * Exponential backoff with a ceiling, in seconds.
 *
 * Written once because four queues need it and four hand-rolled copies is
 * four chances to get the ceiling wrong.
 */
export function backoffSeconds(attempt: number, base: number, ceiling: number): number {
  return Math.min(ceiling, base * 2 ** Math.max(0, attempt - 1));
}
