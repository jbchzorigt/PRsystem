import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import type { IssuedReceipt, PortError } from '@prsystem/ports';
import { derivedIdempotencyKey } from '../../iam/services/derived-key';
import type { CommandActor, OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase, backoffSeconds, portContext } from './onboarding-context';
import {
  manualEBarimtIssuances,
  pendingEBarimtDeliveries,
  pendingEBarimtIssuances,
} from '../repositories/subscription.repository';

/**
 * eBarimt issuance and its manual queue (doc 16 §4.1, `SUB-DEC-005`,
 * `SUB-DEC-008`).
 *
 * Two rules the code is shaped around.
 *
 * **A missing receipt never rolls anything back.** doc 16 §5 is explicit: a
 * confirmed payment activates the subscription whether or not the receipt
 * exists yet. So issuance is a queue entry created *with* the payment — in the
 * provisioning wrapper for the onboarding payment, in the same repository call
 * for a renewal or an upgrade — drained separately by the worker, and a failure
 * moves it to `MANUAL_RESOLUTION`, never to a reversed provisioning.
 *
 * **The operator writes nothing.** Every receipt field arrives from the port
 * together or not at all, the database refuses a partial set and refuses to
 * rewrite a complete one, and the retry surface takes no receipt parameters.
 * The only thing an operator holding `SUBSCRIPTION_EBARIMT_RETRY` can do is ask
 * the issuer again.
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
  readonly vatRateBp: number;
  readonly attempts: number;
  readonly adminEmail: string | null;
  readonly ownerRef: string;
  readonly ownerType: 'CITIZEN' | 'ORGANIZATION';
}

/** doc 18 §5: the one permission that reaches the queue and the retry. */
/** The catalogued Operation action whose named permission is `SUBSCRIPTION_EBARIMT_RETRY`. */
const RETRY_ACTION = 'operation.ebarimt_retry';

