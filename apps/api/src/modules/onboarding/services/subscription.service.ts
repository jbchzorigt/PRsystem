import type { PackageCode } from '@prsystem/authz';
import { isPackageCode } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import { mnt } from '@prsystem/money';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase } from './onboarding-context';
import type { IntentRow, SubscriptionRow } from '../repositories/subscription.repository';
import {
  SubscriptionRepository,
  dueUpgradeCandidates,
} from '../repositories/subscription.repository';
import type { PaymentProvider, RawCallback } from '../contracts/payment-gateway.port';
import { isPaymentProvider } from '../contracts/payment-gateway.port';
import {
  isTermMonths,
  isUpgrade,
  packageRank,
  quoteTerm,
  quoteUpgrade,
  renewalFloor,
  vatInsideInclusive,
} from '../domain/pricing';
import {
  deriveState,
  expiryFrom,
  higherRenewalEffectiveAt,
  listingEligible,
  nextServiceMonthBoundary,
  remainingWholeServiceMonths,
  renewFrom,
} from '../domain/lifecycle';

/**
 * Subscription renewal, upgrade and the service-month boundary (doc 17,
 * `LIFE-DEC-001`…`007`; doc 14 `OPS-DEC-006`, `OPS-DEC-007`).
 *
 * Everything money touches runs the same way: lock the subscription row, read
 * the billing revision, decide, then apply with that revision as a
 * compare-and-set. A callback and the boundary worker take the same lock and
 * compete for the same revision, so exactly one of them applies an entitlement
 * and the other finds zero rows and stops.
 */

export interface QuoteResult {
  readonly intentId: string;
  readonly providerInvoiceId: string;
  readonly checkoutUrl: string;
  readonly amountMnt: string;
  readonly vatAmountMnt: string;
  readonly targetPackage: PackageCode;
  readonly effectiveAt?: string;
}

export type BillingCallbackOutcome =
  | { readonly kind: 'renewed'; readonly expiresAt: string }
  | { readonly kind: 'upgrade_pending'; readonly effectiveAt: string }
  | { readonly kind: 'upgrade_applied'; readonly effectivePackage: PackageCode }
  | { readonly kind: 'replay' }
  | { readonly kind: 'requires_reconciliation'; readonly intentId: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'not_paid'; readonly state: string };

