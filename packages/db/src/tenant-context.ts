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
export const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';

export interface TenantContext {
  readonly hotelId: string;
  readonly realm: Realm;
  /** Opaque actor reference. Never a name, an email or any other identifier. */
  readonly actorRef: string;
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
}

/** True when the context is the platform scope rather than a real hotel. */
export function isPlatformScope(context: TenantContext): boolean {
  return context.hotelId === PLATFORM_SCOPE;
}
