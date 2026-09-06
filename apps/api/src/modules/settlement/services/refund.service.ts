import { ApiError } from '@prsystem/contracts';
import { isRetryable } from '@prsystem/ports';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { SettlementRepository } from '../repositories/settlement.repository';
import type { RefundRow } from '../repositories/settlement.repository';
import { hotelLocalDate, instant } from '@prsystem/time';
import type { RequestContext, SettlementDependencies } from './settlement-context';
import { SettlementServiceBase, hotelTimeZone, newSettlementRequest } from './settlement-context';
import { SettlementService } from './settlement.service';

/**
 * Executing the refunds the booking lifecycle owes (doc 11 §§5, 9).
 *
 * The shape is the Phase 13 expiry sweep's, for the same reasons: candidates
 * are read without a lock, and each one is settled in its own transaction on
 * its own row, so a hundred open refunds do not become one transaction holding
 * a hundred payables.
 *
 * The provider call happens **between** two transactions, never inside one. A
 * database transaction held open across a network call holds its locks for as
 * long as the provider takes to answer, and a provider that never answers holds
 * them for ever. So: read and mark `PENDING`, call, then apply what came back
 * under the lock again — re-reading, because the refund may have been settled by
 * another delivery of the same result while the call was in flight.
 */
export class BookingRefundService extends SettlementServiceBase {
  private readonly settlement = new SettlementService();

  constructor(deps: SettlementDependencies) {
    super(deps);
  }

  /** Executes up to `limit` open refunds. Returns how many reached the provider. */
  async sweep(limit = 100, request: RequestContext = newSettlementRequest()): Promise<number> {
    const candidates = await this.candidates(limit);
    let executed = 0;
    for (const candidate of candidates) {
      if (await this.executeOne(candidate.refundId, candidate.hotelId, request)) executed += 1;
    }
    return executed;
  }

  private async candidates(
    limit: number,
  ): Promise<readonly { refundId: string; hotelId: string }[]> {
    // Through the resolver: the job has no tenant, and it has to see the open
    // obligations of every hotel before it can settle one in any of them.
    const rows = await this.deps.pool.query<{ refund_id: string; hotel_id: string }>(
      `SELECT refund_id, hotel_id FROM platform.open_booking_refunds($1::integer)`,
      [limit],
    );
    return rows.rows.map((row) => ({ refundId: row.refund_id, hotelId: row.hotel_id }));
  }

