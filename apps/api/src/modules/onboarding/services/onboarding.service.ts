import { randomUUID } from 'node:crypto';
import type { PackageCode } from '@prsystem/authz';
import { isPackageCode } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  lockIdempotencyClaim,
  recordPlatformAudit,
  withTenantTransaction,
} from '@prsystem/db';
import { deriveLookupToken, encryptValue } from '@prsystem/ports';
import type { PaymentProvider } from '@prsystem/ports';
import { isPaymentProvider } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import { AccountRepository } from '../../iam/repositories/account.repository';
import { accountScope } from '../../iam/services/iam-context';
import type { CommandActor, OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase, portContext, portFailure } from './onboarding-context';
import type {
  ApplicationRow,
  ApplicationState,
  OwnerType,
} from '../repositories/onboarding.repository';
import { OnboardingRepository, resolveApplicantToken } from '../repositories/onboarding.repository';
import { isTermMonths, quoteTerm } from '../domain/pricing';

/**
 * Hotel onboarding (doc 15, `ONB-DEC-001`…`008`).
 *
 * The rule the whole file is arranged around is `ONB-DEC-001`: **no hotel,
 * subscription, membership, session, listing, drawer, activation delivery — or
 * owner profile — exists before authoritative payment success.** Before payment
 * there is one row, an application, and it carries no tenant and no canonical
 * owner: only its own encrypted copy of the identifier, which the provisioning
 * boundary turns into an owner once the money is real.
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
  /**
   * The applicant's bearer reference. Returned exactly once, here, so the
   * applicant can come back to their own draft; it is stored only as a keyed
   * digest and is never logged, audited or placed in an outbox payload.
   */
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

export type OwnerResolution = 'NEW' | 'EXISTING_PROOF_REQUIRED' | 'EXISTING_PROVED';

export interface OwnerResolutionResult {
  readonly state: ApplicationState;
  readonly proofRequired: boolean;
  readonly ownerResolution: OwnerResolution;
}

/**
 * R9: the canonical state and the minimal safe progress an applicant needs.
 *
 * Identifiers of other things — the owner, the payment, the hotel — are not
 * here, and neither is any secret; what is here is what a screen has to show.
 */
export interface ApplicationProgress {
  readonly applicationId: string;
  readonly state: ApplicationState;
  readonly phoneVerified: boolean;
  readonly ownerResolution: 'UNRESOLVED' | OwnerResolution;
  readonly existingAccount: 'NONE' | 'PROOF_REQUIRED' | 'PROVED';
  readonly payment: {
    readonly provider: PaymentProvider;
    readonly state: string;
    readonly expiresAt: string;
  } | null;
  readonly provisioning: {
    readonly attempts: number;
    readonly hotelProvisioned: boolean;
  };
  readonly packageCode: PackageCode;
  readonly termMonths: number;
  readonly totalAmountMnt: string;
}

export interface OpenedInvoice {
  readonly attemptId: string;
  readonly providerInvoiceId: string;
  readonly checkoutUrl: string;
  readonly amountMnt: string;
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

/** The subject an owner-proof code is bound to: this application's proof, and no other. */
export function ownerProofSubject(applicationId: string): string {
  return `${applicationId}:owner-proof`;
}

function required(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) throw new ApiError('VALIDATION_FAILED', `${field} is required`);
  return trimmed;
}

