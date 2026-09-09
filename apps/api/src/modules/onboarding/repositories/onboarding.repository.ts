import type { UnitOfWork } from '@prsystem/db';
import type { ReconciliationOutcome } from '../../operation/domain/operation';
import type { PackageCode } from '@prsystem/authz';
import type { PaymentProvider } from '@prsystem/ports';

/**
 * The pre-tenant onboarding graph.
 *
 * Every statement runs under `app.onboarding_ref` or the Operation realm — the
 * policies decide which rows exist, so nothing here reasons about visibility. A
 * lookup that returns nothing is a lookup the caller was not entitled to make,
 * and the service turns it into the same `NOT_FOUND` an absent application gets.
 *
 * From remediation 1 the application row is also the **durable provisioning
 * job**: it carries the claim token, the lease, the availability instant, the
 * attempt count and the last error, and the worker's claim, settlement and
 * backoff are all compare-and-set writes against it.
 */

export type ApplicationState =
  | 'DRAFT'
  | 'OWNER_VERIFICATION_REQUIRED'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_UNCERTAIN'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_EXPIRED'
  | 'PAID_OWNER_VERIFICATION_REQUIRED'
  | 'PAID_PENDING_PROVISIONING'
  | 'PROVISIONING'
  | 'PROVISIONING_FAILED'
  | 'PROVISIONED';

export type OwnerType = 'CITIZEN' | 'ORGANIZATION';

export type AttemptState =
  | 'PREPARING'
  | 'PENDING'
  | 'ABANDONED'
  | 'REFUSED'
  | 'PAYMENT_UNCERTAIN'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PAID_REQUIRES_RECONCILIATION';

export type ExistingAccountProofMethod = 'SIGNED_IN' | 'PASSWORD_RECOVERY';

export interface ApplicationRow {
  readonly applicationId: string;
  readonly state: ApplicationState;
  readonly ownerType: OwnerType;
  readonly ownerDisplayName: string;
  readonly representativeName: string | null;
  readonly representativePosition: string | null;
  readonly ownerIdentityType: string;
  readonly ownerCountryCode: string;
  readonly ownerLookupToken: string;
  readonly contactPhone: string;
  readonly contactPhoneVerifiedAt: Date | null;
  readonly subscriptionContactPhone: string;
  readonly adminEmailNormalized: string;
  readonly hotelDisplayName: string;
  readonly hotelPublicPhone: string;
  readonly district: string;
  readonly khoroo: string;
  readonly addressLine: string;
  readonly latitudeMicro: number;
  readonly longitudeMicro: number;
  readonly packageCode: PackageCode;
  readonly termMonths: number;
  readonly monthlyPriceMnt: bigint;
  readonly discountMnt: bigint;
  readonly totalAmountMnt: bigint;
  readonly vatRateBp: number;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
  readonly existingAccountId: string | null;
  readonly existingAccountProofMethod: ExistingAccountProofMethod | null;
  readonly existingAccountProvedAt: Date | null;
  readonly ownerId: string | null;
  readonly duplicateReviewRequired: boolean;
  readonly provisionedHotelId: string | null;
  readonly paidAttemptId: string | null;
  readonly paymentConfirmedAt: Date | null;
  readonly provisionAttempts: number;
  readonly provisionAvailableAt: Date;
  readonly provisionClaimToken: string | null;
  readonly provisionClaimedUntil: Date | null;
  readonly provisionLastError: string | null;
  readonly revision: number;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly applicationId: string;
  readonly provider: PaymentProvider;
  readonly merchantRef: string;
  /** NULL while the attempt is `PREPARING`: the provider has not answered yet. */
  readonly providerInvoiceId: string | null;
  readonly providerPaymentId: string | null;
  readonly state: AttemptState;
  readonly amountMnt: bigint;
  /** NULL when the provider stated no fee; never a fabricated zero. */
  readonly providerFeeMnt: bigint | null;
  readonly currency: string;
  readonly packageCode: PackageCode;
  readonly termMonths: number;
  readonly monthlyPriceMnt: bigint;
  readonly vatRateBp: number;
  readonly expiresAt: Date;
  readonly confirmedAt: Date | null;
  readonly revision: number;
}

const APPLICATION_COLUMNS = `
  application_id, state, owner_type, owner_display_name, representative_name,
  representative_position, owner_identity_type, owner_country_code,
  owner_identifier_lookup_token, contact_phone, contact_phone_verified_at,
  subscription_contact_phone, admin_email_normalized, hotel_display_name,
  hotel_public_phone, district, khoroo, address_line, latitude_micro, longitude_micro,
  package_code, term_months, monthly_price_mnt, discount_mnt, total_amount_mnt,
  vat_rate_bp, price_book_version, tax_config_version, package_feature_version,
  existing_account_id, existing_account_proof_method, existing_account_proved_at,
  owner_id, duplicate_review_required, provisioned_hotel_id,
  paid_attempt_id, payment_confirmed_at, provision_attempts, provision_available_at,
  provision_claim_token, provision_claimed_until, provision_last_error, revision`;

