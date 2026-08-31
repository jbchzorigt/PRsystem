/**
 * Package entitlement (doc 18 §4, `RBAC-DEC-003`).
 *
 * Entitlement sits **above** role permission and cannot be bypassed by granting
 * a role: creating a Manager Plus role on a 25,000₮ hotel unlocks nothing, and
 * both the role assignment and the action API are refused.
 */

import type { HotelRole } from './roles';

/** MNT price points, used as the package identity. */
export const PACKAGES = ['P20', 'P25', 'P30'] as const;
export type PackageCode = (typeof PACKAGES)[number];

export const ALL_PACKAGES: readonly PackageCode[] = PACKAGES;
export const PACKAGE_25_30: readonly PackageCode[] = ['P25', 'P30'];
export const PACKAGE_30: readonly PackageCode[] = ['P30'];
export const PACKAGE_20: readonly PackageCode[] = ['P20'];

/** The monthly price each package is named for, in whole MNT. */
export const PACKAGE_PRICE_MNT: Readonly<Record<PackageCode, number>> = {
  P20: 20_000,
  P25: 25_000,
  P30: 30_000,
};

/**
 * doc 18 §4, transcribed row by row.
 *
 * Kept as the feature table the document states rather than derived from the
 * action matrix: the two are compared in `packages.test.ts`, so a permission
 * whose package annotation drifts away from the feature it belongs to is a test
 * failure rather than an invisible widening.
 */
export const PACKAGE_FEATURES = {
  reception: ALL_PACKAGES,
  manager_room_management: ALL_PACKAGES,
  cash_drawer_shift: ALL_PACKAGES,
  guest_registry: ALL_PACKAGES,
  official_reply: ALL_PACKAGES,
  cleaner_role_api: PACKAGE_25_30,
  minibar_management: PACKAGE_25_30,
  minibar_template: PACKAGE_25_30,
  manager_plus_restaurant_registration: PACKAGE_30,
  restaurant_manager: PACKAGE_30,
} as const satisfies Readonly<Record<string, readonly PackageCode[]>>;

export type PackageFeature = keyof typeof PACKAGE_FEATURES;

/**
 * Which hotel roles a package permits at all.
 *
 * doc 19 §3: Cleaner exists only on 25,000/30,000₮ and Manager Plus only on
 * 30,000₮, so an invitation naming an unentitled role is refused before a token
 * is ever created. Restaurant Manager follows restaurant registration, which is
 * a 30,000₮ feature.
 */
export function rolesAssignableIn(packageCode: PackageCode): readonly HotelRole[] {
  const base: HotelRole[] = ['HOTEL_ADMIN', 'MANAGER', 'RECEPTION'];
  if (packageCode === 'P25' || packageCode === 'P30') base.push('CLEANER');
  if (packageCode === 'P30') base.push('MANAGER_PLUS', 'RESTAURANT_MANAGER');
  return base;
}

export function isRoleAssignableIn(role: HotelRole, packageCode: PackageCode): boolean {
  return rolesAssignableIn(packageCode).includes(role);
}

export function isPackageCode(value: string): value is PackageCode {
  return (PACKAGES as readonly string[]).includes(value);
}
