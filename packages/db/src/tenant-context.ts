/**
 * Server-derived tenant context (ADR-0017 §2–§3).
 *
 * The context is established from the resolved authorization result, never from a
 * URL or a request body. A `hotel_id` in a request is a *target*; authority comes
 * from membership. Phase 04 supplies the resolver — the kernel only guarantees
 * that nothing runs without a context.
 */

/** ADR-0005: realms never merge. Carried into the transaction for policy use. */
export type Realm = 'hotel' | 'guest' | 'operation' | 'police';

export const REALMS: readonly Realm[] = ['hotel', 'guest', 'operation', 'police'];

/**
 * Operations that belong to the platform rather than to one hotel run under this
 * scope. It is a real value rather than NULL so every tenant column stays
 * `NOT NULL` and the RLS predicate never has to reason about NULL.
 */
/**
 * The platform-wide scope, as distinct from any one hotel.
 *
 * **What the tenant-context mechanism protects against, and what it does not.**
 *
 * Scope is carried in transaction-local custom GUCs (`app.hotel_id` and
 * friends) and read by every RLS policy. That makes a *missing tenant predicate*
 * harmless — a query with no `WHERE hotel_id = …` still returns only the scoped
 * tenant's rows — and it makes scope leakage between pooled connections
 * impossible, because the settings are transaction-local and reset on release.
 *
 * It is **not** unforgeable. A custom GUC is writable by the session that holds
 * the connection, so a runtime credential that can execute arbitrary SQL can
 * call `set_config('app.hotel_id', …)` and choose its own scope. Defending
 * against that is the job of the layers above — parameterised queries, the
 * authorization pipeline, and the credential separation in ADR-0017 — not of
 * this mechanism, and no test here should be read as claiming otherwise.
 *
 * Server-derived authorization resolution, where the scope is established from
 * the authenticated principal rather than supplied by the caller, is Phase 04
 * work and does not exist yet.
 */
export const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';

