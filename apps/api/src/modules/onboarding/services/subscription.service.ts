import { randomUUID } from 'node:crypto';
import type { PackageCode, SubscriptionStatePort } from '@prsystem/authz';
import { isPackageCode } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  lockIdempotencyClaim,
  recordPlatformAudit,
} from '@prsystem/db';
import { mnt } from '@prsystem/money';
import type { InvoiceStatus, PaymentProvider, RawCallback } from '@prsystem/ports';
import { isPaymentProvider } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { CommandActor, OnboardingDependencies, RequestContext } from './onboarding-context';
import { AuthorizationDenied } from '../../iam/services/authorization.service';
import { OnboardingServiceBase, portContext, portFailure } from './onboarding-context';
import type { IntentRow, SubscriptionRow } from '../repositories/subscription.repository';
import {
  SubscriptionRepository,
  dueUpgradeCandidates,
} from '../repositories/subscription.repository';
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
  snapshotFrom,
} from '../domain/lifecycle';
import { providerStatusFrom } from './provisioning.service';

/**
 * Subscription renewal, upgrade and the service-month boundary (doc 17,
 * `LIFE-DEC-001`…`007`; doc 14 `OPS-DEC-006`, `OPS-DEC-007`).
 *
 * Everything money touches runs the same way: the actor's live scope is
 * resolved before the hotel is bound, the subscription row is locked, the
 * Phase 04 pipeline is evaluated against `hotel.subscription.pay` on the very
 * row that was locked, the billing revision is read, and the effect is applied
 * with that revision as a compare-and-set. A callback and the boundary worker
 * take the same lock and compete for the same revision, so exactly one of them
 * applies an entitlement and the other finds zero rows and stops.
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

export interface SubscriptionStatus {
  readonly subscriptionId: string;
  readonly effectivePackage: PackageCode;
  readonly packageFloor: PackageCode;
  readonly pendingUpgradePackage: PackageCode | null;
  readonly pendingUpgradeEffectiveAt: Date | null;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly graceExpiresAt: Date;
  readonly state: string;
  readonly listingEligible: boolean;
  readonly billingRevision: number;
}

/** doc 18 §3: the one action that pays or renews a subscription. */
const PAY_PERMISSION = 'hotel.subscription.pay';
/** doc 18 §7: what any active member keeps — enough to read the state. */
const READ_PERMISSION = 'platform.expired_notice';

/**
 * The complete quoted snapshot (doc 17 §4.4): everything the price and the
 * effect were computed from. Re-locked and compared before the intent is
 * persisted, so a quote is never stamped with a revision that moved under it.
 */
interface QuotedSnapshot {
  readonly billingRevision: number;
  readonly effectivePackage: PackageCode;
  readonly packageFloor: PackageCode;
  readonly pendingUpgradePackage: PackageCode | null;
  readonly pendingUpgradeEffectiveAt: number | null;
  readonly startsAt: number;
  readonly expiresAt: number;
  readonly termMonths: number;
}

function snapshotOf(row: SubscriptionRow): QuotedSnapshot {
  return {
    billingRevision: row.billingRevision,
    effectivePackage: row.effectivePackage,
    packageFloor: row.packageFloor,
    pendingUpgradePackage: row.pendingUpgradePackage,
    pendingUpgradeEffectiveAt: row.pendingUpgradeEffectiveAt?.getTime() ?? null,
    startsAt: row.startsAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    termMonths: row.termMonths,
  };
}

/**
 * The snapshot a prepared quote was priced from, as the row recorded it. A row
 * without one — there are none after remediation 2 — can never match.
 */
function quotedSnapshotOf(row: IntentRow): QuotedSnapshot | undefined {
  const stored = row.quotedSnapshot;
  if (stored === null) return undefined;
  return {
    billingRevision: Number(stored['billingRevision']),
    effectivePackage: stored['effectivePackage'] as PackageCode,
    packageFloor: stored['packageFloor'] as PackageCode,
    pendingUpgradePackage: (stored['pendingUpgradePackage'] as PackageCode | null) ?? null,
    pendingUpgradeEffectiveAt:
      stored['pendingUpgradeEffectiveAt'] === null
        ? null
        : Number(stored['pendingUpgradeEffectiveAt']),
    startsAt: Number(stored['startsAt']),
    expiresAt: Number(stored['expiresAt']),
    termMonths: Number(stored['termMonths']),
  };
}