const ATTEMPT_COLUMNS = `
  attempt_id, application_id, provider, merchant_ref, provider_invoice_id,
  provider_payment_id, state, amount_mnt, provider_fee_mnt, currency, package_code,
  term_months, monthly_price_mnt, vat_rate_bp, expires_at, confirmed_at, revision`;

function mapApplication(row: Record<string, unknown> | undefined): ApplicationRow | undefined {
  if (row === undefined) return undefined;
  return {
    applicationId: row['application_id'] as string,
    state: row['state'] as ApplicationState,
    ownerType: row['owner_type'] as OwnerType,
    ownerDisplayName: row['owner_display_name'] as string,
    representativeName: row['representative_name'] as string | null,
    representativePosition: row['representative_position'] as string | null,
    ownerIdentityType: row['owner_identity_type'] as string,
    ownerCountryCode: row['owner_country_code'] as string,
    ownerLookupToken: row['owner_identifier_lookup_token'] as string,
    contactPhone: row['contact_phone'] as string,
    contactPhoneVerifiedAt: row['contact_phone_verified_at'] as Date | null,
    subscriptionContactPhone: row['subscription_contact_phone'] as string,
    adminEmailNormalized: row['admin_email_normalized'] as string,
    hotelDisplayName: row['hotel_display_name'] as string,
    hotelPublicPhone: row['hotel_public_phone'] as string,
    district: row['district'] as string,
    khoroo: row['khoroo'] as string,
    addressLine: row['address_line'] as string,
    latitudeMicro: Number(row['latitude_micro']),
    longitudeMicro: Number(row['longitude_micro']),
    packageCode: row['package_code'] as PackageCode,
    termMonths: Number(row['term_months']),
    monthlyPriceMnt: BigInt(row['monthly_price_mnt'] as string),
    discountMnt: BigInt(row['discount_mnt'] as string),
    totalAmountMnt: BigInt(row['total_amount_mnt'] as string),
    vatRateBp: Number(row['vat_rate_bp']),
    priceBookVersion: row['price_book_version'] as string,
    taxConfigVersion: row['tax_config_version'] as string,
    packageFeatureVersion: row['package_feature_version'] as string,
    existingAccountId: row['existing_account_id'] as string | null,
    existingAccountProofMethod: row[
      'existing_account_proof_method'
    ] as ExistingAccountProofMethod | null,
    existingAccountProvedAt: row['existing_account_proved_at'] as Date | null,
    ownerId: row['owner_id'] as string | null,
    duplicateReviewRequired: row['duplicate_review_required'] as boolean,
    provisionedHotelId: row['provisioned_hotel_id'] as string | null,
    paidAttemptId: row['paid_attempt_id'] as string | null,
    paymentConfirmedAt: row['payment_confirmed_at'] as Date | null,
    provisionAttempts: Number(row['provision_attempts']),
    provisionAvailableAt: row['provision_available_at'] as Date,
    provisionClaimToken: row['provision_claim_token'] as string | null,
    provisionClaimedUntil: row['provision_claimed_until'] as Date | null,
    provisionLastError: row['provision_last_error'] as string | null,
    revision: Number(row['revision']),
  };
}

function mapAttempt(row: Record<string, unknown> | undefined): AttemptRow | undefined {
  if (row === undefined) return undefined;
  return {
    attemptId: row['attempt_id'] as string,
    applicationId: row['application_id'] as string,
    provider: row['provider'] as PaymentProvider,
    merchantRef: row['merchant_ref'] as string,
    providerInvoiceId: row['provider_invoice_id'] as string | null,
    providerPaymentId: row['provider_payment_id'] as string | null,
    state: row['state'] as AttemptState,
    amountMnt: BigInt(row['amount_mnt'] as string),
    providerFeeMnt:
      row['provider_fee_mnt'] === null ? null : BigInt(row['provider_fee_mnt'] as string),
    currency: row['currency'] as string,
    packageCode: row['package_code'] as PackageCode,
    termMonths: Number(row['term_months']),
    monthlyPriceMnt: BigInt(row['monthly_price_mnt'] as string),
    vatRateBp: Number(row['vat_rate_bp']),
    expiresAt: row['expires_at'] as Date,
    confirmedAt: row['confirmed_at'] as Date | null,
    revision: Number(row['revision']),
  };
}