export class EBarimtService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  /** The worker's drain. Same leased design as every other queue in the platform. */
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
    processed += await this.drainDeliveries(limit, request);
    return processed;
  }

  /**
   * The delivery job (remediation 2, finding 4): an issued receipt whose mail
   * was never sent, or failed, is its own durable, retryable unit on the
   * issuance row — claimed with a lease, sent under the stable delivery id
   * `ebarimt-<issuanceId>`, settled by compare-and-set, and backed off on
   * failure. The receipt is never reissued to resend the mail.
   */
  async drainDeliveries(limit = 32, request?: RequestContext): Promise<number> {
    const scoped = request ?? {
      correlationId: `ebarimt-delivery-${randomUUID().slice(0, 8)}`,
    };
    const due = await this.inOperationScope(scoped, (uow) => pendingEBarimtDeliveries(uow, limit));
    let delivered = 0;
    for (const candidate of due) {
      const outcome = await this.deliverReceipt(candidate.hotelId, candidate.issuanceId, scoped);
      if (outcome !== 'not_claimable') delivered += 1;
    }
    return delivered;
  }

  async deliverReceipt(
    hotelId: string,
    issuanceId: string,
    request: RequestContext,
  ): Promise<'sent' | 'failed' | 'not_claimable'> {
    const claimToken = randomUUID();
    const claimed = await this.inHotelScope(hotelId, request, async (uow) => {
      const result = await uow.query<{
        payment_id: string;
        attempts: number;
        receipt_number: string;
        receipt_qr: string;
        receipt_amount_mnt: string;
        receipt_issued_at: Date;
        admin_email: string | null;
      }>(
        `WITH claimed AS (
           UPDATE platform.ebarimt_issuance
              SET delivery_claim_token = $2,
                  delivery_claimed_until = now() + make_interval(secs => $3),
                  delivery_attempts = delivery_attempts + 1, revision = revision + 1
            WHERE hotel_id = $1 AND issuance_id = $4
              AND state = 'ISSUED'
              AND delivery_state = ANY (ARRAY['PENDING'::text, 'FAILED'::text])
              AND delivery_available_at <= now()
              AND (delivery_claimed_until IS NULL OR delivery_claimed_until < now())
            RETURNING payment_id, delivery_attempts, receipt_number, receipt_qr,
                      receipt_amount_mnt, receipt_issued_at
         )
         SELECT c.payment_id, c.delivery_attempts AS attempts, c.receipt_number, c.receipt_qr,
                c.receipt_amount_mnt, c.receipt_issued_at, a.email_normalized AS admin_email
           FROM claimed c
           LEFT JOIN platform.hotel_admin_activation a ON a.hotel_id = $1`,
        [hotelId, claimToken, this.parameters.ebarimtLeaseSeconds, issuanceId],
      );
      return result.rows[0];
    });
    if (claimed === undefined) return 'not_claimable';

    const sent =
      claimed.admin_email === null
        ? { ok: true as const }
        : await this.deps.notifications.send(
            {
              kind: 'ebarimt_receipt',
              deliveryId: `ebarimt-${issuanceId}`,
              hotelId,
              paymentId: claimed.payment_id,
              emailNormalized: claimed.admin_email,
              receiptNumber: claimed.receipt_number,
              receiptQr: claimed.receipt_qr,
              totalMnt: claimed.receipt_amount_mnt,
              issuedAt: claimed.receipt_issued_at,
            },
            portContext(request),
          );

    const backoff = backoffSeconds(
      Number(claimed.attempts),
      this.parameters.ebarimtRetryBackoffSeconds,
      this.parameters.ebarimtRetryBackoffCeilingSeconds,
    );
    await this.inHotelScope(hotelId, request, async (uow) => {
      await uow.query(
        `UPDATE platform.ebarimt_issuance
            SET delivery_state = $3,
                delivered_at = CASE WHEN $3 = 'SENT' THEN now() ELSE NULL END,
                delivery_available_at = CASE WHEN $3 = 'SENT' THEN delivery_available_at
                                             ELSE now() + make_interval(secs => $4) END,
                delivery_claim_token = NULL, delivery_claimed_until = NULL,
                last_error = CASE WHEN $3 = 'SENT' THEN last_error ELSE 'delivery_failed' END,
                revision = revision + 1
          WHERE hotel_id = $1 AND issuance_id = $2 AND delivery_claim_token = $5`,
        [hotelId, issuanceId, sent.ok ? 'SENT' : 'FAILED', backoff, claimToken],
      );
      await recordPlatformAudit(uow, {
        action: 'subscription.ebarimt.delivery',
        outcome: sent.ok ? 'allowed' : 'failed',
        targetType: 'ebarimt_issuance',
        targetRef: issuanceId,
        // The recipient is recorded masked (doc 16 §4.1); the receipt number is
        // the reference a taxpayer quotes and is not a secret.
        payload: {
          paymentId: claimed.payment_id,
          recipient: maskEmail(claimed.admin_email ?? ''),
          receiptNumber: claimed.receipt_number,
          attempt: Number(claimed.attempts),
        },
      });
    });
    return sent.ok ? 'sent' : 'failed';
  }

  async processOne(
    hotelId: string,
    issuanceId: string,
    request: RequestContext,
  ): Promise<IssuanceOutcome> {
    const claimed = await this.claim(hotelId, issuanceId, request);
    if (claimed === undefined) return { kind: 'not_claimable' };

    const result = await this.deps.ebarimt.issue(
      {
        paymentId: claimed.paymentId,
        totalMnt: claimed.grossAmountMnt,
        vatBreakdown: { vatMnt: claimed.vatAmountMnt, vatRateBp: claimed.vatRateBp },
        buyer: { ownerRef: claimed.ownerRef, ownerType: claimed.ownerType },
        // Stable across every retry of this payment, so the issuer recognises a
        // repeat rather than producing a second receipt (doc 16 §6).
        idempotencyKey: derivedIdempotencyKey('subscription.ebarimt', claimed.paymentId),
      },
      portContext(request),
    );

    if (result.ok) {
      const settled = await this.settleIssued(hotelId, claimed, result.value, request);
      return settled ?? { kind: 'issued', receiptNumber: result.value.receiptNumber };
    }

    const reason = issuanceFailureReason(result.error);
    // A closed gate is a queue entry for an operator, exactly like a permanent
    // refusal — not something to retry into.
    const exhausted =
      result.error.kind === 'DISABLED' ||
      result.error.kind === 'REJECTED' ||
      result.error.kind === 'INVALID_SIGNATURE' ||
      result.error.kind === 'MISMATCH' ||
      claimed.attempts >= this.parameters.ebarimtMaxAutomaticAttempts;
    await this.settleUnissued(hotelId, claimed, exhausted, reason, request);
    return exhausted
      ? { kind: 'manual_resolution', reason }
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
        vat_rate_bp: number;
        admin_email: string | null;
        owner_id: string;
        owner_type: 'CITIZEN' | 'ORGANIZATION';
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
                p.gross_amount_mnt, p.vat_amount_mnt, p.vat_rate_bp,
                a.email_normalized AS admin_email,
                l.owner_id, l.owner_type
           FROM claimed c
           JOIN platform.subscription_payment p
             ON p.hotel_id = $1 AND p.payment_id = c.payment_id
           JOIN platform.hotel_owner_link l ON l.hotel_id = $1
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
        vatRateBp: Number(row.vat_rate_bp),
        attempts: Number(row.attempts),
        adminEmail: row.admin_email,
        ownerRef: row.owner_id,
        ownerType: row.owner_type,
      };
    });
  }

  private async settleIssued(
    hotelId: string,
    claimed: ClaimedIssuance,
    receipt: IssuedReceipt,
    request: RequestContext,
  ): Promise<IssuanceOutcome | undefined> {
    // doc 16 §6: the receipt's amount must equal the confirmed payment's final
    // amount. An issuer that answered with a different figure has not issued a
    // receipt for this payment, and storing it would make the two disagree.
    if (receipt.totalMnt !== claimed.grossAmountMnt) {
      await this.settleUnissued(hotelId, claimed, true, 'receipt_amount_mismatch', request);
      return { kind: 'manual_resolution', reason: 'receipt_amount_mismatch' };
    }

    const recorded = await this.inHotelScope(hotelId, request, async (uow) => {
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
          receipt.totalMnt.toString(),
          receipt.vatMnt.toString(),
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
    if (!recorded) return undefined;

    // doc 16 §4.1 step 7: the receipt is emailed **only after** it officially
    // exists, through its own template — by the delivery job, which is durable
    // on the row that just committed. A crash here, a mail outage or a lost
    // acknowledgement leaves an issued receipt with a delivery the next drain
    // retries under the same identity (remediation 2, finding 4).
    await this.deliverReceipt(hotelId, claimed.issuanceId, request);
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

  // ============================================================ the operator

  /**
   * doc 16 §4.1 step 5: the queue an operator works from, across every hotel.
   *
   * An Operation action — realm, column, the explicit `SUBSCRIPTION_EBARIMT_RETRY`
   * grant and a recent step-up — evaluated by the Phase 04 pipeline, and
   * audited as a read: an operator seeing the queue is an operator seeing
   * which payments have no receipt.
   */
  async manualQueue(
    actor: CommandActor,
    request: RequestContext,
  ): Promise<
    readonly {
      hotelId: string;
      issuanceId: string;
      paymentId: string;
      lastError: string | null;
      createdAt: Date;
    }[]
  > {
    return this.runOperationCommand(
      actor,
      RETRY_ACTION,
      { targetType: 'ebarimt_queue', targetRef: 'manual_resolution' },
      request,
      async (uow) => {
        const items = await manualEBarimtIssuances(uow, 256);
        await recordPlatformAudit(uow, {
          action: 'subscription.ebarimt.queue_read',
          outcome: 'allowed',
          targetType: 'ebarimt_queue',
          targetRef: 'manual_resolution',
          payload: { items: items.length },
        });
        return items;
      },
    );
  }

  /**
   * `SUB-DEC-008`: the operator's retry.
   *
   * Takes an issuance and the actor, and nothing else. There is deliberately no
   * parameter for a receipt number, a QR, a tax figure or a payment reference —
   * so the flow doc 16 §4.1 forbids has no surface to happen through. The
   * permission, the realm and the step-up are the Phase 04 pipeline's decision,
   * and the request is audited before the issuer is asked again.
   */
  async retry(
    hotelId: string,
    issuanceId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<IssuanceOutcome> {
    const accountId = actor.principal.accountId;
    // The authorization, its audit and the reopening commit together, under
    // the Operation realm (remediation 2, finding 5). What follows — asking the
    // issuer again — is the issuance job, run as the worker would run it.
    await this.runOperationCommand(
      actor,
      RETRY_ACTION,
      { targetType: 'ebarimt_issuance', targetRef: issuanceId },
      request,
      async (uow) => {
        await recordPlatformAudit(uow, {
          action: 'subscription.ebarimt.retry_requested',
          outcome: 'allowed',
          targetType: 'ebarimt_issuance',
          targetRef: issuanceId,
          payload: { hotelId, accountId },
        });
        const result = await uow.query(
          `UPDATE platform.ebarimt_issuance
              SET state = 'PENDING', available_at = now(), retried_by_account_id = $3,
                  revision = revision + 1
            WHERE hotel_id = $1 AND issuance_id = $2 AND state = 'MANUAL_RESOLUTION'`,
          [hotelId, issuanceId, accountId],
        );
        if (result.rowCount !== 1) {
          throw new ApiError('CONFLICT', 'this issuance is not awaiting manual resolution');
        }
      },
    );
    return this.processOne(hotelId, issuanceId, { ...request, accountId });
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

function issuanceFailureReason(error: PortError): string {
  switch (error.kind) {
    case 'DISABLED':
      return 'adapter_unavailable';
    case 'REJECTED':
      return `issuer_rejected:${error.providerCode}`;
    default:
      return error.kind.toLowerCase();
  }
}

/** `a****@example.test` — the recorded recipient, never the address. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}
