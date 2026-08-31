import { HOTEL_ACTIONS } from './actions';
import type { HotelAction } from './actions';
import type { Cell } from './cells';
import { catalogEntry } from './catalog';
import type { PackageCode } from './packages';
import { isRoleAssignableIn } from './packages';
import type { HotelRole } from './roles';

/**
 * Effective hotel permissions (doc 05 §3).
 *
 * ```
 * granted   = ∪ permissions of every active role on THIS membership
 * effective = granted ∩ permissions entitled by the hotel's applied package
 * ```
 *
 * Two properties this function exists to make impossible to get wrong:
 *
 *  - **Never unioned across hotels.** The input is one membership's roles, so
 *    there is no shape in which two memberships' roles could be merged
 *    (doc 06 §6).
 *  - **The package gate is above the role.** A role the current package does not
 *    permit contributes nothing at all, *and* the resulting set is intersected
 *    with what the package entitles. A Manager Plus role created on a 25,000₮
 *    hotel therefore fails twice, independently (doc 18 §4, `RBAC-DEC-003`).
 */
export function effectiveHotelPermissions(
  roles: readonly HotelRole[],
  packageCode: PackageCode,
  actions: readonly HotelAction[] = HOTEL_ACTIONS,
): ReadonlySet<string> {
  const granted = new Set<string>();

  for (const role of roles) {
    // A role the package does not permit is inert, however it came to be stored.
    if (!isRoleAssignableIn(role, packageCode)) continue;
    for (const action of actions) {
      const cell: Cell | undefined = action.cells[role];
      if (cell === undefined) continue;
      if (cell.kind === 'allow' && cell.packages.includes(packageCode)) {
        granted.add(action.id);
      }
      if (cell.kind === 'derived' && cell.packages.includes(packageCode)) {
        granted.add(`${action.id}.${cell.suffix}`);
      }
    }
  }

  // The entitlement intersection, evaluated against the catalog rather than
  // against the cell that produced the grant, so the two gates stay independent.
  const effective = new Set<string>();
  for (const permission of granted) {
    const entry = catalogEntry(permission);
    if (entry === undefined) continue;
    if (entry.entitledPackages.includes(packageCode)) effective.add(permission);
  }
  return effective;
}

/**
 * The grant half alone, before the package intersection.
 *
 * Exposed so a test can show the two gates are genuinely independent: a role
 * assignment that is refused by entitlement must be visible as granted-then-
 * withheld, not as never-granted.
 */
export function grantedHotelPermissions(
  roles: readonly HotelRole[],
  packageCode: PackageCode,
  actions: readonly HotelAction[] = HOTEL_ACTIONS,
): ReadonlySet<string> {
  const granted = new Set<string>();
  for (const role of roles) {
    for (const action of actions) {
      const cell: Cell | undefined = action.cells[role];
      if (cell === undefined) continue;
      if (cell.kind === 'allow' && cell.packages.includes(packageCode)) granted.add(action.id);
      if (cell.kind === 'derived' && cell.packages.includes(packageCode)) {
        granted.add(`${action.id}.${cell.suffix}`);
      }
    }
  }
  return granted;
}

/** The cell a given role holds for a given action, for diagnostics and tests. */
export function cellFor(action: HotelAction, role: HotelRole): Cell {
  const cell = action.cells[role];
  if (cell === undefined) {
    throw new Error(`the matrix has no ${role} column for ${action.id}`);
  }
  return cell;
}