export interface CreateApplicationInput {
  /**
   * Minted by the caller, not by the database.
   *
   * The envelope AAD and the applicant token digest are both bound to this id,
   * so it has to exist before the row does — a value the insert generated could
   * only be bound to afterwards, and a ciphertext bound to the wrong row is one
   * that will not decrypt.
   */
  readonly applicationId: string;
  readonly ownerType: OwnerType;
  readonly applicantTokenHash: string;
  readonly applicantTokenKeyVersion: string;
  readonly ownerDisplayName: string;
  readonly representativeName: string | null;
  readonly representativePosition: string | null;
  readonly identifierCiphertext: Uint8Array;
  readonly identifierWrappedDek: Uint8Array;
  readonly identifierKeyVersion: string;
  readonly identifierLookupToken: string;
  readonly identifierLookupKeyVersion: string;
  readonly contactPhone: string;
  readonly subscriptionContactPhone: string;
  readonly adminEmailNormalized: string;
  readonly hotelDisplayName: string;
  readonly hotelPublicPhone: string;
  readonly district: string;
  readonly khoroo: string;
  readonly addressLine: string;
  readonly latitudeMicro: number;
  readonly longitudeMicro: number;
  readonly packageCode: PackageCode;
  readonly termMonths: number;
  readonly monthlyPriceMnt: bigint;
  readonly totalAmountMnt: bigint;
  readonly vatRateBp: number;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
  readonly duplicateReviewRequired: boolean;
}

/**
 * Resolves an applicant's bearer digest to the application it names.
 *
 * The one lookup that cannot go through the policy, because the policy needs
 * the very reference this call produces. It goes through the `SECURITY DEFINER`
 * wrapper, which returns an id and nothing else; the caller then establishes
 * that scope and reads the row through the ordinary policy like everything else.
 */
export async function resolveApplicantToken(
  uow: UnitOfWork,
  tokenHash: string,
): Promise<string | undefined> {
  const result = await uow.query<{ application_id: string | null }>(
    `SELECT platform.resolve_onboarding_applicant($1) AS application_id`,
    [tokenHash],
  );
  return result.rows[0]?.application_id ?? undefined;
}

/**
 * Resolves a provider invoice reference to the application it belongs to.
 *
 * The callback's counterpart to `resolveApplicantToken`, and it exists for the
 * same reason: the scope has to come from somewhere, and a gateway holds no
 * applicant secret. The authority is the signature the service verified before
 * calling this; what comes back is an identifier and nothing else.
 */
export async function resolvePaymentAttempt(
  uow: UnitOfWork,
  provider: string,
  providerInvoiceId: string,
): Promise<string | undefined> {
  const result = await uow.query<{ application_id: string | null }>(
    `SELECT platform.resolve_payment_attempt($1, $2) AS application_id`,
    [provider, providerInvoiceId],
  );
  return result.rows[0]?.application_id ?? undefined;
}

/** The provisioning work that is due, as identifiers (R3). */
export async function pendingProvisioningApplications(
  uow: UnitOfWork,
  limit: number,
  maxAttempts: number,
): Promise<readonly string[]> {
  const result = await uow.query<{ application_id: string }>(
    `SELECT application_id FROM platform.pending_provisioning_applications($1, $2)`,
    [limit, maxAttempts],
  );
  return result.rows.map((row) => row.application_id);
}

