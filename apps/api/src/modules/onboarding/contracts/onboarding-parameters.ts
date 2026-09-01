/**
 * Onboarding, pricing and lifecycle parameters.
 *
 * The fixed ones are approved decisions and are stated as constants elsewhere —
 * the three monthly prices (`SUB-DEC-001`), the four terms (`SUB-DEC-002`), the
 * zero discount (`SUB-DEC-003`), the 168-hour expiring-soon boundary and the
 * 48-hour grace (`LIFE-DEC-003`). What lives here is the configuration the
 * requirement documents deliberately leave open, carried in one versioned
 * record and stamped onto every artefact it produced.
 *
 * The VAT rate is the clearest case. Doc 16 §6 fixes that the published price is
 * VAT-inclusive; it does not fix the rate, and the official accounting treatment
 * is P1-11, still open in `assumptions-and-conflicts.md`. So the rate is
 * configuration with a version beside it, and every payment records the version
 * it was computed under. When P1-11 closes, the change is a new
 * `taxConfigVersion` and the historical rows keep meaning what they meant.
 */

export interface OnboardingParameters {
  /**
   * The price book these figures came from. Stamped onto every quote, invoice
   * and payment so a later price change cannot restate an old one (doc 16 §4).
   */
  readonly priceBookVersion: string;
  /** The tax configuration the VAT split was computed under. */
  readonly taxConfigVersion: string;
  /** The package feature set the entitlement snapshot refers to. */
  readonly packageFeatureVersion: string;
  /**
   * VAT, in basis points, of the tax-exclusive base — so a `1000` rate on a
   * VAT-inclusive 20,000₮ means 1,818₮ of tax inside it, not 2,000₮ on top.
   * Integer basis points, never a float (CLAUDE.md §5).
   */
  readonly vatRateBp: number;

  /** How long a draft application's bearer reference stays usable. */
  readonly applicationTtlSeconds: number;
  /** doc 15 §2.1: the phone OTP's lifetime and guess budget. */
  readonly otpTtlSeconds: number;
  readonly otpMaxAttempts: number;
  readonly otpLength: number;
  /** doc 15 §3.1: how long an ownership challenge stays open. */
  readonly ownerProofTtlSeconds: number;
  /** How long a payment invoice stays payable before it expires. */
  readonly paymentAttemptTtlSeconds: number;
  /** How long a renewal or upgrade quote stays payable. */
  readonly billingIntentTtlSeconds: number;

  /**
   * `ONB-DEC-006`: automatic provisioning retries before an operator with
   * `ONBOARDING_PROVISION_RETRY` has to take it on. Five, as the document says.
   */
  readonly provisioningMaxAutomaticAttempts: number;
  readonly provisioningRetryBackoffSeconds: number;
  readonly provisioningRetryBackoffCeilingSeconds: number;

  /** doc 15 §5: the first Hotel Admin's activation link. */
  readonly activationTtlSeconds: number;
  readonly activationLeaseSeconds: number;
  readonly activationDeliveryMaxAttempts: number;
  readonly activationRetryBackoffSeconds: number;
  readonly activationRetryBackoffCeilingSeconds: number;

  /** doc 16 §4.1: the eBarimt issuance queue. */
  readonly ebarimtLeaseSeconds: number;
  readonly ebarimtMaxAutomaticAttempts: number;
  readonly ebarimtRetryBackoffSeconds: number;
  readonly ebarimtRetryBackoffCeilingSeconds: number;

  /**
   * doc 15 §5.1: how close two hotels must be before the duplicate-review flag
   * is raised. Micro-degrees, so the comparison is integer arithmetic — roughly
   * 100 m at Ulaanbaatar's latitude.
   */
  readonly duplicateProximityMicroDegrees: number;
}

/** The current parameter set. Every open value carries the provisional prefix. */
export const ONBOARDING_PARAMETERS: OnboardingParameters = {
  priceBookVersion: 'pb-2026-08',
  // P1-11 is open: the official tax treatment awaits an accountant. The version
  // says so plainly, and every payment row records it.
  taxConfigVersion: 'p1-provisional-tax-2026-08',
  packageFeatureVersion: 'pkg-2026-08',
  vatRateBp: 1000,

  applicationTtlSeconds: 7 * 24 * 60 * 60,
  otpTtlSeconds: 5 * 60,
  otpMaxAttempts: 5,
  otpLength: 6,
  ownerProofTtlSeconds: 24 * 60 * 60,
  paymentAttemptTtlSeconds: 60 * 60,
  billingIntentTtlSeconds: 60 * 60,

  provisioningMaxAutomaticAttempts: 5,
  provisioningRetryBackoffSeconds: 5,
  provisioningRetryBackoffCeilingSeconds: 15 * 60,

  activationTtlSeconds: 7 * 24 * 60 * 60,
  activationLeaseSeconds: 2 * 60,
  activationDeliveryMaxAttempts: 5,
  activationRetryBackoffSeconds: 30,
  activationRetryBackoffCeilingSeconds: 15 * 60,

  ebarimtLeaseSeconds: 2 * 60,
  ebarimtMaxAutomaticAttempts: 3,
  ebarimtRetryBackoffSeconds: 30,
  ebarimtRetryBackoffCeilingSeconds: 15 * 60,

  duplicateProximityMicroDegrees: 1000,
};

/** True while any open P1 value in this set is still an unapproved placeholder. */
export function onboardingParametersAreProvisional(
  parameters: OnboardingParameters = ONBOARDING_PARAMETERS,
): boolean {
  return parameters.taxConfigVersion.startsWith('p1-provisional');
}