export interface TenantContext {
  readonly hotelId: string;
  readonly realm: Realm;
  /** Opaque actor reference. Never a name, an email or any other identifier. */
  readonly actorRef: string;
  /**
   * The authenticated account, when there is one (Phase 04).
   *
   * Carried transaction-locally like the tenant scope, and read by the policies
   * on the two IAM tables that are about an account rather than about a hotel:
   * a principal must be able to read its own membership rows before any hotel
   * scope exists (doc 06 §2), and an account-wide session revocation crosses
   * every hotel the account belongs to (doc 19 §10).
   */
  readonly accountId?: string;
  /**
   * The pre-tenant onboarding reference (Phase 05).
   *
   * An onboarding application exists before any hotel does, so it cannot be
   * isolated by `hotel_id`: a nullable tenant column or the platform sentinel
   * would be a scope every applicant shares. This is a separate axis, carried
   * transaction-locally like the rest, and read by the onboarding policies.
   *
   * Unset it is NULL, and `application_id = NULL` is never true — so a statement
   * that has not presented an applicant's bearer secret sees zero applications
   * rather than everybody's.
   */
  readonly onboardingRef?: string;
  /**
   * The stay a Restaurant guest session is bound to (Phase 15).
   *
   * A restaurant guest is not an account. They are whoever holds the room's QR
   * and a one-time code, and doc 08 §7 confines what they may see to their own
   * stay — which cannot be expressed by `hotel_id`, because the menus they must
   * be able to read are the hotel's. So this is a separate axis, and the
   * restrictive policies of migration `0016` read it: a guest-realm transaction
   * that carries one sees the orders of that stay and no other.
   *
   * Unset it is NULL, and the restriction is then vacuous — which is the
   * correct reading of the one path that has no stay yet: redeeming a code,
   * where the stay is what the redemption is about to establish.
   */
  readonly guestStayId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export class TenantScopeError extends Error {
  override readonly name = 'TenantScopeError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates a context before it can reach `SET LOCAL`.
 *
 * The values are interpolated into `set_config` parameters rather than SQL text,
 * but they are validated anyway: a context that is not well formed is a bug in
 * the resolver, and failing here is cheaper than failing inside a policy.
 */
export function assertTenantContext(context: TenantContext): void {
  if (!UUID.test(context.hotelId)) {
    throw new TenantScopeError('tenant scope must be a UUID');
  }
  if (!REALMS.includes(context.realm)) {
    throw new TenantScopeError('unknown realm');
  }
  if (context.actorRef.length === 0 || context.actorRef.length > 128) {
    throw new TenantScopeError('actor reference is missing or implausible');
  }
  if (context.correlationId.length === 0 || context.correlationId.length > 128) {
    throw new TenantScopeError('correlation id is missing or implausible');
  }
  if (context.accountId !== undefined && !UUID.test(context.accountId)) {
    throw new TenantScopeError('the account reference must be a UUID');
  }
  if (context.onboardingRef !== undefined && !UUID.test(context.onboardingRef)) {
    throw new TenantScopeError('the onboarding reference must be a UUID');
  }
  if (context.guestStayId !== undefined && !UUID.test(context.guestStayId)) {
    throw new TenantScopeError('the guest stay reference must be a UUID');
  }
  // A restaurant guest session belongs to one stay inside one hotel, so it is
  // meaningless outside a hotel scope and meaningless outside the Guest realm.
  if (context.guestStayId !== undefined) {
    if (context.realm !== 'guest') {
      throw new TenantScopeError('a guest stay scope belongs to the Guest realm');
    }
    if (context.hotelId === PLATFORM_SCOPE) {
      throw new TenantScopeError('a guest stay scope belongs to a hotel, not to the platform');
    }
  }
  // The platform sentinel is not a hotel. It is the scope work that belongs to
  // no single tenant runs in: platform-wide Operation work, and — from Phase 04
  // — the account-scoped half of the Hotel realm, where signing in, changing a
  // password and logging out of every device belong to an account rather than
  // to one hotel.
  //
  // It widens nothing. No hotel carries the sentinel as its id, so every
  // tenant policy matches zero rows under it; the only rows reachable are the
  // account-scoped tables, which carry no `hotel_id` at all, and the principal's
  // own membership and session-scope rows through the account policies.
  // An account-scoped transaction that has not authenticated anybody yet —
  // signing in, asking for a reset link, redeeming one — establishes no account
  // either, and then the account policies match nothing as well. That is the
  // correct reading of those flows: they touch only the tables that carry no
  // tenant column at all.
  //
  // Phase 12 admits the Guest realm on exactly the same terms and for exactly
  // the same work: a guest belongs to no hotel, so registering, signing in and
  // recovering a password are account-scoped in the sense above, and the four
  // `guest_*` tables carry no `hotel_id` either. The public listing projection
  // runs here too, and reads across tenants only through the `SECURITY
  // DEFINER` functions of migration `0013` — never by widening this context.
  // Phase 18 admits the Police realm on the same terms, and for work that is
  // platform-wide by its nature rather than by accident: a wanted person
  // belongs to no hotel, a case belongs to no hotel, and a match belongs to the
  // Police realm even though it names one. None of the `police.*` tables
  // carries a `hotel_id` as a tenant axis, so the sentinel widens nothing there
  // either — what confines a Police transaction is the realm its policies
  // compare, the unit and territory scope doc 18 §6 applies above them, and the
  // fact that `prsystem_police` holds no grant on a hotel's own tables at all.
  //
  // Anything else is a resolver that has widened a tenant request into a
  // platform one. This is an application-boundary rule, not a database one —
  // see the note on what custom-GUC RLS does and does not protect against.
  if (
    context.hotelId === PLATFORM_SCOPE &&
    context.realm !== 'operation' &&
    context.realm !== 'hotel' &&
    context.realm !== 'guest' &&
    context.realm !== 'police'
  ) {
    throw new TenantScopeError(
      'the platform scope is valid only in the operation realm and for account-scoped work',
    );
  }
}

/** True when the context is the platform scope rather than a real hotel. */
export function isPlatformScope(context: TenantContext): boolean {
  return context.hotelId === PLATFORM_SCOPE;
}
