import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { ReconciliationOutcome } from '../../operation/domain/operation';
import type { UnitOfWork } from '@prsystem/db';
import { recordPlatformAudit } from '@prsystem/db';
import { decryptValue, encryptValue } from '@prsystem/ports';
import type { InvoiceStatus, PaymentProvider, RawCallback } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { CommandActor, OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase, backoffSeconds, portContext } from './onboarding-context';
import type { ApplicationRow, AttemptRow } from '../repositories/onboarding.repository';
import {
  OnboardingRepository,
  pendingProvisioningApplications,
  resolvePaymentAttempt,
} from '../repositories/onboarding.repository';
import { pendingActivationDeliveries } from '../repositories/subscription.repository';
import { ownerProofSubject } from './onboarding.service';

/**
 * Payment confirmation, the durable provisioning job and the first Hotel
 * Admin's activation delivery (doc 15 §4, §5; `ONB-DEC-001`, `ONB-DEC-006`,
 * `ONB-DEC-008`).
 *
 * The order is the one doc 15 §5 states and is not negotiable: the payment
 * success is made immutable **first**, and only then does one logical
 * provisioning job build the tenant graph in a single transaction.
 *
 * The job is the application row (R3). A confirmed payment makes it due; the
 * worker claims it with a token and a lease, runs the boundary, and settles by
 * compare-and-set on that token — a failure records `PROVISIONING_FAILED`
 * outside the rolled-back build, persists a real exponential backoff, and after
 * five attempts the row is visible only to the permissioned manual retry. A
 * process that dies mid-run leaves an expired lease, which the next sweep
 * reclaims. Redis carries a best-effort signal and nothing else.
 */

export type CallbackOutcome =
  | { readonly kind: 'paid'; readonly applicationId: string; readonly attemptId: string }
  | { readonly kind: 'paid_owner_verification_required'; readonly applicationId: string }
  | { readonly kind: 'replay'; readonly applicationId: string }
  | { readonly kind: 'requires_reconciliation'; readonly attemptId: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'not_paid'; readonly state: string };

export type ProvisioningOutcome =
  | { readonly kind: 'provisioned'; readonly hotelId: string }
  | { readonly kind: 'already_provisioned'; readonly hotelId: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly attempts: number }
  | { readonly kind: 'exhausted'; readonly attempts: number }
  | { readonly kind: 'blocked'; readonly state: string }
  /** Not due yet: the persisted backoff has not elapsed (remediation 2, finding 3). */
  | { readonly kind: 'deferred'; readonly availableAt: Date };

export interface SweepOutcome {
  readonly claimed: number;
  readonly provisioned: number;
  readonly failed: number;
}

/** What `queryStatus` said, in the shape the settlement reads. */
type ProviderStatus =
  | {
      readonly outcome: 'paid';
      readonly providerPaymentId: string;
      readonly paidAmountMnt: bigint;
      readonly currency: string;
      readonly merchantRef: string;
      readonly confirmedAt: Date;
      /** The fee the provider stated, or null when it stated none (finding 6). */
      readonly providerFeeMnt: bigint | null;
    }
  | { readonly outcome: 'pending' }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'uncertain'; readonly reason: string };

/** The SQLSTATE the boundary raises when an owner appeared since the probe. */
const OWNER_APPEARED = 'P0501';

export function providerStatusFrom(status: InvoiceStatus): ProviderStatus {
  switch (status.state) {
    case 'PAID':
      if (
        status.providerPaymentId === undefined ||
        status.paidAmountMnt === undefined ||
        status.currency === undefined ||
        status.merchantRef === undefined ||
        status.paidAt === undefined
      ) {
        // A "paid" without its settlement facts is not evidence of a payment.
        return { outcome: 'uncertain', reason: 'incomplete_settlement' };
      }
      return {
        outcome: 'paid',
        providerPaymentId: status.providerPaymentId,
        paidAmountMnt: status.paidAmountMnt,
        currency: status.currency,
        merchantRef: status.merchantRef,
        confirmedAt: status.paidAt,
        providerFeeMnt: status.providerFeeMnt ?? null,
      };
    case 'FAILED':
      return { outcome: 'failed', reason: status.failureCode ?? 'failed' };
    case 'EXPIRED':
      return { outcome: 'expired' };
    case 'PENDING':
      return { outcome: 'pending' };
  }
}

