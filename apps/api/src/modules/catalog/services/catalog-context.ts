import type { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { withTenantTransaction } from '@prsystem/db';
import type {
  CommandActor,
  HotelGate,
  RequestContext as IamRequestContext,
} from '../../iam/services/iam-context';
import { gateHotelScope, recordAuthorizationDenial } from '../../iam/services/iam-context';
import { AuthorizationDenied, authorizeCommand } from '../../iam/services/authorization.service';

/**
 * The one transaction shape the catalog runs in: an ordinary hotel scope.
 *
 * Every route names a `hotelId` in its path and that path segment grants
 * nothing. The actor's live membership and session scope grant are resolved in
 * the **account** scope first, before any hotel context is bound, and the Phase
 * 04 pipeline is then evaluated against the named permission *inside* the
 * transaction that will apply the effect — so a role revoked, a membership
 * suspended or a subscription expired between authentication and commit refuses
 * the command (doc 06 §2, `RBAC-DEC-006`).
 */

export interface CatalogDependencies {
  readonly pool: Pool;
  /**
   * The authoritative subscription-state contract.
   *
   * Injected as a port: the catalog never reads Phase 05's tables (CLAUDE.md
   * §3), and the package gate above every role permission is decided from this
   * contract at command time (`RBAC-DEC-003`, ADR-0019 §4).
   */
  readonly subscription: SubscriptionStatePort;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export type { CommandActor, HotelGate };

export function newCatalogRequest(accountId?: string): RequestContext {
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

export abstract class CatalogServiceBase {
  protected constructor(protected readonly deps: CatalogDependencies) {}

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }

  /**
   * Runs a hotel command behind the scope gate, with the named permission
   * evaluated inside the transaction.
   *
   * `authorize` is handed to the body rather than run before it, so a command
   * can take its row locks first and authorize against the state it locked. The
   * order every caller here uses is: lock, then authorize, then mutate.
   */
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
   * The same, for a surface that more than one named permission may open.
   *
   * doc 18 §3 writes some rows as a full grant in one column and `Read-only` in
   * another, and `Read-only` is a *different permission* — `<action>.read`. A
   * read endpoint therefore has to accept either, and it does so by evaluating
   * them in order and taking the first that the pipeline allows. Each attempt is
   * a full re-evaluation against server state; none of them widens the other.
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
