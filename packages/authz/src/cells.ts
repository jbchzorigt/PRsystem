import type { PackageCode } from './packages';
import { ALL_PACKAGES, PACKAGE_20, PACKAGE_25_30, PACKAGE_30 } from './packages';
import type { HotelRole } from './roles';

/**
 * One cell of the canonical matrix, in the four forms doc 18 §3 actually uses.
 *
 * The document does not have a single "allowed" mark. It has `✓`, `—`,
 * `Нэмэлт <role> role`, `Read-only`, `Request`, package annotations, and
 * scope-limited or conditional grants written in prose. Flattening those into a
 * boolean is how `Нэмэлт role` stops being enforced: "Hotel Admin does not
 * inherit Manager" reads as `deny` for Hotel Admin *and* names the role that
 * does grant it, and both halves are asserted.
 */
export type Cell =
  | { readonly kind: 'deny'; readonly note?: string }
  | {
      readonly kind: 'allow';
      readonly packages: readonly PackageCode[];
      /** Prose limit the owning module enforces — never a substitute for the permission. */
      readonly scope?: CellScope;
      readonly condition?: CellCondition;
    }
  | {
      /**
       * `Нэмэлт <role> role`. The role in this column grants nothing here; the
       * named roles do. Held separately on the same membership, never inherited.
       */
      readonly kind: 'requires';
      readonly roles: readonly HotelRole[];
    }
  | {
      /**
       * A weaker permission than the row's action: `Read-only` grants
       * `<action>.read`, `Request` grants `<action>.request`.
       */
      readonly kind: 'derived';
      readonly suffix: DerivedSuffix;
      readonly packages: readonly PackageCode[];
      readonly scope?: CellScope;
    };

export const DERIVED_SUFFIXES = ['read', 'request'] as const;
export type DerivedSuffix = (typeof DERIVED_SUFFIXES)[number];

/**
 * A resource limit carried by the grant.
 *
 * The permission is granted; the owning module must additionally confine the
 * actor to the named resources. Recorded here so the limit is part of the
 * catalog rather than folklore in a later phase.
 */
export const CELL_SCOPES = [
  'own_restaurant',
  'own_task',
  'own_child_task',
  'own_shift',
  'own_request',
  'assigned_replacement',
  'own_managed_events',
  'booking_owner',
  'room_scope',
  'own_police_scope',
] as const;
export type CellScope = (typeof CELL_SCOPES)[number];

/**
 * A precondition the owning module must evaluate in addition to the permission.
 *
 * `self_approved` and `self_reviewed` are the two audited single-actor
 * exceptions of doc 05 §3.2: permitted, recorded, never silent.
 */
export const CELL_CONDITIONS = [
  'exception_review_only',
  'not_original_actor',
  'self_approved_audited',
  'self_reviewed_audited',
  'approved_request_only',
  'stay_dec_009_bound_and_reason',
  'limited_review',
] as const;
export type CellCondition = (typeof CELL_CONDITIONS)[number];

/** `✓` — allowed by this role, in every package unless narrowed. */
export function allow(
  packages: readonly PackageCode[] = ALL_PACKAGES,
  extra: { scope?: CellScope; condition?: CellCondition } = {},
): Cell {
  return {
    kind: 'allow',
    packages,
    ...(extra.scope === undefined ? {} : { scope: extra.scope }),
    ...(extra.condition === undefined ? {} : { condition: extra.condition }),
  };
}

/** `—` — refused for this role. */
export function deny(note?: string): Cell {
  return note === undefined ? { kind: 'deny' } : { kind: 'deny', note };
}

/** `Нэмэлт <role> role` — refused here; the named roles grant it. */
export function requires(...roles: readonly HotelRole[]): Cell {
  return { kind: 'requires', roles };
}

/** `Read-only` — grants `<action>.read` and not the action. */
export function readOnly(
  packages: readonly PackageCode[] = ALL_PACKAGES,
  extra: { scope?: CellScope } = {},
): Cell {
  return {
    kind: 'derived',
    suffix: 'read',
    packages,
    ...(extra.scope === undefined ? {} : { scope: extra.scope }),
  };
}

/** `Request` — grants `<action>.request` and not the decision itself. */
export function requestOnly(packages: readonly PackageCode[] = ALL_PACKAGES): Cell {
  return { kind: 'derived', suffix: 'request', packages };
}

export { ALL_PACKAGES, PACKAGE_20, PACKAGE_25_30, PACKAGE_30 };
