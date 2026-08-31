import type {
  AuthorizationDecision,
  AuthzRealm,
  Principal,
  RealmRole,
  ResolvedMembership,
  SubscriptionStatePort,
} from '@prsystem/authz';
import { authorize } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { AccountRepository } from '../repositories/account.repository';
import { MembershipRepository } from '../repositories/membership.repository';

/**
 * The binding between the pure pipeline and the database (doc 05 §2).
 *
 * Two things happen here and nowhere else:
 *
 *  - the principal is **resolved from server state** — account, memberships,
 *    active role grants, explicit permission grants — never from anything the
 *    caller sent (`RBAC-DEC-006`, doc 05 §6);
 *  - a denial is **audited and flattened**. Stages 1–4 all become one
 *    indistinguishable `NOT_FOUND` with an identical body, so a caller cannot
 *    learn whether a resource exists in another tenant (doc 06 §5).
 */

/** The single message every indistinguishable denial carries. */
const OPAQUE_DENIAL = 'not found';

/**
 * A denial, carrying what the audit record needs.
 *
 * It is an `ApiError`, so the filter renders it exactly as it would any other
 * refusal and the caller learns nothing extra. The stage and the code travel
 * with it for the audit write, which happens in a transaction of its own —
 * writing it into the transaction the denial aborts would roll the record back
 * along with the effect, and doc 05 §7 requires the attempt to leave a trace.
 */
export class AuthorizationDenied extends ApiError {
  constructor(
    error: ApiError,
    readonly permission: string,
    readonly stage: string,
    readonly denialCode: string,
    readonly targetType?: string,
    readonly targetRef?: string,
  ) {
    super(error.code, error.message, error.details);
  }
}

/**
 * Reads the whole principal from server state.
 *
 * `stepUpAt` is **not** server state of the account — it is a property of the
 * session that authenticated, so the caller passes the value the session row
 * carried. Dropping it here is what would silently turn every step-up-gated
 * action into a refusal no fresh challenge could satisfy.
 */
export async function resolvePrincipal(
  uow: UnitOfWork,
  accountId: string,
  stepUpAt?: Date,
): Promise<Principal | undefined> {
  const accounts = new AccountRepository(uow);
  const account = await accounts.findById(accountId);
  if (account === undefined) return undefined;

  const memberships = new MembershipRepository(uow);
  const rows = await memberships.forAccount(accountId);
  const roles = await memberships.rolesForAccount(accountId);
  const directPermissions = await accounts.permissionsFor(accountId);

  const resolved: ResolvedMembership[] = rows.map((row) => ({
    membershipId: row.membershipId,
    hotelId: row.hotelId,
    ...(row.restaurantId === null ? {} : { restaurantId: row.restaurantId }),
    state: row.state,
    roles: roles.get(row.membershipId) ?? [],
    revision: row.membershipRevision,
  }));

  return {
    accountId: account.accountId,
    realm: account.realm as AuthzRealm,
    accountState: account.state,
    memberships: resolved,
    directPermissions,
    ...(account.realmRole === null ? {} : { realmRole: account.realmRole as RealmRole }),
    ...(account.policeScopeRef === null ? {} : { policeScopeRef: account.policeScopeRef }),
    ...(stepUpAt === undefined ? {} : { stepUpAt }),
  };
}

export interface AuthorizeCommandInput {
  readonly uow: UnitOfWork;
  readonly endpointRealm: AuthzRealm;
  readonly permission: string;
  readonly principal: Principal;
  readonly target: { readonly hotelId?: string; readonly restaurantId?: string };
  readonly subscription: SubscriptionStatePort;
  readonly resourceOwnerAccountId?: string;
  /**
   * The verified session the command is running under.
   *
   * doc 19 §10: authority inside a hotel is the session's scope grant, not the
   * session itself. Passing it here is what lets the commit-time re-evaluation
   * check that the grant is still live at the membership's current revision — so
   * a role change or a suspension that commits first wins over a request that
   * was authorised a moment earlier.
   */
  readonly sessionId?: string;
  /** The step-up recency the authenticated session carried. */
  readonly stepUpAt?: Date;
  readonly separationCounterpartAccountId?: string;
  readonly resourceScopeRef?: string;
  /** Recorded on the audit event so a denial can be traced to a request. */
  readonly targetType?: string;
  readonly targetRef?: string;
}

/**
 * Evaluates the pipeline against freshly read state, and throws on a denial.
 *
 * Called **inside** the transaction that will apply the effect, after the rows
 * it depends on have been locked, so the state it reads is the state the effect
 * commits against (CLAUDE.md §6).
 *
 * The principal handed in is treated as an **identity claim only**: the account,
 * its memberships, its live role grants and its explicit permission grants are
 * all re-read here. A membership suspended between the request being
 * authenticated and the command reaching its lock is therefore suspended for
 * this command too — which is the whole point of re-evaluating at commit.
 */
