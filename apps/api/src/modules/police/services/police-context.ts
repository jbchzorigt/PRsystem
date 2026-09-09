import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import {
  PLATFORM_SCOPE,
  claimIdempotencyKey,
  recordPoliceAudit,
  withTenantTransaction,
} from '@prsystem/db';
import type {
  KeyManagementPort,
  ObjectStoragePort,
  SmsPort,
  XypIdentityPort,
} from '@prsystem/ports';
import type {
  CommandActor,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';

/**
 * The one transaction shape the Police realm has (doc 13 §3).
 *
 * A wanted person belongs to no hotel, a case belongs to no hotel, and a match
 * belongs to the Police realm even though it names one — so every command here
 * runs at the platform sentinel in the `police` realm. That is not a widening:
 * the `police.*` policies compare the realm, `prsystem_police` holds no grant
 * on a hotel's own tables, and the unit and territory limits of doc 18 §6 are
 * applied by the pipeline above this line.
 *
 * There is no `hotel` variant of any of this, deliberately. A Police account
 * has no membership and no package, so a command that named a hotel target
 * would be asking the pipeline for a membership that can never exist.
 */

export interface PoliceDependencies {
  /** The Police login's own pool. It reaches no hotel table (doc 13 §13.2). */
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  readonly keys: KeyManagementPort;
  /** `EXT-05`. Disabled in production until CallPro is contracted. */
  readonly sms: SmsPort;
  /** `EXT-01`. ХУР answers an identity, or the officer types one (doc 13 §6.2). */
  readonly xyp: XypIdentityPort;
  /** Where a Wanted Case export file lives, for its hour (doc 13 §12.3). */
  readonly storage: ObjectStoragePort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
  /** doc 13 §13.1: the device or address an access is audited with. */
  readonly deviceRef?: string;
}

export type { CommandActor };

export function newPoliceRequest(accountId?: string, deviceRef?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
    ...(deviceRef === undefined ? {} : { deviceRef }),
  };
}

export function policeScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'police',
    actorRef: request.accountId ?? 'police',
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

/** doc 18 §6: the action ids this module's commands run under. */
export const ACCOUNT_MANAGE = 'police.account_manage';
export const DRAFT_CREATE = 'police.wanted_case_draft_create';
export const WANTED_VIEW = 'police.wanted_active_view';
export const MATCH_VIEW = 'police.match_alert_view';
export const EXACT_SEARCH = 'police.exact_identifier_search';
export const CHECKIN_LIST = 'police.all_hotel_checkin_list';
export const CHECKIN_EXPORT = 'police.all_hotel_checkin_export';
export const ACKNOWLEDGE = 'police.match_acknowledge';
export const FOUND_CONFIRM = 'police.found_confirm';
export const FOUND_CORRECTION_REQUEST = 'police.found_correction_request';
export const FOUND_CORRECTION_DECIDE = 'police.found_correction_decide';
export const FALSE_MATCH_REQUEST = 'police.false_match_request';
export const FALSE_MATCH_DECIDE = 'police.false_match_decide';
export const IDENTITY_APPROVE = 'police.manual_identity_approve';
export const CASE_STATE_MANAGE = 'police.case_state_manage';
export const DASHBOARD_BASIC = 'police.dashboard_basic';
export const ANALYTICS_AUDIT = 'police.analytics_and_access_audit';
export const CASE_EXPORT = 'police.wanted_case_export';

/**
 * The additional grant that unmasks a registration number in an export
 * (doc 13 §12.2). It is not a doc 18 §6 row of its own: it is a second
 * permission the exporting account must also hold, on top of the row.
 */
export const EXPORT_FULL_IDENTIFIER = 'WANTED_EXPORT_FULL_IDENTIFIER';

export interface PoliceAuthorization {
  /**
   * The unit the addressed row belongs to, for the `own_police_scope` rows of
   * doc 18 §6. An Officer's match view is confined to their own unit; an Admin's
   * is not, and the pipeline decides which rule applies from the account's own
   * column.
   */
  readonly resourceScopeRef?: string;
  /**
   * The other person, for the three two-person actions. It fails closed: an
   * approver whose requester could not be loaded is not a different person.
   */
  readonly separationCounterpartAccountId?: string;
  readonly targetType?: string;
  readonly targetRef?: string;
}

export abstract class PoliceServiceBase {
  protected constructor(protected readonly deps: PoliceDependencies) {}

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected wallClock(): Date {
    return this.deps.clock === undefined ? new Date() : this.deps.clock();
  }

  /** A read or a maintenance sweep in the Police realm, with no account gate. */
  protected inPoliceScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, policeScope(request), work);
  }

  /**
   * A Police command, gated by the Phase 04 pipeline against doc 18 §6.
   *
   * The authorization runs inside the transaction that does the work, so a
   * permission revoked or an account suspended between the request and the
   * write is revoked for the write too. A denial is recorded on the Police
   * audit stream rather than the platform one: this realm's access log is
   * separate, and ADR-0018 §1 keeps it that way.
   */
  protected async runPoliceCommand<T>(
    actor: CommandActor,
    permission: string,
    request: RequestContext,
    work: (
      uow: UnitOfWork,
      authorize: (extra?: PoliceAuthorization) => Promise<void>,
    ) => Promise<T>,
    fixed: PoliceAuthorization = {},
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    try {
      return await withTenantTransaction(this.deps.pool, policeScope(iamRequest), (uow) =>
        work(uow, async (extra) => {
          const options = { ...fixed, ...(extra ?? {}) };
          await authorizeCommand({
            uow,
            endpointRealm: 'police',
            permission,
            principal: actor.principal,
            // A Police permission is not scoped to a hotel, and naming one
            // would invite the pipeline to look for a membership that will
            // never exist.
            target: {},
            subscription: this.deps.subscription,
            ...(actor.principal.stepUpAt === undefined
              ? {}
              : { stepUpAt: actor.principal.stepUpAt }),
            ...(options.resourceScopeRef === undefined
              ? {}
              : { resourceScopeRef: options.resourceScopeRef }),
            ...(options.separationCounterpartAccountId === undefined
              ? {}
              : { separationCounterpartAccountId: options.separationCounterpartAccountId }),
            targetType: options.targetType ?? 'police',
            ...(options.targetRef === undefined ? {} : { targetRef: options.targetRef }),
          });
        }),
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await this.recordDenial(iamRequest, error, fixed.targetRef);
      }
      throw error;
    }
  }

  /**
   * A refused Police action, on the Police audit stream.
   *
   * Written in its own transaction because the one that refused has rolled
   * back, and recorded with the action and the stage — never with a payload
   * that could carry the identifier the caller was reaching for.
   */
  private async recordDenial(
    request: IamRequestContext,
    error: AuthorizationDenied,
    targetRef: string | undefined,
  ): Promise<void> {
    try {
      await withTenantTransaction(this.deps.pool, policeScope(request), async (uow) => {
        await recordPoliceAudit(uow, {
          action: `police.denied.${error.permission}`,
          outcome: 'denied',
          ...(targetRef === undefined ? {} : { caseRef: targetRef }),
          reason: error.stage,
          payload: { stage: error.stage },
        });
      });
    } catch {
      // A denial that cannot be recorded must not become a different error for
      // the caller: the refusal is what the caller gets either way.
    }
  }
}