export class OnboardingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async create(input: CreateApplicationInput): Promise<string> {
    const result = await this.uow.query<{ application_id: string }>(
      `INSERT INTO platform.onboarding_application
         (application_id, owner_type, applicant_token_hash, applicant_token_key_version,
          owner_display_name,
          representative_name, representative_position, owner_identifier_ciphertext,
          owner_identifier_wrapped_dek, owner_identifier_key_version,
          owner_identifier_lookup_token, owner_identifier_lookup_key_version,
          contact_phone, subscription_contact_phone, admin_email_normalized,
          hotel_display_name, hotel_public_phone, district, khoroo, address_line,
          latitude_micro, longitude_micro, package_code, term_months, monthly_price_mnt,
          total_amount_mnt, vat_rate_bp, price_book_version, tax_config_version,
          package_feature_version, duplicate_review_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       RETURNING application_id`,
      [
        input.applicationId,
        input.ownerType,
        input.applicantTokenHash,
        input.applicantTokenKeyVersion,
        input.ownerDisplayName,
        input.representativeName,
        input.representativePosition,
        Buffer.from(input.identifierCiphertext),
        Buffer.from(input.identifierWrappedDek),
        input.identifierKeyVersion,
        input.identifierLookupToken,
        input.identifierLookupKeyVersion,
        input.contactPhone,
        input.subscriptionContactPhone,
        input.adminEmailNormalized,
        input.hotelDisplayName,
        input.hotelPublicPhone,
        input.district,
        input.khoroo,
        input.addressLine,
        input.latitudeMicro,
        input.longitudeMicro,
        input.packageCode,
        input.termMonths,
        input.monthlyPriceMnt.toString(),
        input.totalAmountMnt.toString(),
        input.vatRateBp,
        input.priceBookVersion,
        input.taxConfigVersion,
        input.packageFeatureVersion,
        input.duplicateReviewRequired,
      ],
    );
    const applicationId = result.rows[0]?.application_id;
    if (applicationId === undefined) throw new Error('the application insert returned no row');
    return applicationId;
  }

  async byId(applicationId: string): Promise<ApplicationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${APPLICATION_COLUMNS} FROM platform.onboarding_application
        WHERE application_id = $1`,
      [applicationId],
    );
    return mapApplication(result.rows[0]);
  }

  /** The row under a write lock. Every state transition takes this first. */
  async lock(applicationId: string): Promise<ApplicationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${APPLICATION_COLUMNS} FROM platform.onboarding_application
        WHERE application_id = $1 FOR UPDATE`,
      [applicationId],
    );
    return mapApplication(result.rows[0]);
  }

  /**
   * The sealed owner identifier, for the one operation that has to reseal it.
   *
   * Read as bytes and never as text: this is ciphertext, and a text round-trip
   * would corrupt it silently.
   */
  async sealedIdentifier(applicationId: string): Promise<
    | {
        ciphertext: Uint8Array;
        wrappedDek: Uint8Array;
        keyVersion: string;
        lookupKeyVersion: string;
      }
    | undefined
  > {
    const result = await this.uow.query<{
      c: Buffer;
      d: Buffer;
      v: string;
      lookup_version: string;
    }>(
      `SELECT owner_identifier_ciphertext AS c, owner_identifier_wrapped_dek AS d,
              owner_identifier_key_version AS v,
              owner_identifier_lookup_key_version AS lookup_version
         FROM platform.onboarding_application WHERE application_id = $1`,
      [applicationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      ciphertext: Uint8Array.from(row.c),
      wrappedDek: Uint8Array.from(row.d),
      keyVersion: row.v,
      lookupKeyVersion: row.lookup_version,
    };
  }

  /**
   * Moves the application, fenced on the revision it was read at.
   *
   * Zero rows means somebody else moved it first, which is exactly the
   * duplicate-callback and concurrent-retry case: the caller stops rather than
   * applying a second transition (`ONB-DEC-008`).
   */
  async transition(input: {
    applicationId: string;
    expectedRevision: number;
    state: ApplicationState;
    reason: string;
    ownerId?: string | null;
    existingAccount?: { accountId: string; method: ExistingAccountProofMethod };
    paidAttemptId?: string | null;
    paymentConfirmedAt?: Date | null;
    contactPhoneVerifiedAt?: Date | null;
    duplicateReviewRequired?: boolean;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET state = $3,
              state_changed_at = now(),
              state_reason = $4,
              owner_id = COALESCE($5, owner_id),
              existing_account_id = COALESCE($6, existing_account_id),
              existing_account_proof_method = COALESCE($7, existing_account_proof_method),
              existing_account_proved_at =
                CASE WHEN $6::uuid IS NULL THEN existing_account_proved_at
                     ELSE COALESCE(existing_account_proved_at, now()) END,
              paid_attempt_id = COALESCE($8, paid_attempt_id),
              payment_confirmed_at = COALESCE($9, payment_confirmed_at),
              contact_phone_verified_at = COALESCE($10, contact_phone_verified_at),
              duplicate_review_required = COALESCE($11, duplicate_review_required),
              -- A transition into the payable state makes the job due now.
              provision_available_at =
                CASE WHEN $3 = 'PAID_PENDING_PROVISIONING' THEN now()
                     ELSE provision_available_at END,
              revision = revision + 1
        WHERE application_id = $1 AND revision = $2`,
      [
        input.applicationId,
        input.expectedRevision,
        input.state,
        input.reason,
        input.ownerId ?? null,
        input.existingAccount?.accountId ?? null,
        input.existingAccount?.method ?? null,
        input.paidAttemptId ?? null,
        input.paymentConfirmedAt ?? null,
        input.contactPhoneVerifiedAt ?? null,
        input.duplicateReviewRequired ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  // ---------------------------------------------------------- the durable job

  /**
   * Claims the provisioning job: a fresh claim token, a lease, one more
   * attempt, and the `PROVISIONING` transition, in one compare-and-set on the
   * revision the caller locked at.
   */
  async claimProvisioning(input: {
    applicationId: string;
    expectedRevision: number;
    claimToken: string;
    leaseSeconds: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET state = 'PROVISIONING',
              state_changed_at = now(),
              state_reason = 'provisioning_started',
              provision_claim_token = $3,
              provision_claimed_until = now() + make_interval(secs => $4),
              provision_attempts = provision_attempts + 1,
              revision = revision + 1
        WHERE application_id = $1 AND revision = $2
          AND (provision_claim_token IS NULL OR provision_claimed_until < now())`,
      [input.applicationId, input.expectedRevision, input.claimToken, input.leaseSeconds],
    );
    return result.rowCount === 1;
  }

  /**
   * Re-claims a job whose holder died: the lease has expired and the row is
   * still `PROVISIONING`. The state does not change here — the caller records
   * the failure first, in its own transaction — only the ownership does.
   */
  async reclaimExpired(input: {
    applicationId: string;
    expectedRevision: number;
    claimToken: string;
    leaseSeconds: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET provision_claim_token = $3,
              provision_claimed_until = now() + make_interval(secs => $4),
              revision = revision + 1
        WHERE application_id = $1 AND revision = $2
          AND (provision_claim_token IS NULL OR provision_claimed_until < now())`,
      [input.applicationId, input.expectedRevision, input.claimToken, input.leaseSeconds],
    );
    return result.rowCount === 1;
  }

  /**
   * Settles a failed attempt: `PROVISIONING_FAILED`, the claim released, the
   * error name recorded, and the next availability pushed out by a persisted
   * backoff. Fenced on the claim token, so a worker whose lease expired and
   * whose job another worker has since taken cannot settle it.
   */
  async settleProvisioningFailure(input: {
    applicationId: string;
    claimToken: string;
    reason: string;
    backoffSeconds: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET state = 'PROVISIONING_FAILED',
              state_changed_at = now(),
              state_reason = $3,
              provision_claim_token = NULL,
              provision_claimed_until = NULL,
              provision_last_error = $3,
              provision_available_at = now() + make_interval(secs => $4),
              revision = revision + 1
        WHERE application_id = $1 AND provision_claim_token = $2 AND state = 'PROVISIONING'`,
      [input.applicationId, input.claimToken, input.reason, input.backoffSeconds],
    );
    return result.rowCount === 1;
  }

  /** Releases a claim on a row that needs no further work. */
  async releaseClaim(applicationId: string, claimToken: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET provision_claim_token = NULL, provision_claimed_until = NULL,
              revision = revision + 1
        WHERE application_id = $1 AND provision_claim_token = $2`,
      [applicationId, claimToken],
    );
    return result.rowCount === 1;
  }

  async recordEvent(input: {
    applicationId: string;
    fromState: ApplicationState | null;
    toState: ApplicationState;
    reason: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.onboarding_event
         (application_id, from_state, to_state, reason, actor_ref, correlation_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.applicationId,
        input.fromState,
        input.toState,
        input.reason,
        this.uow.context.actorRef,
        this.uow.context.correlationId,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }

  async history(applicationId: string): Promise<readonly { from: string | null; to: string }[]> {
    const result = await this.uow.query<{ from_state: string | null; to_state: string }>(
      `SELECT from_state, to_state FROM platform.onboarding_event
        WHERE application_id = $1 ORDER BY event_id`,
      [applicationId],
    );
    return result.rows.map((row) => ({ from: row.from_state, to: row.to_state }));
  }

  // ----------------------------------------------------------- owner profiles

  /**
   * doc 15 §3.1: the existing owner behind this application's registration
   * number, if any — probed, never mutated.
   *
   * Through the probe wrapper, not a direct read. An applicant may not read an
   * owner profile they are not linked to — it holds the verified contact a proof
   * would be sent to — so the probe answers with an opaque reference, a masked
   * destination and whether that owner already holds a hotel. Exact match on a
   * versioned keyed HMAC, never the plaintext identifier and never an unkeyed
   * digest (ADR-0020 §6).
   */
  async probeOwner(
    applicationId: string,
  ): Promise<
    { ownerId: string; maskedDestination: string | null; ownsOtherHotel: boolean } | undefined
  > {
    const result = await this.uow.query<{
      owner_id: string;
      masked_destination: string | null;
      owns_other_hotel: boolean;
    }>(
      `SELECT owner_id, masked_destination, owns_other_hotel
         FROM platform.probe_subscription_owner($1)`,
      [applicationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      ownerId: row.owner_id,
      maskedDestination: row.masked_destination,
      ownsOtherHotel: row.owns_other_hotel,
    };
  }

  /**
   * The owner's stored verified channel, in full, for the delivery port alone.
   * Never returned to the applicant, never stored on the application.
   */
  async ownerChallengeDestination(
    applicationId: string,
  ): Promise<{ channel: 'phone' | 'email'; destination: string } | undefined> {
    const result = await this.uow.query<{ channel: string | null; destination: string | null }>(
      `SELECT channel, destination FROM platform.owner_challenge_destination($1)`,
      [applicationId],
    );
    const row = result.rows[0];
    if (row === undefined || row.channel === null || row.destination === null) return undefined;
    return { channel: row.channel as 'phone' | 'email', destination: row.destination };
  }

  /** doc 15 §3.1's callback-time race: did the owner acquire a hotel elsewhere? */
  async ownerHoldsOtherHotel(applicationId: string): Promise<boolean> {
    const result = await this.uow.query<{ holds: boolean }>(
      `SELECT platform.owner_holds_other_hotel($1) AS holds`,
      [applicationId],
    );
    return result.rows[0]?.holds === true;
  }

  /** doc 15 §3.1 proof (1): is this account the Primary Admin of a hotel this owner holds? */
  async accountLinkedToOwner(applicationId: string, accountId: string): Promise<boolean> {
    const result = await this.uow.query<{ linked: boolean }>(
      `SELECT platform.account_linked_to_owner($1, $2) AS linked`,
      [applicationId, accountId],
    );
    return result.rows[0]?.linked === true;
  }

  /** doc 15 §3.1 / §5.1: does an account already hold this application's admin email? */
  async existingAccountHoldsEmail(applicationId: string): Promise<boolean> {
    const result = await this.uow.query<{ held: boolean }>(
      `SELECT platform.probe_existing_hotel_account($1) AS held`,
      [applicationId],
    );
    return result.rows[0]?.held === true;
  }

  // ------------------------------------------------------ phone verification

  async openPhoneChallenge(input: {
    applicationId: string;
    phone: string;
    codeDigest: string;
    codeKeyVersion: string;
    maxAttempts: number;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ verification_id: string }>(
      `INSERT INTO platform.onboarding_phone_verification
         (application_id, phone, code_digest, code_key_version, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING verification_id`,
      [
        input.applicationId,
        input.phone,
        input.codeDigest,
        input.codeKeyVersion,
        input.maxAttempts,
        input.ttlSeconds,
      ],
    );
    const verificationId = result.rows[0]?.verification_id;
    if (verificationId === undefined) throw new Error('the challenge insert returned no row');
    return verificationId;
  }

  async lockPendingPhoneChallenge(applicationId: string): Promise<
    | {
        verificationId: string;
        codeDigest: string;
        attempts: number;
        maxAttempts: number;
        expired: boolean;
      }
    | undefined
  > {
    const result = await this.uow.query<{
      verification_id: string;
      code_digest: string;
      attempts: number;
      max_attempts: number;
      expired: boolean;
    }>(
      `SELECT verification_id, code_digest, attempts, max_attempts,
              (expires_at <= now()) AS expired
         FROM platform.onboarding_phone_verification
        WHERE application_id = $1 AND state = 'PENDING'
          FOR UPDATE`,
      [applicationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      verificationId: row.verification_id,
      codeDigest: row.code_digest,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      expired: row.expired,
    };
  }

  async recordPhoneAttempt(verificationId: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.onboarding_phone_verification
          SET attempts = attempts + 1
        WHERE verification_id = $1 AND state = 'PENDING'`,
      [verificationId],
    );
  }

  /**
   * Settles the challenge and destroys its digest.
   *
   * The code is cleared rather than kept: a verified or dead challenge that
   * still held a redeemable digest would be a second copy of the secret with
   * nothing left to protect it.
   */
  async settlePhoneChallenge(
    verificationId: string,
    state: 'VERIFIED' | 'EXPIRED' | 'FAILED',
  ): Promise<void> {
    await this.uow.query(
      `UPDATE platform.onboarding_phone_verification
          SET state = $2, settled_at = now(),
              code_digest = NULL, code_key_version = NULL
        WHERE verification_id = $1 AND state = 'PENDING'`,
      [verificationId, state],
    );
  }

  // ---------------------------------------------------------- owner proof

  async openOwnerProof(input: {
    applicationId: string;
    ownerId: string;
    method: 'AUTHENTICATED_ACCOUNT' | 'STORED_CONTACT_CHALLENGE' | 'OFFLINE_VERIFICATION';
    challengeDigest: string | null;
    challengeKeyVersion: string | null;
    maskedDestination: string | null;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ proof_id: string }>(
      `INSERT INTO platform.onboarding_owner_proof
         (application_id, owner_id, method, challenge_digest, challenge_key_version,
          masked_destination, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))
       RETURNING proof_id`,
      [
        input.applicationId,
        input.ownerId,
        input.method,
        input.challengeDigest,
        input.challengeKeyVersion,
        input.maskedDestination,
        input.ttlSeconds,
      ],
    );
    const proofId = result.rows[0]?.proof_id;
    if (proofId === undefined) throw new Error('the proof insert returned no row');
    return proofId;
  }

  async lockPendingProof(applicationId: string): Promise<
    | {
        proofId: string;
        ownerId: string;
        method: string;
        challengeDigest: string | null;
        expired: boolean;
      }
    | undefined
  > {
    const result = await this.uow.query<{
      proof_id: string;
      owner_id: string;
      method: string;
      challenge_digest: string | null;
      expired: boolean;
    }>(
      `SELECT proof_id, owner_id, method, challenge_digest, (expires_at <= now()) AS expired
         FROM platform.onboarding_owner_proof
        WHERE application_id = $1 AND state = 'PENDING'
          FOR UPDATE`,
      [applicationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      proofId: row.proof_id,
      ownerId: row.owner_id,
      method: row.method,
      challengeDigest: row.challenge_digest,
      expired: row.expired,
    };
  }

  async settleProof(input: {
    proofId: string;
    state: 'PASSED' | 'FAILED' | 'EXPIRED';
    decidedByAccountId: string | null;
    reason: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_owner_proof
          SET state = $2, decided_at = now(), decided_by_account_id = $3,
              decision_reason = $4, challenge_digest = NULL, challenge_key_version = NULL
        WHERE proof_id = $1 AND state = 'PENDING'`,
      [input.proofId, input.state, input.decidedByAccountId, input.reason],
    );
    return result.rowCount === 1;
  }

  async hasPassedProof(applicationId: string): Promise<boolean> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.onboarding_owner_proof
        WHERE application_id = $1 AND state = 'PASSED'`,
      [applicationId],
    );
    return (result.rows[0]?.n ?? '0') !== '0';
  }

  async hasPendingProof(applicationId: string): Promise<boolean> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.onboarding_owner_proof
        WHERE application_id = $1 AND state = 'PENDING'`,
      [applicationId],
    );
    return (result.rows[0]?.n ?? '0') !== '0';
  }

  // ------------------------------------------------------- payment attempts

  /**
   * Prepares an attempt before the provider is called (remediation 2, finding
   * 1): the terms are on the row, the provider's invoice is not yet. A retry
   * under the same key recovers it by merchant reference.
   */
  async prepareAttempt(input: {
    applicationId: string;
    provider: PaymentProvider;
    merchantRef: string;
    amountMnt: bigint;
    packageCode: PackageCode;
    termMonths: number;
    monthlyPriceMnt: bigint;
    vatRateBp: number;
    priceBookVersion: string;
    taxConfigVersion: string;
    packageFeatureVersion: string;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ attempt_id: string }>(
      `INSERT INTO platform.onboarding_payment_attempt
         (application_id, provider, merchant_ref, state, amount_mnt,
          package_code, term_months, monthly_price_mnt, vat_rate_bp, price_book_version,
          tax_config_version, package_feature_version, expires_at)
       VALUES ($1,$2,$3,'PREPARING',$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => $12))
       RETURNING attempt_id`,
      [
        input.applicationId,
        input.provider,
        input.merchantRef,
        input.amountMnt.toString(),
        input.packageCode,
        input.termMonths,
        input.monthlyPriceMnt.toString(),
        input.vatRateBp,
        input.priceBookVersion,
        input.taxConfigVersion,
        input.packageFeatureVersion,
        input.ttlSeconds,
      ],
    );
    const attemptId = result.rows[0]?.attempt_id;
    if (attemptId === undefined) throw new Error('the attempt insert returned no row');
    return attemptId;
  }

  /** The prepared attempt a merchant reference names, locked. */
  async lockAttemptByMerchantRef(merchantRef: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.onboarding_payment_attempt
        WHERE merchant_ref = $1 FOR UPDATE`,
      [merchantRef],
    );
    return mapAttempt(result.rows[0]);
  }

  /** The provider answered and the application is still invoiceable: the attempt goes live. */
  async finalizeAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    providerInvoiceId: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_payment_attempt
          SET state = 'PENDING', provider_invoice_id = $2, revision = revision + 1
        WHERE attempt_id = $1 AND revision = $3 AND state = 'PREPARING'`,
      [input.attemptId, input.providerInvoiceId, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  /** The provider refused to create the invoice: terminal, no invoice, the reason (remediation 3). */
  async refuseAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    reason: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_payment_attempt
          SET state = 'REFUSED', terminal_at = now(), terminal_reason = $2, revision = revision + 1
        WHERE attempt_id = $1 AND revision = $3 AND state = 'PREPARING'
          AND provider_invoice_id IS NULL`,
      [input.attemptId, input.reason, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  /** The attempt was never live; the provider's invoice, if any, stays recorded on it. */
  async abandonAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    providerInvoiceId: string | null;
    reason: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_payment_attempt
          SET state = 'ABANDONED', terminal_at = now(), terminal_reason = $2,
              provider_invoice_id = COALESCE(provider_invoice_id, $3), revision = revision + 1
        WHERE attempt_id = $1 AND revision = $4 AND state = 'PREPARING'`,
      [input.attemptId, input.reason, input.providerInvoiceId, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  async lockAttemptByInvoice(
    provider: PaymentProvider,
    providerInvoiceId: string,
  ): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.onboarding_payment_attempt
        WHERE provider = $1 AND provider_invoice_id = $2
          FOR UPDATE`,
      [provider, providerInvoiceId],
    );
    return mapAttempt(result.rows[0]);
  }

  async attemptById(attemptId: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.onboarding_payment_attempt
        WHERE attempt_id = $1`,
      [attemptId],
    );
    return mapAttempt(result.rows[0]);
  }

  async attemptsFor(applicationId: string): Promise<readonly AttemptRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.onboarding_payment_attempt
        WHERE application_id = $1 ORDER BY created_at`,
      [applicationId],
    );
    return result.rows.flatMap((row) => {
      const mapped = mapAttempt(row);
      return mapped === undefined ? [] : [mapped];
    });
  }

  /** Settles an attempt, fenced on the revision it was locked at. */
  async settleAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    state: AttemptState;
    reason: string;
    providerPaymentId?: string | null;
    confirmedAt?: Date | null;
    providerFeeMnt?: bigint | null;
  }): Promise<boolean> {
    const terminal = input.state !== 'PENDING' && input.state !== 'PAYMENT_UNCERTAIN';
    const result = await this.uow.query(
      `UPDATE platform.onboarding_payment_attempt
          SET state = $3,
              terminal_at = CASE WHEN $4 THEN COALESCE(terminal_at, now()) ELSE terminal_at END,
              terminal_reason = $5,
              provider_payment_id = COALESCE(provider_payment_id, $6),
              confirmed_at = COALESCE(confirmed_at, $7),
              provider_fee_mnt = CASE WHEN provider_payment_id IS NULL
                                      THEN COALESCE($8, provider_fee_mnt)
                                      ELSE provider_fee_mnt END,
              revision = revision + 1
        WHERE attempt_id = $1 AND revision = $2`,
      [
        input.attemptId,
        input.expectedRevision,
        input.state,
        terminal,
        input.reason,
        input.providerPaymentId ?? null,
        input.confirmedAt ?? null,
        input.providerFeeMnt === undefined || input.providerFeeMnt === null
          ? null
          : input.providerFeeMnt.toString(),
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * Binds an application to the owner it collided with, without moving its
   * state (remediation 2, finding 2): the application is already
   * `PAID_OWNER_VERIFICATION_REQUIRED`, and what it lacked was the owner whose
   * stored contact the challenge must go to.
   */
  async bindOwner(input: {
    applicationId: string;
    expectedRevision: number;
    ownerId: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_application
          SET owner_id = $3, revision = revision + 1
        WHERE application_id = $1 AND revision = $2 AND owner_id IS NULL`,
      [input.applicationId, input.expectedRevision, input.ownerId],
    );
    return result.rowCount === 1;
  }

  /** doc 15 §4.1: the reconciliation queue an operator owns. */
  async reconciliationQueue(): Promise<readonly AttemptRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.onboarding_payment_attempt
        WHERE state = 'PAID_REQUIRES_RECONCILIATION' AND reconciliation_outcome IS NULL
        ORDER BY confirmed_at`,
    );
    return result.rows.flatMap((row) => {
      const mapped = mapAttempt(row);
      return mapped === undefined ? [] : [mapped];
    });
  }

  async closeReconciliation(input: {
    attemptId: string;
    expectedRevision: number;
    // `OPS-DEC-017` fixes the vocabulary in doc 14 §4.2 and Phase 19 adopts it.
    outcome: ReconciliationOutcome;
    accountId: string;
    reason: string;
    /** doc 14 §4.2: the provider, bank or finance reference. Mandatory. */
    reference: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.onboarding_payment_attempt
          SET reconciliation_outcome = $3, reconciled_by_account_id = $4,
              reconciled_at = now(), reconciliation_reason = $5,
              reconciliation_reference = $6, revision = revision + 1
        WHERE attempt_id = $1 AND revision = $2
          AND state = 'PAID_REQUIRES_RECONCILIATION'
          AND reconciliation_outcome IS NULL`,
      [
        input.attemptId,
        input.expectedRevision,
        input.outcome,
        input.accountId,
        input.reason,
        input.reference,
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * doc 15 §5.1: hotels whose name, address or coordinate is close enough to
   * this one that somebody should look before it is published.
   *
   * Integer micro-degree arithmetic, not a distance: a real proximity search is
   * Phase 12's `GeoPort` work, and approximating one here would be inventing the
   * geocoding EXT-06 has not cleared.
   */
  async duplicateSuspected(input: {
    hotelDisplayName: string;
    district: string;
    addressLine: string;
    latitudeMicro: number;
    longitudeMicro: number;
    proximityMicroDegrees: number;
  }): Promise<boolean> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM platform.onboarding_application
        WHERE provisioned_hotel_id IS NOT NULL
          AND (
            (lower(hotel_display_name) = lower($1)
             AND abs(latitude_micro - $4) <= $6 AND abs(longitude_micro - $5) <= $6)
            OR (lower(district) = lower($2) AND lower(address_line) = lower($3))
          )`,
      [
        input.hotelDisplayName,
        input.district,
        input.addressLine,
        input.latitudeMicro,
        input.longitudeMicro,
        input.proximityMicroDegrees,
      ],
    );
    return (result.rows[0]?.n ?? '0') !== '0';
  }
}
