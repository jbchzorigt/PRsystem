import type { AuthzRealm } from './catalog';
import { catalogEntry } from './catalog';
import { effectiveHotelPermissions, grantedHotelPermissions } from './effective';
import { operationAction } from './operation';
import { policeAction } from './police';
import type { PackageCode } from './packages';
import type { HotelRole, OperationRole, PoliceRole, RealmRole } from './roles';
import { isOperationRole, isPoliceRole } from './roles';
import type { SubscriptionSnapshot } from './subscription';
import { ALWAYS_AVAILABLE_PERMISSIONS, RENEWAL_PERMISSION, isOperational } from './subscription';

/**
 * The seven-stage authorization pipeline (doc 05 §2, `RBAC-DEC-006`).
 *
 * Every backend action evaluates all seven conditions, in this fixed order, and
 * any failure denies. The order is what stops a denial leaking information from
 * a later stage: stages 2–4 return **one indistinguishable denial**, so a caller
 * cannot probe whether a resource exists in another tenant, while stages 5–7
 * return actionable codes because the caller is legitimately inside the tenant.
 *
 * The function is pure. It reads no database and performs no I/O: everything it
 * needs is resolved by the caller and handed in, so the same decision can be
 * asserted in a unit test, replayed in an audit record, and re-evaluated at
 * commit time inside the transaction that applies the effect.
 */

export const STAGES = [
  'realm',
  'account_and_membership',
  'named_permission',
  'scope',
  'package_entitlement',
  'state',
  'step_up',
] as const;
export type Stage = (typeof STAGES)[number];

export const DENIAL_CODES = [
  'REALM_MISMATCH',
  'NOT_AUTHORIZED',
  'PACKAGE_NOT_ENTITLED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_STATE_UNAVAILABLE',
  'ACCOUNT_SUSPENDED',
  'STEP_UP_REQUIRED',
  'UNKNOWN_PERMISSION',
  'SEPARATION_OF_DUTIES',
] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];

/** doc 05 §2: stages 2–4 must be indistinguishable to the caller. */
export const INDISTINGUISHABLE_STAGES: readonly Stage[] = [
  'account_and_membership',
  'named_permission',
  'scope',
];

/**
 * `PENDING_ACTIVATION` is a Phase 05 state (doc 15 §5 step 7, §7): a first
 * Hotel Admin whose account exists but whose activation link has not been
 * redeemed. It is not `ACTIVE`, so stage 2 refuses it exactly as it refuses a
 * suspended one — and sign-in never issues a session for it.
 */
export const ACCOUNT_STATES = ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const MEMBERSHIP_STATES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export interface ResolvedMembership {
  readonly membershipId: string;
  readonly hotelId: string;
  /** Present only on a Restaurant-scoped membership (doc 06 §4.1). */
  readonly restaurantId?: string;
  readonly state: MembershipState;
  readonly roles: readonly HotelRole[];
  readonly revision: number;
}

export interface Principal {
  readonly accountId: string;
  readonly realm: AuthzRealm;
  readonly accountState: AccountState;
  /** Hotel realm. Never merged across hotels — the pipeline picks exactly one. */
  readonly memberships: readonly ResolvedMembership[];
  /** Operation and Police realms: explicit per-account permission grants. */
  readonly directPermissions: readonly string[];
  /**
   * Operation and Police realms: the column of doc 18 §5 / §6 this account is
   * evaluated against. Absent for a Hotel or Guest principal, and absent for a
   * realm account that has not been given one — which denies, rather than
   * defaulting to the weaker column.
   */
  readonly realmRole?: RealmRole;
  /** doc 18 §6: the unit/scope an Officer's `own_police_scope` rows are confined to. */
  readonly policeScopeRef?: string;
  /** When the principal last completed a step-up challenge. */
  readonly stepUpAt?: Date;
}