export class ProvisioningService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  // ============================================================ payment callback

  /**
   * doc 15 §4: applies a provider callback.
   *
   * Nothing the callback says is believed on its own. In order:
   *
   *  1. the gateway authenticates it;
   *  2. the provider's own status is re-queried — a callback claiming success is
   *     never sufficient;
   *  3. the attempt it names is locked, so two callbacks serialise;
   *  4. provider, merchant reference, amount and currency are matched against
   *     the stored attempt, not against the callback's own claims;
   *  5. the application row is locked and the canonical transition applied once.
   *
   * A confirmed payment makes the provisioning job due — the row itself says
   * so — and then, after commit, a best-effort signal tells the worker not to
   * wait for its sweep. A signal that fails changes nothing.
   */
  async applyCallback(callback: RawCallback, request: RequestContext): Promise<CallbackOutcome> {
    const gateway = this.deps.gateways.gateway(callback.provider);
    const verified = await gateway.verifyCallback(callback, portContext(request));
    if (!verified.ok) {
      return { kind: 'rejected', reason: callbackRejection(verified.error) };
    }

    // The provider's own answer, fetched before anything is locked. A callback
    // is a notification that something may have changed, not evidence of what.
    const queried = await gateway.queryStatus(
      { providerInvoiceId: callback.providerInvoiceId },
      portContext(request),
    );
    const status: ProviderStatus = queried.ok
      ? providerStatusFrom(queried.value)
      : queried.error.kind === 'UNAVAILABLE' || queried.error.kind === 'TIMEOUT'
        ? { outcome: 'uncertain', reason: queried.error.kind.toLowerCase() }
        : { outcome: 'uncertain', reason: callbackRejection(queried.error) };

    const applicationId = await this.inOnboardingScope(undefined, request, (uow) =>
      resolvePaymentAttempt(uow, callback.provider, callback.providerInvoiceId),
    );
    if (applicationId === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

    const outcome = await this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      return this.settleAttempt(uow, repository, callback, status);
    });

    if (outcome.kind === 'paid') {
      await this.deps.signals.signal(applicationId).catch(() => false);
    }
    return outcome;
  }

  private async settleAttempt(
    uow: UnitOfWork,
    repository: OnboardingRepository,
    callback: RawCallback,
    status: ProviderStatus,
  ): Promise<CallbackOutcome> {
    // One lock order with the invoice's finalization: the application row
    // first, then the attempt (remediation 2, finding 1).
    const scoped = uow.context.onboardingRef;
    if (scoped === undefined) return { kind: 'rejected', reason: 'unknown_reference' };
    const held = await repository.lock(scoped);
    if (held === undefined) return { kind: 'rejected', reason: 'unknown_reference' };
    const attempt = await repository.lockAttemptByInvoice(
      callback.provider,
      callback.providerInvoiceId,
    );
    if (attempt === undefined || attempt.applicationId !== held.applicationId) {
      return { kind: 'rejected', reason: 'unknown_reference' };
    }

    if (attempt.state === 'PAID') {
      return { kind: 'replay', applicationId: attempt.applicationId };
    }
    if (attempt.state === 'PAID_REQUIRES_RECONCILIATION') {
      return { kind: 'requires_reconciliation', attemptId: attempt.attemptId };
    }

    if (status.outcome !== 'paid') {
      return this.settleUnpaid(repository, attempt, status);
    }

    // Provider, merchant, reference, amount and currency, against the stored
    // attempt (doc 15 §4). Every mismatch is the same refusal.
    const mismatch =
      status.merchantRef !== attempt.merchantRef
        ? 'merchant_ref_mismatch'
        : status.paidAmountMnt !== attempt.amountMnt
          ? 'amount_mismatch'
          : status.currency !== attempt.currency
            ? 'currency_mismatch'
            : undefined;
    if (mismatch !== undefined) {
      await recordPlatformAudit(uow, {
        action: 'onboarding.payment.callback_rejected',
        outcome: 'denied',
        targetType: 'onboarding_payment_attempt',
        targetRef: attempt.attemptId,
        reason: mismatch,
      });
      return { kind: 'rejected', reason: mismatch };
    }

    const application = await repository.lock(attempt.applicationId);
    if (application === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

    // `ONB-DEC-008`: the first valid confirmed payment wins, under the
    // application's own row lock. Anything after it is money that arrived, so it
    // becomes a reconciliation case rather than a second subscription. A late
    // success resurrects only an expired attempt (doc 15 §4.1); a capture on a
    // cancelled or failed one is money against no live attempt.
    const alreadyPaid = application.paidAttemptId !== null;
    const canStillBePaid =
      attempt.state === 'PENDING' ||
      attempt.state === 'PAYMENT_UNCERTAIN' ||
      attempt.state === 'EXPIRED';
    if (alreadyPaid || !canStillBePaid) {
      const reason = alreadyPaid ? 'application_already_paid' : 'superseded_attempt_paid';
      const settled = await repository.settleAttempt({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        state: 'PAID_REQUIRES_RECONCILIATION',
        reason,
        providerPaymentId: status.providerPaymentId,
        confirmedAt: status.confirmedAt,
        providerFeeMnt: status.providerFeeMnt,
      });
      if (!settled) throw new ApiError('CONFLICT', 'the attempt changed concurrently');
      await repository.recordEvent({
        applicationId: attempt.applicationId,
        fromState: application.state,
        toState: application.state,
        reason: 'duplicate_capture',
        detail: { attemptId: attempt.attemptId, provider: attempt.provider },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.payment.requires_reconciliation',
        outcome: 'allowed',
        targetType: 'onboarding_payment_attempt',
        targetRef: attempt.attemptId,
        reason,
      });
      return { kind: 'requires_reconciliation', attemptId: attempt.attemptId };
    }

    const settled = await repository.settleAttempt({
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      state: 'PAID',
      reason: 'provider_confirmed',
      providerPaymentId: status.providerPaymentId,
      confirmedAt: status.confirmedAt,
      providerFeeMnt: status.providerFeeMnt,
    });
    if (!settled) throw new ApiError('CONFLICT', 'the attempt changed concurrently');

    // A late success on an expired attempt supersedes any newer unpaid one: the
    // money is real, and the application may only be paid once (doc 15 §4.1).
    for (const other of await repository.attemptsFor(attempt.applicationId)) {
      if (other.attemptId === attempt.attemptId) continue;
      if (other.state === 'PENDING' || other.state === 'PAYMENT_UNCERTAIN') {
        await repository.settleAttempt({
          attemptId: other.attemptId,
          expectedRevision: other.revision,
          state: 'CANCELLED',
          reason: 'superseded_by_late_success',
        });
      }
    }

    // doc 15 §3.1: an owner that appeared between the pre-payment check and this
    // callback blocks provisioning without touching the payment. Either the
    // application already resolved to an existing owner whose proof is still
    // outstanding, or the number was fresh at the probe and is not any more.
    const ownerRace = await this.ownerRaceDetected(repository, application);
    const next = ownerRace ? 'PAID_OWNER_VERIFICATION_REQUIRED' : 'PAID_PENDING_PROVISIONING';

    const moved = await repository.transition({
      applicationId: attempt.applicationId,
      expectedRevision: application.revision,
      state: next,
      reason: 'payment_confirmed',
      paidAttemptId: attempt.attemptId,
      paymentConfirmedAt: status.confirmedAt,
      ...(ownerRace === undefined || ownerRace === false ? {} : { ownerId: ownerRace.ownerId }),
    });
    if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
    if (ownerRace !== false && ownerRace.openProof) {
      await repository.openOwnerProof({
        applicationId: attempt.applicationId,
        ownerId: ownerRace.ownerId,
        method:
          ownerRace.maskedDestination === null
            ? 'OFFLINE_VERIFICATION'
            : 'STORED_CONTACT_CHALLENGE',
        challengeDigest: null,
        challengeKeyVersion: null,
        maskedDestination: ownerRace.maskedDestination,
        ttlSeconds: this.parameters.ownerProofTtlSeconds,
      });
    }
    await repository.recordEvent({
      applicationId: attempt.applicationId,
      fromState: application.state,
      toState: next,
      reason: 'payment_confirmed',
      detail: { attemptId: attempt.attemptId, provider: attempt.provider },
    });
    await recordPlatformAudit(uow, {
      action: 'onboarding.payment.confirmed',
      outcome: 'allowed',
      targetType: 'onboarding_payment_attempt',
      targetRef: attempt.attemptId,
      payload: {
        applicationId: attempt.applicationId,
        provider: attempt.provider,
        amountMnt: attempt.amountMnt.toString(),
      },
    });

    return next === 'PAID_PENDING_PROVISIONING'
      ? { kind: 'paid', applicationId: attempt.applicationId, attemptId: attempt.attemptId }
      : { kind: 'paid_owner_verification_required', applicationId: attempt.applicationId };
  }

  /**
   * The §3.1 race, decided from the rows: `false` when the owner is either new
   * or proved, otherwise the owner the application must prove itself against.
   * The challenge digest is not minted here — a callback has no applicant to
   * hand a code to; the applicant's next owner resolution opens and delivers
   * one, or the pending proof it finds is the one to satisfy.
   */
  private async ownerRaceDetected(
    repository: OnboardingRepository,
    application: ApplicationRow,
  ): Promise<false | { ownerId: string; maskedDestination: string | null; openProof: boolean }> {
    if (application.ownerId !== null) {
      if (await repository.hasPassedProof(application.applicationId)) return false;
      const probe = await repository.probeOwner(application.applicationId);
      return {
        ownerId: application.ownerId,
        maskedDestination: probe?.maskedDestination ?? null,
        openProof: !(await repository.hasPendingProof(application.applicationId)),
      };
    }
    const probe = await repository.probeOwner(application.applicationId);
    if (probe === undefined) return false;
    return { ownerId: probe.ownerId, maskedDestination: probe.maskedDestination, openProof: true };
  }

  private async settleUnpaid(
    repository: OnboardingRepository,
    attempt: AttemptRow,
    status: { outcome: 'pending' | 'failed' | 'expired' | 'uncertain'; reason?: string },
  ): Promise<CallbackOutcome> {
    const application = await repository.lock(attempt.applicationId);
    if (application === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

    const attemptState =
      status.outcome === 'failed'
        ? ('FAILED' as const)
        : status.outcome === 'expired'
          ? ('EXPIRED' as const)
          : status.outcome === 'uncertain'
            ? ('PAYMENT_UNCERTAIN' as const)
            : undefined;
    if (attemptState === undefined) return { kind: 'not_paid', state: attempt.state };
    if (attemptState === 'PAYMENT_UNCERTAIN' && attempt.state !== 'PENDING') {
      return { kind: 'not_paid', state: attempt.state };
    }

    await repository.settleAttempt({
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      state: attemptState,
      reason: status.reason ?? status.outcome,
    });

    // The application follows the attempt, but only while it is still unpaid: a
    // paid application never returns to an unpaid state (doc 15 §7).
    if (application.paidAttemptId === null && application.state === 'PENDING_PAYMENT') {
      const next =
        attemptState === 'FAILED'
          ? ('PAYMENT_FAILED' as const)
          : attemptState === 'EXPIRED'
            ? ('PAYMENT_EXPIRED' as const)
            : ('PAYMENT_UNCERTAIN' as const);
      await repository.transition({
        applicationId: attempt.applicationId,
        expectedRevision: application.revision,
        state: next,
        reason: status.reason ?? status.outcome,
      });
      await repository.recordEvent({
        applicationId: attempt.applicationId,
        fromState: application.state,
        toState: next,
        reason: status.reason ?? status.outcome,
      });
      return { kind: 'not_paid', state: next };
    }
    return { kind: 'not_paid', state: application.state };
  }

  // ============================================================== provisioning

  /**
   * doc 15 §5: one attempt of the one logical provisioning job.
   *
   * Three transactions, and the split is the requirement rather than a
   * convenience:
   *
   *  1. claim — the job is taken with a fresh token and a lease, and the
   *     application moves to `PROVISIONING`, so two runners cannot both start;
   *  2. build — the whole tenant graph in **one** transaction through the
   *     provisioning wrapper, all-or-nothing, with the outbox event and the
   *     eBarimt intent inside it;
   *  3. settle — a failure is recorded in a transaction of its own, because a
   *     `PROVISIONING_FAILED` written inside the rolled-back build would roll
   *     back with it. A success needs no settlement: the wrapper released the
   *     claim as part of the graph.
   *
   * The payment is never taken again, the retry never edits the payment, the
   * owner, the package, the term, the amount, `starts_at` or `expires_at` — the
   * wrapper re-derives every one of them from the rows it locks.
   */
  async provision(
    applicationId: string,
    idempotencyKey: string,
    request: RequestContext,
    options: { manual?: boolean } = {},
  ): Promise<ProvisioningOutcome> {
    const parameters = this.parameters;
    const claimToken = randomUUID();

    const claimed = await this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      let application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      if (application.state === 'PROVISIONED') {
        // Provisioned, and possibly still carrying a claim a crashed process
        // never released (R4 replay): release it and report the hotel.
        if (application.provisionClaimToken !== null) {
          await repository.releaseClaim(applicationId, application.provisionClaimToken);
        }
        return { outcome: 'already', hotelId: application.provisionedHotelId } as const;
      }
      if (
        application.state !== 'PAID_PENDING_PROVISIONING' &&
        application.state !== 'PROVISIONING_FAILED' &&
        application.state !== 'PROVISIONING'
      ) {
        return { outcome: 'blocked', state: application.state } as const;
      }
      const leaseLive =
        application.provisionClaimToken !== null &&
        application.provisionClaimedUntil !== null &&
        application.provisionClaimedUntil.getTime() > uow.serverNow.getTime();
      if (leaseLive) {
        // Somebody else holds it, and their lease has not lapsed.
        return { outcome: 'blocked', state: 'PROVISIONING' } as const;
      }
      if (application.state === 'PROVISIONING') {
        // A crash: claimed, never built, lease expired. The failure is recorded
        // for the attempt that died, then the row is claimed again below.
        const recorded = await repository.settleProvisioningFailure({
          applicationId,
          claimToken: application.provisionClaimToken ?? claimToken,
          reason: 'lease_expired',
          backoffSeconds: 0,
        });
        if (!recorded) throw new ApiError('CONFLICT', 'the application changed concurrently');
        await repository.recordEvent({
          applicationId,
          fromState: 'PROVISIONING',
          toState: 'PROVISIONING_FAILED',
          reason: 'lease_expired',
        });
        application = await repository.lock(applicationId);
        if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
      }
      if (
        options.manual !== true &&
        application.provisionAttempts >= parameters.provisioningMaxAutomaticAttempts
      ) {
        // `ONB-DEC-006`: after five automatic attempts a permissioned operator
        // has to take it on, through `retryProvisioning`.
        return { outcome: 'exhausted', attempts: application.provisionAttempts } as const;
      }
      if (
        options.manual !== true &&
        application.provisionAvailableAt.getTime() > uow.serverNow.getTime()
      ) {
        // The persisted backoff binds a signal exactly as it binds the sweep
        // (remediation 2, finding 3): a claim before it elapsed is refused.
        return { outcome: 'deferred', availableAt: application.provisionAvailableAt } as const;
      }

      // The §3.1 race, discovered at claim time: an owner with this number
      // appeared since the pre-payment probe. Back to proof, on the same
      // payment; nothing is provisioned.
      const race = await this.ownerRaceDetected(repository, application);
      if (race !== false) {
        // Bound to the owner it collided with, and sent back to proof. No proof
        // row is opened here: a proof without a delivered challenge is one
        // nobody can pass (remediation 2, finding 2). The applicant's next
        // owner resolution opens the challenge and delivers it to the owner's
        // stored contact.
        const moved = await repository.transition({
          applicationId,
          expectedRevision: application.revision,
          state: 'PAID_OWNER_VERIFICATION_REQUIRED',
          reason: 'existing_owner_detected',
          ownerId: race.ownerId,
        });
        if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
        await repository.recordEvent({
          applicationId,
          fromState: application.state,
          toState: 'PAID_OWNER_VERIFICATION_REQUIRED',
          reason: 'existing_owner_detected',
        });
        return { outcome: 'blocked', state: 'PAID_OWNER_VERIFICATION_REQUIRED' } as const;
      }

      const taken = await repository.claimProvisioning({
        applicationId,
        expectedRevision: application.revision,
        claimToken,
        leaseSeconds: parameters.provisioningLeaseSeconds,
      });
      if (!taken) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await repository.recordEvent({
        applicationId,
        fromState: application.state,
        toState: 'PROVISIONING',
        reason: 'provisioning_started',
        detail: { attempt: application.provisionAttempts + 1, manual: options.manual === true },
      });
      return {
        outcome: 'claimed',
        application,
        attempts: application.provisionAttempts + 1,
      } as const;
    });

    if (claimed.outcome === 'already') {
      return { kind: 'already_provisioned', hotelId: claimed.hotelId as string };
    }
    if (claimed.outcome === 'blocked') return { kind: 'blocked', state: claimed.state };
    if (claimed.outcome === 'exhausted') {
      return { kind: 'exhausted', attempts: claimed.attempts };
    }
    if (claimed.outcome === 'deferred')
      return { kind: 'deferred', availableAt: claimed.availableAt };

    // The owner's resealed identifier and the activation link are minted here,
    // outside the build transaction, because they need the key-management port.
    // Only digests and ciphertext cross into the database; the plaintexts exist
    // in this process and nowhere else.
    const application = claimed.application;
    const owner =
      application.ownerId === null
        ? await this.resealOwnerIdentifier(applicationId, request)
        : undefined;
    const existingAccount = application.existingAccountId !== null;
    const activationId = randomUUID();
    const link = existingAccount
      ? undefined
      : await this.mintActivationLink(activationId, parameters.activationTtlSeconds);

    try {
      const hotelId = await this.inOnboardingScope(applicationId, request, async (uow) => {
        const result = await uow.query<{ hotel_id: string }>(
          `SELECT platform.provision_paid_hotel($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
              AS hotel_id`,
          [
            applicationId,
            idempotencyKey,
            owner?.ownerId ?? null,
            owner === undefined ? null : Buffer.from(owner.sealed.ciphertext),
            owner === undefined ? null : Buffer.from(owner.sealed.wrappedDek),
            owner?.sealed.keyVersion ?? null,
            activationId,
            link?.tokenHash ?? null,
            link?.keyVersion ?? null,
            link?.expiresAt ?? null,
            link === undefined ? null : Buffer.from(link.sealed.ciphertext),
            link === undefined ? null : Buffer.from(link.sealed.wrappedDek),
            link?.sealed.keyVersion ?? null,
            // The fence: the boundary runs only under this claim and its
            // unexpired lease (remediation 2, finding 3).
            claimToken,
          ],
        );
        const id = result.rows[0]?.hotel_id;
        if (id === undefined) throw new Error('provisioning returned no hotel');
        return id;
      });

      // Everything after this line runs against a hotel that exists. A failure
      // here is reported as itself and never as a failed provisioning: the graph
      // committed, its event committed with it, and this row is already
      // `PROVISIONED` with its claim released.
      await this.recordSettlement(applicationId, hotelId, claimed.attempts, request).catch(
        () => undefined,
      );
      return { kind: 'provisioned', hotelId };
    } catch (error) {
      const failure = classifyFailure(error);
      const attempts = await this.recordProvisioningFailure(
        applicationId,
        claimToken,
        claimed.attempts,
        failure,
        request,
      );
      if (failure.ownerAppeared) {
        return { kind: 'blocked', state: 'PAID_OWNER_VERIFICATION_REQUIRED' };
      }
      return { kind: 'failed', reason: failure.reason, attempts };
    }
  }

  /**
   * The identifier the application sealed against itself, decrypted and
   * resealed against the owner row the boundary is about to create. The AAD
   * binds each ciphertext to its own row, so a copy would not decrypt.
   */
  private async resealOwnerIdentifier(
    applicationId: string,
    request: RequestContext,
  ): Promise<{
    ownerId: string;
    sealed: { ciphertext: Uint8Array; wrappedDek: Uint8Array; keyVersion: string };
  }> {
    const sealed = await this.inOnboardingScope(applicationId, request, (uow) =>
      new OnboardingRepository(uow).sealedIdentifier(applicationId),
    );
    if (sealed === undefined) throw new ApiError('NOT_FOUND', 'not found');
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
        rowRef: applicationId,
      },
    );
    const ownerId = randomUUID();
    const resealed = await encryptValue(this.deps.keys, 'pii.subscription_owner', plaintext, {
      table: 'subscription_owner',
      column: 'identifier_ciphertext',
      rowRef: ownerId,
    });
    return { ownerId, sealed: resealed };
  }

  private async mintActivationLink(
    activationId: string,
    ttlSeconds: number,
  ): Promise<{
    tokenHash: string;
    keyVersion: string;
    expiresAt: Date;
    sealed: { ciphertext: Uint8Array; wrappedDek: Uint8Array; keyVersion: string };
  }> {
    const issued = await this.tokens.issue('hotel_admin_activation', ACTIVATION_SUBJECT);
    const sealed = await encryptValue(this.deps.keys, 'auth.delivery_secret', issued.token, {
      table: 'activation_delivery',
      column: 'secret_ciphertext',
      rowRef: activationId,
    });
    return {
      tokenHash: issued.tokenHash,
      keyVersion: issued.keyVersion,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      sealed,
    };
  }

  /** The job's own post-commit record: which attempt built the hotel. */
  private async recordSettlement(
    applicationId: string,
    hotelId: string,
    attempt: number,
    request: RequestContext,
  ): Promise<void> {
    await this.inOnboardingScope(applicationId, request, async (uow) => {
      await new OnboardingRepository(uow).recordEvent({
        applicationId,
        fromState: 'PROVISIONED',
        toState: 'PROVISIONED',
        reason: 'provisioning_settled',
        detail: { hotelId, attempt },
      });
    });
  }

  private async recordProvisioningFailure(
    applicationId: string,
    claimToken: string,
    attempt: number,
    failure: { reason: string; ownerAppeared: boolean },
    request: RequestContext,
  ): Promise<number> {
    const parameters = this.parameters;
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) return 0;
      if (application.state !== 'PROVISIONING' || application.provisionClaimToken !== claimToken) {
        return application.provisionAttempts;
      }

      // Recorded in a transaction of its own, fenced on the claim, with a real
      // persisted backoff: the row is not due again until it has elapsed.
      const settled = await repository.settleProvisioningFailure({
        applicationId,
        claimToken,
        reason: failure.reason,
        backoffSeconds: backoffSeconds(
          attempt,
          parameters.provisioningRetryBackoffSeconds,
          parameters.provisioningRetryBackoffCeilingSeconds,
        ),
      });
      if (!settled) return application.provisionAttempts;
      await repository.recordEvent({
        applicationId,
        fromState: 'PROVISIONING',
        toState: 'PROVISIONING_FAILED',
        reason: failure.reason,
        // The error's *name*, never its message: a driver message can carry a
        // column value, and a value from this graph is a registration number.
        detail: { errorName: failure.reason, attempt },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.provisioning.failed',
        outcome: 'failed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        reason: failure.reason,
        payload: { attempts: application.provisionAttempts },
      });

      if (failure.ownerAppeared) {
        // The boundary refused because an owner with this number now exists:
        // back to proof, on the same payment, bound to that owner so the
        // challenge can reach its stored contact (remediation 2, finding 2).
        const failed = await repository.lock(applicationId);
        if (failed !== undefined) {
          const collided = await repository.probeOwner(applicationId);
          await repository.transition({
            applicationId,
            expectedRevision: failed.revision,
            state: 'PAID_OWNER_VERIFICATION_REQUIRED',
            reason: 'existing_owner_detected',
            ...(collided === undefined ? {} : { ownerId: collided.ownerId }),
          });
          await repository.recordEvent({
            applicationId,
            fromState: 'PROVISIONING_FAILED',
            toState: 'PAID_OWNER_VERIFICATION_REQUIRED',
            reason: 'existing_owner_detected',
          });
        }
      }
      return application.provisionAttempts;
    });
  }

  /**
   * R3: the sweep. Every application whose job is due — paid and unclaimed,
   * failed and past its backoff, or left behind by a dead process — is claimed
   * and run, each in its own transactions.
   */
  async provisionDue(limit = 32): Promise<SweepOutcome> {
    const request: RequestContext = { correlationId: `provision-sweep-${randomSuffix()}` };
    const due = await this.inOnboardingScope(undefined, request, (uow) =>
      pendingProvisioningApplications(uow, limit, this.parameters.provisioningMaxAutomaticAttempts),
    );
    let claimed = 0;
    let provisioned = 0;
    let failed = 0;
    for (const applicationId of due) {
      const outcome = await this.provisionOne(applicationId, request);
      if (outcome.kind === 'provisioned' || outcome.kind === 'failed') claimed += 1;
      if (outcome.kind === 'exhausted') claimed += 1;
      if (outcome.kind === 'already_provisioned') claimed += 1;
      if (outcome.kind === 'provisioned') provisioned += 1;
      if (outcome.kind === 'failed') failed += 1;
    }
    return { claimed, provisioned, failed };
  }

  /** One application, as the worker runs it — from a signal or from the sweep. */
  provisionOne(applicationId: string, request?: RequestContext): Promise<ProvisioningOutcome> {
    return this.provision(
      applicationId,
      derivedIdempotencyKey('onboarding.provision.job', applicationId),
      request ?? { correlationId: `provision-signal-${randomSuffix()}` },
    );
  }

  /**
   * doc 15 §5: the manual retry, for an operator holding
   * `ONBOARDING_PROVISION_RETRY` and a recent step-up — evaluated by the Phase
   * 04 pipeline in the Operation realm, and audited.
   *
   * The retry carries no parameters at all: there is nothing an operator could
   * pass that would change the payment, the owner, the package, the term, the
   * amount or the dates, because the wrapper re-derives every one of them.
   */
  async retryProvisioning(
    applicationId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ProvisioningOutcome> {
    const accountId = actor.principal.accountId;
    await this.runOperationCommand(
      actor,
      'operation.onboarding_provision_retry',
      { targetType: 'onboarding_application', targetRef: applicationId },
      request,
      async (uow) => {
        const application = await new OnboardingRepository(uow).byId(applicationId);
        if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (
          application.state !== 'PROVISIONING_FAILED' &&
          application.state !== 'PAID_PENDING_PROVISIONING' &&
          application.state !== 'PROVISIONING'
        ) {
          throw new ApiError('CONFLICT', 'this application is not awaiting provisioning');
        }
        await recordPlatformAudit(uow, {
          action: 'onboarding.provisioning.retry_requested',
          outcome: 'allowed',
          targetType: 'onboarding_application',
          targetRef: applicationId,
          payload: { accountId, attempts: application.provisionAttempts },
        });
      },
    );
    return this.provision(
      applicationId,
      derivedIdempotencyKey('onboarding.provision.manual', applicationId, accountId),
      { ...request, accountId },
      { manual: true },
    );
  }

  /**
   * doc 15 §4.1: closes an onboarding reconciliation case.
   *
   * `SUBSCRIPTION_PAYMENT_RECONCILE` plus a recent step-up, in the Operation
   * realm. The only thing this can write is one of doc 14 §4.2's four terminal
   * outcomes, the account, the mandatory note and the mandatory provider, bank
   * or finance reference: no parameter exists for a package, a term, an
   * entitlement, a provisioning result or a date (`OPS-DEC-017`).
   */
  async closeReconciliation(
    input: {
      applicationId: string;
      attemptId: string;
      outcome: ReconciliationOutcome;
      reason: string;
      /** doc 14 §4.2: the provider, bank or finance reference. Mandatory. */
      reference: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<void> {
    const accountId = actor.principal.accountId;
    await this.runOperationCommand(
      actor,
      'operation.subscription_payment_reconcile',
      { targetType: 'onboarding_payment_attempt', targetRef: input.attemptId },
      request,
      async (uow) => {
        const repository = new OnboardingRepository(uow);
        const attempt = await repository.attemptById(input.attemptId);
        if (attempt === undefined || attempt.applicationId !== input.applicationId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (attempt.state !== 'PAID_REQUIRES_RECONCILIATION') {
          throw new ApiError('CONFLICT', 'this payment is not in the reconciliation queue');
        }
        const closed = await repository.closeReconciliation({
          attemptId: input.attemptId,
          expectedRevision: attempt.revision,
          outcome: input.outcome,
          accountId,
          reason: input.reason,
          reference: input.reference,
        });
        if (!closed) throw new ApiError('CONFLICT', 'the case changed concurrently');
        await recordPlatformAudit(uow, {
          action: 'onboarding.payment.reconciled',
          outcome: 'allowed',
          targetType: 'onboarding_payment_attempt',
          targetRef: input.attemptId,
          payload: { outcome: input.outcome, accountId, reference: input.reference },
        });
      },
    );
  }

  // ======================================================= activation delivery

  /**
   * doc 15 §5: drains the activation-delivery queue.
   *
   * The same leased design the password-reset intake earned in Phase 04: a claim
   * token and a lease make ownership real, settlement is a compare-and-set on
   * that token, a transient failure is retried with capped backoff, and an
   * exhausted entry is dead-lettered rather than retried forever.
   */
  async drainActivationDeliveries(limit = 32): Promise<number> {
    const request: RequestContext = { correlationId: `activation-drain-${randomSuffix()}` };
    const candidates = await this.inOperationScope(request, (uow) =>
      pendingActivationDeliveries(uow, limit),
    );

    let processed = 0;
    for (const candidate of candidates) {
      const claimed = await this.claimDelivery(candidate.hotelId, candidate.deliveryId, request);
      if (claimed === undefined) continue;
      processed += 1;
      await this.deliverActivation(candidate.hotelId, claimed, request);
    }
    return processed;
  }

  private async claimDelivery(
    hotelId: string,
    deliveryId: string,
    request: RequestContext,
  ): Promise<ClaimedDelivery | undefined> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimToken = randomUUID();
      const result = await uow.query<{
        delivery_id: string;
        activation_id: string;
        email_normalized: string;
        attempts: number;
        expires_at: Date;
        c: Buffer | null;
        d: Buffer | null;
        v: string | null;
        expired: boolean;
      }>(
        `UPDATE platform.activation_delivery
            SET state = 'CLAIMED', claim_token = $2,
                claimed_until = now() + make_interval(secs => $3),
                attempts = attempts + 1
          WHERE hotel_id = $1 AND delivery_id = $4
            AND state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])
            AND available_at <= now()
            AND (claimed_until IS NULL OR claimed_until < now())
          RETURNING delivery_id, activation_id, email_normalized, attempts, expires_at,
                    secret_ciphertext AS c, secret_wrapped_dek AS d, secret_key_version AS v,
                    (expires_at <= now()) AS expired`,
        [hotelId, claimToken, this.parameters.activationLeaseSeconds, deliveryId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        deliveryId: row.delivery_id,
        claimToken,
        email: row.email_normalized,
        activationId: row.activation_id,
        attempts: Number(row.attempts),
        expiresAt: row.expires_at,
        secret:
          row.c === null || row.d === null || row.v === null
            ? null
            : {
                ciphertext: Uint8Array.from(row.c),
                wrappedDek: Uint8Array.from(row.d),
                keyVersion: row.v,
              },
        expired: row.expired,
      };
    });
  }

  private async deliverActivation(
    hotelId: string,
    claimed: ClaimedDelivery,
    request: RequestContext,
  ): Promise<void> {
    const parameters = this.parameters;
    if (claimed.expired || claimed.secret === null) {
      await this.settleDelivery(hotelId, claimed, 'DEAD_LETTER', 'expired_or_empty', request);
      return;
    }

    let sent: { ok: boolean } = { ok: false };
    try {
      const token = await decryptValue(this.deps.keys, 'auth.delivery_secret', claimed.secret, {
        table: 'activation_delivery',
        column: 'secret_ciphertext',
        rowRef: claimed.activationId,
      });
      sent = await this.deps.notifications.send(
        {
          kind: 'staff_invitation',
          hotelId,
          invitationId: claimed.activationId,
          emailNormalized: claimed.email,
          expiresAt: claimed.expiresAt,
          token,
        },
        portContext(request),
      );
    } catch {
      sent = { ok: false };
    }
    if (sent.ok) {
      await this.settleDelivery(hotelId, claimed, 'SENT', 'delivered', request);
      return;
    }
    const exhausted = claimed.attempts >= parameters.activationDeliveryMaxAttempts;
    await this.settleDelivery(
      hotelId,
      claimed,
      exhausted ? 'DEAD_LETTER' : 'PENDING',
      exhausted ? 'delivery_exhausted' : 'delivery_failed',
      request,
    );
  }

  private async settleDelivery(
    hotelId: string,
    claimed: { deliveryId: string; claimToken: string; attempts: number },
    state: 'SENT' | 'PENDING' | 'DEAD_LETTER',
    reason: string,
    request: RequestContext,
  ): Promise<void> {
    const parameters = this.parameters;
    const backoff = backoffSeconds(
      claimed.attempts,
      parameters.activationRetryBackoffSeconds,
      parameters.activationRetryBackoffCeilingSeconds,
    );
    await this.inHotelScope(hotelId, request, async (uow) => {
      await uow.query(
        `UPDATE platform.activation_delivery
            SET state = $3,
                claim_token = NULL,
                claimed_until = NULL,
                delivered_at = CASE WHEN $3 = 'SENT' THEN now() ELSE delivered_at END,
                available_at = CASE WHEN $3 = 'PENDING'
                                    THEN now() + make_interval(secs => $5)
                                    ELSE available_at END,
                last_error = $4,
                secret_ciphertext = CASE WHEN $3 = 'PENDING' THEN secret_ciphertext ELSE NULL END,
                secret_wrapped_dek = CASE WHEN $3 = 'PENDING' THEN secret_wrapped_dek ELSE NULL END,
                secret_key_version = CASE WHEN $3 = 'PENDING' THEN secret_key_version ELSE NULL END
          WHERE hotel_id = $1 AND delivery_id = $2 AND claim_token = $6`,
        [hotelId, claimed.deliveryId, state, reason, backoff, claimed.claimToken],
      );
    });
  }
}

interface ClaimedDelivery {
  deliveryId: string;
  claimToken: string;
  email: string;
  activationId: string;
  attempts: number;
  expiresAt: Date;
  secret: { ciphertext: Uint8Array; wrappedDek: Uint8Array; keyVersion: string } | null;
  expired: boolean;
}

/** The fixed subject an activation digest is bound to. */
export const ACTIVATION_SUBJECT = 'hotel_admin_activation';

function randomSuffix(): string {
  return randomUUID().slice(0, 8);
}

function callbackRejection(error: { kind: string; providerCode?: string; field?: string }): string {
  switch (error.kind) {
    case 'INVALID_SIGNATURE':
      return 'bad_signature';
    case 'MISMATCH':
      return `${error.field ?? 'reference'}_mismatch`;
    case 'REJECTED':
      return error.providerCode === 'UNKNOWN_REFERENCE'
        ? 'unknown_reference'
        : error.providerCode === 'PROVIDER_MISMATCH'
          ? 'provider_mismatch'
          : 'provider_rejected';
    case 'DISABLED':
      return 'gateway_disabled';
    default:
      return 'gateway_unavailable';
  }
}

/** The error's name and whether the boundary refused for the §3.1 race. */
function classifyFailure(error: unknown): { reason: string; ownerAppeared: boolean } {
  const code = (error as { code?: string }).code;
  if (code === OWNER_APPEARED) return { reason: 'existing_owner_detected', ownerAppeared: true };
  // A database refusal is named by its SQLSTATE, never by its message: the
  // message may carry a constraint name and, through it, a hint about the row.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    return { reason: `pg:${code}`, ownerAppeared: false };
  }
  return { reason: error instanceof Error ? error.name : 'unknown', ownerAppeared: false };
}

export { ownerProofSubject };
export type { PaymentProvider };
