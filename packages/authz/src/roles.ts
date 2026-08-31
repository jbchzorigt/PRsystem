/**
 * The role vocabulary of every realm, and the package a role may exist in.
 *
 * A role name grants nothing on its own (`RBAC-DEC-004`, doc 05 §1.1). It is a
 * key into the canonical matrix in `actions.ts`, and the matrix is what decides
 * whether an account may perform a named action.
 */

/** doc 18 §3 column headings, in the order the matrix states them. */
export const HOTEL_ROLES = [
  'HOTEL_ADMIN',
  'MANAGER',
  'MANAGER_PLUS',
  'RECEPTION',
  'CLEANER',
  'RESTAURANT_MANAGER',
] as const;

export type HotelRole = (typeof HOTEL_ROLES)[number];

/** doc 18 §5. Separate realm, separate population, no shared accounts. */
export const OPERATION_ROLES = ['OPERATION_ADMIN', 'PLATFORM_SUPER_ADMIN'] as const;
export type OperationRole = (typeof OPERATION_ROLES)[number];

/** doc 18 §6. */
export const POLICE_ROLES = ['POLICE_OFFICER', 'POLICE_ADMIN'] as const;
export type PoliceRole = (typeof POLICE_ROLES)[number];

/** The Guest realm has no roles: authorization is ownership-based (doc 06 §4.3). */
export const GUEST_ROLES = ['GUEST'] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

export function isHotelRole(value: string): value is HotelRole {
  return (HOTEL_ROLES as readonly string[]).includes(value);
}

export function isOperationRole(value: string): value is OperationRole {
  return (OPERATION_ROLES as readonly string[]).includes(value);
}

export function isPoliceRole(value: string): value is PoliceRole {
  return (POLICE_ROLES as readonly string[]).includes(value);
}

/**
 * The role a Restaurant membership carries, and the only one it may carry.
 *
 * doc 19 §3: Manager Plus invites a Restaurant Manager into one `restaurant_id`
 * scope and grants no general hotel role there.
 */
export const RESTAURANT_SCOPE_ROLE: HotelRole = 'RESTAURANT_MANAGER';
