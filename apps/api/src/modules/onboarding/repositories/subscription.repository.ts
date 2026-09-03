import type { PackageCode } from '@prsystem/authz';
import type { UnitOfWork } from '@prsystem/db';
import type { PaymentProvider } from '@prsystem/ports';

/**
 * The tenant-scoped subscription graph.
 *
 * Every statement runs under an established hotel scope, so the tenant policy
 * supplies the predicate. What this file adds on top is the concurrency
 * discipline `LIFE-DEC-006` requires: the subscription row is locked, the
 * billing revision is a compare-and-set, and a callback and the boundary worker
 * therefore cannot both apply the same entitlement.
 */

export type IntentKind = 'RENEWAL' | 'UPGRADE';
export type IntentState =
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'STALE'
  | 'PAID_REQUIRES_RECONCILIATION';

export interface SubscriptionRow {
  readonly subscriptionId: string;
  readonly hotelId: string;
  readonly effectivePackage: PackageCode;
  readonly packageFloor: PackageCode;
  readonly pendingUpgradePackage: PackageCode | null;
  readonly pendingUpgradeEffectiveAt: Date | null;
  readonly termMonths: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly suspendedAt: Date | null;
  readonly billingRevision: number;
  readonly revision: number;
}

export interface IntentRow {
  readonly intentId: string;
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly kind: IntentKind;
  readonly state: IntentState;
  readonly provider: PaymentProvider;
  readonly merchantRef: string;
  readonly providerInvoiceId: string;
  readonly providerPaymentId: string | null;
  readonly amountMnt: bigint;
  readonly providerFeeMnt: bigint;
  readonly quotedBillingRevision: number;
  readonly currentPackage: PackageCode;
  readonly targetPackage: PackageCode;
  readonly termMonths: number | null;
  readonly monthlyPriceMnt: bigint;
  readonly priceDeltaMnt: bigint | null;
  readonly remainingServiceMonths: number | null;
  readonly effectiveAt: Date | null;
  readonly quotedExpiresAt: Date;
  readonly vatRateBp: number;
  readonly priceBookVersion: string;
  readonly taxConfigVersion: string;
  readonly packageFeatureVersion: string;
  readonly expiresAt: Date;
  readonly confirmedAt: Date | null;
  readonly revision: number;
}

const SUBSCRIPTION_COLUMNS = `
  subscription_id, hotel_id, effective_package, package_floor, pending_upgrade_package,
  pending_upgrade_effective_at, term_months, starts_at, expires_at, suspended_at,
  billing_revision, revision`;

const INTENT_COLUMNS = `
  intent_id, hotel_id, subscription_id, kind, state, provider, merchant_ref,
  provider_invoice_id, provider_payment_id, amount_mnt, provider_fee_mnt,
  quoted_billing_revision, current_package, target_package, term_months, monthly_price_mnt,
  price_delta_mnt, remaining_service_months, effective_at, quoted_expires_at, vat_rate_bp,
  price_book_version, tax_config_version, package_feature_version, expires_at,
  confirmed_at, revision`;

function mapSubscription(row: Record<string, unknown> | undefined): SubscriptionRow | undefined {
  if (row === undefined) return undefined;
  return {
    subscriptionId: row['subscription_id'] as string,
    hotelId: row['hotel_id'] as string,
    effectivePackage: row['effective_package'] as PackageCode,
    packageFloor: row['package_floor'] as PackageCode,
    pendingUpgradePackage: row['pending_upgrade_package'] as PackageCode | null,
    pendingUpgradeEffectiveAt: row['pending_upgrade_effective_at'] as Date | null,
    termMonths: Number(row['term_months']),
    startsAt: row['starts_at'] as Date,
    expiresAt: row['expires_at'] as Date,
    suspendedAt: row['suspended_at'] as Date | null,
    billingRevision: Number(row['billing_revision']),
    revision: Number(row['revision']),
  };
}

