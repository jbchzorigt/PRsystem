import type { AuthzRealm } from './catalog';
import { catalogEntry } from './catalog';
import { effectiveHotelPermissions, grantedHotelPermissions } from './effective';
import type { PackageCode } from './packages';
import type { HotelRole } from './roles';
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
] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];

/** doc 05 §2: stages 2–4 must be indistinguishable to the caller. */
export const INDISTINGUISHABLE_STAGES: readonly Stage[] = [
  'account_and_membership',
  'named_permission',
  'scope',
];

export const ACCOUNT_STATES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
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
  if (entry.realm === 'guest') return authorizeGuest(input);
  return authorizeDirect(input);
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
  // The exact scope row the request addresses: the hotel-scoped membership, or
  // the membership for the named restaurant (doc 06 §4.1). A Restaurant Manager
  // asking about another restaurant resolves to no row and is refused here.
  const membership =
    target.restaurantId === undefined
      ? inHotel.find((entry) => entry.restaurantId === undefined)
      : inHotel.find((entry) => entry.restaurantId === target.restaurantId);
  if (membership === undefined) {
    return deny(permission, 'scope', 'NOT_AUTHORIZED');
  }
  // And the decision is made against that one row, never against the union.
  if (!alwaysAvailable && packageCode !== undefined && !grantsOf(membership).has(permission)) {
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

function authorizeGuest(input: AuthorizationInput): AuthorizationDecision {
  const { permission, principal } = input;
  // Guest authorization is ownership-based (doc 06 §4.3). There is no
  // membership, no role and no package: the only question is whether the
  // addressed resource belongs to this account.
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

function authorizeDirect(input: AuthorizationInput): AuthorizationDecision {
  const { permission, principal } = input;
  // Operation, Platform and Police: a role name grants nothing. The account
  // either holds the named permission explicitly or it does not.
  if (!principal.directPermissions.includes(permission)) {
    return deny(permission, 'named_permission', 'NOT_AUTHORIZED');
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
