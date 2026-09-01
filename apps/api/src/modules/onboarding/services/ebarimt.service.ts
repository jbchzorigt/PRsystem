import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase, backoffSeconds } from './onboarding-context';
import { pendingEBarimtIssuances } from '../repositories/subscription.repository';

/**
 * eBarimt issuance and its manual queue (doc 16 §4.1, `SUB-DEC-005`,
 * `SUB-DEC-008`).
 *
 * Two rules the code is shaped around.
 *
 * **A missing receipt never rolls anything back.** doc 16 §5 is explicit: a
 * confirmed payment activates the subscription whether or not the receipt
 * exists yet. So issuance is a queue entry created beside the payment, drained
 * separately, and a failure moves it to `MANUAL_RESOLUTION` — never to a
 * reversed provisioning.
 *
 * **The operator writes nothing.** Every receipt field arrives from the port
 * together or not at all, the database refuses a partial set and refuses to
 * rewrite a complete one, and the retry API takes no receipt parameters. The
 * only thing an operator with `SUBSCRIPTION_EBARIMT_RETRY` can do is ask the
 * issuer again.
 */

export type IssuanceOutcome =
  | { readonly kind: 'issued'; readonly receiptNumber: string }
  | { readonly kind: 'retry_scheduled'; readonly attempts: number }
  | { readonly kind: 'manual_resolution'; readonly reason: string }
  | { readonly kind: 'not_claimable' };

interface ClaimedIssuance {
  readonly issuanceId: string;
  readonly claimToken: string;
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly merchantRef: string;
  readonly grossAmountMnt: bigint;
  readonly vatAmountMnt: bigint;
  readonly attempts: number;
  readonly adminEmail: string | null;
}

