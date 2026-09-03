/**
 * Injection tokens for the catalog module.
 *
 * The subscription-state port is **not** declared here: the module reads the
 * IAM module's `SUBSCRIPTION_STATE` export, so the entitlement gate the catalog
 * evaluates is the same instance the rest of the Hotel realm authorizes against.
 */
export const CATALOG_POOL = Symbol('catalog.pool');