/** The audit a finalized quote records, derived from the row and nothing else. */
function auditFor(row: IntentRow): { action: string; payload: Record<string, unknown> } {
  return row.kind === 'RENEWAL'
    ? {
        action: 'subscription.renewal.quoted',
        payload: {
          targetPackage: row.targetPackage,
          termMonths: row.termMonths,
          amountMnt: row.amountMnt.toString(),
        },
      }
    : {
        action: 'subscription.upgrade.quoted',
        payload: {
          basisPackage: row.currentPackage,
          targetPackage: row.targetPackage,
          remainingServiceMonths: row.remainingServiceMonths,
          amountMnt: row.amountMnt.toString(),
        },
      };
}

function sameSnapshot(left: QuotedSnapshot, right: QuotedSnapshot): boolean {
  return (
    left.billingRevision === right.billingRevision &&
    left.effectivePackage === right.effectivePackage &&
    left.packageFloor === right.packageFloor &&
    left.pendingUpgradePackage === right.pendingUpgradePackage &&
    left.pendingUpgradeEffectiveAt === right.pendingUpgradeEffectiveAt &&
    left.startsAt === right.startsAt &&
    left.expiresAt === right.expiresAt &&
    left.termMonths === right.termMonths
  );
}

/** A port answering from the row a command has already locked. */
function portFromRow(row: SubscriptionRow): SubscriptionStatePort {
  return {
    snapshot: (hotelId, now) =>
      Promise.resolve(
        snapshotFrom(
          {
            hotelId,
            effectivePackage: row.effectivePackage,
            expiresAt: row.expiresAt,
            suspendedAt: row.suspendedAt,
          },
          now,
        ),
      ),
  };
}

function replayStored(status: number, body: unknown): QuoteResult {
  if (status >= 400) {
    const stored = body as { error?: { code?: string; message?: string } };
    throw new ApiError(
      (stored.error?.code as ApiError['code'] | undefined) ?? 'CONFLICT',
      stored.error?.message ?? 'this request was refused when it was first made',
    );
  }
  return body as QuoteResult;
}