function mapIntent(row: Record<string, unknown> | undefined): IntentRow | undefined {
  if (row === undefined) return undefined;
  const delta = row['price_delta_mnt'] as string | null;
  return {
    intentId: row['intent_id'] as string,
    hotelId: row['hotel_id'] as string,
    subscriptionId: row['subscription_id'] as string,
    kind: row['kind'] as IntentKind,
    state: row['state'] as IntentState,
    provider: row['provider'] as PaymentProvider,
    merchantRef: row['merchant_ref'] as string,
    providerInvoiceId: row['provider_invoice_id'] as string,
    providerPaymentId: row['provider_payment_id'] as string | null,
    amountMnt: BigInt(row['amount_mnt'] as string),
    providerFeeMnt: BigInt(row['provider_fee_mnt'] as string),
    quotedBillingRevision: Number(row['quoted_billing_revision']),
    currentPackage: row['current_package'] as PackageCode,
    targetPackage: row['target_package'] as PackageCode,
    termMonths: row['term_months'] === null ? null : Number(row['term_months']),
    monthlyPriceMnt: BigInt(row['monthly_price_mnt'] as string),
    priceDeltaMnt: delta === null ? null : BigInt(delta),
    remainingServiceMonths:
      row['remaining_service_months'] === null ? null : Number(row['remaining_service_months']),
    effectiveAt: row['effective_at'] as Date | null,
    quotedExpiresAt: row['quoted_expires_at'] as Date,
    vatRateBp: Number(row['vat_rate_bp']),
    priceBookVersion: row['price_book_version'] as string,
    taxConfigVersion: row['tax_config_version'] as string,
    packageFeatureVersion: row['package_feature_version'] as string,
    expiresAt: row['expires_at'] as Date,
    confirmedAt: row['confirmed_at'] as Date | null,
    revision: Number(row['revision']),
  };
}