export interface AuthorizationInput {
  /** The realm this endpoint belongs to. Fixed by the route, never by the caller. */
  readonly endpointRealm: AuthzRealm;
  readonly permission: string;
  readonly principal: Principal;
  /**
   * The **request target**, not an assertion of authority (doc 06 §2). A
   * `hotel_id` in a URL is checked against the actor's memberships at stage 4.
   */
  readonly target: { readonly hotelId?: string; readonly restaurantId?: string };
  /** Stage 6 input. `undefined` means the authoritative contract could not answer. */
  readonly subscription?: SubscriptionSnapshot;
  /** Guest realm: the account that owns the addressed resource (doc 06 §4.3). */
  readonly resourceOwnerAccountId?: string;
  /**
   * doc 05 §3.2: the account on the other side of an approval — the requester of
   * a correction, or the creator of a manual identity. Required by every row the
   * matrix marks with a separation rule, and its absence denies.
   */
  readonly separationCounterpartAccountId?: string;
  /** The police scope the addressed resource belongs to, for `own_police_scope` rows. */
  readonly resourceScopeRef?: string;
  readonly now: Date;
}

export type AuthorizationDecision =
  | {
      readonly allowed: true;
      readonly permission: string;
      /** The one membership the decision was made against, if any. */
      readonly membership?: ResolvedMembership;
      readonly effectivePackage?: PackageCode;
    }
  | {
      readonly allowed: false;
      readonly permission: string;
      readonly stage: Stage;
      readonly code: DenialCode;
    };

/** doc 05 §5: step-up is proof of recent possession, inside a ten-minute window. */
export const STEP_UP_WINDOW_MINUTES = 10;

function deny(permission: string, stage: Stage, code: DenialCode): AuthorizationDecision {
  return { allowed: false, permission, stage, code };
}

export function authorize(input: AuthorizationInput): AuthorizationDecision {
  const { permission, principal } = input;
  const entry = catalogEntry(permission);
  if (entry === undefined) {
    // Fail closed on an unknown name. A permission the catalog does not carry is
    // one nobody reviewed, and treating it as "not granted to anyone" would let
    // a typo look like a deliberate refusal.
    return deny(permission, 'named_permission', 'UNKNOWN_PERMISSION');
  }

  // ------------------------------------------------------------- 1. realm
  if (principal.realm !== input.endpointRealm || entry.realm !== input.endpointRealm) {
    return deny(permission, 'realm', 'REALM_MISMATCH');
  }

  // --------------------------------------- 2. active account and membership
  if (principal.accountState !== 'ACTIVE') {
    // An inactive account is refused before anything else is consulted, and with
    // the same denial as a missing membership: stage 2 tells a caller nothing.
    return deny(permission, 'account_and_membership', 'NOT_AUTHORIZED');
  }

  if (entry.realm === 'hotel') return authorizeHotel(input, entry.entitledPackages);
  if (entry.realm === 'guest') return authorizeGuest(input, entry.ownershipScope !== undefined);
  if (entry.realm === 'operation') return authorizeOperation(input);
  return authorizePolice(input);
}

/** The exact restaurant scope is evaluated before the hotel-wide one. */
function coverRank(
  membership: ResolvedMembership,
  target: { readonly restaurantId?: string },
): number {
  if (target.restaurantId !== undefined && membership.restaurantId === target.restaurantId) {
    return 0;
  }
  return 1;
}