  /**
   * Executes one refund, or leaves it alone.
   *
   * `false` is not a failure: the refund may have been settled by somebody else
   * between the read and the lock, or the provider may have been unreachable —
   * which is a retry, not a decision.
   */
  async executeOne(
    refundId: string,
    hotelId: string,
    request: RequestContext = newSettlementRequest(),
  ): Promise<boolean> {
    const claimed = await this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SettlementRepository(uow);
      const refund = await repository.lockRefund(refundId);
      if (refund === undefined) return undefined;
      if (refund.state !== 'REQUIRED' && refund.state !== 'PENDING') return undefined;
      if (refund.providerPaymentId === null) {
        // Nothing to refund against. It stays open and visible rather than
        // being marked settled against a payment that was never identified.
        return undefined;
      }
      if (refund.state === 'REQUIRED') {
        const moved = await repository.settleRefund({
          refundId: refund.refundId,
          expectedRevision: refund.revision,
          state: 'PENDING',
        });
        if (!moved) return undefined;
        await this.deps.bookings.setRefundState(uow, {
          bookingId: refund.bookingId,
          state: 'PENDING',
          actorRef: 'system:refund',
        });
      }
      return refund;
    });
    if (claimed === undefined) return false;

    const gateway = this.deps.payments.gateway(claimed.provider);
    const answer = await gateway.refund(
      {
        providerPaymentId: claimed.providerPaymentId as string,
        amountMnt: claimed.amountMnt,
        reason: claimed.reason,
        // The refund's own id: the same obligation retried asks the provider
        // for the same refund, and a second obligation is a different one.
        idempotencyKey: `refund:${claimed.refundId}`,
      },
      { correlationId: request.correlationId },
    );

    if (!answer.ok) {
      // A provider that could not be reached has decided nothing. The
      // obligation stays `PENDING` and the next sweep asks again.
      if (isRetryable(answer.error)) return false;
      await this.record(claimed, hotelId, request, { kind: 'failed', code: answer.error.kind });
      return true;
    }
    if (answer.value.state === 'PENDING') return false;
    if (answer.value.state === 'FAILED') {
      await this.record(claimed, hotelId, request, { kind: 'failed', code: 'PROVIDER_DECLINED' });
      return true;
    }
    await this.record(claimed, hotelId, request, {
      kind: 'refunded',
      providerRefundId: answer.value.providerRefundId,
    });
    return true;
  }

  /**
   * Writes what the provider said, under the lock, having re-read the row.
   *
   * A duplicated delivery of the same result finds the refund already
   * `REFUNDED` and posts nothing: the ledger's unique cause and the refund's own
   * terminal state each refuse it independently.
   */
  private async record(
    refund: RefundRow,
    hotelId: string,
    request: RequestContext,
    outcome: { kind: 'refunded'; providerRefundId: string } | { kind: 'failed'; code: string },
  ): Promise<void> {
    await this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SettlementRepository(uow);
      const current = await repository.lockRefund(refund.refundId);
      if (current === undefined || current.state === 'REFUNDED') return;
      const now = this.now(uow);

      if (outcome.kind === 'failed') {
        const moved = await repository.settleRefund({
          refundId: current.refundId,
          expectedRevision: current.revision,
          state: 'FAILED',
          failureCode: outcome.code,
          settledAt: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'the refund changed under this command');
        // doc 11 §5: a failed refund does not restore the booking. It leaves an
        // obligation somebody has to resolve, and says so on the axis.
        await this.deps.bookings.setRefundState(uow, {
          bookingId: current.bookingId,
          state: 'FAILED',
          actorRef: 'system:refund',
          reason: outcome.code,
        });
        await recordPlatformAudit(uow, {
          action: 'settlement.refund_failed',
          outcome: 'failed',
          targetType: 'booking',
          targetRef: current.bookingId,
          payload: { refundId: current.refundId, failureCode: outcome.code },
        });
        return;
      }

      const moved = await repository.settleRefund({
        refundId: current.refundId,
        expectedRevision: current.revision,
        state: 'REFUNDED',
        providerRefundId: outcome.providerRefundId,
        settledAt: now,
      });
      if (!moved) throw new ApiError('CONFLICT', 'the refund changed under this command');

      if (current.payableId !== null) {
        const zone = await hotelTimeZone(uow);
        await this.settlement.applyRefund(uow, {
          hotelId,
          bookingId: current.bookingId,
          payableId: current.payableId,
          refundId: current.refundId,
          amountMnt: current.amountMnt,
          providerRefundId: outcome.providerRefundId,
          at: now,
          localDate: hotelLocalDate(instant(now), zone),
        });
      } else {
        // A late or duplicate capture: the money went back and the payable it
        // never belonged to is untouched, but the ledger still records it.
        await repository.post({
          hotelId,
          bookingId: current.bookingId,
          payableId: null,
          eventType: 'REFUND',
          amountMnt: -current.amountMnt,
          sourceRef: `refund:${current.refundId}`,
          providerRefundId: outcome.providerRefundId,
        });
      }

      await this.deps.bookings.setRefundState(uow, {
        bookingId: current.bookingId,
        state: 'REFUNDED',
        actorRef: 'system:refund',
      });
      await recordPlatformAudit(uow, {
        action: 'settlement.refund_completed',
        outcome: 'allowed',
        targetType: 'booking',
        targetRef: current.bookingId,
        payload: {
          refundId: current.refundId,
          amountMnt: current.amountMnt.toString(),
          reason: current.reason,
        },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'booking',
        aggregateId: current.bookingId,
        eventType: 'settlement.refunded',
        payload: {
          bookingId: current.bookingId,
          hotelId,
          amountMnt: current.amountMnt.toString(),
        },
      });
    });
  }

  /** Exposed for the module's own tests: the refunds a booking has raised. */
  async refundsOf(
    hotelId: string,
    bookingId: string,
    request: RequestContext = newSettlementRequest(),
  ): Promise<readonly RefundRow[]> {
    return this.inHotelScope(hotelId, request, async (uow: UnitOfWork) =>
      new SettlementRepository(uow).refundsFor(bookingId),
    );
  }
}
