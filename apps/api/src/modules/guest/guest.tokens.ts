/**
 * Injection tokens for the guest module's ports.
 *
 * Named constants rather than class references: each adapter is selected by
 * environment (`selectPhoneVerification`, `selectEMongoliaAuth`), so a class
 * token would tie the container to whichever implementation happened to be
 * imported.
 */
export const GUEST_POOL = Symbol('guest.pool');
export const GUEST_OTP = Symbol('guest.phoneVerification');
export const GUEST_EMONGOLIA = Symbol('guest.emongolia');
export const GUEST_PARAMETERS_TOKEN = Symbol('guest.parameters');
