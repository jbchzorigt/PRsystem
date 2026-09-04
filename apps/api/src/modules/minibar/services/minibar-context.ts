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
import type { LifecycleResolutionPort } from '../../catalog/contracts/lifecycle-resolution';

/**
 * The one transaction shape the minibar runs in: an ordinary hotel scope, the
 * Phase 04 pipeline evaluated against the named action inside the transaction
 * that applies the effect, on the rows it has just locked — the same shape the
 * catalog uses, restated here so the two modules share a discipline without
 * sharing a class.
 *
 * Every write is entitlement-gated at stage 3 and stage 5: on 20,000₮ the
 * named minibar permission is not in the effective set, so the refusal is the
 * same opaque `NOT_FOUND` a missing role gets (doc 06 §5, doc 22 §1).
 */

export interface MinibarDependencies {
  readonly pool: Pool;
  readonly subscription: SubscriptionStatePort;
  /**
   * The catalog's lifecycle contract. Applying a configuration, returning a
   * room's stock or dropping a product from every active version can resolve
   * the last blocker of a `RETIRING` room, product or template; the minibar
   * tells the catalog inside the same transaction (doc 26 §2).
   */
  readonly lifecycle: LifecycleResolutionPort;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newMinibarRequest(accountId?: string): RequestContext {
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

export abstract class MinibarServiceBase {
  protected constructor(protected readonly deps: MinibarDependencies) {}

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
   * As the catalog's: the permissions are tried in order and the first the
   * pipeline allows opens the surface — a `Read-only` cell is a different
   * permission, `<action>.read`, and a read has to accept either.
   */
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