function authorizeHotel(
  input: AuthorizationInput,
  entitledPackages: readonly PackageCode[],
): AuthorizationDecision {
  const { permission, principal, target } = input;
  const targetHotelId = target.hotelId;
  if (targetHotelId === undefined) {
    return deny(permission, 'account_and_membership', 'NOT_AUTHORIZED');
  }

  // --------------------------------- 2. active account and membership
  // Only memberships in the target hotel are consulted. A membership in another
  // hotel is not read at all, so there is no shape in which two hotels' roles
  // could be unioned (doc 06 §6).
  const inHotel = principal.memberships.filter(
    (entry) => entry.hotelId === targetHotelId && entry.state === 'ACTIVE',
  );
  if (inHotel.length === 0) {
    return deny(permission, 'account_and_membership', 'NOT_AUTHORIZED');
  }

  // ------------------------------------------------- 3. named permission
  // The session actions of doc 18 §7 are held by any active membership: they
  // are what a hard lock leaves behind, so they are never role-gated.
  const alwaysAvailable = ALWAYS_AVAILABLE_PERMISSIONS.includes(permission);
  const subscription = input.subscription;
  const packageCode = subscription?.effectivePackage;

  // Evaluated with the *effective* package, so a role the package does not
  // permit contributes nothing at stage 3 either. Without a package the grant
  // half cannot be evaluated at all and stage 5 refuses.
  const grantsOf = (entry: ResolvedMembership): ReadonlySet<string> =>
    packageCode === undefined
      ? new Set<string>()
      : grantedHotelPermissions(entry.roles, packageCode);

  if (!alwaysAvailable && packageCode !== undefined) {
    const grantedInHotel = inHotel.some((entry) => grantsOf(entry).has(permission));
    if (!grantedInHotel) {
      return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
    }
  }

  // ------------------------------------------------------------ 4. scope
  // The membership whose scope **covers** the request (doc 06 §4.1). A
  // hotel-scoped membership covers any target in its hotel — including one that
  // names a restaurant, because a row like `Restaurant Manager account үүсгэх`
  // is a Manager Plus action *about* a restaurant, and doc 19 §3 is explicit
  // that the inviter needs no membership inside it. A restaurant-scoped
  // membership covers only its own restaurant, so a Restaurant Manager asking
  // about another one is refused here.
  //
  // The exact restaurant is tried first, so a person holding both is evaluated
  // as the narrower one before the wider. Each candidate is evaluated **on its
  // own**: this is "does any single membership authorise this?", never a union
  // of two memberships' roles, which doc 06 §6 forbids.
  const covering = inHotel
    .filter(
      (entry) => entry.restaurantId === undefined || entry.restaurantId === target.restaurantId,
    )
    .sort((left, right) => coverRank(left, target) - coverRank(right, target));
  const membership = covering.find(
    (entry) => alwaysAvailable || packageCode === undefined || grantsOf(entry).has(permission),
  );
  if (membership === undefined) {
    return deny(permission, 'scope', 'NOT_AUTHORIZED');
  }

  // ---------------------------------------------- 5. package entitlement
  if (subscription === undefined) {
    // Fail closed. The authoritative contract could not answer, so nothing about
    // this hotel's entitlement or state is known.
    return deny(permission, 'package_entitlement', 'SUBSCRIPTION_STATE_UNAVAILABLE');
  }
  if (!alwaysAvailable) {
    if (!entitledPackages.includes(subscription.effectivePackage)) {
      return deny(permission, 'package_entitlement', 'PACKAGE_NOT_ENTITLED');
    }
    const effective = effectiveHotelPermissions(membership.roles, subscription.effectivePackage);
    if (!effective.has(permission)) {
      return deny(permission, 'package_entitlement', 'PACKAGE_NOT_ENTITLED');
    }
  }

  // -------------------------------------------------------------- 6. state
  if (subscription.state === 'SUSPENDED') {
    return deny(permission, 'state', 'ACCOUNT_SUSPENDED');
  }
  if (!isOperational(subscription.state)) {
    // Hard lock: renew, help and logout survive; the whole operational matrix
    // does not (doc 18 §7). The renewal action is the Hotel Admin's, and it is
    // decided by the permission the role actually holds, not by the role name.
    const survives =
      ALWAYS_AVAILABLE_PERMISSIONS.includes(permission) ||
      (permission === RENEWAL_PERMISSION &&
        effectiveHotelPermissions(membership.roles, subscription.effectivePackage).has(
          RENEWAL_PERMISSION,
        ));
    if (!survives) return deny(permission, 'state', 'SUBSCRIPTION_EXPIRED');
  }

  // ------------------------------------------------------------ 7. step-up
  const stepUp = stepUpDecision(input);
  if (stepUp !== undefined) return stepUp;

  return {
    allowed: true,
    permission,
    membership,
    effectivePackage: subscription.effectivePackage,
  };
}

function authorizeGuest(input: AuthorizationInput, ownershipRow: boolean): AuthorizationDecision {
  const { permission, principal } = input;
  // Guest authorization is ownership-based (doc 06 §4.3). There is no
  // membership, no role and no package: the only question is whether the
  // addressed resource belongs to this account — and on a row the matrix marks
  // with an ownership scope that question cannot be skipped. An owner the caller
  // did not load is refused, not waved through: `booking.cancel_own` without an
  // explicitly loaded owner would otherwise cancel any booking at all.
  if (ownershipRow) {
    if (input.resourceOwnerAccountId === undefined) {
      return deny(permission, 'scope', 'NOT_AUTHORIZED');
    }
  }
  if (
    input.resourceOwnerAccountId !== undefined &&
    input.resourceOwnerAccountId !== principal.accountId
  ) {
    return deny(permission, 'scope', 'NOT_AUTHORIZED');
  }
  const stepUp = stepUpDecision(input);
  if (stepUp !== undefined) return stepUp;
  return { allowed: true, permission };
}