export async function authorizeCommand(
  input: AuthorizeCommandInput,
): Promise<Extract<AuthorizationDecision, { allowed: true }>> {
  const now = input.uow.serverNow;
  const snapshot =
    input.target.hotelId === undefined
      ? undefined
      : await input.subscription.snapshot(input.target.hotelId, now);

  const principal = await resolvePrincipal(
    input.uow,
    input.principal.accountId,
    input.stepUpAt ?? input.principal.stepUpAt,
  );
  if (principal === undefined) {
    throw new AuthorizationDenied(
      new ApiError('NOT_FOUND', OPAQUE_DENIAL),
      input.permission,
      'account_and_membership',
      'NOT_AUTHORIZED',
      input.targetType,
      input.targetRef,
    );
  }

  const decision = authorize({
    endpointRealm: input.endpointRealm,
    permission: input.permission,
    principal,
    target: input.target,
    ...(snapshot === undefined ? {} : { subscription: snapshot }),
    ...(input.resourceOwnerAccountId === undefined
      ? {}
      : { resourceOwnerAccountId: input.resourceOwnerAccountId }),
    ...(input.separationCounterpartAccountId === undefined
      ? {}
      : { separationCounterpartAccountId: input.separationCounterpartAccountId }),
    ...(input.resourceScopeRef === undefined ? {} : { resourceScopeRef: input.resourceScopeRef }),
    now,
  });

  if (decision.allowed) {
    // The last gate, and the one a concurrent lifecycle command wins: the
    // session must still hold a live scope grant on the very membership the
    // decision was made against, at that membership's current revision.
    const membership = decision.membership;
    if (membership !== undefined && input.sessionId !== undefined) {
      const grant = await new MembershipRepository(input.uow).liveScopeGrant(
        input.sessionId,
        membership.membershipId,
      );
      if (grant === undefined || grant.membershipRevision !== membership.revision) {
        throw new AuthorizationDenied(
          new ApiError('NOT_FOUND', OPAQUE_DENIAL),
          input.permission,
          'scope',
          'NOT_AUTHORIZED',
          input.targetType,
          input.targetRef,
        );
      }
    }
    return decision;
  }

  throw new AuthorizationDenied(
    denialToApiError(decision),
    input.permission,
    decision.stage,
    decision.code,
    input.targetType,
    input.targetRef,
  );
}

/**
 * Maps a denial to the response the caller sees.
 *
 * Stages 1–4 are one answer: the same status, the same code and the same
 * message, with no detail. Stages 5–7 are actionable, because the caller is
 * legitimately inside the tenant and needs to know what to do.
 */
export function denialToApiError(
  decision: Extract<AuthorizationDecision, { allowed: false }>,
): ApiError {
  switch (decision.code) {
    case 'REALM_MISMATCH':
    case 'NOT_AUTHORIZED':
      return new ApiError('NOT_FOUND', OPAQUE_DENIAL);
    case 'PACKAGE_NOT_ENTITLED':
      return new ApiError('FORBIDDEN', 'the hotel package does not include this action');
    case 'SUBSCRIPTION_EXPIRED':
      return new ApiError('FORBIDDEN', 'the subscription has expired');
    case 'ACCOUNT_SUSPENDED':
      return new ApiError('FORBIDDEN', 'the subscription is suspended');
    case 'SUBSCRIPTION_STATE_UNAVAILABLE':
      // Fail closed and say so: the authoritative contract could not answer, and
      // pretending the hotel is active would be the stale flag this design
      // exists to remove.
      return new ApiError('DEPENDENCY_UNAVAILABLE', 'the subscription state cannot be determined');
    case 'STEP_UP_REQUIRED':
      return new ApiError('PRECONDITION_FAILED', 'a recent step-up authentication is required');
    case 'SEPARATION_OF_DUTIES':
      // doc 05 §3.2: an approver is never the requester or the creator. The
      // caller is legitimately inside the realm, so the reason is actionable.
      return new ApiError('FORBIDDEN', 'this decision belongs to a different account');
    case 'UNKNOWN_PERMISSION':
    default:
      // A permission the catalog does not carry is a defect in this service, not
      // in the request.
      return new ApiError('INTERNAL_ERROR', 'the action is not in the permission catalog');
  }
}

/** The denial every caller outside the tenant sees, whatever the real reason. */
export function opaqueDenial(): ApiError {
  return new ApiError('NOT_FOUND', OPAQUE_DENIAL);
}