export class EBarimtService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  /**
   * `SUB-DEC-005`: opens the issuance intent for a confirmed payment.
   *
   * One per payment, enforced by a unique key rather than by this call being
   * made once — a duplicate callback that reached here twice creates one row.
   */
  async openIssuance(hotelId: string, paymentId: string, request: RequestContext): Promise<void> {
    await this.inHotelScope(hotelId, request, async (uow) => {
      await uow.query(
        `INSERT INTO platform.ebarimt_issuance (hotel_id, payment_id)
         VALUES ($1, $2)
         ON CONFLICT (hotel_id, payment_id) DO NOTHING`,
        [hotelId, paymentId],
      );
    });
  }

  /** Drains the queue. Same leased design as every other queue in the platform. */
  async drain(limit = 32): Promise<number> {
    const request: RequestContext = { correlationId: `ebarimt-drain-${randomUUID().slice(0, 8)}` };
    const candidates = await this.inOperationScope(request, (uow) =>
      pendingEBarimtIssuances(uow, limit),
    );

    let processed = 0;
    for (const candidate of candidates) {
      const outcome = await this.processOne(candidate.hotelId, candidate.issuanceId, request);
      if (outcome.kind !== 'not_claimable') processed += 1;
    }
    return processed;
  }

  async processOne(
    hotelId: string,
    issuanceId: string,
    request: RequestContext,
  ): Promise<IssuanceOutcome> {
    const claimed = await this.claim(hotelId, issuanceId, request);
    if (claimed === undefined) return { kind: 'not_claimable' };

    let result;
    try {
      result = await this.deps.ebarimt.issue({
        paymentId: claimed.paymentId,
        providerPaymentId: claimed.providerPaymentId,
        merchantRef: claimed.merchantRef,
        grossAmountMnt: claimed.grossAmountMnt,
        vatAmountMnt: claimed.vatAmountMnt,
        currency: 'MNT',
        // Stable across every retry of this payment, so the issuer recognises a
        // repeat rather than producing a second receipt (doc 16 §6).
        idempotencyKey: derivedIdempotencyKey('subscription.ebarimt', claimed.paymentId),
      });
    } catch {
      // The gate being closed reaches here as a rejection. It is a queue entry
      // for an operator, exactly like an issuer outage — not a failed payment.
      result = { outcome: 'retryable' as const, reason: 'adapter_unavailable' };
    }

    if (result.outcome === 'issued') {
      const settled = await this.settleIssued(hotelId, claimed, result.receipt, request);
      // `settleIssued` can still refuse: doc 16 §6 requires the receipt's amount
      // to equal the payment's, and an issuer that answered with a different
      // figure has not issued this payment's receipt. Reporting `issued` there
      // would be the service agreeing with a document the database refused.
      return settled ?? { kind: 'issued', receiptNumber: result.receipt.receiptNumber };
    }

    const exhausted =
      result.outcome === 'permanent' ||
      claimed.attempts >= this.parameters.ebarimtMaxAutomaticAttempts;
    await this.settleUnissued(hotelId, claimed, exhausted, result.reason, request);
    return exhausted
      ? { kind: 'manual_resolution', reason: result.reason }
      : { kind: 'retry_scheduled', attempts: claimed.attempts };
  }

  private async claim(
    hotelId: string,
    issuanceId: string,
    request: RequestContext,
  ): Promise<ClaimedIssuance | undefined> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimToken = randomUUID();
      const result = await uow.query<{
        issuance_id: string;
        payment_id: string;
        attempts: number;
        provider_payment_id: string;
        merchant_ref: string;
        gross_amount_mnt: string;
        vat_amount_mnt: string;
        admin_email: string | null;
      }>(
        `WITH claimed AS (
           UPDATE platform.ebarimt_issuance
              SET state = 'CLAIMED', claim_token = $2,
                  claimed_until = now() + make_interval(secs => $3),
                  attempts = attempts + 1, revision = revision + 1
            WHERE hotel_id = $1 AND issuance_id = $4
              AND state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])
              AND available_at <= now()
              AND (claimed_until IS NULL OR claimed_until < now())
            RETURNING issuance_id, payment_id, attempts
         )
         SELECT c.issuance_id, c.payment_id, c.attempts,
                p.provider_payment_id, p.merchant_ref,
                p.gross_amount_mnt, p.vat_amount_mnt,
                a.email_normalized AS admin_email
           FROM claimed c
           JOIN platform.subscription_payment p
             ON p.hotel_id = $1 AND p.payment_id = c.payment_id
           LEFT JOIN platform.hotel_admin_activation a ON a.hotel_id = $1`,
        [hotelId, claimToken, this.parameters.ebarimtLeaseSeconds, issuanceId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        issuanceId: row.issuance_id,
        claimToken,
        paymentId: row.payment_id,
        providerPaymentId: row.provider_payment_id,
        merchantRef: row.merchant_ref,
        grossAmountMnt: BigInt(row.gross_amount_mnt),
        vatAmountMnt: BigInt(row.vat_amount_mnt),
        attempts: Number(row.attempts),
        adminEmail: row.admin_email,
      };
    });
  }

  private async settleIssued(
    hotelId: string,
    claimed: ClaimedIssuance,
    receipt: {
      receiptNumber: string;
      qr: string;
      amountMnt: bigint;
      vatAmountMnt: bigint;
      issuedAt: Date;
    },
    request: RequestContext,
  ): Promise<IssuanceOutcome | undefined> {
    // doc 16 §6: the receipt's amount must equal the confirmed payment's final
    // amount. An issuer that answered with a different figure has not issued a
    // receipt for this payment, and storing it would make the two disagree.
    if (receipt.amountMnt !== claimed.grossAmountMnt) {
      await this.settleUnissued(hotelId, claimed, true, 'receipt_amount_mismatch', request);
      return { kind: 'manual_resolution', reason: 'receipt_amount_mismatch' };
    }

    const delivered = await this.inHotelScope(hotelId, request, async (uow) => {
      const result = await uow.query(
        `UPDATE platform.ebarimt_issuance
            SET state = 'ISSUED', claim_token = NULL, claimed_until = NULL,
                receipt_number = $3, receipt_qr = $4, receipt_amount_mnt = $5,
                receipt_vat_amount_mnt = $6, receipt_issued_at = $7,
                last_error = NULL, revision = revision + 1
          WHERE hotel_id = $1 AND issuance_id = $2 AND claim_token = $8
            AND receipt_number IS NULL`,
        [
          hotelId,
          claimed.issuanceId,
          receipt.receiptNumber,
          receipt.qr,
          receipt.amountMnt.toString(),
          receipt.vatAmountMnt.toString(),
          receipt.issuedAt,
          claimed.claimToken,
        ],
      );
      if (result.rowCount !== 1) return false;
      await recordPlatformAudit(uow, {
        action: 'subscription.ebarimt.issued',
        outcome: 'allowed',
        targetType: 'ebarimt_issuance',
        targetRef: claimed.issuanceId,
        payload: { paymentId: claimed.paymentId, receiptNumber: receipt.receiptNumber },
      });
      return true;
    });
    if (!delivered) return undefined;

    // doc 16 §4.1 step 7: the receipt is emailed **only after** it officially
    // exists. The send is outside the transaction that recorded it, so a mail
    // outage leaves an issued receipt with a pending delivery rather than an
    // unissued one.
    if (claimed.adminEmail === null) return undefined;
    try {
      await this.deps.notifications.deliver({
        kind: 'password_reset',
        deliveryId: `ebarimt-${claimed.issuanceId}`,
        accountId: claimed.paymentId,
        resetId: claimed.issuanceId,
        emailNormalized: claimed.adminEmail,
        expiresAt: receipt.issuedAt,
        // The receipt number is the deliverable, and it is not a secret: it is
        // the reference a taxpayer quotes. No token, no link, no credential.
        token: receipt.receiptNumber,
      });
      await this.inHotelScope(hotelId, request, async (uow) => {
        await uow.query(
          `UPDATE platform.ebarimt_issuance
              SET delivery_state = 'SENT', delivered_at = now(), revision = revision + 1
            WHERE hotel_id = $1 AND issuance_id = $2 AND delivery_state = 'PENDING'`,
          [hotelId, claimed.issuanceId],
        );
      });
    } catch {
      await this.inHotelScope(hotelId, request, async (uow) => {
        await uow.query(
          `UPDATE platform.ebarimt_issuance
              SET delivery_state = 'FAILED', last_error = 'delivery_failed',
                  revision = revision + 1
            WHERE hotel_id = $1 AND issuance_id = $2 AND delivery_state = 'PENDING'`,
          [hotelId, claimed.issuanceId],
        );
      });
    }
    return undefined;
  }

  private async settleUnissued(
    hotelId: string,
    claimed: ClaimedIssuance,
    exhausted: boolean,
    reason: string,
    request: RequestContext,
  ): Promise<void> {
    const backoff = backoffSeconds(
      claimed.attempts,
      this.parameters.ebarimtRetryBackoffSeconds,
      this.parameters.ebarimtRetryBackoffCeilingSeconds,
    );
    await this.inHotelScope(hotelId, request, async (uow) => {
      await uow.query(
        `UPDATE platform.ebarimt_issuance
            SET state = $3, claim_token = NULL, claimed_until = NULL,
                available_at = CASE WHEN $3 = 'PENDING'
                                    THEN now() + make_interval(secs => $4)
                                    ELSE available_at END,
                last_error = $5, revision = revision + 1
          WHERE hotel_id = $1 AND issuance_id = $2 AND claim_token = $6`,
        [
          hotelId,
          claimed.issuanceId,
          exhausted ? 'MANUAL_RESOLUTION' : 'PENDING',
          backoff,
          reason,
          claimed.claimToken,
        ],
      );
      if (exhausted) {
        await recordPlatformAudit(uow, {
          action: 'subscription.ebarimt.manual_resolution',
          outcome: 'failed',
          targetType: 'ebarimt_issuance',
          targetRef: claimed.issuanceId,
          reason,
        });
      }
    });
  }

  /**
   * `SUB-DEC-008`: the operator's retry.
   *
   * Takes an issuance and an account, and nothing else. There is deliberately no
   * parameter for a receipt number, a QR, a tax figure or a payment reference —
   * so the flow doc 16 §4.1 forbids ("Оператор eBarimt-ийн дугаар, QR, татварын
   * дүн болон payment reference-ийг гараар зохиохгүй") has no surface to happen
   * through. The permission and the step-up are checked above this layer.
   */
  async retry(
    hotelId: string,
    issuanceId: string,
    accountId: string,
    request: RequestContext,
  ): Promise<IssuanceOutcome> {
    const reopened = await this.inHotelScope(hotelId, { ...request, accountId }, async (uow) => {
      const result = await uow.query(
        `UPDATE platform.ebarimt_issuance
            SET state = 'PENDING', available_at = now(), retried_by_account_id = $3,
                revision = revision + 1
          WHERE hotel_id = $1 AND issuance_id = $2 AND state = 'MANUAL_RESOLUTION'`,
        [hotelId, issuanceId, accountId],
      );
      if (result.rowCount !== 1) return false;
      await recordPlatformAudit(uow, {
        action: 'subscription.ebarimt.retry_requested',
        outcome: 'allowed',
        targetType: 'ebarimt_issuance',
        targetRef: issuanceId,
        payload: { accountId },
      });
      return true;
    });
    if (!reopened)
      throw new ApiError('CONFLICT', 'this issuance is not awaiting manual resolution');
    return this.processOne(hotelId, issuanceId, { ...request, accountId });
  }

  /** doc 16 §4.1 step 5: the queue an operator works from. */
  async manualQueue(
    hotelId: string,
    request: RequestContext,
  ): Promise<readonly { issuanceId: string; paymentId: string; lastError: string | null }[]> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const result = await uow.query<{
        issuance_id: string;
        payment_id: string;
        last_error: string | null;
      }>(
        `SELECT issuance_id, payment_id, last_error FROM platform.ebarimt_issuance
          WHERE hotel_id = $1 AND state = 'MANUAL_RESOLUTION' ORDER BY created_at`,
        [hotelId],
      );
      return result.rows.map((row) => ({
        issuanceId: row.issuance_id,
        paymentId: row.payment_id,
        lastError: row.last_error,
      }));
    });
  }

  async issuanceFor(
    hotelId: string,
    paymentId: string,
    request: RequestContext,
  ): Promise<
    | {
        issuanceId: string;
        state: string;
        receiptNumber: string | null;
        deliveryState: string;
        attempts: number;
      }
    | undefined
  > {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const result = await uow.query<{
        issuance_id: string;
        state: string;
        receipt_number: string | null;
        delivery_state: string;
        attempts: number;
      }>(
        `SELECT issuance_id, state, receipt_number, delivery_state, attempts
           FROM platform.ebarimt_issuance WHERE hotel_id = $1 AND payment_id = $2`,
        [hotelId, paymentId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        issuanceId: row.issuance_id,
        state: row.state,
        receiptNumber: row.receipt_number,
        deliveryState: row.delivery_state,
        attempts: Number(row.attempts),
      };
    });
  }
}