/**
 * Operation and Platform Super Admin (doc 18 §5).
 *
 * Three independent conditions, none of which a stored row can supply on its
 * own: the table must grant the row to *some* column, the account's realm role
 * must be one of those columns, and the account must hold the row's **canonical
 * named permission**. The dotted action id is an identifier, never a grant — a
 * row stored under it satisfies nothing, which is what makes
 * `permission: null` / `grantableTo: []` structurally impossible rather than
 * merely unassigned.
 */
function authorizeOperation(input: AuthorizationInput): AuthorizationDecision {
  const { permission, principal } = input;
  const action = operationAction(permission);
  if (action === undefined) return deny(permission, 'named_permission', 'UNKNOWN_PERMISSION');

  // A row the document refuses to both columns. There is no permission to hold.
  if (action.permission === null || action.grantableTo.length === 0) {
    return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
  }

  const role = principal.realmRole;
  if (role === undefined || !isOperationRole(role)) {
    return deny(permission, 'account_and_membership', 'NOT_AUTHORIZED');
  }
  if (!action.grantableTo.includes(role as OperationRole)) {
    return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
  }
  if (!principal.directPermissions.includes(action.permission)) {
    return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
  }

  const stepUp = stepUpDecision(input);
  if (stepUp !== undefined) return stepUp;
  return { allowed: true, permission };
}

/**
 * Police (doc 18 §6).
 *
 * The cell for the account's own column decides, in the four forms the table
 * uses: refused, allowed, allowed-within-own-scope, or allowed only to an
 * account holding a named permission. A separation rule on the cell is compared
 * on immutable account ids and **fails closed** when the counterpart was not
 * loaded: an unknown requester is not a different requester.
 */
function authorizePolice(input: AuthorizationInput): AuthorizationDecision {
  const { permission, principal } = input;
  const action = policeAction(permission);
  if (action === undefined) return deny(permission, 'named_permission', 'UNKNOWN_PERMISSION');

  const role = principal.realmRole;
  if (role === undefined || !isPoliceRole(role)) {
    return deny(permission, 'account_and_membership', 'NOT_AUTHORIZED');
  }
  const cell = action.cells[role as PoliceRole];

  if (cell.kind === 'deny') return deny(permission, 'named_permission', 'NOT_AUTHORIZED');

  if (cell.kind === 'named') {
    if (!principal.directPermissions.includes(cell.permission)) {
      return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
    }
    if (cell.separation !== undefined) {
      const counterpart = input.separationCounterpartAccountId;
      if (counterpart === undefined || counterpart === principal.accountId) {
        return deny(permission, 'scope', 'SEPARATION_OF_DUTIES');
      }
    }
  }

  if (cell.kind === 'allow' && cell.scope === 'own_police_scope') {
    const own = principal.policeScopeRef;
    const addressed = input.resourceScopeRef;
    if (own === undefined || addressed === undefined || own !== addressed) {
      return deny(permission, 'scope', 'NOT_AUTHORIZED');
    }
  }

  const stepUp = stepUpDecision(input);
  if (stepUp !== undefined) return stepUp;
  return { allowed: true, permission };
}

function stepUpDecision(input: AuthorizationInput): AuthorizationDecision | undefined {
  const entry = catalogEntry(input.permission);
  if (entry === undefined || !entry.stepUp) return undefined;
  const at = input.principal.stepUpAt;
  if (at === undefined) return deny(input.permission, 'step_up', 'STEP_UP_REQUIRED');
  const ageMs = input.now.getTime() - at.getTime();
  if (ageMs < 0 || ageMs > STEP_UP_WINDOW_MINUTES * 60_000) {
    return deny(input.permission, 'step_up', 'STEP_UP_REQUIRED');
  }
  return undefined;
}