export class SubscriptionRepository {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly hotelId: string = uow.context.hotelId,
  ) {}

  async current(): Promise<SubscriptionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM platform.hotel_subscription WHERE hotel_id = $1`,
      [this.hotelId],
    );
    return mapSubscription(result.rows[0]);
  }

  /**
   * The subscription under a write lock.
   *
   * `LIFE-DEC-006`: a callback and the boundary worker take this same lock, so
   * only one of them is inside the critical section at a time. The billing
   * revision is then the compare-and-set that decides which one's transition
   * lands, and the loser sees zero rows rather than a silently reordered write.
   */
  async lock(): Promise<SubscriptionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM platform.hotel_subscription
        WHERE hotel_id = $1 FOR UPDATE`,
      [this.hotelId],
    );
    return mapSubscription(result.rows[0]);
  }

  /**
   * Applies a subscription change, fenced on the billing revision.
   *
   * Every field is optional and `COALESCE`d, so a renewal touches the expiry and
   * a boundary apply touches the package without either having to restate the
   * other. `clearPendingUpgrade` is separate from `pendingUpgradePackage`
   * because `COALESCE` cannot express "set this to NULL".
   */
  async apply(input: {
    expectedBillingRevision: number;
    effectivePackage?: PackageCode;
    packageFloor?: PackageCode;
    pendingUpgradePackage?: PackageCode;
    pendingUpgradeEffectiveAt?: Date;
    clearPendingUpgrade?: boolean;
    startsAt?: Date;
    expiresAt?: Date;
    termMonths?: number;
    suspendedAt?: Date | null;
    suspensionReason?: string | null;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_subscription
          SET effective_package = COALESCE($3, effective_package),
              package_floor = COALESCE($4, package_floor),
              pending_upgrade_package =
                CASE WHEN $7 THEN NULL ELSE COALESCE($5, pending_upgrade_package) END,
              pending_upgrade_effective_at =
                CASE WHEN $7 THEN NULL ELSE COALESCE($6, pending_upgrade_effective_at) END,
              starts_at = COALESCE($8, starts_at),
              expires_at = COALESCE($9, expires_at),
              term_months = COALESCE($10, term_months),
              suspended_at = CASE WHEN $12 THEN $11 ELSE suspended_at END,
              suspension_reason = CASE WHEN $12 THEN $13 ELSE suspension_reason END,
              billing_revision = billing_revision + 1,
              revision = revision + 1
        WHERE hotel_id = $1 AND billing_revision = $2`,
      [
        this.hotelId,
        input.expectedBillingRevision,
        input.effectivePackage ?? null,
        input.packageFloor ?? null,
        input.pendingUpgradePackage ?? null,
        input.pendingUpgradeEffectiveAt ?? null,
        input.clearPendingUpgrade === true,
        input.startsAt ?? null,
        input.expiresAt ?? null,
        input.termMonths ?? null,
        input.suspendedAt ?? null,
        input.suspendedAt !== undefined,
        input.suspensionReason ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async recordEvent(input: {
    subscriptionId: string;
    eventType:
      'PROVISIONED' | 'RENEWED' | 'UPGRADE_PAID' | 'UPGRADE_APPLIED' | 'SUSPENDED' | 'REACTIVATED';
    billingRevision: number;
    fromPackage?: PackageCode | null;
    toPackage?: PackageCode | null;
    fromExpiresAt?: Date | null;
    toExpiresAt?: Date | null;
    paymentId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.subscription_event
         (hotel_id, subscription_id, event_type, billing_revision, from_package, to_package,
          from_expires_at, to_expires_at, payment_id, actor_ref, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        this.hotelId,
        input.subscriptionId,
        input.eventType,
        input.billingRevision,
        input.fromPackage ?? null,
        input.toPackage ?? null,
        input.fromExpiresAt ?? null,
        input.toExpiresAt ?? null,
        input.paymentId ?? null,
        this.uow.context.actorRef,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }

  async events(subscriptionId: string): Promise<readonly { type: string; revision: number }[]> {
    const result = await this.uow.query<{ event_type: string; billing_revision: number }>(
      `SELECT event_type, billing_revision FROM platform.subscription_event
        WHERE hotel_id = $1 AND subscription_id = $2 ORDER BY event_id`,
      [this.hotelId, subscriptionId],
    );
    return result.rows.map((row) => ({
      type: row.event_type,
      revision: Number(row.billing_revision),
    }));
  }

  // ------------------------------------------------------------ billing intents

  async openIntent(input: {
    subscriptionId: string;
    kind: IntentKind;
    provider: PaymentProvider;
    merchantRef: string;
    providerInvoiceId: string;
    amountMnt: bigint;
    quotedBillingRevision: number;
    currentPackage: PackageCode;
    targetPackage: PackageCode;
    termMonths: number | null;
    monthlyPriceMnt: bigint;
    priceDeltaMnt: bigint | null;
    remainingServiceMonths: number | null;
    effectiveAt: Date | null;
    quotedExpiresAt: Date;
    vatRateBp: number;
    priceBookVersion: string;
    taxConfigVersion: string;
    packageFeatureVersion: string;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ intent_id: string }>(
      `INSERT INTO platform.subscription_billing_intent
         (hotel_id, subscription_id, kind, provider, merchant_ref, provider_invoice_id,
          amount_mnt, quoted_billing_revision, current_package, target_package, term_months,
          monthly_price_mnt, price_delta_mnt, remaining_service_months, effective_at,
          quoted_expires_at, vat_rate_bp, price_book_version, tax_config_version,
          package_feature_version, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               now() + make_interval(secs => $21))
       RETURNING intent_id`,
      [
        this.hotelId,
        input.subscriptionId,
        input.kind,
        input.provider,
        input.merchantRef,
        input.providerInvoiceId,
        input.amountMnt.toString(),
        input.quotedBillingRevision,
        input.currentPackage,
        input.targetPackage,
        input.termMonths,
        input.monthlyPriceMnt.toString(),
        input.priceDeltaMnt === null ? null : input.priceDeltaMnt.toString(),
        input.remainingServiceMonths,
        input.effectiveAt,
        input.quotedExpiresAt,
        input.vatRateBp,
        input.priceBookVersion,
        input.taxConfigVersion,
        input.packageFeatureVersion,
        input.ttlSeconds,
      ],
    );
    const intentId = result.rows[0]?.intent_id;
    if (intentId === undefined) throw new Error('the billing intent insert returned no row');
    return intentId;
  }

  async livePendingIntent(subscriptionId: string): Promise<IntentRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${INTENT_COLUMNS} FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND subscription_id = $2 AND state = 'PENDING'`,
      [this.hotelId, subscriptionId],
    );
    return mapIntent(result.rows[0]);
  }

  async lockIntentByInvoice(
    provider: PaymentProvider,
    providerInvoiceId: string,
  ): Promise<IntentRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${INTENT_COLUMNS} FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND provider = $2 AND provider_invoice_id = $3
          FOR UPDATE`,
      [this.hotelId, provider, providerInvoiceId],
    );
    return mapIntent(result.rows[0]);
  }

  async intentById(intentId: string): Promise<IntentRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${INTENT_COLUMNS} FROM platform.subscription_billing_intent
        WHERE hotel_id = $1 AND intent_id = $2`,
      [this.hotelId, intentId],
    );
    return mapIntent(result.rows[0]);
  }

  async settleIntent(input: {
    intentId: string;
    expectedRevision: number;
    state: IntentState;
    reason: string;
    providerPaymentId?: string | null;
    confirmedAt?: Date | null;
    providerFeeMnt?: bigint;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_billing_intent
          SET state = $3,
              terminal_at = CASE WHEN $3 = 'PENDING' THEN NULL ELSE COALESCE(terminal_at, now()) END,
              terminal_reason = $4,
              provider_payment_id = COALESCE(provider_payment_id, $5),
              confirmed_at = COALESCE(confirmed_at, $6),
              provider_fee_mnt = CASE WHEN confirmed_at IS NULL THEN COALESCE($8, provider_fee_mnt)
                                      ELSE provider_fee_mnt END,
              revision = revision + 1
        WHERE hotel_id = $1 AND intent_id = $2 AND revision = $7`,
      [
        this.hotelId,
        input.intentId,
        input.state,
        input.reason,
        input.providerPaymentId ?? null,
        input.confirmedAt ?? null,
        input.expectedRevision,
        input.providerFeeMnt === undefined ? null : input.providerFeeMnt.toString(),
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * doc 17 §4.4: cancels the live unpaid intent, if there is one.
   *
   * Called in the transaction that persists the replacement, after the
   * replacement's provider invoice durably exists — never before, so a
   * provider that fails to answer leaves the existing usable intent exactly as
   * it was. A quote that is superseded is `STALE`, not deleted: a late payment
   * on it has to find a row to attach a reconciliation case to.
   */
  async staleLiveIntent(subscriptionId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_billing_intent
          SET state = 'STALE', terminal_at = now(), terminal_reason = $3,
              revision = revision + 1
        WHERE hotel_id = $1 AND subscription_id = $2 AND state = 'PENDING'`,
      [this.hotelId, subscriptionId, reason],
    );
    return result.rowCount;
  }

  async closeIntentReconciliation(input: {
    intentId: string;
    expectedRevision: number;
    outcome: 'PROVIDER_CORRECTED_NOT_PAID' | 'EXTERNALLY_VOIDED' | 'FINANCE_CLOSED_EXCEPTION';
    accountId: string;
    reason: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_billing_intent
          SET reconciliation_outcome = $3, reconciled_by_account_id = $4,
              reconciled_at = now(), reconciliation_reason = $5, revision = revision + 1
        WHERE hotel_id = $1 AND intent_id = $2 AND revision = $6
          AND state = 'PAID_REQUIRES_RECONCILIATION' AND reconciliation_outcome IS NULL`,
      [
        this.hotelId,
        input.intentId,
        input.outcome,
        input.accountId,
        input.reason,
        input.expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  // ------------------------------------------------------------------ payments

  /**
   * Records the immutable payment **and** its eBarimt issuance intent, in the
   * caller's transaction (`SUB-DEC-005`). A payment row without its intent
   * cannot exist, and a duplicate callback that reached here twice is stopped
   * by the payment's own unique key before either row is written.
   */
  async recordPayment(input: {
    subscriptionId: string;
    purpose: 'RENEWAL' | 'UPGRADE';
    provider: PaymentProvider;
    providerPaymentId: string;
    merchantRef: string;
    grossAmountMnt: bigint;
    vatAmountMnt: bigint;
    providerFeeMnt: bigint;
    vatRateBp: number;
    packageCode: PackageCode;
    termMonths: number | null;
    monthlyPriceMnt: bigint;
    priceBookVersion: string;
    taxConfigVersion: string;
    packageFeatureVersion: string;
    intentId: string;
    confirmedAt: Date;
  }): Promise<string> {
    const result = await this.uow.query<{ payment_id: string }>(
      `INSERT INTO platform.subscription_payment
         (hotel_id, subscription_id, purpose, provider, provider_payment_id, merchant_ref,
          gross_amount_mnt, vat_amount_mnt, provider_fee_mnt, net_amount_mnt, vat_rate_bp,
          package_code, term_months, monthly_price_mnt, price_book_version,
          tax_config_version, package_feature_version, intent_id, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7::bigint - $9::bigint,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING payment_id`,
      [
        this.hotelId,
        input.subscriptionId,
        input.purpose,
        input.provider,
        input.providerPaymentId,
        input.merchantRef,
        input.grossAmountMnt.toString(),
        input.vatAmountMnt.toString(),
        input.providerFeeMnt.toString(),
        input.vatRateBp,
        input.packageCode,
        input.termMonths,
        input.monthlyPriceMnt.toString(),
        input.priceBookVersion,
        input.taxConfigVersion,
        input.packageFeatureVersion,
        input.intentId,
        input.confirmedAt,
      ],
    );
    const paymentId = result.rows[0]?.payment_id;
    if (paymentId === undefined) throw new Error('the payment insert returned no row');
    await this.uow.query(
      `INSERT INTO platform.ebarimt_issuance (hotel_id, payment_id) VALUES ($1, $2)`,
      [this.hotelId, paymentId],
    );
    return paymentId;
  }

  async payments(): Promise<
    readonly {
      paymentId: string;
      purpose: string;
      grossAmountMnt: bigint;
      vatAmountMnt: bigint;
      providerFeeMnt: bigint;
      netAmountMnt: bigint;
    }[]
  > {
    const result = await this.uow.query<{
      payment_id: string;
      purpose: string;
      gross_amount_mnt: string;
      vat_amount_mnt: string;
      provider_fee_mnt: string;
      net_amount_mnt: string;
    }>(
      `SELECT payment_id, purpose, gross_amount_mnt, vat_amount_mnt, provider_fee_mnt,
              net_amount_mnt
         FROM platform.subscription_payment WHERE hotel_id = $1 ORDER BY confirmed_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => ({
      paymentId: row.payment_id,
      purpose: row.purpose,
      grossAmountMnt: BigInt(row.gross_amount_mnt),
      vatAmountMnt: BigInt(row.vat_amount_mnt),
      providerFeeMnt: BigInt(row.provider_fee_mnt),
      netAmountMnt: BigInt(row.net_amount_mnt),
    }));
  }

  // ------------------------------------------------------------------ listing

  async listingState(): Promise<
    { listingState: string; duplicateReviewRequired: boolean } | undefined
  > {
    const result = await this.uow.query<{
      listing_state: string;
      duplicate_review_required: boolean;
    }>(
      `SELECT listing_state, duplicate_review_required FROM platform.hotel_profile
        WHERE hotel_id = $1`,
      [this.hotelId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      listingState: row.listing_state,
      duplicateReviewRequired: row.duplicate_review_required,
    };
  }

  async defaultDrawer(): Promise<{ name: string; code: string } | undefined> {
    const result = await this.uow.query<{ name: string; code: string }>(
      `SELECT name, code FROM platform.cash_location
        WHERE hotel_id = $1 AND is_default_drawer IS TRUE`,
      [this.hotelId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { name: row.name, code: row.code };
  }
}

/**
 * Work due across every tenant, as identifiers.
 *
 * A background operation has to find its work before it can scope to it, and
 * every row it is looking for is tenant-scoped — so an unscoped scan sees
 * nothing, correctly. These go through the `SECURITY DEFINER` discovery
 * wrappers, which return identifiers and nothing else: no package, no amount,
 * no name, no address. Discovery is advisory; each item is then processed in
 * its own tenant-scoped transaction, where the row is locked, re-read and
 * claimed by compare-and-set.
 */
export async function dueUpgradeCandidates(
  uow: UnitOfWork,
  limit: number,
): Promise<readonly { hotelId: string; subscriptionId: string }[]> {
  const result = await uow.query<{ hotel_id: string; subscription_id: string }>(
    `SELECT hotel_id, subscription_id FROM platform.due_upgrade_boundaries($1)`,
    [limit],
  );
  return result.rows.map((row) => ({
    hotelId: row.hotel_id,
    subscriptionId: row.subscription_id,
  }));
}

export async function pendingActivationDeliveries(
  uow: UnitOfWork,
  limit: number,
): Promise<readonly { hotelId: string; deliveryId: string }[]> {
  const result = await uow.query<{ hotel_id: string; delivery_id: string }>(
    `SELECT hotel_id, delivery_id FROM platform.pending_activation_deliveries($1)`,
    [limit],
  );
  return result.rows.map((row) => ({ hotelId: row.hotel_id, deliveryId: row.delivery_id }));
}

export async function pendingEBarimtIssuances(
  uow: UnitOfWork,
  limit: number,
): Promise<readonly { hotelId: string; issuanceId: string }[]> {
  const result = await uow.query<{ hotel_id: string; issuance_id: string }>(
    `SELECT hotel_id, issuance_id FROM platform.pending_ebarimt_issuances($1)`,
    [limit],
  );
  return result.rows.map((row) => ({ hotelId: row.hotel_id, issuanceId: row.issuance_id }));
}

/** doc 16 §4.1 step 5: the receipts awaiting an operator, across every hotel. */
export async function manualEBarimtIssuances(
  uow: UnitOfWork,
  limit: number,
): Promise<
  readonly {
    hotelId: string;
    issuanceId: string;
    paymentId: string;
    lastError: string | null;
    createdAt: Date;
  }[]
> {
  const result = await uow.query<{
    hotel_id: string;
    issuance_id: string;
    payment_id: string;
    last_error: string | null;
    created_at: Date;
  }>(
    `SELECT hotel_id, issuance_id, payment_id, last_error, created_at
        FROM platform.manual_ebarimt_issuances($1)`,
    [limit],
  );
  return result.rows.map((row) => ({
    hotelId: row.hotel_id,
    issuanceId: row.issuance_id,
    paymentId: row.payment_id,
    lastError: row.last_error,
    createdAt: row.created_at,
  }));
}
