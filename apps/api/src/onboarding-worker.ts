/**
 * The Phase 05 worker surface of the API package, consumed by the worker
 * deployment through `@prsystem/api/onboarding-worker`.
 *
 * The modular monolith has one API deployment and one worker deployment
 * (CLAUDE.md §1); they share modules, not a network. What crosses here is the
 * runtime the worker drives, the queue and job contracts the two agree on, and
 * the tokens an end-to-end test needs to reach the simulators the API booted.
 */
export {
  attachOnboardingWorkerRuntime,
  createOnboardingWorkerRuntime,
} from './modules/onboarding/worker/onboarding-worker';
export type {
  OnboardingWorkerConfig,
  OnboardingWorkerRuntime,
} from './modules/onboarding/worker/onboarding-worker';
export {
  PROVISIONING_QUEUE,
  signalJobId,
} from './modules/onboarding/contracts/bullmq-provisioning-signal';
export type {
  ProvisioningOutcome,
  SweepOutcome,
} from './modules/onboarding/services/provisioning.service';
export {
  EBARIMT,
  ONBOARDING_PARAMS,
  ONBOARDING_POOL,
  PAYMENT_GATEWAYS,
  PHONE_VERIFICATION,
  PROVISIONING_SIGNAL,
} from './modules/onboarding/onboarding.tokens';
