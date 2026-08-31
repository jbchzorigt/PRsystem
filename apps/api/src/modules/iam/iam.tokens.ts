/**
 * Injection tokens for the IAM module's ports.
 *
 * Named constants rather than class references: an adapter is selected by
 * environment (`selectSubscriptionState`, `selectStaffNotification`), and a
 * class token would tie the container to whichever implementation happened to be
 * imported.
 */
export const SUBSCRIPTION_STATE = Symbol('iam.subscriptionState');
export const STAFF_NOTIFICATION = Symbol('iam.staffNotification');
export const AUTH_PARAMETERS = Symbol('iam.authParameters');
export const OPEN_WORK = Symbol('iam.openWork');
export const RESTAURANT_DIRECTORY = Symbol('iam.restaurantDirectory');
export const IAM_POOL = Symbol('iam.pool');
export const KEY_MANAGEMENT = Symbol('iam.keyManagement');
