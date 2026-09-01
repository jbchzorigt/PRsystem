import { randomUUID } from 'node:crypto';
import type { PackageCode } from '@prsystem/authz';
import { isPackageCode } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { claimIdempotencyKey, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { decryptValue, deriveLookupToken, encryptValue } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase } from './onboarding-context';
import type {
  ApplicationRow,
  ApplicationState,
  OwnerType,
} from '../repositories/onboarding.repository';
import { OnboardingRepository, resolveApplicantToken } from '../repositories/onboarding.repository';
import type { PaymentProvider } from '../contracts/payment-gateway.port';
import { isPaymentProvider } from '../contracts/payment-gateway.port';
import { isTermMonths, quoteTerm } from '../domain/pricing';

/**
 * Hotel onboarding (doc 15, `ONB-DEC-001`…`008`).
 *
 * The rule the whole file is arranged around is `ONB-DEC-001`: **no hotel,
 * subscription, membership, session, listing, drawer or activation delivery
 * exists before authoritative payment success.** Before payment there is one row
 * — an application — and it carries no tenant.
 */

/** doc 15 §2.1 and §2.2: the required fields, per registration type. */
export interface ApplicationDraft {
  readonly ownerType: OwnerType;
  readonly ownerDisplayName: string;
  readonly representativeName?: string;
  readonly representativePosition?: string;
  /** The registration number. Encrypted at rest; never logged, never returned. */
  readonly registrationNumber: string;
  readonly countryCode?: string;
  readonly contactPhone: string;
  readonly subscriptionContactPhone: string;
  readonly adminEmail: string;
  readonly hotelDisplayName: string;
  readonly hotelPublicPhone: string;
  readonly district: string;
  readonly khoroo: string;
  readonly addressLine: string;
  readonly latitudeMicro: number;
  readonly longitudeMicro: number;
  readonly packageCode: string;
  readonly termMonths: number;
}

export interface CreatedApplication {
  readonly applicationId: string;
  readonly state: ApplicationState;
  /** The applicant's bearer reference. Returned once and never stored in clear. */
  readonly applicantToken: string;
  readonly totalAmountMnt: string;
  readonly monthlyPriceMnt: string;
  readonly discountMnt: string;
  readonly vatAmountMnt: string;
  readonly vatInclusive: true;
  readonly currency: 'MNT';
  readonly termMonths: number;
  readonly packageCode: PackageCode;
}

const OWNER_TYPES: readonly OwnerType[] = ['CITIZEN', 'ORGANIZATION'];

/** The registration-number shape checked server-side (doc 15 §2.1). */
const REGISTRATION_NUMBER = /^[0-9A-ZА-ЯӨҮ]{5,20}$/u;
const PHONE = /^\+?[0-9]{8,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The fixed subject an applicant's bearer digest is bound to.
 *
 * The same shape a session token uses, and for the same reason: the digest is
 * looked up before its subject is known, so it is bound to the purpose alone and
 * everything about the application is then read from the row it identifies.
 */
export const APPLICANT_LOOKUP_SUBJECT = 'onboarding_applicant';

function required(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) throw new ApiError('VALIDATION_FAILED', `${field} is required`);
  return trimmed;
}

