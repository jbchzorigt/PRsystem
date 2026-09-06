import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { SettlementRepository } from '../repositories/settlement.repository';
import type { PayableRow } from '../repositories/settlement.repository';
import { payableFigures, payoutStateAfterSettlement } from '../domain/settlement';
import type { RefundReason } from '../domain/settlement';

/**
 * The money side of a booking's lifecycle (doc 11 §§3, 7–9).
 *
 * Every method here runs inside the caller's transaction — the booking's own —
 * because each is the money half of a lifecycle change and neither half may
 * survive without the other.
 *
 * The one rule that shapes all of it: **a payable's figures move only when
 * money actually moved.** A cancellation raises an obligation and holds the
 * payout; it does not reduce the commission base against a refund the guest has
 * not received. That is what makes the commission "the VAT-inclusive room
 * charge actually retained" (doc 11 §3) rather than the charge somebody
 * intended to retain.
 */
export class SettlementService {
  /**
   * doc 11 §3: the payment is confirmed, so the rate is snapshotted and the
   * four events a confirmation produces are posted.
   *
   * `source_ref` is the provider's own payment id, so the captured transaction
   * enters the ledger exactly once however many times the callback arrives.
   */
  async openPayable(
    uow: UnitOfWork,
    input: {
      hotelId: string;
      bookingId: string;
      grossPaidMnt: bigint;
      providerFeeMnt: bigint;
      provider: 'QPAY' | 'KHAAN';
      providerPaymentId: string;
      contract: {
        contractId: string;
        contractVersion: number;
        commissionRateBps: number;
      };
    },
  ): Promise<PayableRow> {
    const repository = new SettlementRepository(uow);
    const figures = payableFigures(input.grossPaidMnt, 0n, input.contract.commissionRateBps);
    const payable = await repository.createPayable({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      contractId: input.contract.contractId,
      contractVersion: input.contract.contractVersion,
      commissionRateBps: input.contract.commissionRateBps,
      grossPaidMnt: input.grossPaidMnt,
      retainedMnt: figures.retainedMnt,
      commissionMnt: figures.commissionMnt,
      hotelPayableMnt: figures.hotelPayableMnt,
      providerFeeMnt: input.providerFeeMnt,
    });

    const cause = `capture:${input.providerPaymentId}`;
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'PAYMENT',
      amountMnt: input.grossPaidMnt,
      sourceRef: cause,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
    });
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'COMMISSION',
      amountMnt: figures.commissionMnt,
      sourceRef: cause,
    });
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'HOTEL_PAYABLE',
      amountMnt: figures.hotelPayableMnt,
      sourceRef: cause,
    });
    // `BK-DEC-011`: the platform's cost, on its own line. A fee of zero is a
    // fee the provider reported as zero; an unreported fee posts nothing rather
    // than inventing one.
    if (input.providerFeeMnt > 0n) {
      await repository.post({
        hotelId: input.hotelId,
        bookingId: input.bookingId,
        payableId: payable.payableId,
        eventType: 'PROVIDER_FEE',
        amountMnt: input.providerFeeMnt,
        sourceRef: cause,
        provider: input.provider,
        providerPaymentId: input.providerPaymentId,
      });
    }
    await recordPlatformAudit(uow, {
      action: 'settlement.payable_opened',
      outcome: 'allowed',
      targetType: 'booking',
      targetRef: input.bookingId,
      payload: {
        contractVersion: input.contract.contractVersion,
        commissionRateBps: input.contract.commissionRateBps,
        commissionMnt: figures.commissionMnt.toString(),
        hotelPayableMnt: figures.hotelPayableMnt.toString(),
      },
    });
    return payable;
  }

  /**
   * `PAY-DEC-007`: what a terminal transition retained, and what it owes back.
   *
   * A refund owed puts the payable on hold (doc 11 §8). A retention with
   * nothing to refund — a late cancellation of a one-night booking — is settled
   * already, so the retained amount becomes eligible here and now.
   */
  async recordRetention(
    uow: UnitOfWork,
    input: {
      hotelId: string;
      bookingId: string;
      refundMnt: bigint;
      reason: RefundReason;
      sourceRef: string;
      at: Date;
      localDate: string;
    },
  ): Promise<void> {
    const repository = new SettlementRepository(uow);
    const payable = await repository.lockPayableForBooking(input.bookingId);
    // A booking that never confirmed has no payable and owes nothing: the money
    // it did not take is not money to give back.
    if (payable === undefined) return;

    if (input.refundMnt <= 0n) {
      await this.makeEligible(uow, payable, input.at, input.localDate);
      return;
    }

    // The refund goes back to the transaction that took the money, so the
    // provider is the ledger's, never the caller's.
    const captured = await repository.capturedPayment(input.bookingId);
    if (captured === undefined) {
      throw new ApiError('PRECONDITION_FAILED', 'the booking carries no captured payment');
    }
    const { created } = await repository.createRefund({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      reason: input.reason,
      amountMnt: input.refundMnt,
      provider: captured.provider,
      providerPaymentId: captured.providerPaymentId,
      sourceRef: input.sourceRef,
    });
    if (!created) return;

    const held = await repository.updatePayable({
      payableId: payable.payableId,
      expectedRevision: payable.revision,
      payoutState: 'HELD',
      holdReason: `refund ${input.reason}`,
    });
    if (!held) throw new ApiError('CONFLICT', 'the payable changed under this command');

    await appendOutboxEvent(uow, {
      aggregateType: 'booking',
      aggregateId: input.bookingId,
      eventType: 'settlement.refund_required',
      payload: {
        bookingId: input.bookingId,
        hotelId: input.hotelId,
        reason: input.reason,
        amountMnt: input.refundMnt.toString(),
      },
    });
  }

  /**
   * `PAY-DEC-006`: money that arrived outside the booking's own payment.
   *
   * It names no payable, so it reduces no commission base: the hotel earns what
   * the first valid payment earned, and the platform owes the guest the rest.
   */
  async raiseUnmatchedRefund(
    uow: UnitOfWork,
    input: {
      hotelId: string;
      bookingId: string;
      amountMnt: bigint;
      reason: 'LATE_PAYMENT_AFTER_HOLD' | 'DUPLICATE_CAPTURE';
      provider: 'QPAY' | 'KHAAN';
      providerPaymentId: string;
      sourceRef: string;
    },
  ): Promise<void> {
    if (input.amountMnt <= 0n) return;
    const repository = new SettlementRepository(uow);
    const { created } = await repository.createRefund({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: null,
      reason: input.reason,
      amountMnt: input.amountMnt,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      sourceRef: input.sourceRef,
    });
    if (!created) return;
    await appendOutboxEvent(uow, {
      aggregateType: 'booking',
      aggregateId: input.bookingId,
      eventType: 'settlement.refund_required',
      payload: {
        bookingId: input.bookingId,
        hotelId: input.hotelId,
        reason: input.reason,
        amountMnt: input.amountMnt.toString(),
      },
    });
  }

  /** doc 11 §8: the stay completed, so the retained room charge may be paid. */
  async markEligible(
    uow: UnitOfWork,
    input: { bookingId: string; at: Date; localDate: string },
  ): Promise<void> {
    const repository = new SettlementRepository(uow);
    const payable = await repository.lockPayableForBooking(input.bookingId);
    if (payable === undefined) return;
    await this.makeEligible(uow, payable, input.at, input.localDate);
  }

  /**
   * Puts a payable in the state its own numbers say it is in.
   *
   * `HELD` wins over everything: doc 11 §8 holds a payout while any refund or
   * reconciliation is still open, whatever the stay did.
   */
  private async makeEligible(
    uow: UnitOfWork,
    payable: PayableRow,
    at: Date,
    localDate: string,
  ): Promise<void> {
    const repository = new SettlementRepository(uow);
    // A payable inside a live batch is left alone: the batch's own settlement
    // recomputes it from whatever the figures are by then. A payable that has
    // already been *paid* is not left alone — a refund landing after a payout
    // is exactly `PAY-DEC-009`'s negative adjustment, and skipping it here
    // would leave the hotel holding money the booking no longer earned.
    if (payable.payoutState === 'BATCHED') return;
    const open = await repository.hasOpenRefund(payable.bookingId);
    const next = open
      ? 'HELD'
      : payoutStateAfterSettlement(payable.hotelPayableMnt, payable.paidOutMnt);
    if (next === payable.payoutState && payable.eligibleLocalDate === localDate) return;
    const moved = await repository.updatePayable({
      payableId: payable.payableId,
      expectedRevision: payable.revision,
      payoutState: next,
      // A payable that is owed nothing carries no eligibility at all, which is
      // what keeps a fully refunded booking out of every batch.
      ...(next === 'ELIGIBLE' || next === 'ADJUSTMENT_DUE'
        ? { eligibleAt: payable.eligibleAt ?? at, eligibleLocalDate: localDate }
        : {}),
      ...(next === 'HELD' ? {} : { holdReason: null }),
    });
    if (!moved) throw new ApiError('CONFLICT', 'the payable changed under this command');
  }

  /**
   * Applies a refund the provider has confirmed (doc 11 §§3, 5).
   *
   * This is the only place a commission base shrinks, and it shrinks by money
   * that has actually gone back. Nothing is edited: the new figures are written
   * onto the payable and the *differences* are posted as their own ledger
   * events, so the ledger still adds up to what the row says.
   */
  async applyRefund(
    uow: UnitOfWork,
    input: {
      hotelId: string;
      bookingId: string;
      payableId: string;
      refundId: string;
      amountMnt: bigint;
      providerRefundId: string;
      at: Date;
      localDate: string;
    },
  ): Promise<void> {
    const repository = new SettlementRepository(uow);
    const payable = await repository.lockPayable(input.payableId);
    if (payable === undefined) throw new ApiError('NOT_FOUND', 'no such payable');

    const before = payable;
    const after = payableFigures(
      payable.grossPaidMnt,
      payable.refundedMnt + input.amountMnt,
      payable.commissionRateBps,
    );
    const applied = await repository.updatePayable({
      payableId: payable.payableId,
      expectedRevision: payable.revision,
      refundedMnt: payable.refundedMnt + input.amountMnt,
      retainedMnt: after.retainedMnt,
      commissionMnt: after.commissionMnt,
      hotelPayableMnt: after.hotelPayableMnt,
    });
    if (!applied) throw new ApiError('CONFLICT', 'the payable changed under this command');

    const cause = `refund:${input.refundId}`;
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'REFUND',
      amountMnt: -input.amountMnt,
      sourceRef: cause,
      providerRefundId: input.providerRefundId,
    });
    // The corrections, as their own events. `PAY-DEC-008`'s "commission base
    // zero on full refund" needs no branch: a full refund makes both of these
    // the exact negative of what the confirmation posted.
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'COMMISSION',
      amountMnt: after.commissionMnt - before.commissionMnt,
      sourceRef: cause,
    });
    await repository.post({
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      payableId: payable.payableId,
      eventType: 'HOTEL_PAYABLE',
      amountMnt: after.hotelPayableMnt - before.hotelPayableMnt,
      sourceRef: cause,
    });

    const settled = await repository.lockPayable(input.payableId);
    if (settled === undefined) throw new Error('the payable vanished under its own lock');
    await this.makeEligible(uow, settled, input.at, input.localDate);
  }
}
