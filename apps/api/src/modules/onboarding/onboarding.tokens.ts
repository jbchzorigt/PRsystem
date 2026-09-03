/**
 * Injection tokens for the Phase 05 ports.
 *
 * Named constants rather than class references, for the same reason the IAM
 * module uses them: every adapter is selected by environment, and a class token
 * would tie the container to whichever implementation happened to be imported.
 */
export const PAYMENT_GATEWAYS = Symbol('onboarding.paymentGateways');
export const EBARIMT = Symbol('onboarding.ebarimt');
export const PHONE_VERIFICATION = Symbol('onboarding.phoneVerification');
export const ONBOARDING_POOL = Symbol('onboarding.pool');
export const ONBOARDING_PARAMS = Symbol('onboarding.parameters');
export const PROVISIONING_SIGNAL = Symbol('onboarding.provisioningSignal');
