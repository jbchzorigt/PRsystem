import type { Pool } from 'pg';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import { newCorrelationId } from '@prsystem/contracts';
import type { KeyManagementPort } from '@prsystem/ports';
import { TokenService } from '../../iam/services/token.service';
import type { OnboardingParameters } from '../contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from '../contracts/onboarding-parameters';
import type { PaymentGateways } from '../contracts/payment-gateway.port';
import type { EBarimtPort } from '../contracts/ebarimt.port';
import type { PhoneVerificationPort } from '../contracts/phone-verification.port';
import type { StaffNotificationPort } from '../../iam/contracts/staff-notification.port';

/**
 * The three transaction shapes Phase 05 runs in.
 *
 * A **pre-tenant** transaction carries `app.onboarding_ref` and no hotel. It is
 * how an applicant reaches their own draft and nothing else: the reference is
 * established from the bearer secret they presented, and unset it is NULL, so
 * every onboarding policy matches zero rows.
 *
 * An **Operation** transaction carries the operation realm and the platform
 * scope. Review, provisioning retry and reconciliation run there; which
 * Operation accounts may act is decided by the named permissions above this
 * layer, never by RLS alone.
 *
 * A **hotel** transaction is the ordinary tenant one, used once a hotel exists.
 */

export interface OnboardingDependencies {
  readonly pool: Pool;
  readonly keys: KeyManagementPort;
  readonly gateways: PaymentGateways;
  readonly ebarimt: EBarimtPort;
  readonly phone: PhoneVerificationPort;
  /** Reused from Phase 04: there is one email delivery port, not two. */
  readonly notifications: StaffNotificationPort;
  readonly parameters?: OnboardingParameters;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export function newOnboardingRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
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
}

/**
 * Exponential backoff with a ceiling, in seconds.
 *
 * Written once because three queues need it and three hand-rolled copies is
 * three chances to get the ceiling wrong.
 */
export function backoffSeconds(attempt: number, base: number, ceiling: number): number {
  return Math.min(ceiling, base * 2 ** Math.max(0, attempt - 1));
}