export class SubscriptionService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  // ================================================================ read model

  /** The authoritative row, plus the state and listing truth derived from it. */
  async status(
    hotelId: string,
    request: RequestContext,
  ): Promise<
    | {
        subscriptionId: string;
        effectivePackage: PackageCode;
        packageFloor: PackageCode;
        pendingUpgradePackage: PackageCode | null;
        pendingUpgradeEffectiveAt: Date | null;
        startsAt: Date;
        expiresAt: Date;
        graceExpiresAt: Date;
        state: string;
        listingEligible: boolean;
        billingRevision: number;
      }
    | undefined
  > {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const row = await repository.current();
      if (row === undefined) return undefined;
      const facts = {
        hotelId,
        effectivePackage: row.effectivePackage,
        expiresAt: row.expiresAt,
        suspendedAt: row.suspendedAt,
      };
      return {
        subscriptionId: row.subscriptionId,
        effectivePackage: row.effectivePackage,
        packageFloor: row.packageFloor,
        pendingUpgradePackage: row.pendingUpgradePackage,
        pendingUpgradeEffectiveAt: row.pendingUpgradeEffectiveAt,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        graceExpiresAt: new Date(row.expiresAt.getTime() + 48 * 60 * 60 * 1000),
        state: deriveState(facts, uow.serverNow),
        listingEligible: listingEligible(facts, uow.serverNow),
        billingRevision: row.billingRevision,
      };
    });
  }

  // ================================================================== renewal

  /**
   * doc 17 §3: quotes a renewal.
   *
   * The floor is the higher of the package in force and any paid pending
   * upgrade, so a renewal cannot undo an upgrade somebody has already paid for
   * by arriving before the boundary. A request below the floor is refused
   * outright — there is no invoice to create for it (`LIFE-DEC-001`).
   */
  async quoteRenewal(
    input: {
      hotelId: string;
      targetPackage: string;
      termMonths: number;
      provider: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<QuoteResult> {
    if (!isPackageCode(input.targetPackage)) {
      throw new ApiError('VALIDATION_FAILED', 'unknown package');
    }
    if (!isTermMonths(input.termMonths)) {
      throw new ApiError('VALIDATION_FAILED', 'the term must be 1, 3, 7 or 12 months');
    }
    if (!isPaymentProvider(input.provider)) {
      throw new ApiError('VALIDATION_FAILED', 'the gateway must be QPay or Khaan Bank');
    }
    const provider: PaymentProvider = input.provider;
    const targetPackage: PackageCode = input.targetPackage;
    const parameters = this.parameters;

    const prepared = await this.inHotelScope(input.hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const subscription = await repository.lock();
      if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const floor = renewalFloor(
        subscription.effectivePackage,
        subscription.pendingUpgradePackage ?? undefined,
      );
      if (packageRank(targetPackage) < packageRank(floor)) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'a renewal is never quoted below the package floor',
        );
      }
      // doc 17 §4.4: one unpaid intent at a time, and starting a different kind
      // of billing action supersedes the previous quote rather than queueing it.
      await repository.staleLiveIntent(subscription.subscriptionId, 'superseded_by_renewal');
      return { subscription, floor };
    });

    const price = quoteTerm(targetPackage, input.termMonths, parameters);
    const merchantRef = derivedIdempotencyKey(
      'subscription.renewal',
      input.hotelId,
      input.idempotencyKey,
    );
    const invoice = await this.deps.gateways.gateway(provider).createInvoice({
      provider,
      merchantRef,
      amountMnt: price.totalAmountMnt,
      currency: 'MNT',
      expiresAt: new Date(Date.now() + parameters.billingIntentTtlSeconds * 1000),
    });

    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const subscription = await repository.lock();
      if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const intentId = await repository.openIntent({
        subscriptionId: subscription.subscriptionId,
        kind: 'RENEWAL',
        provider,
        merchantRef,
        providerInvoiceId: invoice.providerInvoiceId,
        amountMnt: price.totalAmountMnt,
        quotedBillingRevision: subscription.billingRevision,
        currentPackage: prepared.floor,
        targetPackage,
        termMonths: price.termMonths,
        monthlyPriceMnt: price.monthlyPriceMnt,
        priceDeltaMnt: null,
        remainingServiceMonths: null,
        effectiveAt: null,
        quotedExpiresAt: subscription.expiresAt,
        vatRateBp: price.vatRateBp,
        priceBookVersion: price.priceBookVersion,
        taxConfigVersion: price.taxConfigVersion,
        packageFeatureVersion: price.packageFeatureVersion,
        ttlSeconds: parameters.billingIntentTtlSeconds,
      });
      await recordPlatformAudit(uow, {
        action: 'subscription.renewal.quoted',
        outcome: 'allowed',
        targetType: 'subscription_billing_intent',
        targetRef: intentId,
        payload: {
          targetPackage,
          termMonths: price.termMonths,
          amountMnt: price.totalAmountMnt.toString(),
        },
      });
      return {
        intentId,
        providerInvoiceId: invoice.providerInvoiceId,
        checkoutUrl: invoice.checkoutUrl,
        amountMnt: price.totalAmountMnt.toString(),
        vatAmountMnt: price.vatAmountMnt.toString(),
        targetPackage,
      };
    });
  }

  // ================================================================== upgrade

  /**
   * doc 17 §4.2 and §4.3: quotes an upgrade.
   *
   * The basis is the **committed** package: the effective one ordinarily, and a
   * paid pending target when there is one — which is what makes a second upgrade
   * incremental rather than a re-charge of the first. The boundary is inherited
   * from the existing pending upgrade for the same reason.
   *
   * Zero remaining whole service months means no invoice at all; the caller is
   * told to renew at the higher package instead (`LIFE-DEC-002`).
   */
  async quoteUpgrade(
    input: {
      hotelId: string;
      targetPackage: string;
      provider: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<QuoteResult> {
    if (!isPackageCode(input.targetPackage)) {
      throw new ApiError('VALIDATION_FAILED', 'unknown package');
    }
    if (!isPaymentProvider(input.provider)) {
      throw new ApiError('VALIDATION_FAILED', 'the gateway must be QPay or Khaan Bank');
    }
    const provider: PaymentProvider = input.provider;
    const targetPackage: PackageCode = input.targetPackage;
    const parameters = this.parameters;

    const prepared = await this.inHotelScope(input.hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const subscription = await repository.lock();
      if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const basis = subscription.pendingUpgradePackage ?? subscription.effectivePackage;
      // `LIFE-DEC-001`: there is no downgrade, and an equal target is not an
      // upgrade either. Both are refused here and neither has an API of its own.
      if (!isUpgrade(basis, targetPackage)) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'a subscription package is only ever raised (LIFE-DEC-001)',
        );
      }

      const effectiveAt =
        subscription.pendingUpgradeEffectiveAt ??
        nextServiceMonthBoundary(subscription.startsAt, uow.serverNow);
      const remaining = remainingWholeServiceMonths(
        subscription.startsAt,
        effectiveAt,
        subscription.expiresAt,
      );
      const quote = quoteUpgrade(basis, targetPackage, remaining, parameters);
      if (quote === undefined) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'no whole service months remain; renew at the higher package instead',
        );
      }
      await repository.staleLiveIntent(subscription.subscriptionId, 'superseded_by_upgrade');
      return { subscription, basis, effectiveAt, quote };
    });

    const merchantRef = derivedIdempotencyKey(
      'subscription.upgrade',
      input.hotelId,
      input.idempotencyKey,
    );
    const invoice = await this.deps.gateways.gateway(provider).createInvoice({
      provider,
      merchantRef,
      amountMnt: prepared.quote.totalAmountMnt,
      currency: 'MNT',
      expiresAt: new Date(Date.now() + parameters.billingIntentTtlSeconds * 1000),
    });

    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const subscription = await repository.lock();
      if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const intentId = await repository.openIntent({
        subscriptionId: subscription.subscriptionId,
        kind: 'UPGRADE',
        provider,
        merchantRef,
        providerInvoiceId: invoice.providerInvoiceId,
        amountMnt: prepared.quote.totalAmountMnt,
        quotedBillingRevision: subscription.billingRevision,
        currentPackage: prepared.basis,
        targetPackage,
        termMonths: null,
        monthlyPriceMnt: prepared.quote.monthlyPriceMnt,
        priceDeltaMnt: prepared.quote.priceDeltaMnt,
        remainingServiceMonths: prepared.quote.remainingServiceMonths,
        effectiveAt: prepared.effectiveAt,
        quotedExpiresAt: subscription.expiresAt,
        vatRateBp: prepared.quote.vatRateBp,
        priceBookVersion: prepared.quote.priceBookVersion,
        taxConfigVersion: prepared.quote.taxConfigVersion,
        packageFeatureVersion: prepared.quote.packageFeatureVersion,
        ttlSeconds: parameters.billingIntentTtlSeconds,
      });
      await recordPlatformAudit(uow, {
        action: 'subscription.upgrade.quoted',
        outcome: 'allowed',
        targetType: 'subscription_billing_intent',
        targetRef: intentId,
        payload: {
          basisPackage: prepared.basis,
          targetPackage,
          remainingServiceMonths: prepared.quote.remainingServiceMonths,
          amountMnt: prepared.quote.totalAmountMnt.toString(),
        },
      });
      return {
        intentId,
        providerInvoiceId: invoice.providerInvoiceId,
        checkoutUrl: invoice.checkoutUrl,
        amountMnt: prepared.quote.totalAmountMnt.toString(),
        vatAmountMnt: prepared.quote.vatAmountMnt.toString(),
        targetPackage,
        effectiveAt: prepared.effectiveAt.toISOString(),
      };
    });
  }

  // ================================================================= callbacks

  /**
   * doc 17 §4.4: applies a renewal or upgrade callback.
   *
   * The same discipline as the onboarding callback — authenticate, re-query the
   * provider, match the stored intent, lock, apply once — plus the two rules
   * that are specific to a live subscription:
   *
   *  * a quote that went stale is not applied. `LIFE-DEC-006` says a late
   *    payment on a superseded intent becomes a reconciliation case, and the
   *    billing revision the quote was taken at is what detects it;
   *  * an upgrade whose boundary has already passed by the time the payment
   *    confirms is applied **immediately** rather than left pending, which is
   *    `LIFE-DEC-007`'s "callback commit үед `effective_at <= now` бол target
   *    шууд apply".
   */
  async applyBillingCallback(
    hotelId: string,
    callback: RawCallback,
    request: RequestContext,
  ): Promise<BillingCallbackOutcome> {
    const gateway = this.deps.gateways.gateway(callback.provider);
    const verified = await gateway.verifyCallback(callback);
    if (!verified.verified) return { kind: 'rejected', reason: verified.reason };
    const status = await gateway.queryStatus(callback.providerInvoiceId);

    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const intent = await repository.lockIntentByInvoice(
        callback.provider,
        callback.providerInvoiceId,
      );
      if (intent === undefined) return { kind: 'rejected', reason: 'unknown_reference' };
      if (intent.state === 'PAID') return { kind: 'replay' };
      if (intent.state === 'PAID_REQUIRES_RECONCILIATION') {
        return { kind: 'requires_reconciliation', intentId: intent.intentId };
      }

      if (status.outcome !== 'paid') {
        if (status.outcome === 'pending') return { kind: 'not_paid', state: intent.state };
        const next =
          status.outcome === 'failed'
            ? ('FAILED' as const)
            : status.outcome === 'expired'
              ? ('EXPIRED' as const)
              : ('PENDING' as const);
        if (next !== 'PENDING' && intent.state === 'PENDING') {
          await repository.settleIntent({
            intentId: intent.intentId,
            expectedRevision: intent.revision,
            state: next,
            reason: status.outcome,
          });
        }
        return { kind: 'not_paid', state: next };
      }

      const mismatch =
        status.merchantRef !== intent.merchantRef
          ? 'merchant_ref_mismatch'
          : status.paidAmountMnt !== intent.amountMnt
            ? 'amount_mismatch'
            : status.currency !== 'MNT'
              ? 'currency_mismatch'
              : undefined;
      if (mismatch !== undefined) {
        await recordPlatformAudit(uow, {
          action: 'subscription.payment.callback_rejected',
          outcome: 'denied',
          targetType: 'subscription_billing_intent',
          targetRef: intent.intentId,
          reason: mismatch,
        });
        return { kind: 'rejected', reason: mismatch };
      }

      const subscription = await repository.lock();
      if (subscription === undefined) return { kind: 'rejected', reason: 'unknown_reference' };

      // A stale or superseded quote: the money arrived, the entitlement does
      // not move, and a case is opened for somebody with the permission to close
      // it (`LIFE-DEC-006`).
      const stale =
        intent.state !== 'PENDING' || intent.quotedBillingRevision !== subscription.billingRevision;
      if (stale) {
        await repository.settleIntent({
          intentId: intent.intentId,
          expectedRevision: intent.revision,
          state: 'PAID_REQUIRES_RECONCILIATION',
          reason: 'stale_quote',
          providerPaymentId: status.providerPaymentId,
          confirmedAt: status.confirmedAt,
        });
        await recordPlatformAudit(uow, {
          action: 'subscription.payment.requires_reconciliation',
          outcome: 'allowed',
          targetType: 'subscription_billing_intent',
          targetRef: intent.intentId,
          reason: 'stale_quote',
        });
        return { kind: 'requires_reconciliation', intentId: intent.intentId };
      }

      return intent.kind === 'RENEWAL'
        ? this.applyRenewal(
            repository,
            subscription,
            intent,
            status.providerPaymentId,
            status.confirmedAt,
            uow.serverNow,
          )
        : this.applyUpgrade(
            repository,
            subscription,
            intent,
            status.providerPaymentId,
            status.confirmedAt,
            uow.serverNow,
          );
    });
  }

  private async applyRenewal(
    repository: SubscriptionRepository,
    subscription: SubscriptionRow,
    intent: IntentRow,
    providerPaymentId: string,
    confirmedAt: Date,
    _now: Date,
  ): Promise<BillingCallbackOutcome> {
    const termMonths = intent.termMonths ?? subscription.termMonths;
    // `OPS-DEC-007` / `LIFE-DEC-005`: continue from the existing expiry before it
    // and inside grace; restart at confirmation after grace. `renewFrom` is the
    // one place that boundary is decided.
    const outcome = renewFrom(subscription.expiresAt, confirmedAt, termMonths);

    // `LIFE-DEC-007`: a higher-package renewal opens at the later of the previous
    // expiry and the confirmation — so paid mid-term it waits for the new term,
    // and paid in or after grace it opens now.
    const raising = packageRank(intent.targetPackage) > packageRank(subscription.effectivePackage);
    const effectiveNow =
      raising &&
      higherRenewalEffectiveAt(subscription.expiresAt, confirmedAt).getTime() <=
        confirmedAt.getTime();

    const settled = await repository.settleIntent({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      state: 'PAID',
      reason: 'provider_confirmed',
      providerPaymentId,
      confirmedAt,
    });
    if (!settled) throw new ApiError('CONFLICT', 'the intent changed concurrently');

    const paymentId = await repository.recordPayment({
      subscriptionId: subscription.subscriptionId,
      purpose: 'RENEWAL',
      provider: intent.provider,
      providerPaymentId,
      merchantRef: intent.merchantRef,
      grossAmountMnt: intent.amountMnt,
      vatAmountMnt: vatInsideInclusive(mnt(intent.amountMnt), intent.vatRateBp),
      vatRateBp: intent.vatRateBp,
      packageCode: intent.targetPackage,
      termMonths,
      monthlyPriceMnt: intent.monthlyPriceMnt,
      priceBookVersion: intent.priceBookVersion,
      taxConfigVersion: intent.taxConfigVersion,
      packageFeatureVersion: intent.packageFeatureVersion,
      intentId: intent.intentId,
      confirmedAt,
    });

    const applied = await repository.apply({
      expectedBillingRevision: subscription.billingRevision,
      ...(outcome.startsAt === undefined ? {} : { startsAt: outcome.startsAt }),
      expiresAt: outcome.expiresAt,
      termMonths,
      // The floor never falls, so a renewal raises it and never lowers it.
      packageFloor:
        packageRank(intent.targetPackage) > packageRank(subscription.packageFloor)
          ? intent.targetPackage
          : subscription.packageFloor,
      ...(effectiveNow ? { effectivePackage: intent.targetPackage } : {}),
      ...(raising && !effectiveNow
        ? {
            pendingUpgradePackage: intent.targetPackage,
            pendingUpgradeEffectiveAt: higherRenewalEffectiveAt(
              subscription.expiresAt,
              confirmedAt,
            ),
          }
        : {}),
    });
    if (!applied) throw new ApiError('CONFLICT', 'the subscription changed concurrently');

    await repository.recordEvent({
      subscriptionId: subscription.subscriptionId,
      eventType: 'RENEWED',
      billingRevision: subscription.billingRevision + 1,
      fromPackage: subscription.effectivePackage,
      toPackage: intent.targetPackage,
      fromExpiresAt: subscription.expiresAt,
      toExpiresAt: outcome.expiresAt,
      paymentId,
      detail: { restarted: outcome.restarted, termMonths },
    });
    return { kind: 'renewed', expiresAt: outcome.expiresAt.toISOString() };
  }

  private async applyUpgrade(
    repository: SubscriptionRepository,
    subscription: SubscriptionRow,
    intent: IntentRow,
    providerPaymentId: string,
    confirmedAt: Date,
    now: Date,
  ): Promise<BillingCallbackOutcome> {
    const effectiveAt = intent.effectiveAt ?? now;
    const dueNow = effectiveAt.getTime() <= now.getTime();

    const settled = await repository.settleIntent({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      state: 'PAID',
      reason: 'provider_confirmed',
      providerPaymentId,
      confirmedAt,
    });
    if (!settled) throw new ApiError('CONFLICT', 'the intent changed concurrently');

    const paymentId = await repository.recordPayment({
      subscriptionId: subscription.subscriptionId,
      purpose: 'UPGRADE',
      provider: intent.provider,
      providerPaymentId,
      merchantRef: intent.merchantRef,
      grossAmountMnt: intent.amountMnt,
      vatAmountMnt: vatInsideInclusive(mnt(intent.amountMnt), intent.vatRateBp),
      vatRateBp: intent.vatRateBp,
      packageCode: intent.targetPackage,
      termMonths: null,
      monthlyPriceMnt: intent.monthlyPriceMnt,
      priceBookVersion: intent.priceBookVersion,
      taxConfigVersion: intent.taxConfigVersion,
      packageFeatureVersion: intent.packageFeatureVersion,
      intentId: intent.intentId,
      confirmedAt,
    });

    // `LIFE-DEC-001`: the target becomes the renewal floor the moment the payment
    // confirms, whether or not the entitlement has opened yet.
    const applied = await repository.apply({
      expectedBillingRevision: subscription.billingRevision,
      packageFloor: intent.targetPackage,
      ...(dueNow
        ? { effectivePackage: intent.targetPackage, clearPendingUpgrade: true }
        : { pendingUpgradePackage: intent.targetPackage, pendingUpgradeEffectiveAt: effectiveAt }),
    });
    if (!applied) throw new ApiError('CONFLICT', 'the subscription changed concurrently');

    await repository.recordEvent({
      subscriptionId: subscription.subscriptionId,
      eventType: dueNow ? 'UPGRADE_APPLIED' : 'UPGRADE_PAID',
      billingRevision: subscription.billingRevision + 1,
      fromPackage: subscription.effectivePackage,
      toPackage: intent.targetPackage,
      paymentId,
      detail: { effectiveAt: effectiveAt.toISOString(), appliedImmediately: dueNow },
    });

    return dueNow
      ? { kind: 'upgrade_applied', effectivePackage: intent.targetPackage }
      : { kind: 'upgrade_pending', effectiveAt: effectiveAt.toISOString() };
  }

  // ========================================================= boundary worker

  /**
   * doc 17 §4.4: the service-month boundary operation.
   *
   * It takes the same subscription lock and the same billing-revision
   * compare-and-set a callback takes, so a worker racing a callback applies the
   * entitlement exactly once: whichever commits second finds the revision moved
   * and updates zero rows.
   *
   * Discovery is advisory and each hotel is processed in its own transaction, so
   * a candidate that a callback applied first costs one wasted lookup.
   */
  async applyDueUpgrades(limit = 32): Promise<number> {
    const request: RequestContext = {
      correlationId: `boundary-${crypto.randomUUID().slice(0, 8)}`,
    };
    const candidates = await this.inOperationScope(request, (uow) =>
      dueUpgradeCandidates(uow, limit),
    );

    let applied = 0;
    for (const candidate of candidates) {
      const moved = await this.applyDueUpgrade(candidate.hotelId, request);
      if (moved) applied += 1;
    }
    return applied;
  }

  async applyDueUpgrade(hotelId: string, request: RequestContext): Promise<boolean> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const subscription = await repository.lock();
      if (subscription === undefined) return false;
      // Re-read under the lock. The candidate list was taken outside it, so a
      // callback may have applied this target already — in which case there is
      // nothing pending and nothing to do.
      if (
        subscription.pendingUpgradePackage === null ||
        subscription.pendingUpgradeEffectiveAt === null ||
        subscription.pendingUpgradeEffectiveAt.getTime() > uow.serverNow.getTime()
      ) {
        return false;
      }

      const target = subscription.pendingUpgradePackage;
      const applied = await repository.apply({
        expectedBillingRevision: subscription.billingRevision,
        effectivePackage: target,
        packageFloor:
          packageRank(target) > packageRank(subscription.packageFloor)
            ? target
            : subscription.packageFloor,
        clearPendingUpgrade: true,
      });
      if (!applied) return false;

      await repository.recordEvent({
        subscriptionId: subscription.subscriptionId,
        eventType: 'UPGRADE_APPLIED',
        billingRevision: subscription.billingRevision + 1,
        fromPackage: subscription.effectivePackage,
        toPackage: target,
        detail: { appliedBy: 'boundary_worker' },
      });
      await recordPlatformAudit(uow, {
        action: 'subscription.upgrade.applied',
        outcome: 'allowed',
        targetType: 'hotel_subscription',
        targetRef: subscription.subscriptionId,
        payload: { toPackage: target },
      });
      return true;
    });
  }

  // ========================================================= reconciliation

  /**
   * `LIFE-DEC-007`: closes a reconciliation case.
   *
   * The permission (`SUBSCRIPTION_PAYMENT_RECONCILE`) and the recent step-up are
   * checked above this layer. What is enforced here is the part that matters:
   * the only thing this can write is the outcome, the account that decided it
   * and the reason. There is no parameter for a package, a term, an entitlement,
   * a provisioning result, `starts_at` or `expires_at` — so no resolution can
   * grant one, and a customer who should have an entitlement gets it by paying a
   * new authoritative quote.
   */
  async closeReconciliation(
    input: {
      hotelId: string;
      intentId: string;
      outcome: 'PROVIDER_CORRECTED_NOT_PAID' | 'EXTERNALLY_VOIDED' | 'FINANCE_CLOSED_EXCEPTION';
      reason: string;
    },
    accountId: string,
    request: RequestContext,
  ): Promise<void> {
    await this.inHotelScope(input.hotelId, { ...request, accountId }, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      const intent = await repository.intentById(input.intentId);
      if (intent === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (intent.state !== 'PAID_REQUIRES_RECONCILIATION') {
        throw new ApiError('CONFLICT', 'this payment is not in the reconciliation queue');
      }
      const closed = await repository.closeIntentReconciliation({
        intentId: input.intentId,
        expectedRevision: intent.revision,
        outcome: input.outcome,
        accountId,
        reason: input.reason,
      });
      if (!closed) throw new ApiError('CONFLICT', 'the case changed concurrently');
      await recordPlatformAudit(uow, {
        action: 'subscription.payment.reconciled',
        outcome: 'allowed',
        targetType: 'subscription_billing_intent',
        targetRef: input.intentId,
        payload: { outcome: input.outcome, accountId },
      });
    });
  }
}

export { expiryFrom };