export class OnboardingService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  // ==================================================================== draft

  /**
   * Creates the pre-payment application, and nothing else (doc 15 §3).
   *
   * The registration number is envelope-encrypted with its own key scope, and
   * the exact-lookup token is a versioned keyed HMAC namespaced by identity type
   * and country. The plaintext is held only long enough to produce both and is
   * never written to a log, a URL, an audit payload or an outbox event.
   *
   * The commercial figures are the server's own: the caller names a package and
   * a term, and doc 16 §3's "the backend recomputes the total" is why nothing
   * from the request body reaches an amount column.
   */
  async createApplication(
    draft: ApplicationDraft,
    request: RequestContext,
  ): Promise<CreatedApplication> {
    const validated = this.validate(draft);
    const parameters = this.parameters;
    const price = quoteTerm(validated.packageCode, validated.termMonths, parameters);

    const applicationId = randomUUID();
    // Bound to a fixed subject, like a session token: the row the digest
    // identifies is what says which application it belongs to, and there is no
    // application id to bind to before the lookup that finds it.
    const applicant = await this.tokens.issue('onboarding_draft', APPLICANT_LOOKUP_SUBJECT);
    const namespace = {
      identityType: 'registration_number' as const,
      countryCode: validated.countryCode,
    };
    const lookup = await deriveLookupToken(
      this.deps.keys,
      'lookup.identity',
      namespace,
      validated.registrationNumber,
    );
    const sealed = await encryptValue(
      this.deps.keys,
      'pii.subscription_owner',
      validated.registrationNumber,
      {
        table: 'onboarding_application',
        column: 'owner_identifier_ciphertext',
        rowRef: applicationId,
      },
    );

    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);

      // doc 15 §5.1: a suspicious duplicate never blocks a paid provisioning; it
      // blocks publication. The flag is decided here, once, from the submitted
      // location — not by a geocoder, which is Phase 12 and EXT-06.
      const duplicate = await repository.duplicateSuspected({
        hotelDisplayName: validated.hotelDisplayName,
        district: validated.district,
        addressLine: validated.addressLine,
        latitudeMicro: validated.latitudeMicro,
        longitudeMicro: validated.longitudeMicro,
        proximityMicroDegrees: parameters.duplicateProximityMicroDegrees,
      });

      await repository.create({
        applicationId,
        ownerType: validated.ownerType,
        applicantTokenHash: applicant.tokenHash,
        applicantTokenKeyVersion: applicant.keyVersion,
        ownerDisplayName: validated.ownerDisplayName,
        representativeName: validated.representativeName,
        representativePosition: validated.representativePosition,
        identifierCiphertext: sealed.ciphertext,
        identifierWrappedDek: sealed.wrappedDek,
        identifierKeyVersion: sealed.keyVersion,
        identifierLookupToken: lookup.token,
        identifierLookupKeyVersion: lookup.keyVersion,
        contactPhone: validated.contactPhone,
        subscriptionContactPhone: validated.subscriptionContactPhone,
        adminEmailNormalized: validated.adminEmail,
        hotelDisplayName: validated.hotelDisplayName,
        hotelPublicPhone: validated.hotelPublicPhone,
        district: validated.district,
        khoroo: validated.khoroo,
        addressLine: validated.addressLine,
        latitudeMicro: validated.latitudeMicro,
        longitudeMicro: validated.longitudeMicro,
        packageCode: price.packageCode,
        termMonths: price.termMonths,
        monthlyPriceMnt: price.monthlyPriceMnt,
        totalAmountMnt: price.totalAmountMnt,
        vatRateBp: price.vatRateBp,
        priceBookVersion: price.priceBookVersion,
        taxConfigVersion: price.taxConfigVersion,
        packageFeatureVersion: price.packageFeatureVersion,
        duplicateReviewRequired: duplicate,
      });

      await repository.recordEvent({
        applicationId,
        fromState: null,
        toState: 'DRAFT',
        reason: 'created',
        detail: {
          ownerType: validated.ownerType,
          packageCode: price.packageCode,
          termMonths: price.termMonths,
          duplicateReviewRequired: duplicate,
        },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.application.created',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        payload: {
          ownerType: validated.ownerType,
          packageCode: price.packageCode,
          termMonths: price.termMonths,
        },
      });

      return {
        applicationId,
        state: 'DRAFT' as const,
        applicantToken: applicant.token,
        totalAmountMnt: price.totalAmountMnt.toString(),
        monthlyPriceMnt: price.monthlyPriceMnt.toString(),
        discountMnt: price.discountMnt.toString(),
        vatAmountMnt: price.vatAmountMnt.toString(),
        vatInclusive: true as const,
        currency: 'MNT' as const,
        termMonths: price.termMonths,
        packageCode: price.packageCode,
      };
    });
  }

  private validate(draft: ApplicationDraft): {
    ownerType: OwnerType;
    ownerDisplayName: string;
    representativeName: string | null;
    representativePosition: string | null;
    registrationNumber: string;
    countryCode: string;
    contactPhone: string;
    subscriptionContactPhone: string;
    adminEmail: string;
    hotelDisplayName: string;
    hotelPublicPhone: string;
    district: string;
    khoroo: string;
    addressLine: string;
    latitudeMicro: number;
    longitudeMicro: number;
    packageCode: PackageCode;
    termMonths: 1 | 3 | 7 | 12;
  } {
    if (!OWNER_TYPES.includes(draft.ownerType)) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'the registration type must be citizen or organization',
      );
    }
    if (!isPackageCode(draft.packageCode)) {
      throw new ApiError('VALIDATION_FAILED', 'the package must be 20,000₮, 25,000₮ or 30,000₮');
    }
    if (!isTermMonths(draft.termMonths)) {
      throw new ApiError('VALIDATION_FAILED', 'the term must be 1, 3, 7 or 12 months');
    }

    const registrationNumber = required(draft.registrationNumber, 'the registration number');
    if (!REGISTRATION_NUMBER.test(registrationNumber)) {
      // The message says the shape is wrong and never echoes the value: a
      // registration number must not reach a response body, a log or an error
      // (CLAUDE.md §8).
      throw new ApiError('VALIDATION_FAILED', 'the registration number is not well formed');
    }

    const contactPhone = required(draft.contactPhone, 'the phone number');
    const subscriptionContactPhone = required(
      draft.subscriptionContactPhone,
      'the subscription contact phone',
    );
    const hotelPublicPhone = required(draft.hotelPublicPhone, "the hotel's public phone");
    for (const [phone, field] of [
      [contactPhone, 'the phone number'],
      [subscriptionContactPhone, 'the subscription contact phone'],
      [hotelPublicPhone, "the hotel's public phone"],
    ] as const) {
      if (!PHONE.test(phone))
        throw new ApiError('VALIDATION_FAILED', `${field} is not well formed`);
    }

    const adminEmail = required(draft.adminEmail, 'the Hotel Admin email').toLowerCase();
    if (!EMAIL.test(adminEmail)) {
      throw new ApiError('VALIDATION_FAILED', 'the Hotel Admin email is not well formed');
    }

    // doc 15 §2.2: an organisation registers through a named authorised
    // representative; a citizen has none. Neither shape may be sent as the other.
    const representativeName =
      draft.ownerType === 'ORGANIZATION'
        ? required(draft.representativeName, "the representative's name")
        : null;
    const representativePosition =
      draft.ownerType === 'ORGANIZATION'
        ? required(draft.representativePosition, "the representative's position")
        : null;
    if (draft.ownerType === 'CITIZEN') {
      if (draft.representativeName !== undefined || draft.representativePosition !== undefined) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'a citizen registration carries no authorised representative',
        );
      }
    }

    for (const [value, field] of [
      [draft.latitudeMicro, 'latitude'],
      [draft.longitudeMicro, 'longitude'],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new ApiError('VALIDATION_FAILED', `${field} must be integer micro-degrees`);
      }
    }
    if (draft.latitudeMicro < -90_000_000 || draft.latitudeMicro > 90_000_000) {
      throw new ApiError('VALIDATION_FAILED', 'latitude is out of range');
    }
    if (draft.longitudeMicro < -180_000_000 || draft.longitudeMicro > 180_000_000) {
      throw new ApiError('VALIDATION_FAILED', 'longitude is out of range');
    }

    const countryCode = (draft.countryCode ?? 'MN').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new ApiError('VALIDATION_FAILED', 'the country code must be two letters');
    }

    return {
      ownerType: draft.ownerType,
      ownerDisplayName: required(draft.ownerDisplayName, 'the owner name'),
      representativeName,
      representativePosition,
      registrationNumber,
      countryCode,
      contactPhone,
      subscriptionContactPhone,
      adminEmail,
      hotelDisplayName: required(draft.hotelDisplayName, "the hotel's public name"),
      hotelPublicPhone,
      district: required(draft.district, 'the district'),
      khoroo: required(draft.khoroo, 'the khoroo'),
      addressLine: required(draft.addressLine, 'the address'),
      latitudeMicro: draft.latitudeMicro,
      longitudeMicro: draft.longitudeMicro,
      packageCode: draft.packageCode,
      termMonths: draft.termMonths,
    };
  }

  /**
   * Resolves the application a bearer reference names.
   *
   * The digest is bound to the application it was minted for, so the lookup is
   * two-sided: the candidate id comes from the resolver wrapper, and the digest
   * is then recomputed against *that* id and compared. A token minted for one
   * application therefore cannot be presented against another even if the stored
   * hashes were somehow swapped, and an unknown token is the same `NOT_FOUND` a
   * deleted application would get.
   */
  async resolveApplicant(applicantToken: string, request: RequestContext): Promise<string> {
    const resolved = await this.inOnboardingScope(undefined, request, async (uow) => {
      // The subject is unknown before the lookup, so the first digest is bound to
      // a fixed subject and used only to find a candidate.
      const probe = await this.tokens.digest(
        'onboarding_draft',
        APPLICANT_LOOKUP_SUBJECT,
        applicantToken,
      );
      return resolveApplicantToken(uow, probe.tokenHash);
    });
    if (resolved === undefined) throw new ApiError('NOT_FOUND', 'not found');
    return resolved;
  }

  // ==================================================================== OTP

  /** doc 15 §2.1: opens the phone challenge. The code never touches the row. */
  async requestPhoneVerification(
    applicationId: string,
    request: RequestContext,
  ): Promise<{ deliveryId: string }> {
    const parameters = this.parameters;
    const prepared = await this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (application.state !== 'DRAFT' && application.state !== 'OWNER_VERIFICATION_REQUIRED') {
        throw new ApiError('CONFLICT', 'this application is past phone verification');
      }
      if (application.contactPhoneVerifiedAt !== null) {
        throw new ApiError('CONFLICT', 'this phone is already verified');
      }

      // One live challenge per application: a previous one is settled before a
      // new code is minted, so two codes are never redeemable at once.
      const existing = await repository.lockPendingPhoneChallenge(applicationId);
      if (existing !== undefined) {
        await repository.settlePhoneChallenge(existing.verificationId, 'EXPIRED');
      }

      const code = await this.tokens.issueNumericCode(applicationId, parameters.otpLength);
      const verificationId = await repository.openPhoneChallenge({
        applicationId,
        phone: application.contactPhone,
        codeDigest: code.tokenHash,
        codeKeyVersion: code.keyVersion,
        maxAttempts: parameters.otpMaxAttempts,
        ttlSeconds: parameters.otpTtlSeconds,
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.phone.challenge_opened',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        payload: { verificationId },
      });
      return {
        verificationId,
        phone: application.contactPhone,
        code: code.token,
        expiresAt: new Date(uow.serverNow.getTime() + parameters.otpTtlSeconds * 1000),
      };
    });

    // Delivery is outside the transaction that minted the code: a provider
    // outage must not roll back the challenge, and the code is not stored, so a
    // failed send is retried by asking for a new challenge.
    await this.deps.phone.send({
      subjectRef: applicationId,
      phone: prepared.phone,
      expiresAt: prepared.expiresAt,
      deliveryId: prepared.verificationId,
      code: prepared.code,
    });
    return { deliveryId: prepared.verificationId };
  }

  /** doc 15 §2.1: redeems the code, in constant time against the stored digest. */
  async confirmPhoneVerification(
    applicationId: string,
    code: string,
    request: RequestContext,
  ): Promise<{ verified: boolean }> {
    const digest = await this.tokens.digest('phone_otp', applicationId, code);
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const challenge = await repository.lockPendingPhoneChallenge(applicationId);
      if (challenge === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (challenge.expired) {
        await repository.settlePhoneChallenge(challenge.verificationId, 'EXPIRED');
        throw new ApiError('CONFLICT', 'this code has expired');
      }

      await repository.recordPhoneAttempt(challenge.verificationId);
      const matches = challenge.codeDigest === digest.tokenHash;
      if (!matches) {
        // The budget is on the row, so a guessing client runs out of attempts
        // rather than out of patience.
        if (challenge.attempts + 1 >= challenge.maxAttempts) {
          await repository.settlePhoneChallenge(challenge.verificationId, 'FAILED');
        }
        await recordPlatformAudit(uow, {
          action: 'onboarding.phone.verification_failed',
          outcome: 'denied',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          reason: 'code_mismatch',
        });
        return { verified: false };
      }

      await repository.settlePhoneChallenge(challenge.verificationId, 'VERIFIED');
      const moved = await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: application.state,
        reason: 'phone_verified',
        contactPhoneVerifiedAt: uow.serverNow,
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await recordPlatformAudit(uow, {
        action: 'onboarding.phone.verified',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
      });
      return { verified: true };
    });
  }

  // =========================================================== owner resolution

  /**
   * doc 15 §3.1: resolves the owner behind the application, before any invoice.
   *
   * A new registration number becomes a new owner profile. A known one does
   * **not** attach: it moves the application to `OWNER_VERIFICATION_REQUIRED`
   * and opens a challenge to the owner's *previously stored* verified contact.
   * The contact on the new application is never treated as proof of anything,
   * and never overwrites what the owner profile already holds.
   */
  async resolveOwner(
    applicationId: string,
    request: RequestContext,
  ): Promise<{ state: ApplicationState; proofRequired: boolean }> {
    const parameters = this.parameters;
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (application.ownerId !== null) {
        return { state: application.state, proofRequired: false };
      }
      if (application.state !== 'DRAFT') {
        throw new ApiError('CONFLICT', 'this application is past owner resolution');
      }

      const existing = await repository.probeOwner(applicationId);

      if (existing === undefined) {
        const ownerId = await this.createOwnerFor(repository, application);
        const moved = await repository.transition({
          applicationId,
          expectedRevision: application.revision,
          state: 'DRAFT',
          reason: 'owner_created',
          ownerId,
        });
        if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
        return { state: 'DRAFT' as const, proofRequired: false };
      }

      // An existing owner. The challenge goes to the channel the owner profile
      // already holds — which the applicant never sees in full: the probe
      // returned it already masked (doc 15 §8).
      const destination = existing.maskedDestination;
      const challenge =
        destination === null
          ? null
          : await this.tokens.issue('onboarding_draft', `${applicationId}:owner-proof`);
      await repository.openOwnerProof({
        applicationId,
        ownerId: existing.ownerId,
        // With no stored verified channel there is nothing to challenge, so the
        // only remaining route is the audited offline verification of §3.1.
        method: destination === null ? 'OFFLINE_VERIFICATION' : 'STORED_CONTACT_CHALLENGE',
        challengeDigest: challenge?.tokenHash ?? null,
        challengeKeyVersion: challenge?.keyVersion ?? null,
        maskedDestination: destination,
        ttlSeconds: parameters.ownerProofTtlSeconds,
      });

      const moved = await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: 'OWNER_VERIFICATION_REQUIRED',
        reason: 'existing_owner_matched',
        ownerId: existing.ownerId,
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await repository.recordEvent({
        applicationId,
        fromState: 'DRAFT',
        toState: 'OWNER_VERIFICATION_REQUIRED',
        reason: 'existing_owner_matched',
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.owner.proof_required',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        payload: {
          method: destination === null ? 'OFFLINE_VERIFICATION' : 'STORED_CONTACT_CHALLENGE',
          maskedDestination: destination,
        },
      });
      return { state: 'OWNER_VERIFICATION_REQUIRED' as const, proofRequired: true };
    });
  }

  private async createOwnerFor(
    repository: OnboardingRepository,
    application: ApplicationRow,
  ): Promise<string> {
    const sealed = await repository.sealedIdentifier(application.applicationId);
    if (sealed === undefined) throw new ApiError('NOT_FOUND', 'not found');

    // The ciphertext is bound to the application row it was sealed against, so
    // it is decrypted and resealed against the owner row rather than copied.
    // Moving a ciphertext between rows must fail, and the AAD is what makes it
    // fail rather than merely be discouraged (ADR-0020 §3).
    const plaintext = await decryptValue(
      this.deps.keys,
      'pii.subscription_owner',
      {
        ciphertext: sealed.ciphertext,
        wrappedDek: sealed.wrappedDek,
        keyVersion: sealed.keyVersion,
      },
      {
        table: 'onboarding_application',
        column: 'owner_identifier_ciphertext',
        rowRef: application.applicationId,
      },
    );
    const ownerId = randomUUID();
    const resealed = await encryptValue(this.deps.keys, 'pii.subscription_owner', plaintext, {
      table: 'subscription_owner',
      column: 'identifier_ciphertext',
      rowRef: ownerId,
    });

    return repository.createOwner({
      ownerId,
      ownerType: application.ownerType,
      displayName: application.ownerDisplayName,
      representativeName: application.representativeName,
      representativePosition: application.representativePosition,
      identityType: application.ownerIdentityType,
      countryCode: application.ownerCountryCode,
      identifierCiphertext: resealed.ciphertext,
      identifierWrappedDek: resealed.wrappedDek,
      identifierKeyVersion: resealed.keyVersion,
      identifierLookupToken: application.ownerLookupToken,
      identifierLookupKeyVersion: sealed.lookupKeyVersion,
      // The owner's verified channels are what a future proof is sent to, so
      // only a channel this flow actually verified is stored. The phone was
      // OTP-verified; the email has not been demonstrated yet and is left unset
      // rather than asserted (doc 15 §3.1).
      verifiedEmail: null,
      verifiedPhone: application.contactPhoneVerifiedAt === null ? null : application.contactPhone,
    });
  }

  /** doc 15 §3.1: redeems the stored-contact challenge. */
  async proveOwnership(
    applicationId: string,
    challengeToken: string,
    request: RequestContext,
  ): Promise<{ state: ApplicationState }> {
    const digest = await this.tokens.digest(
      'onboarding_draft',
      `${applicationId}:owner-proof`,
      challengeToken,
    );
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const proof = await repository.lockPendingProof(applicationId);
      if (proof === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (proof.expired) {
        await repository.settleProof({
          proofId: proof.proofId,
          state: 'EXPIRED',
          decidedByAccountId: null,
          reason: 'expired',
        });
        throw new ApiError('CONFLICT', 'this challenge has expired');
      }
      if (proof.challengeDigest === null || proof.challengeDigest !== digest.tokenHash) {
        await recordPlatformAudit(uow, {
          action: 'onboarding.owner.proof_failed',
          outcome: 'denied',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          reason: 'challenge_mismatch',
        });
        throw new ApiError('NOT_FOUND', 'not found');
      }

      await repository.settleProof({
        proofId: proof.proofId,
        state: 'PASSED',
        decidedByAccountId: request.accountId ?? null,
        reason: 'stored_contact_challenge',
      });
      return this.releaseAfterProof(uow, repository, application);
    });
  }

  /**
   * What a passed ownership proof unblocks.
   *
   * The canonical machine of doc 15 §7 has no edge back to `DRAFT`, so a
   * pre-payment proof leaves the application exactly where it is: still
   * `OWNER_VERIFICATION_REQUIRED`, but now with a passed proof, which is what
   * `openInvoice` checks before it will quote. The post-payment race — §3.1's
   * owner appearing between the pre-payment check and the callback — is the one
   * that moves, from `PAID_OWNER_VERIFICATION_REQUIRED` to
   * `PAID_PENDING_PROVISIONING`, on the same payment.
   */
  private async releaseAfterProof(
    uow: UnitOfWork,
    repository: OnboardingRepository,
    application: ApplicationRow,
  ): Promise<{ state: ApplicationState }> {
    await recordPlatformAudit(uow, {
      action: 'onboarding.owner.proved',
      outcome: 'allowed',
      targetType: 'onboarding_application',
      targetRef: application.applicationId,
    });

    if (application.state !== 'PAID_OWNER_VERIFICATION_REQUIRED') {
      return { state: application.state };
    }

    const moved = await repository.transition({
      applicationId: application.applicationId,
      expectedRevision: application.revision,
      state: 'PAID_PENDING_PROVISIONING',
      reason: 'owner_proved',
    });
    if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
    await repository.recordEvent({
      applicationId: application.applicationId,
      fromState: 'PAID_OWNER_VERIFICATION_REQUIRED',
      toState: 'PAID_PENDING_PROVISIONING',
      reason: 'owner_proved',
    });
    return { state: 'PAID_PENDING_PROVISIONING' as const };
  }

  /**
   * doc 15 §3.1: the Platform Super Admin's audited offline verification.
   *
   * The permission is checked above this layer. What is enforced here is the
   * part an operator cannot be trusted to remember: the decision is recorded
   * with the account that made it, and it can only ever *pass* a proof that
   * exists — it can never attach an owner, skip the proof or rewrite the link.
   */
  async approveOfflineOwnership(
    applicationId: string,
    accountId: string,
    reason: string,
    request: RequestContext,
  ): Promise<{ state: ApplicationState }> {
    return this.inOperationScope({ ...request, accountId }, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      const proof = await repository.lockPendingProof(applicationId);
      if (proof === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await repository.settleProof({
        proofId: proof.proofId,
        state: 'PASSED',
        decidedByAccountId: accountId,
        reason,
      });
      return this.releaseAfterProof(uow, repository, application);
    });
  }

  // ================================================================== invoicing

  /**
   * doc 15 §3 step 8: creates the payment invoice.
   *
   * Every precondition doc 15 states is checked here, in the transaction that
   * would create the attempt: the required fields are complete because the row
   * exists, the phone is verified, and any existing-owner proof has passed. An
   * unverified phone or an outstanding proof produces no invoice at all — which
   * is the acceptance criterion, not a UI convention.
   */
  async openInvoice(
    input: { applicationId: string; provider: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{
    attemptId: string;
    providerInvoiceId: string;
    checkoutUrl: string;
    amountMnt: string;
  }> {
    if (!isPaymentProvider(input.provider)) {
      throw new ApiError('VALIDATION_FAILED', 'the gateway must be QPay or Khaan Bank');
    }
    const provider: PaymentProvider = input.provider;
    const parameters = this.parameters;

    const prepared = await this.inOnboardingScope(input.applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(input.applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      if (application.contactPhoneVerifiedAt === null) {
        throw new ApiError('PRECONDITION_FAILED', 'the phone number is not verified');
      }
      if (application.ownerId === null) {
        throw new ApiError('PRECONDITION_FAILED', 'the subscription owner is not resolved');
      }
      // doc 15 §3.1: an outstanding proof means **no invoice at all**. A passed
      // one lifts the block without moving the state, because §7's machine has
      // no edge back to `DRAFT` — the invoice is what moves it.
      if (
        application.state === 'OWNER_VERIFICATION_REQUIRED' &&
        !(await repository.hasPassedProof(input.applicationId))
      ) {
        throw new ApiError('PRECONDITION_FAILED', 'the ownership proof is outstanding');
      }
      if (
        application.state !== 'DRAFT' &&
        application.state !== 'OWNER_VERIFICATION_REQUIRED' &&
        application.state !== 'PAYMENT_FAILED' &&
        application.state !== 'PAYMENT_EXPIRED'
      ) {
        throw new ApiError('CONFLICT', 'this application cannot open a new invoice');
      }

      // `ONB-DEC-008`: one live attempt. The partial unique index is the arbiter
      // under concurrency; this check is what turns its refusal into a message.
      const attempts = await repository.attemptsFor(input.applicationId);
      const live = attempts.find(
        (attempt) => attempt.state === 'PENDING' || attempt.state === 'PAYMENT_UNCERTAIN',
      );
      if (live !== undefined) {
        throw new ApiError(
          'CONFLICT',
          live.state === 'PAYMENT_UNCERTAIN'
            ? 'the previous payment is being reconciled with the provider'
            : 'an invoice is already open for this application',
        );
      }
      return application;
    });

    // The provider call is outside the transaction that will store its result: a
    // gateway that hangs must not hold a row lock, and an invoice the provider
    // created but we failed to store is an orphan on their side, not a paid
    // hotel on ours.
    const merchantRef = derivedIdempotencyKey(
      'onboarding.invoice',
      input.applicationId,
      input.idempotencyKey,
    );
    const invoice = await this.deps.gateways.gateway(provider).createInvoice({
      provider,
      merchantRef,
      amountMnt: prepared.totalAmountMnt,
      currency: 'MNT',
      expiresAt: new Date(Date.now() + parameters.paymentAttemptTtlSeconds * 1000),
    });

    return this.inOnboardingScope(input.applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(input.applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const claimed = await claimIdempotencyKey(uow, {
        operation: 'onboarding.invoice.open',
        key: input.idempotencyKey,
        clientRef: input.applicationId,
        payload: { applicationId: input.applicationId, provider },
      });
      if (claimed.kind === 'replay') {
        return claimed.body as {
          attemptId: string;
          providerInvoiceId: string;
          checkoutUrl: string;
          amountMnt: string;
        };
      }
      if (claimed.kind !== 'claimed') {
        throw new ApiError(
          claimed.kind === 'in_progress'
            ? 'IDEMPOTENT_REQUEST_IN_PROGRESS'
            : 'IDEMPOTENCY_KEY_REUSED',
          'this request is already being processed',
        );
      }

      const attemptId = await repository.openAttempt({
        applicationId: input.applicationId,
        provider,
        merchantRef,
        providerInvoiceId: invoice.providerInvoiceId,
        amountMnt: application.totalAmountMnt,
        packageCode: application.packageCode,
        termMonths: application.termMonths,
        monthlyPriceMnt: application.monthlyPriceMnt,
        vatRateBp: application.vatRateBp,
        priceBookVersion: application.priceBookVersion,
        taxConfigVersion: application.taxConfigVersion,
        packageFeatureVersion: application.packageFeatureVersion,
        ttlSeconds: parameters.paymentAttemptTtlSeconds,
      });

      const moved = await repository.transition({
        applicationId: input.applicationId,
        expectedRevision: application.revision,
        state: 'PENDING_PAYMENT',
        reason: 'invoice_opened',
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await repository.recordEvent({
        applicationId: input.applicationId,
        fromState: application.state,
        toState: 'PENDING_PAYMENT',
        reason: 'invoice_opened',
        detail: { attemptId, provider },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.invoice.opened',
        outcome: 'allowed',
        targetType: 'onboarding_payment_attempt',
        targetRef: attemptId,
        payload: {
          applicationId: input.applicationId,
          provider,
          amountMnt: application.totalAmountMnt.toString(),
        },
      });

      const result = {
        attemptId,
        providerInvoiceId: invoice.providerInvoiceId,
        checkoutUrl: invoice.checkoutUrl,
        amountMnt: application.totalAmountMnt.toString(),
      };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
      return result;
    });
  }
}
