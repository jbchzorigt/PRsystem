import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, recordPlatformAudit, withTenantTransaction } from '@prsystem/db';
import { AuthorizationDenied } from './authorization.service';
import { newCorrelationId } from '@prsystem/contracts';
import type { StaffNotificationPort } from '../contracts/staff-notification.port';
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
   * Runs a hotel-scoped command and records a denial that the command's own
   * transaction could not.
   *
   * doc 05 §7 requires a denied high-risk attempt to be audited, and a denial
   * aborts the transaction it was detected in — so an audit written there rolls
   * back with it and there is no record at all. The denial is therefore written
   * in a transaction of its own, under the platform scope, naming the hotel that
   * was targeted. The effect stays refused either way; what changes is that the
   * attempt leaves a trace.
   */
  protected async runHotelCommand<T>(
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

  private async recordDenial(
    hotelId: string,
    request: RequestContext,
    denial: AuthorizationDenied,
  ): Promise<void> {
    try {
      await this.inAccountScope(request, async (uow) => {
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
      // The refusal itself has already happened and is what the caller sees. A
      // failure to record it must not turn a denial into a different error.
    }
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
