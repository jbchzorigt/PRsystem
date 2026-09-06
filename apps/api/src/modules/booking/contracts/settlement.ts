import type { UnitOfWork } from '@prsystem/db';

/**
 * The money a booking makes, for the module that runs the booking's lifecycle
 * but does not own the ledger (CLAUDE.md §3).
 *
 * Every method takes the caller's `UnitOfWork`, because each of these has to
 * happen in the same transaction as the lifecycle change that caused it. A
 * confirmation that recorded the payment but failed to open the payable would
 * leave money received and nobody owed it; a cancellation that released the
 * inventory but failed to raise the refund would leave the guest paid up for a
 * booking that no longer exists.
 */

/** doc 11 §3: the rate a booking is settled at, snapshotted at confirmation. */
export interface CommissionContract {
  readonly contractId: string;
  readonly contractVersion: number;
  readonly commissionRateBps: number;
  readonly cancellationPolicyVersion: number;
}

export interface ConfirmedPayment {
  readonly hotelId: string;
  readonly bookingId: string;
  /** What the guest was actually charged, VAT-inclusive (doc 11 §3). */
  readonly grossPaidMnt: bigint;
  readonly provider: 'QPAY' | 'KHAAN';
  readonly providerPaymentId: string;
  /** The platform's cost, when the provider reported one (`BK-DEC-011`). */
  readonly providerFeeMnt: bigint;
  readonly contract: CommissionContract;
}

export type SettlementRefundReason =
  | 'GUEST_CANCELLATION'
  | 'LATE_CANCELLATION_BALANCE'
  | 'NO_SHOW_BALANCE'
  | 'HOTEL_CANCELLATION'
  | 'LATE_PAYMENT_AFTER_HOLD'
  | 'DUPLICATE_CAPTURE';

/** What a terminal transition leaves behind: a retained fee and a refund owed. */
export interface Retention {
  readonly hotelId: string;
  readonly bookingId: string;
  readonly refundMnt: bigint;
  readonly reason: SettlementRefundReason;
  /** The cause, so a repeated command raises no second obligation. */
  readonly sourceRef: string;
  readonly at: Date;
  /** The hotel-local day, for the `D+1` batch this would fall into. */
  readonly localDate: string;
}

/**
 * Money that arrived outside a booking's own payment (`PAY-DEC-006`).
 *
 * A late capture on an expired booking and a second capture on a paid one are
 * both fully owed back, and neither belongs to the payable: the hotel earns
 * what the *first valid* payment earned, whatever the provider charged twice.
 */
export interface UnmatchedCapture {
  readonly hotelId: string;
  readonly bookingId: string;
  readonly amountMnt: bigint;
  readonly reason: 'LATE_PAYMENT_AFTER_HOLD' | 'DUPLICATE_CAPTURE';
  readonly provider: 'QPAY' | 'KHAAN';
  readonly providerPaymentId: string;
  readonly sourceRef: string;
}

export interface SettlementPort {
  /**
   * The hotel's active commission contract, or nothing.
   *
   * Nothing is what refuses the payment (`PAY-DEC-001`, `BK-DEC-008`). There is
   * no default rate to fall back to, here or anywhere below this line.
   */
  contractFor(uow: UnitOfWork, at: Date): Promise<CommissionContract | undefined>;

  /** Opens the payable and posts the four events a confirmation produces. */
  openPayable(uow: UnitOfWork, input: ConfirmedPayment): Promise<void>;

  /**
   * Records what a terminal transition retained, and what it owes back.
   *
   * The payable's own figures do not move here: doc 11 §5 keeps the refund on
   * its own axis until a verified provider result completes it, so the payable
   * is held rather than reduced against money the guest has not yet received.
   */
  recordRetention(uow: UnitOfWork, input: Retention): Promise<void>;

  /** Raises the full refund a late or duplicate capture owes. */
  raiseUnmatchedRefund(uow: UnitOfWork, input: UnmatchedCapture): Promise<void>;

  /**
   * doc 11 §8: the stay completed and the checkout is recorded, so the retained
   * room charge becomes payout-eligible.
   */
  markEligible(
    uow: UnitOfWork,
    input: { bookingId: string; at: Date; localDate: string },
  ): Promise<void>;
}

/**
 * The default until Phase 14: no relation, no ledger — and a relation with no
 * implementation behind it is a refusal, never a silent success. A confirmation
 * that opened no payable would take the guest's money and owe the hotel
 * nothing, which is the one outcome this module must not be able to produce.
 */
export class UnprovisionedSettlement implements SettlementPort {
  async contractFor(uow: UnitOfWork): Promise<CommissionContract | undefined> {
    await this.refuseOnceProvisioned(uow, 'read a hotel commission contract');
    return undefined;
  }

  async openPayable(uow: UnitOfWork): Promise<void> {
    await this.refuseOnceProvisioned(uow, 'open a booking payable');
  }

  async recordRetention(uow: UnitOfWork): Promise<void> {
    await this.refuseOnceProvisioned(uow, 'record what a terminal booking retained');
  }

  async raiseUnmatchedRefund(uow: UnitOfWork): Promise<void> {
    await this.refuseOnceProvisioned(uow, 'raise a refund obligation');
  }

  async markEligible(uow: UnitOfWork): Promise<void> {
    await this.refuseOnceProvisioned(uow, 'make a payable payout-eligible');
  }

  private async refuseOnceProvisioned(uow: UnitOfWork, action: string): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking_payable') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) {
      throw new Error(
        `platform.booking_payable exists: a booking must ${action} through a real ` +
          'SettlementPort (Phase 14), not this default',
      );
    }
  }
}