/** A stored refusal, replayed as the refusal it was. */
function replayStored(status: number, body: unknown): OpenedInvoice {
  if (status >= 400) {
    const stored = body as { error?: { code?: string; message?: string } };
    throw new ApiError(
      (stored.error?.code as ApiError['code'] | undefined) ?? 'CONFLICT',
      stored.error?.message ?? 'this request was refused when it was first made',
    );
  }
  return body as OpenedInvoice;
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
   * The candidate id comes from the resolver wrapper, which answers an
   * identifier and nothing else; an unknown token is the same `NOT_FOUND` a
   * deleted application would get.
   */
  async resolveApplicant(applicantToken: string, request: RequestContext): Promise<string> {
    const resolved = await this.inOnboardingScope(undefined, request, async (uow) => {
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

  // ================================================================ progress

  /** R9: the canonical state and the minimal safe progress. */
  async applicationState(
    applicationId: string,
    request: RequestContext,
  ): Promise<ApplicationProgress> {
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.byId(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      const attempts = (await repository.attemptsFor(applicationId)).filter(
        (attempt) => attempt.state !== 'PREPARING' && attempt.state !== 'ABANDONED',
      );
      const latest = attempts[attempts.length - 1];
      const passed = await repository.hasPassedProof(applicationId);
      const existingAccountHeld =
        application.existingAccountId !== null ||
        (await repository.existingAccountHoldsEmail(applicationId));

      let ownerResolution: ApplicationProgress['ownerResolution'] = 'UNRESOLVED';
      if (application.ownerId !== null) {
        ownerResolution =
          application.state === 'PROVISIONED' && !(await repository.hasPendingProof(applicationId))
            ? passed
              ? 'EXISTING_PROVED'
              : 'NEW'
            : passed
              ? 'EXISTING_PROVED'
              : 'EXISTING_PROOF_REQUIRED';
      } else if (
        application.state !== 'DRAFT' ||
        (await repository.probeOwner(applicationId)) === undefined
      ) {
        // A draft is "unresolved" until the applicant asks; once the flow has
        // moved on, or the number is known to be fresh, it is a new owner.
        ownerResolution = application.state === 'DRAFT' ? 'UNRESOLVED' : 'NEW';
      }

      return {
        applicationId,
        state: application.state,
        phoneVerified: application.contactPhoneVerifiedAt !== null,
        ownerResolution,
        existingAccount:
          application.existingAccountId !== null
            ? 'PROVED'
            : existingAccountHeld
              ? 'PROOF_REQUIRED'
              : 'NONE',
        payment:
          latest === undefined
            ? null
            : {
                provider: latest.provider,
                state: latest.state,
                expiresAt: latest.expiresAt.toISOString(),
              },
        provisioning: {
          attempts: application.provisionAttempts,
          hotelProvisioned: application.provisionedHotelId !== null,
        },
        packageCode: application.packageCode,
        termMonths: application.termMonths,
        totalAmountMnt: application.totalAmountMnt.toString(),
      };
    });
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
    const sent = await this.deps.phone.send(
      {
        subjectRef: applicationId,
        phone: prepared.phone,
        expiresAt: prepared.expiresAt,
        deliveryId: prepared.verificationId,
        code: prepared.code,
      },
      portContext(request),
    );
    if (!sent.ok) throw portFailure(sent.error, 'phone verification');
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
   * A new registration number is exactly that — nothing is created for it;
   * the owner profile comes into existence inside the paid provisioning
   * transaction (R2). A known one moves the application to
   * `OWNER_VERIFICATION_REQUIRED` and opens a challenge to the owner's
   * *previously stored* verified contact. The owner row is probed and never
   * touched; the contact on the new application is never treated as proof of
   * anything, never overwrites what the owner profile holds, and the secret is
   * never returned — the applicant sees a mask.
   */
  async resolveOwner(
    applicationId: string,
    request: RequestContext,
  ): Promise<OwnerResolutionResult> {
    const outcome = await this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      if (application.ownerId !== null) {
        if (await repository.hasPassedProof(applicationId)) {
          return { result: proved(application.state), challenge: undefined };
        }
        const pending = await repository.lockPendingProof(applicationId);
        if (pending !== undefined) {
          // A live challenge is live. One that was never delivered — opened
          // without a digest by a claim-time collision — or has expired is not
          // (remediation 2, finding 2): it is settled and a fresh one opened.
          const stale =
            pending.expired ||
            (pending.method === 'STORED_CONTACT_CHALLENGE' && pending.challengeDigest === null);
          if (!stale) return { result: proofRequired(application.state), challenge: undefined };
          await repository.settleProof({
            proofId: pending.proofId,
            state: 'EXPIRED',
            decidedByAccountId: null,
            reason: pending.expired ? 'expired' : 'never_challenged',
          });
        }
        const challenge = await this.openChallenge(
          uow,
          repository,
          application,
          application.ownerId,
        );
        return { result: proofRequired(application.state), challenge };
      }
      if (application.state === 'PAID_OWNER_VERIFICATION_REQUIRED') {
        // The collision was discovered after payment and the application was
        // sent back to proof without an owner binding. The owner is the one the
        // identifier names, found by the probe and never by the applicant.
        const collided = await repository.probeOwner(applicationId);
        if (collided === undefined) {
          throw new ApiError('CONFLICT', 'this application is past owner resolution');
        }
        const bound = await repository.bindOwner({
          applicationId,
          expectedRevision: application.revision,
          ownerId: collided.ownerId,
        });
        if (!bound) throw new ApiError('CONFLICT', 'the application changed concurrently');
        const challenge = await this.openChallenge(uow, repository, application, collided.ownerId);
        return { result: proofRequired(application.state), challenge };
      }
      if (application.state !== 'DRAFT') {
        throw new ApiError('CONFLICT', 'this application is past owner resolution');
      }

      const existing = await repository.probeOwner(applicationId);
      if (existing === undefined) {
        await recordPlatformAudit(uow, {
          action: 'onboarding.owner.resolved',
          outcome: 'allowed',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          payload: { resolution: 'NEW' },
        });
        return {
          result: {
            state: 'DRAFT' as const,
            proofRequired: false,
            ownerResolution: 'NEW' as const,
          },
          challenge: undefined,
        };
      }

      // Bound first: the challenge destination is read through the
      // application's owner binding, never through anything the applicant sent.
      const moved = await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: 'OWNER_VERIFICATION_REQUIRED',
        reason: 'existing_owner_matched',
        ownerId: existing.ownerId,
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      const challenge = await this.openChallenge(uow, repository, application, existing.ownerId);
      await repository.recordEvent({
        applicationId,
        fromState: 'DRAFT',
        toState: 'OWNER_VERIFICATION_REQUIRED',
        reason: 'existing_owner_matched',
      });
      return { result: proofRequired('OWNER_VERIFICATION_REQUIRED'), challenge };
    });

    if (outcome.challenge !== undefined) {
      await this.deliverChallenge(applicationId, outcome.challenge, request);
    }
    return outcome.result;
  }

  /**
   * Opens the stored-contact challenge — or, with no stored channel at all, the
   * offline proof of §3.1 (3) — and returns what the delivery port needs. The
   * plaintext exists only in this process, for the length of the send.
   */
  private async openChallenge(
    uow: UnitOfWork,
    repository: OnboardingRepository,
    application: ApplicationRow,
    ownerId: string,
  ): Promise<
    | {
        channel: 'phone' | 'email';
        destination: string;
        code: string;
        expiresAt: Date;
        proofId: string;
      }
    | undefined
  > {
    const parameters = this.parameters;
    const probe = await repository.probeOwner(application.applicationId);
    const destination = await repository.ownerChallengeDestination(application.applicationId);
    const code =
      destination === undefined
        ? undefined
        : await this.tokens.issueNumericCode(
            ownerProofSubject(application.applicationId),
            parameters.otpLength,
          );
    const proofId = await repository.openOwnerProof({
      applicationId: application.applicationId,
      ownerId,
      method: destination === undefined ? 'OFFLINE_VERIFICATION' : 'STORED_CONTACT_CHALLENGE',
      challengeDigest: code?.tokenHash ?? null,
      challengeKeyVersion: code?.keyVersion ?? null,
      maskedDestination: probe?.maskedDestination ?? null,
      ttlSeconds: parameters.ownerProofTtlSeconds,
    });
    await recordPlatformAudit(uow, {
      action: 'onboarding.owner.proof_required',
      outcome: 'allowed',
      targetType: 'onboarding_application',
      targetRef: application.applicationId,
      payload: {
        method: destination === undefined ? 'OFFLINE_VERIFICATION' : 'STORED_CONTACT_CHALLENGE',
        maskedDestination: probe?.maskedDestination ?? null,
      },
    });
    if (destination === undefined || code === undefined) return undefined;
    return {
      channel: destination.channel,
      destination: destination.destination,
      code: code.token,
      expiresAt: new Date(uow.serverNow.getTime() + parameters.ownerProofTtlSeconds * 1000),
      proofId,
    };
  }

  private async deliverChallenge(
    applicationId: string,
    challenge: {
      channel: 'phone' | 'email';
      destination: string;
      code: string;
      expiresAt: Date;
      proofId: string;
    },
    request: RequestContext,
  ): Promise<void> {
    const subjectRef = ownerProofSubject(applicationId);
    const sent =
      challenge.channel === 'phone'
        ? await this.deps.phone.send(
            {
              subjectRef,
              phone: challenge.destination,
              expiresAt: challenge.expiresAt,
              deliveryId: challenge.proofId,
              code: challenge.code,
            },
            portContext(request),
          )
        : await this.deps.notifications.send(
            {
              kind: 'owner_challenge',
              deliveryId: challenge.proofId,
              subjectRef,
              emailNormalized: challenge.destination,
              expiresAt: challenge.expiresAt,
              code: challenge.code,
            },
            portContext(request),
          );
    if (!sent.ok) {
      // A challenge nobody received is not a live challenge: it is expired so
      // the next resolution opens a fresh one, and the failure is reported.
      await this.inOnboardingScope(applicationId, request, async (uow) => {
        await new OnboardingRepository(uow).settleProof({
          proofId: challenge.proofId,
          state: 'EXPIRED',
          decidedByAccountId: null,
          reason: 'delivery_failed',
        });
      });
      throw portFailure(sent.error, 'the ownership challenge delivery');
    }
  }

  /** doc 15 §3.1 (2): redeems the stored-contact challenge. */
  async proveOwnership(
    applicationId: string,
    code: string,
    request: RequestContext,
  ): Promise<{ state: ApplicationState }> {
    const digest = await this.tokens.digest('phone_otp', ownerProofSubject(applicationId), code);
    // A refusal is recorded — the proof expired, the mismatch audited — in the
    // transaction, and thrown only once that transaction has committed
    // (remediation 2, finding 2). Thrown inside it, the record rolled back with
    // the refusal and the row kept saying "pending" to the next attempt.
    const outcome = await this.inOnboardingScope(applicationId, request, async (uow) => {
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
        return { refusal: new ApiError('CONFLICT', 'this challenge has expired') };
      }
      if (proof.challengeDigest === null || proof.challengeDigest !== digest.tokenHash) {
        await recordPlatformAudit(uow, {
          action: 'onboarding.owner.proof_failed',
          outcome: 'denied',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          reason: 'challenge_mismatch',
        });
        return { refusal: new ApiError('NOT_FOUND', 'not found') };
      }

      await repository.settleProof({
        proofId: proof.proofId,
        state: 'PASSED',
        decidedByAccountId: null,
        reason: 'stored_contact_challenge',
      });
      return { result: await this.releaseAfterProof(uow, repository, application) };
    });
    if ('refusal' in outcome) throw outcome.refusal;
    return outcome.result;
  }

  /**
   * doc 15 §3.1 (1): the signed-in account is already linked to the owner — it
   * is the Primary Hotel Admin of a hotel the owner holds.
   *
   * A stranger's session proves nothing and is refused with the same
   * `NOT_FOUND` an unknown application gets; the linkage is decided by the
   * definer from the owner link and the membership, never from anything the
   * caller claims.
   */
  async proveOwnershipByAccount(
    applicationId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ state: ApplicationState }> {
    if (actor.principal.realm !== 'hotel' || actor.principal.accountState !== 'ACTIVE') {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    const scoped = { ...request, accountId: actor.principal.accountId };
    return this.inOnboardingScope(applicationId, scoped, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined || application.ownerId === null) {
        throw new ApiError('NOT_FOUND', 'not found');
      }
      if (!(await repository.accountLinkedToOwner(applicationId, actor.principal.accountId))) {
        await recordPlatformAudit(uow, {
          action: 'onboarding.owner.proof_failed',
          outcome: 'denied',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          reason: 'account_not_linked',
        });
        throw new ApiError('NOT_FOUND', 'not found');
      }
      const pending = await repository.lockPendingProof(applicationId);
      if (pending !== undefined) {
        await repository.settleProof({
          proofId: pending.proofId,
          state: 'EXPIRED',
          decidedByAccountId: actor.principal.accountId,
          reason: 'superseded_by_account_proof',
        });
      }
      const proofId = await repository.openOwnerProof({
        applicationId,
        ownerId: application.ownerId,
        method: 'AUTHENTICATED_ACCOUNT',
        challengeDigest: null,
        challengeKeyVersion: null,
        maskedDestination: null,
        ttlSeconds: this.parameters.ownerProofTtlSeconds,
      });
      await repository.settleProof({
        proofId,
        state: 'PASSED',
        decidedByAccountId: actor.principal.accountId,
        reason: 'authenticated_account',
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
   * `openInvoice` checks before it will quote. The post-payment race moves,
   * from `PAID_OWNER_VERIFICATION_REQUIRED` to `PAID_PENDING_PROVISIONING`, on
   * the same payment — and makes the provisioning job due again.
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
   * doc 15 §3.1 (3): the Platform Super Admin's audited offline verification.
   *
   * An Operation action in full: realm, the Platform-only column, the explicit
   * `SUBSCRIPTION_CONTACT_CHANGE_APPROVE` grant and a recent step-up, all
   * evaluated by the Phase 04 pipeline. What is enforced here beyond that is
   * the part an operator cannot be trusted to remember: the decision is
   * recorded with the account that made it, and it can only ever *pass* a proof
   * — it can never attach an owner, skip the proof or rewrite the link.
   *
   * There is no HTTP route for this in Phase 05. The Platform Operation
   * surface is Phase 19, so the production action is not reachable yet.
   */
  async approveOfflineOwnership(
    applicationId: string,
    actor: CommandActor,
    reason: string,
    request: RequestContext,
  ): Promise<{ state: ApplicationState }> {
    const decidedBy = actor.principal.accountId;
    return this.runOperationCommand(
      actor,
      'operation.subscription_contact_change_approve',
      { targetType: 'onboarding_application', targetRef: applicationId },
      request,
      async (uow) => {
        const repository = new OnboardingRepository(uow);
        const application = await repository.lock(applicationId);
        if (application === undefined || application.ownerId === null) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const pending = await repository.lockPendingProof(applicationId);
        if (pending !== undefined) {
          await repository.settleProof({
            proofId: pending.proofId,
            state: 'EXPIRED',
            decidedByAccountId: decidedBy,
            reason: 'superseded_by_offline_verification',
          });
        }
        const proofId = await repository.openOwnerProof({
          applicationId,
          ownerId: application.ownerId,
          method: 'OFFLINE_VERIFICATION',
          challengeDigest: null,
          challengeKeyVersion: null,
          maskedDestination: null,
          ttlSeconds: this.parameters.ownerProofTtlSeconds,
        });
        await repository.settleProof({
          proofId,
          state: 'PASSED',
          decidedByAccountId: decidedBy,
          reason,
        });
        return this.releaseAfterProof(uow, repository, application);
      },
    );
  }

  // ======================================================== existing account

  /**
   * doc 15 §3.1 and §5.1: the admin email already belongs to an account.
   *
   * The applicant proves it by *being* that account: a live session, signed
   * in — freshly, or after completing Phase 04's password recovery — whose
   * account holds exactly the application's admin email. The account id is
   * then bound with the proof that bound it, by this code and nowhere else.
   * A session for any other email is refused with the same `NOT_FOUND`.
   */
  async bindExistingAccount(
    applicationId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ existingAccountId: string }> {
    if (actor.principal.realm !== 'hotel' || actor.principal.accountState !== 'ACTIVE') {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    const scoped = { ...request, accountId: actor.principal.accountId };
    // The account's own row, read under its own scope: the email comes from
    // the server, never from the caller.
    const account = await withTenantTransaction(this.deps.pool, accountScope(scoped), (uow) =>
      new AccountRepository(uow).findById(actor.principal.accountId),
    );
    if (account === undefined || account.realm !== 'hotel' || account.state !== 'ACTIVE') {
      throw new ApiError('NOT_FOUND', 'not found');
    }

    return this.inOnboardingScope(applicationId, scoped, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (application.state === 'PROVISIONED' || application.state === 'PROVISIONING') {
        throw new ApiError('CONFLICT', 'this application is already provisioned');
      }
      if (application.existingAccountId !== null) {
        if (application.existingAccountId === account.accountId) {
          return { existingAccountId: account.accountId };
        }
        throw new ApiError('CONFLICT', 'a different account is already bound');
      }
      if (account.emailNormalized !== application.adminEmailNormalized) {
        await recordPlatformAudit(uow, {
          action: 'onboarding.account.binding_refused',
          outcome: 'denied',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          reason: 'email_mismatch',
        });
        throw new ApiError('NOT_FOUND', 'not found');
      }
      const moved = await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: application.state,
        reason: 'existing_account_bound',
        existingAccount: { accountId: account.accountId, method: 'SIGNED_IN' },
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await recordPlatformAudit(uow, {
        action: 'onboarding.account.bound',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        payload: { accountId: account.accountId, method: 'SIGNED_IN' },
      });
      return { existingAccountId: account.accountId };
    });
  }

  // ================================================================== invoicing

  /**
   * doc 15 §3 step 8: creates the payment invoice.
   *
   * Every precondition doc 15 states is checked in the transaction that claims
   * the request: the phone is verified, an existing owner has a passed proof,
   * an existing account has been bound. Then, in order (R6):
   *
   *  1. the idempotency key is claimed **before** anything irreversible;
   *  2. the provider is called with a stable idempotency key of its own, so a
   *     lost acknowledgement recovers the same invoice on retry;
   *  3. the claim is locked again in the transaction that persists the
   *     attempt, so two concurrent completions serialise and the second replays
   *     the first's result instead of storing a second attempt.
   */
  async openInvoice(
    input: { applicationId: string; provider: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<OpenedInvoice> {
    if (!isPaymentProvider(input.provider)) {
      throw new ApiError('VALIDATION_FAILED', 'the gateway must be QPay or Khaan Bank');
    }
    const provider: PaymentProvider = input.provider;
    const parameters = this.parameters;
    const operation = 'onboarding.invoice.open';
    const payload = { applicationId: input.applicationId, provider };
    const merchantRef = derivedIdempotencyKey(
      'onboarding.invoice',
      input.applicationId,
      input.idempotencyKey,
    );

    // T1 — the claim first, then eligibility, then a prepared attempt.
    //
    // A completed request is replayed before anything about the application's
    // present state is judged (remediation 2, finding 1): the retry of an
    // invoice that was opened and since paid gets the invoice, not a refusal.
    // The attempt is prepared with the terms it was priced at and no provider
    // invoice yet, so a retry after a lost acknowledgement recovers the same
    // provider invoice at the same amount and never re-prices it.
    const prepared = await this.inOnboardingScope(input.applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(input.applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const claimed = await claimIdempotencyKey(uow, {
        operation,
        key: input.idempotencyKey,
        clientRef: input.applicationId,
        payload,
      });
      if (claimed.kind === 'replay') return { replay: replayStored(claimed.status, claimed.body) };
      if (claimed.kind === 'key_reused_with_different_payload') {
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'this key was used for a different request');
      }

      const existing = await repository.lockAttemptByMerchantRef(merchantRef);
      if (existing !== undefined) {
        // An earlier run of this same request prepared the attempt and lost
        // the provider's reply. Its terms are the terms; nothing is re-priced.
        if (existing.state !== 'PREPARING') {
          throw new ApiError('CONFLICT', 'the request claim is gone');
        }
        return { attempt: existing };
      }
      await this.assertInvoiceable(repository, application);
      const attemptId = await repository.prepareAttempt({
        applicationId: input.applicationId,
        provider,
        merchantRef,
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
      const attempt = await repository.attemptById(attemptId);
      if (attempt === undefined) throw new Error('the prepared attempt could not be read back');
      return { attempt };
    });
    if ('replay' in prepared) return prepared.replay;
    const attempt = prepared.attempt;

    const invoice = await this.deps.gateways.gateway(provider).createInvoice(
      {
        intentId: input.applicationId,
        amountMnt: attempt.amountMnt,
        currency: 'MNT',
        merchantRef,
        expiresAt: attempt.expiresAt,
        idempotencyKey: merchantRef,
      },
      portContext(request),
    );
    if (!invoice.ok) {
      const failure = portFailure(invoice.error, 'the payment gateway');
      // A provider refusal is the request's fault and is stored so a retry gets
      // the same answer, and the prepared attempt is abandoned; an outage or a
      // lost reply leaves both open so the retry recovers the invoice instead.
      if (invoice.error.kind === 'REJECTED' || invoice.error.kind === 'MISMATCH') {
        await this.inOnboardingScope(input.applicationId, request, async (uow) => {
          const repository = new OnboardingRepository(uow);
          const lock = await lockIdempotencyClaim(uow, { operation, key: input.idempotencyKey });
          if (lock.kind === 'in_progress') {
            await completeIdempotencyKey(uow, lock.idempotencyId, failure.status, {
              error: { code: failure.code, message: failure.message },
            });
          }
          const row = await repository.lockAttemptByMerchantRef(merchantRef);
          if (row !== undefined && row.state === 'PREPARING') {
            await repository.refuseAttempt({
              attemptId: row.attemptId,
              expectedRevision: row.revision,
              reason: `provider_${invoice.error.kind.toLowerCase()}`,
            });
          }
        });
      }
      throw failure;
    }
    const providerInvoiceId = invoice.value.providerInvoiceId;

    // T2 — the final mutation, with eligibility judged again on the row as it
    // is now. A refusal here is persisted — the attempt abandoned with the
    // provider's invoice on it, the claim completed with the refusal — and only
    // then thrown, after the transaction committed (finding 1).
    const settled = await this.inOnboardingScope(input.applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const locked = await repository.lock(input.applicationId);
      if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const claim = await lockIdempotencyClaim(uow, { operation, key: input.idempotencyKey });
      if (claim.kind === 'replay') return { result: replayStored(claim.status, claim.body) };
      if (claim.kind === 'absent') throw new ApiError('CONFLICT', 'the request claim is gone');
      const row = await repository.lockAttemptByMerchantRef(merchantRef);
      if (row === undefined || row.state !== 'PREPARING') {
        throw new ApiError('CONFLICT', 'the request claim is gone');
      }

      const refusal = await this.assertInvoiceable(repository, locked).then(
        () => undefined,
        (error: unknown) => (error instanceof ApiError ? error : undefined),
      );
      if (refusal !== undefined) {
        await repository.abandonAttempt({
          attemptId: row.attemptId,
          expectedRevision: row.revision,
          providerInvoiceId,
          reason: 'refused_at_finalization',
        });
        await completeIdempotencyKey(uow, claim.idempotencyId, refusal.status, {
          error: { code: refusal.code, message: refusal.message },
        });
        return { refusal };
      }

      const live = await repository.finalizeAttempt({
        attemptId: row.attemptId,
        expectedRevision: row.revision,
        providerInvoiceId,
      });
      if (!live) throw new ApiError('CONFLICT', 'the attempt changed concurrently');

      const moved = await repository.transition({
        applicationId: input.applicationId,
        expectedRevision: locked.revision,
        state: 'PENDING_PAYMENT',
        reason: 'invoice_opened',
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await repository.recordEvent({
        applicationId: input.applicationId,
        fromState: locked.state,
        toState: 'PENDING_PAYMENT',
        reason: 'invoice_opened',
        detail: { attemptId: row.attemptId, provider },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.invoice.opened',
        outcome: 'allowed',
        targetType: 'onboarding_payment_attempt',
        targetRef: row.attemptId,
        payload: {
          applicationId: input.applicationId,
          provider,
          amountMnt: row.amountMnt.toString(),
        },
      });

      const result: OpenedInvoice = {
        attemptId: row.attemptId,
        providerInvoiceId,
        checkoutUrl: invoice.value.payUrl ?? '',
        amountMnt: row.amountMnt.toString(),
      };
      await completeIdempotencyKey(uow, claim.idempotencyId, 201, result);
      return { result };
    });
    if ('refusal' in settled) throw settled.refusal;
    return settled.result;
  }

  /** Every precondition of doc 15 §3 and §3.1, as a refusal with a reason. */
  private async assertInvoiceable(
    repository: OnboardingRepository,
    application: ApplicationRow,
  ): Promise<void> {
    if (application.contactPhoneVerifiedAt === null) {
      throw new ApiError('PRECONDITION_FAILED', 'the phone number is not verified');
    }
    if (
      application.state !== 'DRAFT' &&
      application.state !== 'OWNER_VERIFICATION_REQUIRED' &&
      application.state !== 'PAYMENT_FAILED' &&
      application.state !== 'PAYMENT_EXPIRED'
    ) {
      throw new ApiError('CONFLICT', 'this application cannot open a new invoice');
    }
    // doc 15 §3.1: an outstanding proof means **no invoice at all**. The owner
    // is re-probed here rather than trusted from an earlier call: a matching
    // owner that appeared since is exactly the case this exists to catch.
    if (application.ownerId !== null) {
      if (!(await repository.hasPassedProof(application.applicationId))) {
        throw new ApiError('PRECONDITION_FAILED', 'the ownership proof is outstanding');
      }
    } else if ((await repository.probeOwner(application.applicationId)) !== undefined) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'this registration number belongs to an existing owner; resolve the owner first',
      );
    }
    if (
      application.existingAccountId === null &&
      (await repository.existingAccountHoldsEmail(application.applicationId))
    ) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'an account already holds this email; sign in with it to continue',
      );
    }

    // `ONB-DEC-008`: one live attempt. The partial unique index is the arbiter
    // under concurrency; this check is what turns its refusal into a message.
    const attempts = await repository.attemptsFor(application.applicationId);
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
  }
}

function proved(state: ApplicationState): OwnerResolutionResult {
  return { state, proofRequired: false, ownerResolution: 'EXISTING_PROVED' };
}

function proofRequired(state: ApplicationState): OwnerResolutionResult {
  return { state, proofRequired: true, ownerResolution: 'EXISTING_PROOF_REQUIRED' };
}
