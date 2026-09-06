import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, claimIdempotencyKey, withTenantTransaction } from '@prsystem/db';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';
import type { ReviewEligibilityPort } from '../contracts/review-eligibility';

/**
 * The four transaction shapes a review lives in (doc 10 §§2, 7).
 *
 * **The owner's scope is the platform sentinel.** A reviewer reaches their
 * review from their own account, not from a hotel, so the commands they issue
 * run under `own_review_read` exactly as Phase 13's booking commands do.
 *
 * **A hotel's reply runs in the hotel's own scope**, gated by the Phase 04
 * pipeline against `hotel.review.official_reply_manage` — a package-gated row
 * for Manager Plus and an all-packages row for Hotel Admin and Manager.
 *
 * **A moderator runs in the hotel's scope too, but is authorized in the
 * Operation realm.** doc 10 §7.3 is emphatic that no role *name* grants
 * moderation: what the pipeline checks is the explicitly granted
 * `REVIEW_MODERATE` on that account, and the action carries a step-up
 * requirement on top.
 *
 * **A public read has no account at all** and goes through the projection
 * functions, which is the public module's business and not this one's.
 */

export interface ReviewDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  /** `RV-DEC-002`: what makes a review earned, from the booking module. */
  readonly eligibility: ReviewEligibilityPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newReviewRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/** The reviewer's own scope: the platform sentinel, and their account. */
export function reviewerScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'guest',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/**
 * The hotel's own scope, for the rows a review command has to write.
 *
 * A review is a tenant row: it carries `hotel_id` and every policy on it is the
 * ordinary `tenant_isolation`. The reviewer's own scope can *read* their review
 * through `own_review_read`, but writing one — and moving the hotel's aggregate
 * with it — happens in the hotel the review is about.
 */
export function hotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'guest',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/** The hotel realm's scope, for a staff command such as the official reply. */
export function staffScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'system',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

/** The Operation realm's scope, for a moderator acting on one hotel's review. */
export function moderationScope(hotelId: string, request: RequestContext): TenantContext {
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
      if (outcome.status >= 400) throw new ApiError('CONFLICT', 'the original request was refused');
      return { kind: 'replay', body: outcome.body };
    case 'in_progress':
      throw new ApiError('CONFLICT', 'the same request is already in progress');
    case 'key_reused_with_different_payload':
      throw new ApiError('CONFLICT', 'the idempotency key was reused with a different request');
  }
}

/** The refusal a review that is not the caller's gets: the same as one that does not exist. */
export const NOT_FOUND = 'no such review';

export abstract class ReviewServiceBase {
  protected constructor(protected readonly deps: ReviewDependencies) {}

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected inReviewerScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, reviewerScope(request), work);
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  /** A hotel-staff command, gated the way every other module gates one. */
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

  /**
   * A Platform moderator's command (doc 10 §7.3, `RV-DEC-005`).
   *
   * The Operation realm has no membership and no package: what the pipeline
   * evaluates is the account's own explicitly granted permission, re-read
   * inside this transaction, plus the step-up recency the action demands. A
   * `PLATFORM_SUPER_ADMIN` or `OPERATION_ADMIN` with no `REVIEW_MODERATE` grant
   * is refused here exactly as any other account is — the role name contributes
   * nothing.
   */
  protected async runModeratorCommand<T>(
    actor: CommandActor,
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork, authorize: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const iamRequest: IamRequestContext = { ...request, accountId: actor.principal.accountId };
    try {
      return await withTenantTransaction(
        this.deps.pool,
        moderationScope(hotelId, iamRequest),
        (uow) =>
          work(uow, async () => {
            await authorizeCommand({
              uow,
              endpointRealm: 'operation',
              permission: MODERATE,
              principal: actor.principal,
              // No hotel target: an Operation permission is not scoped to one,
              // and naming a hotel here would invite the pipeline to look for a
              // membership that will never exist.
              target: {},
              subscription: this.deps.subscription,
              ...(actor.principal.stepUpAt === undefined
                ? {}
                : { stepUpAt: actor.principal.stepUpAt }),
              targetType: 'hotel_review',
              targetRef: hotelId,
            });
          }),
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        await recordAuthorizationDenial(this.deps.pool, hotelId, iamRequest, error);
      }
      throw error;
    }
  }
}

/** doc 18 §5: the action id the Operation column is evaluated against. */
export const MODERATE = 'operation.review_moderate';
/** doc 18 §3: the hotel row for the one official reply. */
export const REPLY_MANAGE = 'hotel.review.official_reply_manage';