export class SubscriptionService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  // ================================================================ read model

  /**
   * The authoritative row, plus the state and listing truth derived from it.
   *
   * Reachable by any active member of the hotel — the hard-lock notice needs
   * it — but only through the scope gate: a suspended membership, a stale
   * session grant, a foreign hotel and an unknown hotel are all `NOT_FOUND`.
   */
  async status(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<SubscriptionStatus | undefined> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId },
      READ_PERMISSION,
      request,
      async (uow, _gate, authorize) => {
        const repository = new SubscriptionRepository(uow);
        const row = await repository.current();
        if (row === undefined) return undefined;
        await authorize(portFromRow(row));
        return this.statusOf(hotelId, row, uow.serverNow);
      },
    );
  }

  private statusOf(hotelId: string, row: SubscriptionRow, now: Date): SubscriptionStatus {
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
      state: deriveState(facts, now),
      listingEligible: listingEligible(facts, now),
      billingRevision: row.billingRevision,
    };
  }

  // ================================================================== renewal

  /**
   * doc 17 §3: quotes a renewal.
   *
   * The floor is the higher of the package in force and any paid pending
   * upgrade. With a paid pending target the renewal may be quoted **at** that
   * target and nowhere else: below it is below the floor, and above it is the
   * incremental second upgrade of §4.3, which has to be completed first — a
   * renewal never delays, overwrites, cancels or reprices an upgrade somebody
   * has already paid for (`LIFE-DEC-001`, `LIFE-DEC-006`).
   */
  async quoteRenewal(
    input: {
      hotelId: string;
      targetPackage: string;
      termMonths: number;
      provider: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
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
    const termMonths = input.termMonths;
    const parameters = this.parameters;
    const operation = 'subscription.renewal';

    return this.quote(
      { hotelId: input.hotelId, provider, idempotencyKey: input.idempotencyKey, operation },
      { targetPackage, termMonths, provider },
      actor,
      request,
      (subscription) => {
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
        if (
          subscription.pendingUpgradePackage !== null &&
          packageRank(targetPackage) > packageRank(subscription.pendingUpgradePackage)
        ) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'a paid pending upgrade is in place; complete the incremental upgrade to the higher package first',
          );
        }
        const price = quoteTerm(targetPackage, termMonths, parameters);
        return {
          amountMnt: price.totalAmountMnt,
          vatAmountMnt: price.vatAmountMnt,
          intent: {
            kind: 'RENEWAL' as const,
            currentPackage: floor,
            targetPackage,
            termMonths: price.termMonths,
            monthlyPriceMnt: price.monthlyPriceMnt,
            priceDeltaMnt: null,
            remainingServiceMonths: null,
            effectiveAt: null,
            vatRateBp: price.vatRateBp,
            priceBookVersion: price.priceBookVersion,
            taxConfigVersion: price.taxConfigVersion,
            packageFeatureVersion: price.packageFeatureVersion,
          },
          audit: {
            action: 'subscription.renewal.quoted',
            payload: { targetPackage, termMonths, amountMnt: price.totalAmountMnt.toString() },
          },
          effectiveAt: undefined,
        };
      },
    );
  }

  // ================================================================== upgrade

  /**
   * doc 17 §4.2 and §4.3: quotes an upgrade.
   *
   * The basis is the **committed** package: the effective one ordinarily, and a
   * paid pending target when there is one — which is what makes a second upgrade
   * incremental rather than a re-charge of the first. The boundary is inherited
   * from the existing pending upgrade for the same reason.
   */
  async quoteUpgrade(
    input: { hotelId: string; targetPackage: string; provider: string; idempotencyKey: string },
    actor: CommandActor,
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

    return this.quote(
      {
        hotelId: input.hotelId,
        provider,
        idempotencyKey: input.idempotencyKey,
        operation: 'subscription.upgrade',
      },
      { targetPackage, provider },
      actor,
      request,
      (subscription, now) => {
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
          nextServiceMonthBoundary(subscription.startsAt, now);
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
        return {
          amountMnt: quote.totalAmountMnt,
          vatAmountMnt: quote.vatAmountMnt,
          intent: {
            kind: 'UPGRADE' as const,
            currentPackage: basis,
            targetPackage,
            termMonths: null,
            monthlyPriceMnt: quote.monthlyPriceMnt,
            priceDeltaMnt: quote.priceDeltaMnt,
            remainingServiceMonths: quote.remainingServiceMonths,
            effectiveAt,
            vatRateBp: quote.vatRateBp,
            priceBookVersion: quote.priceBookVersion,
            taxConfigVersion: quote.taxConfigVersion,
            packageFeatureVersion: quote.packageFeatureVersion,
          },
          audit: {
            action: 'subscription.upgrade.quoted',
            payload: {
              basisPackage: basis,
              targetPackage,
              remainingServiceMonths: quote.remainingServiceMonths,
              amountMnt: quote.totalAmountMnt.toString(),
            },
          },
          effectiveAt,
        };
      },
    );
  }

  /**
   * The one quoting discipline both actions share (R6).
   *
   *  1. gate the actor's scope, lock the row, authorize `hotel.subscription.pay`
   *     against that row, price, and **claim the idempotency key** — before
   *     anything irreversible;
   *  2. call the provider with a stable idempotency key of its own, so a lost
   *     reply recovers the same invoice on retry;
   *  3. lock the row again, compare the complete quoted snapshot, lock the
   *     claim, stale the previous live intent and persist the new one — only
   *     now, when the replacement invoice durably exists — and store the result.
   *
   * A retry with the same key and body replays the stored result exactly; the
   * same key with a different body is refused; a revision that moved between
   * the price and the persist refuses the quote and persists nothing.
   */
  private async quote(
    key: { hotelId: string; provider: PaymentProvider; idempotencyKey: string; operation: string },
    payload: Record<string, unknown>,
    actor: CommandActor,
    request: RequestContext,
    price: (subscription: SubscriptionRow, now: Date) => PricedQuote,
  ): Promise<QuoteResult> {
    const parameters = this.parameters;
    const scoped = { ...request, accountId: actor.principal.accountId };
    const merchantRef = derivedIdempotencyKey(key.operation, key.hotelId, key.idempotencyKey);

    // T1 — authorization, then the claim, then eligibility, then a prepared
    // quote (remediation 2, finding 1). A completed request is replayed as soon
    // as the actor is known to hold the hotel, before the present row is
    // judged: the retry of an upgrade that was quoted and since paid gets the
    // stored answer, not a refusal to raise a package that is already raised.
    // The quote is prepared with its complete priced snapshot and no provider
    // invoice; a retry after a lost acknowledgement recovers that row and its
    // price and never re-prices the provider's invoice.
    const prepared = await this.runAuthorizedHotelCommand(
      actor,
      { hotelId: key.hotelId },
      PAY_PERMISSION,
      scoped,
      async (uow, _gate, authorize) => {
        const repository = new SubscriptionRepository(uow);
        const subscription = await repository.lock();
        if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');
        await authorize(portFromRow(subscription));

        const claimed = await claimIdempotencyKey(uow, {
          operation: key.operation,
          key: key.idempotencyKey,
          clientRef: key.hotelId,
          payload: { hotelId: key.hotelId, ...payload },
        });
        if (claimed.kind === 'replay')
          return { replay: replayStored(claimed.status, claimed.body) };
        if (claimed.kind === 'key_reused_with_different_payload') {
          throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'this key was used for a different request');
        }

        const existing = await repository.lockIntentByMerchantRef(merchantRef);
        if (existing !== undefined) {
          if (existing.state !== 'PREPARING') {
            throw new ApiError('CONFLICT', 'the request claim is gone');
          }
          return { intent: existing, subscriptionId: subscription.subscriptionId };
        }
        const priced = price(subscription, uow.serverNow);
        const intentId = await repository.prepareIntent({
          subscriptionId: subscription.subscriptionId,
          provider: key.provider,
          merchantRef,
          amountMnt: priced.amountMnt,
          quotedBillingRevision: subscription.billingRevision,
          quotedSnapshot: { ...snapshotOf(subscription) },
          quotedExpiresAt: subscription.expiresAt,
          ttlSeconds: parameters.billingIntentTtlSeconds,
          ...priced.intent,
        });
        const intent = await repository.intentById(intentId);
        if (intent === undefined) throw new Error('the prepared quote could not be read back');
        return { intent, subscriptionId: subscription.subscriptionId };
      },
    );
    if ('replay' in prepared) return prepared.replay;
    const intent = prepared.intent;

    const invoice = await this.deps.gateways.gateway(key.provider).createInvoice(
      {
        intentId: merchantRef,
        amountMnt: intent.amountMnt,
        currency: 'MNT',
        merchantRef,
        expiresAt: intent.expiresAt,
        idempotencyKey: merchantRef,
      },
      portContext(request),
    );
    if (!invoice.ok) {
      const failure = portFailure(invoice.error, 'the payment gateway');
      if (invoice.error.kind === 'REJECTED' || invoice.error.kind === 'MISMATCH') {
        await this.inHotelScope(key.hotelId, scoped, async (uow) => {
          const repository = new SubscriptionRepository(uow);
          const lock = await lockIdempotencyClaim(uow, {
            operation: key.operation,
            key: key.idempotencyKey,
          });
          if (lock.kind === 'in_progress') {
            await completeIdempotencyKey(uow, lock.idempotencyId, failure.status, {
              error: { code: failure.code, message: failure.message },
            });
          }
          const row = await repository.lockIntentByMerchantRef(merchantRef);
          if (row !== undefined && row.state === 'PREPARING') {
            await repository.refuseIntent({
              intentId: row.intentId,
              expectedRevision: row.revision,
              reason: `provider_${invoice.error.kind.toLowerCase()}`,
            });
          }
        });
      }
      throw failure;
    }
    const providerInvoiceId = invoice.value.providerInvoiceId;

    // T2 — the final mutation, authorized again against the row as it is now
    // (remediation 2, finding 5): a principal who lost the hotel while the
    // provider was being called persists nothing, and the provider's invoice is
    // recorded on the abandoned quote so it is never an untracked orphan.
    let settled: { result: QuoteResult } | { refusal: ApiError };
    try {
      settled = await this.runAuthorizedHotelCommand(
        actor,
        { hotelId: key.hotelId },
        PAY_PERMISSION,
        scoped,
        async (uow, _gate, authorize) => {
          const repository = new SubscriptionRepository(uow);
          const subscription = await repository.lock();
          if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');
          await authorize(portFromRow(subscription));

          const claim = await lockIdempotencyClaim(uow, {
            operation: key.operation,
            key: key.idempotencyKey,
          });
          if (claim.kind === 'replay') return { result: replayStored(claim.status, claim.body) };
          if (claim.kind === 'absent') throw new ApiError('CONFLICT', 'the request claim is gone');
          const row = await repository.lockIntentByMerchantRef(merchantRef);
          if (row === undefined || row.state !== 'PREPARING') {
            throw new ApiError('CONFLICT', 'the request claim is gone');
          }

          // doc 17 §4.4: the snapshot the price was computed from must be the
          // row as it is now. Anything else — a renewal that moved the expiry,
          // an upgrade that moved the revision — makes this quote stale before
          // it exists. A stale quote is never live: it is abandoned with the
          // provider's invoice on it, the refusal is stored against the key, and
          // both are committed before the refusal is thrown (finding 1).
          const quoted = quotedSnapshotOf(row);
          if (quoted === undefined || !sameSnapshot(quoted, snapshotOf(subscription))) {
            const stale = new ApiError(
              'CONFLICT',
              'the subscription changed while the quote was being prepared; quote again',
            );
            await repository.abandonIntent({
              intentId: row.intentId,
              expectedRevision: row.revision,
              providerInvoiceId,
              reason: 'stale_snapshot',
            });
            await completeIdempotencyKey(uow, claim.idempotencyId, stale.status, {
              error: { code: stale.code, message: stale.message },
            });
            return { refusal: stale };
          }

          // doc 17 §4.4: one unpaid intent at a time. The previous quote is
          // superseded here, with the replacement's invoice already durable at
          // the provider — never before.
          await repository.staleLiveIntent(
            subscription.subscriptionId,
            `superseded_by_${row.kind.toLowerCase()}`,
          );
          const live = await repository.finalizeIntent({
            intentId: row.intentId,
            expectedRevision: row.revision,
            providerInvoiceId,
          });
          if (!live) throw new ApiError('CONFLICT', 'the quote changed concurrently');

          const audit = auditFor(row);
          await recordPlatformAudit(uow, {
            action: audit.action,
            outcome: 'allowed',
            targetType: 'subscription_billing_intent',
            targetRef: row.intentId,
            payload: audit.payload,
          });
          const result: QuoteResult = {
            intentId: row.intentId,
            providerInvoiceId,
            checkoutUrl: invoice.value.payUrl ?? '',
            amountMnt: row.amountMnt.toString(),
            vatAmountMnt: vatInsideInclusive(mnt(row.amountMnt), row.vatRateBp).toString(),
            targetPackage: row.targetPackage,
            ...(row.effectiveAt === null ? {} : { effectiveAt: row.effectiveAt.toISOString() }),
          };
          await completeIdempotencyKey(uow, claim.idempotencyId, 201, result);
          return { result };
        },
      );
    } catch (error) {
      // Denied at the final mutation: the provider's invoice exists and the
      // prepared quote is abandoned with it, as bookkeeping and never as an
      // entitlement. The existing live intent is untouched.
      if (error instanceof AuthorizationDenied) {
        await this.inHotelScope(key.hotelId, scoped, async (uow) => {
          const repository = new SubscriptionRepository(uow);
          const row = await repository.lockIntentByMerchantRef(merchantRef);
          if (row !== undefined && row.state === 'PREPARING') {
            await repository.abandonIntent({
              intentId: row.intentId,
              expectedRevision: row.revision,
              providerInvoiceId,
              reason: 'authorization_denied',
            });
          }
        }).catch(() => undefined);
      }
      throw error;
    }
    if ('refusal' in settled) throw settled.refusal;
    return settled.result;
  }

  // ================================================================= callbacks

  /**
   * doc 17 §4.4: applies a renewal or upgrade callback.
   *
   * The same discipline as the onboarding callback — authenticate, re-query the
   * provider, match the stored intent, lock, apply once — plus the two rules
   * that are specific to a live subscription: a stale quote is not applied but
   * becomes a reconciliation case (`LIFE-DEC-006`), and an upgrade whose
   * boundary has already passed is applied immediately (`LIFE-DEC-007`).
   */
  async applyBillingCallback(
    hotelId: string,
    callback: RawCallback,
    request: RequestContext,
  ): Promise<BillingCallbackOutcome> {
    const gateway = this.deps.gateways.gateway(callback.provider);
    const verified = await gateway.verifyCallback(callback, portContext(request));
    if (!verified.ok) return { kind: 'rejected', reason: verified.error.kind.toLowerCase() };
    const queried = await gateway.queryStatus(
      { providerInvoiceId: callback.providerInvoiceId },
      portContext(request),
    );
    const status = queried.ok
      ? providerStatusFrom(queried.value)
      : { outcome: 'uncertain' as const, reason: queried.error.kind.toLowerCase() };

    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SubscriptionRepository(uow);
      // One lock order with the replacement quote: the subscription row first,
      // then the intent (remediation 2, finding 1). The quote's finalization
      // locks the subscription and then stales the live intent; a callback
      // that took the intent first and then waited on the subscription was the
      // other half of a deadlock.
      const subscription = await repository.lock();
      if (subscription === undefined) return { kind: 'rejected', reason: 'unknown_reference' };
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
        if (status.outcome === 'pending' || status.outcome === 'uncertain') {
          return { kind: 'not_paid', state: intent.state };
        }
        const next = status.outcome === 'failed' ? ('FAILED' as const) : ('EXPIRED' as const);
        if (intent.state === 'PENDING') {
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
          providerFeeMnt: status.providerFeeMnt,
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

      const settled = await repository.settleIntent({
        intentId: intent.intentId,
        expectedRevision: intent.revision,
        state: 'PAID',
        reason: 'provider_confirmed',
        providerPaymentId: status.providerPaymentId,
        confirmedAt: status.confirmedAt,
        providerFeeMnt: status.providerFeeMnt,
      });
      if (!settled) throw new ApiError('CONFLICT', 'the intent changed concurrently');

      const settlement = {
        providerPaymentId: status.providerPaymentId,
        confirmedAt: status.confirmedAt,
        providerFeeMnt: status.providerFeeMnt,
      };
      return intent.kind === 'RENEWAL'
        ? this.applyRenewal(repository, subscription, intent, settlement)
        : this.applyUpgrade(repository, subscription, intent, settlement, uow.serverNow);
    });
  }

  private async recordPayment(
    repository: SubscriptionRepository,
    subscription: SubscriptionRow,
    intent: IntentRow,
    purpose: 'RENEWAL' | 'UPGRADE',
    termMonths: number | null,
    settlement: { providerPaymentId: string; confirmedAt: Date; providerFeeMnt: bigint | null },
  ): Promise<string> {
    return repository.recordPayment({
      subscriptionId: subscription.subscriptionId,
      purpose,
      provider: intent.provider,
      providerPaymentId: settlement.providerPaymentId,
      merchantRef: intent.merchantRef,
      grossAmountMnt: intent.amountMnt,
      vatAmountMnt: vatInsideInclusive(mnt(intent.amountMnt), intent.vatRateBp),
      providerFeeMnt: settlement.providerFeeMnt,
      vatRateBp: intent.vatRateBp,
      packageCode: intent.targetPackage,
      termMonths,
      monthlyPriceMnt: intent.monthlyPriceMnt,
      priceBookVersion: intent.priceBookVersion,
      taxConfigVersion: intent.taxConfigVersion,
      packageFeatureVersion: intent.packageFeatureVersion,
      intentId: intent.intentId,
      confirmedAt: settlement.confirmedAt,
    });
  }

  private async applyRenewal(
    repository: SubscriptionRepository,
    subscription: SubscriptionRow,
    intent: IntentRow,
    settlement: { providerPaymentId: string; confirmedAt: Date; providerFeeMnt: bigint | null },
  ): Promise<BillingCallbackOutcome> {
    const termMonths = intent.termMonths ?? subscription.termMonths;
    const confirmedAt = settlement.confirmedAt;
    // `OPS-DEC-007` / `LIFE-DEC-005`: continue from the existing expiry before it
    // and inside grace; restart at confirmation after grace.
    const outcome = renewFrom(subscription.expiresAt, confirmedAt, termMonths);

    const paymentId = await this.recordPayment(
      repository,
      subscription,
      intent,
      'RENEWAL',
      termMonths,
      settlement,
    );

    // R7 / doc 17 §4.4: a paid pending upgrade is untouched by a renewal — its
    // target and its boundary stay exactly as they were paid for. Only with no
    // pending upgrade may a higher-package renewal open the higher entitlement
    // (`LIFE-DEC-007`): now if paid in or after grace, else at the new term.
    const pending = subscription.pendingUpgradePackage !== null;
    const raising =
      !pending && packageRank(intent.targetPackage) > packageRank(subscription.effectivePackage);
    const effectiveNow =
      raising &&
      higherRenewalEffectiveAt(subscription.expiresAt, confirmedAt).getTime() <=
        confirmedAt.getTime();

    const applied = await repository.apply({
      expectedBillingRevision: subscription.billingRevision,
      ...(outcome.startsAt === undefined ? {} : { startsAt: outcome.startsAt }),
      expiresAt: outcome.expiresAt,
      termMonths,
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
      detail: { restarted: outcome.restarted, termMonths, pendingUpgradePreserved: pending },
    });
    return { kind: 'renewed', expiresAt: outcome.expiresAt.toISOString() };
  }

  private async applyUpgrade(
    repository: SubscriptionRepository,
    subscription: SubscriptionRow,
    intent: IntentRow,
    settlement: { providerPaymentId: string; confirmedAt: Date; providerFeeMnt: bigint | null },
    now: Date,
  ): Promise<BillingCallbackOutcome> {
    const effectiveAt = intent.effectiveAt ?? now;
    const dueNow = effectiveAt.getTime() <= now.getTime();

    const paymentId = await this.recordPayment(
      repository,
      subscription,
      intent,
      'UPGRADE',
      null,
      settlement,
    );

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
   */
  async applyDueUpgrades(limit = 32): Promise<number> {
    const request: RequestContext = { correlationId: `boundary-${randomUUID().slice(0, 8)}` };
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
   * `SUBSCRIPTION_PAYMENT_RECONCILE` plus a recent step-up, evaluated in the
   * Operation realm by the Phase 04 pipeline and audited there. The only thing
   * this can write is the outcome, the account that decided it and the reason.
   * There is no parameter for a package, a term, an entitlement, a provisioning
   * result, `starts_at` or `expires_at` — so no resolution can grant one, and a
   * customer who should have an entitlement gets it by paying a new quote.
   */
  async closeReconciliation(
    input: {
      hotelId: string;
      intentId: string;
      outcome: 'PROVIDER_CORRECTED_NOT_PAID' | 'EXTERNALLY_VOIDED' | 'FINANCE_CLOSED_EXCEPTION';
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<void> {
    const accountId = actor.principal.accountId;
    // Authorization and mutation in one transaction, under the Operation realm
    // (remediation 2, finding 5): the decision that was permitted is the
    // decision that commits, and a decision that cannot be applied leaves no
    // audit of having been requested.
    await this.runOperationCommand(
      actor,
      'operation.subscription_payment_reconcile',
      { targetType: 'subscription_billing_intent', targetRef: input.intentId },
      request,
      async (uow) => {
        await recordPlatformAudit(uow, {
          action: 'subscription.payment.reconcile_requested',
          outcome: 'allowed',
          targetType: 'subscription_billing_intent',
          targetRef: input.intentId,
          payload: { hotelId: input.hotelId, outcome: input.outcome, accountId },
        });
        const repository = new SubscriptionRepository(uow, input.hotelId);
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
      },
    );
  }
}

interface PricedQuote {
  readonly amountMnt: bigint;
  readonly vatAmountMnt: bigint;
  readonly intent: {
    readonly kind: 'RENEWAL' | 'UPGRADE';
    readonly currentPackage: PackageCode;
    readonly targetPackage: PackageCode;
    readonly termMonths: number | null;
    readonly monthlyPriceMnt: bigint;
    readonly priceDeltaMnt: bigint | null;
    readonly remainingServiceMonths: number | null;
    readonly effectiveAt: Date | null;
    readonly vatRateBp: number;
    readonly priceBookVersion: string;
    readonly taxConfigVersion: string;
    readonly packageFeatureVersion: string;
  };
  readonly audit: { readonly action: string; readonly payload: Record<string, unknown> };
  readonly effectiveAt: Date | undefined;
}

export { expiryFrom };
export type { InvoiceStatus, UnitOfWork };
