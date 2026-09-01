import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { decryptValue, encryptValue } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase, backoffSeconds } from './onboarding-context';
import type { AttemptRow } from '../repositories/onboarding.repository';
import { OnboardingRepository, resolvePaymentAttempt } from '../repositories/onboarding.repository';
import type { PaymentProvider, RawCallback } from '../contracts/payment-gateway.port';
import { pendingActivationDeliveries } from '../repositories/subscription.repository';

/**
 * Payment confirmation, durable provisioning and the first Hotel Admin's
 * activation delivery (doc 15 §4, §5; `ONB-DEC-001`, `ONB-DEC-006`,
 * `ONB-DEC-008`).
 *
 * The order is the one doc 15 §5 states and is not negotiable: the payment
 * success is made immutable **first**, and only then does one logical
 * provisioning job build the tenant graph in a single transaction.
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
  | { readonly kind: 'blocked'; readonly state: string };

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
   *  2. the attempt it names is locked, so two callbacks serialise;
   *  3. the provider's own status is re-queried — a callback claiming success is
   *     never sufficient (§4, "тодорхойгүй payment-ийг автоматаар амжилттай гэж
   *     үзэхгүй");
   *  4. provider, merchant reference, amount and currency are matched against
   *     the stored attempt, not against the callback's own claims;
   *  5. the application row is locked and the canonical transition applied once.
   *
   * A duplicate callback finds the attempt already terminal and returns the
   * first result. A second provider paying the same application finds the
   * application already paid and produces a reconciliation case, never a second
   * subscription (`ONB-DEC-008`).
   */
  async applyCallback(callback: RawCallback, request: RequestContext): Promise<CallbackOutcome> {
    const gateway = this.deps.gateways.gateway(callback.provider);
    const verified = await gateway.verifyCallback(callback);
    if (!verified.verified) {
      return { kind: 'rejected', reason: verified.reason };
    }

    // The provider's own answer, fetched before anything is locked. A callback
    // is a notification that something may have changed, not evidence of what.
    const status = await gateway.queryStatus(callback.providerInvoiceId);

    // A callback carries no applicant secret, so the scope comes from the
    // reference it names — resolved through the definer wrapper, after the
    // signature has already been verified above. Everything after this point
    // runs under that scope and through the ordinary policies.
    const applicationId = await this.inOnboardingScope(undefined, request, (uow) =>
      resolvePaymentAttempt(uow, callback.provider, callback.providerInvoiceId),
    );
    if (applicationId === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      return this.settleAttempt(uow, repository, callback, status);
    });
  }

  private async settleAttempt(
    uow: UnitOfWork,
    repository: OnboardingRepository,
    callback: RawCallback,
    status: Awaited<
      ReturnType<ReturnType<OnboardingDependencies['gateways']['gateway']>['queryStatus']>
    >,
  ): Promise<CallbackOutcome> {
    const attempt = await repository.lockAttemptByInvoice(
      callback.provider,
      callback.providerInvoiceId,
    );
    if (attempt === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

    // A terminal attempt is a duplicate callback: return the first result rather
    // than transitioning anything a second time.
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
    // attempt (doc 15 §4). Every mismatch is the same refusal: a callback that
    // does not match the invoice is not this invoice's callback.
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
    // becomes a reconciliation case rather than a second subscription.
    //
    // Two different facts lead there, and the second is not the first arriving
    // late. An attempt that was superseded or failed *cannot* become `PAID` —
    // doc 15 §4.1 lets a late success resurrect only an expired attempt, and the
    // transition guard enforces exactly that — so a provider that collected on a
    // cancelled or failed invoice is money the platform holds against no live
    // attempt, whether or not the application itself was ever paid. Both are
    // recorded with the reason that is actually true, because an operator
    // closing the case is entitled to know which one they are looking at.
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
    // callback blocks provisioning without touching the payment.
    const ownerRace =
      application.ownerId !== null && !(await repository.hasPassedProof(attempt.applicationId))
        ? await repository.ownerHoldsOtherHotel(attempt.applicationId)
        : false;
    const next = ownerRace ? 'PAID_OWNER_VERIFICATION_REQUIRED' : 'PAID_PENDING_PROVISIONING';

    const moved = await repository.transition({
      applicationId: attempt.applicationId,
      expectedRevision: application.revision,
      state: next,
      reason: 'payment_confirmed',
      paidAttemptId: attempt.attemptId,
      paymentConfirmedAt: status.confirmedAt,
    });
    if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
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
   * doc 15 §5: the one logical provisioning job.
   *
   * Three transactions, and the split is the requirement rather than a
   * convenience:
   *
   *  1. claim — `PAID_PENDING_PROVISIONING → PROVISIONING`, so two runners
   *     cannot both start;
   *  2. build — the whole tenant graph in **one** transaction through the
   *     provisioning wrapper, all-or-nothing;
   *  3. record the failure — in a transaction of its own, because a
   *     `PROVISIONING_FAILED` written inside the rolled-back inner transaction
   *     rolls back with it and leaves no trace of the attempt.
   *
   * The payment is never taken again, the retry never edits the payment, the
   * owner, the package, the term, the amount, `starts_at` or `expires_at` — the
   * wrapper re-derives every one of them from the rows it locks — and the
   * unique keys make a second hotel, subscription or Primary membership
   * impossible even under a perfectly simultaneous retry.
   */
  async provision(
    applicationId: string,
    idempotencyKey: string,
    request: RequestContext,
  ): Promise<ProvisioningOutcome> {
    const parameters = this.parameters;

    const claimed = await this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) throw new ApiError('NOT_FOUND', 'not found');

      if (application.state === 'PROVISIONED') {
        return { outcome: 'already', hotelId: application.provisionedHotelId } as const;
      }
      if (
        application.state !== 'PAID_PENDING_PROVISIONING' &&
        application.state !== 'PROVISIONING_FAILED'
      ) {
        return { outcome: 'blocked', state: application.state } as const;
      }
      if (
        application.state === 'PROVISIONING_FAILED' &&
        application.provisionAttempts >= parameters.provisioningMaxAutomaticAttempts
      ) {
        // `ONB-DEC-006`: after five automatic attempts a permissioned operator
        // has to take it on, through `retryProvisioning` below.
        return { outcome: 'exhausted', attempts: application.provisionAttempts } as const;
      }

      const moved = await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: 'PROVISIONING',
        reason: 'provisioning_started',
        bumpProvisionAttempts: true,
      });
      if (!moved) throw new ApiError('CONFLICT', 'the application changed concurrently');
      await repository.recordEvent({
        applicationId,
        fromState: application.state,
        toState: 'PROVISIONING',
        reason: 'provisioning_started',
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

    // The activation link is minted here, outside the provisioning transaction,
    // because it needs the key-management port. Only its digest and its sealed
    // ciphertext cross into the database; the plaintext exists in this process
    // and nowhere else, and is dropped as soon as the transaction commits.
    const existingAccount = claimed.application.existingAccountId !== null;
    const activationId = randomUUID();
    const link = existingAccount
      ? undefined
      : await this.mintActivationLink(activationId, parameters.activationTtlSeconds);

    try {
      const hotelId = await this.inOnboardingScope(applicationId, request, async (uow) => {
        const result = await uow.query<{ hotel_id: string }>(
          `SELECT platform.provision_paid_hotel($1,$2,$3,$4,$5,$6,$7,$8,$9) AS hotel_id`,
          [
            applicationId,
            idempotencyKey,
            activationId,
            link?.tokenHash ?? null,
            link?.keyVersion ?? null,
            link?.expiresAt ?? null,
            link === undefined ? null : Buffer.from(link.sealed.ciphertext),
            link === undefined ? null : Buffer.from(link.sealed.wrappedDek),
            link?.sealed.keyVersion ?? null,
          ],
        );
        const id = result.rows[0]?.hotel_id;
        if (id === undefined) throw new Error('provisioning returned no hotel');
        return id;
      });

      // The outbox event is a separate, tenant-scoped transaction. It is not
      // part of the all-or-nothing graph: doc 15 §5 puts the activation delivery
      // outside it precisely so a delivery problem cannot roll a hotel back.
      await this.inHotelScope(hotelId, request, async (uow) => {
        await appendOutboxEvent(uow, {
          aggregateType: 'hotel',
          aggregateId: hotelId,
          eventType: 'onboarding.hotel.provisioned',
          payload: { applicationId, activationRequired: !existingAccount },
        });
      });

      return { kind: 'provisioned', hotelId };
    } catch (error) {
      // Recorded in a transaction of its own. The inner one rolled back, taking
      // every partial entity with it — and it would have taken this record too.
      const reason = error instanceof Error ? error.name : 'unknown';
      const attempts = await this.recordProvisioningFailure(applicationId, reason, error, request);
      return { kind: 'failed', reason, attempts };
    }
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

  private async recordProvisioningFailure(
    applicationId: string,
    reason: string,
    error: unknown,
    request: RequestContext,
  ): Promise<number> {
    return this.inOnboardingScope(applicationId, request, async (uow) => {
      const repository = new OnboardingRepository(uow);
      const application = await repository.lock(applicationId);
      if (application === undefined) return 0;
      if (application.state !== 'PROVISIONING') return application.provisionAttempts;

      await repository.transition({
        applicationId,
        expectedRevision: application.revision,
        state: 'PROVISIONING_FAILED',
        reason,
      });
      await repository.recordEvent({
        applicationId,
        fromState: 'PROVISIONING',
        toState: 'PROVISIONING_FAILED',
        reason,
        // The error's *name*, never its message: a driver message can carry a
        // column value, and a value from this graph is a registration number.
        detail: { errorName: error instanceof Error ? error.name : 'unknown' },
      });
      await recordPlatformAudit(uow, {
        action: 'onboarding.provisioning.failed',
        outcome: 'failed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        reason,
        payload: { attempts: application.provisionAttempts },
      });
      return application.provisionAttempts;
    });
  }

  /**
   * `ONB-DEC-006`: the automatic retry loop, with exponential backoff.
   *
   * Bounded by the parameter set, and the bound is the point: an application
   * that has failed five times stops being retried and starts being visible to
   * an operator who holds `ONBOARDING_PROVISION_RETRY`.
   */
  async provisionWithRetries(
    applicationId: string,
    idempotencyKey: string,
    request: RequestContext,
  ): Promise<ProvisioningOutcome> {
    const parameters = this.parameters;
    let last: ProvisioningOutcome = { kind: 'blocked', state: 'unknown' };
    for (let attempt = 1; attempt <= parameters.provisioningMaxAutomaticAttempts; attempt += 1) {
      last = await this.provision(applicationId, idempotencyKey, request);
      if (last.kind !== 'failed') return last;
      // The delay is computed but not slept through here: the caller decides
      // whether it is a worker with time to wait or a request that must answer
      // now. Recording it keeps the backoff a property of the design rather than
      // of whoever happens to call.
      void backoffSeconds(
        attempt,
        parameters.provisioningRetryBackoffSeconds,
        parameters.provisioningRetryBackoffCeilingSeconds,
      );
    }
    return last;
  }

  /**
   * doc 15 §5: the manual retry, for an operator holding
   * `ONBOARDING_PROVISION_RETRY` and a recent step-up.
   *
   * Both are checked above this layer. What is enforced here is that the retry
   * carries no parameters at all — there is nothing an operator could pass that
   * would change the payment, the owner, the package, the term, the amount or
   * the dates, because the wrapper re-derives every one of them from the rows it
   * locks.
   */
  async retryProvisioning(
    applicationId: string,
    accountId: string,
    request: RequestContext,
  ): Promise<ProvisioningOutcome> {
    const idempotencyKey = derivedIdempotencyKey(
      'onboarding.provision.manual',
      applicationId,
      accountId,
    );
    await this.inOperationScope({ ...request, accountId }, async (uow) => {
      await recordPlatformAudit(uow, {
        action: 'onboarding.provisioning.retry_requested',
        outcome: 'allowed',
        targetType: 'onboarding_application',
        targetRef: applicationId,
        payload: { accountId },
      });
    });
    return this.provision(applicationId, idempotencyKey, { ...request, accountId });
  }

  // ======================================================= activation delivery

  /**
   * doc 15 §5: drains the activation-delivery queue.
   *
   * The same leased design the password-reset intake earned in Phase 04: a claim
   * token and a lease make ownership real, settlement is a compare-and-set on
   * that token, a transient failure is retried with capped backoff, and an
   * exhausted entry is dead-lettered rather than retried forever.
   *
   * A lost acknowledgement costs a repeated provider attempt, never a second
   * link: the delivery id is stable, so the provider recognises the repeat.
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
  ): Promise<
    | {
        deliveryId: string;
        claimToken: string;
        email: string;
        activationId: string;
        attempts: number;
        expiresAt: Date;
        secret: { ciphertext: Uint8Array; wrappedDek: Uint8Array; keyVersion: string } | null;
        expired: boolean;
      }
    | undefined
  > {
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
    claimed: {
      deliveryId: string;
      claimToken: string;
      email: string;
      activationId: string;
      attempts: number;
      expiresAt: Date;
      secret: { ciphertext: Uint8Array; wrappedDek: Uint8Array; keyVersion: string } | null;
      expired: boolean;
    },
    request: RequestContext,
  ): Promise<void> {
    const parameters = this.parameters;

    // An expired or secret-less entry has nothing deliverable left. It is
    // dead-lettered rather than sent: a link that has already lapsed would
    // simply be refused on redemption, and sending it is a wasted message that
    // tells a recipient nothing true.
    if (claimed.expired || claimed.secret === null) {
      await this.settleDelivery(hotelId, claimed, 'DEAD_LETTER', 'expired_or_empty', request);
      return;
    }

    try {
      const token = await decryptValue(this.deps.keys, 'auth.delivery_secret', claimed.secret, {
        table: 'activation_delivery',
        column: 'secret_ciphertext',
        rowRef: claimed.activationId,
      });
      await this.deps.notifications.deliver({
        kind: 'staff_invitation',
        hotelId,
        invitationId: claimed.activationId,
        emailNormalized: claimed.email,
        expiresAt: claimed.expiresAt,
        token,
      });
      await this.settleDelivery(hotelId, claimed, 'SENT', 'delivered', request);
    } catch {
      const exhausted = claimed.attempts >= parameters.activationDeliveryMaxAttempts;
      await this.settleDelivery(
        hotelId,
        claimed,
        exhausted ? 'DEAD_LETTER' : 'PENDING',
        exhausted ? 'delivery_exhausted' : 'delivery_failed',
        request,
      );
    }
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
      // Compare-and-set on the claim token: a worker whose lease expired and
      // whose entry another worker has since taken cannot settle it.
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

/** The fixed subject an activation digest is bound to. */
export const ACTIVATION_SUBJECT = 'hotel_admin_activation';

function randomSuffix(): string {
  return randomUUID().slice(0, 8);
}

export type { PaymentProvider };
