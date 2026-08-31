import type { HotelAction } from './actions';
import { GUEST_ACTIONS, HOTEL_ACTIONS } from './actions';
import type { Cell } from './cells';
import { OPERATION_ACTIONS } from './operation';
import { POLICE_ACTIONS } from './police';
import type { PackageCode } from './packages';
import { ALL_PACKAGES } from './packages';
import type { HotelRole } from './roles';
import { SESSION_ACTIONS } from './subscription';

/**
 * The four authentication realms (doc 05 §1). Declared here rather than imported
 * from `@prsystem/db` so the catalog stays a pure value with no database
 * dependency: it is loaded by the API, by tests, and by the OpenAPI generator.
 */
export const AUTHZ_REALMS = ['hotel', 'guest', 'operation', 'police'] as const;
export type AuthzRealm = (typeof AUTHZ_REALMS)[number];

/**
 * One named permission, as the rest of the platform sees it.
 *
 * Stable and machine-readable: a permission id is part of the contract between
 * the catalog, the database grants and the API. Entries are added, never
 * renamed or repurposed — `RBAC-DEC-006` makes every backend action check one of
 * these by name, and a renamed permission silently opens or closes an action.
 */
export interface CatalogEntry {
  readonly permission: string;
  readonly realm: AuthzRealm;
  /** The document and section the permission is derived from. */
  readonly source: string;
  /** The source row heading, verbatim. */
  readonly label: string;
  /**
   * Packages in which the action exists at all — the union of every column that
   * grants it. Empty for realms with no package concept.
   */
  readonly entitledPackages: readonly PackageCode[];
  /** Hotel roles whose own column grants this permission. */
  readonly grantedByRoles: readonly HotelRole[];
  /** True where the permission is only ever held by an explicit per-account grant. */
  readonly explicitGrantOnly: boolean;
  /** doc 05 §5: recent step-up required before the action. */
  readonly stepUp: boolean;
}

const HOTEL_ROLE_COLUMNS: readonly HotelRole[] = [
  'HOTEL_ADMIN',
  'MANAGER',
  'MANAGER_PLUS',
  'RECEPTION',
  'CLEANER',
  'RESTAURANT_MANAGER',
];

function permissionIdOf(action: HotelAction, cell: Cell): string | undefined {
  if (cell.kind === 'allow') return action.id;
  if (cell.kind === 'derived') return `${action.id}.${cell.suffix}`;
  return undefined;
}

/** Every permission id a hotel row produces, with the roles and packages behind it. */
interface HotelDerivation {
  readonly permission: string;
  readonly action: HotelAction;
  readonly roles: readonly HotelRole[];
  readonly packages: readonly PackageCode[];
}

export function deriveHotelPermissions(
  actions: readonly HotelAction[] = HOTEL_ACTIONS,
): readonly HotelDerivation[] {
  const byPermission = new Map<
    string,
    { action: HotelAction; roles: Set<HotelRole>; packages: Set<PackageCode> }
  >();

  for (const action of actions) {
    for (const [role, cell] of Object.entries(action.cells) as [HotelRole, Cell][]) {
      const permission = permissionIdOf(action, cell);
      if (permission === undefined) continue;
      const packages = cell.kind === 'allow' || cell.kind === 'derived' ? cell.packages : [];
      const existing = byPermission.get(permission);
      const entry = existing ?? { action, roles: new Set<HotelRole>(), packages: new Set() };
      entry.roles.add(role);
      for (const code of packages) entry.packages.add(code);
      byPermission.set(permission, entry);
    }
    // A row every column refuses still names a permission: `RBAC-DEC-006` needs
    // the action to exist in the catalog so a backend check can refuse by name
    // rather than by the absence of an entry.
    if (!byPermission.has(action.id)) {
      byPermission.set(action.id, { action, roles: new Set(), packages: new Set() });
    }
  }

  return [...byPermission.entries()]
    .map(([permission, entry]) => ({
      permission,
      action: entry.action,
      roles: [...entry.roles].sort(),
      packages: [...entry.packages].sort(),
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

/**
 * The whole catalog: hotel rows, guest rows, Operation rows and Police rows.
 *
 * One entry per permission id. A permission that appears in two source tables —
 * `booking.cancel_own` is a Guest action the hotel matrix also lists, so that
 * the matrix states no hotel role may perform it — is one entry, in the realm
 * that can actually hold it.
 */
export const PERMISSION_CATALOG: readonly CatalogEntry[] = buildCatalog();

function buildCatalog(): readonly CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();

  for (const derived of deriveHotelPermissions()) {
    entries.set(derived.permission, {
      permission: derived.permission,
      realm: 'hotel',
      source: derived.action.source,
      label: derived.action.label,
      entitledPackages: derived.packages,
      grantedByRoles: derived.roles,
      explicitGrantOnly: false,
      stepUp: false,
    });
  }

  // Guest rows overwrite a same-named hotel row deliberately: the hotel matrix
  // lists them to say no hotel role holds them, and the realm that can hold the
  // permission is the one the catalog must record.
  for (const action of GUEST_ACTIONS) {
    entries.set(action.id, {
      permission: action.id,
      realm: 'guest',
      source: action.source,
      label: action.label,
      entitledPackages: [],
      grantedByRoles: [],
      explicitGrantOnly: false,
      stepUp: false,
    });
  }

  // The three session actions of doc 18 §7. Every hotel role holds them in
  // every package: they are what remains when the operational matrix is denied
  // in full, so they can never themselves be package- or role-gated.
  for (const action of SESSION_ACTIONS) {
    entries.set(action.id, {
      permission: action.id,
      realm: 'hotel',
      source: action.source,
      label: action.label,
      entitledPackages: ALL_PACKAGES,
      grantedByRoles: [...HOTEL_ROLE_COLUMNS],
      explicitGrantOnly: false,
      stepUp: false,
    });
  }

  for (const action of OPERATION_ACTIONS) {
    entries.set(action.id, {
      permission: action.id,
      realm: 'operation',
      source: action.source,
      label: action.label,
      entitledPackages: [],
      grantedByRoles: [],
      explicitGrantOnly: true,
      stepUp: action.stepUp,
    });
  }

  for (const action of POLICE_ACTIONS) {
    const explicit = Object.values(action.cells).every((cell) => cell.kind !== 'allow');
    entries.set(action.id, {
      permission: action.id,
      realm: 'police',
      source: action.source,
      label: action.label,
      entitledPackages: [],
      grantedByRoles: [],
      explicitGrantOnly: explicit,
      stepUp: action.stepUp,
    });
  }

  return [...entries.values()].sort((a, b) => a.permission.localeCompare(b.permission));
}

const CATALOG_BY_ID = new Map(PERMISSION_CATALOG.map((entry) => [entry.permission, entry]));

export function catalogEntry(permission: string): CatalogEntry | undefined {
  return CATALOG_BY_ID.get(permission);
}

/** Every permission id, sorted. The stable machine-readable surface. */
export const PERMISSION_IDS: readonly string[] = PERMISSION_CATALOG.map(
  (entry) => entry.permission,
);
