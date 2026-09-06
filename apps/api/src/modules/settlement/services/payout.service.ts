import { ApiError } from '@prsystem/contracts';
import { isRetryable } from '@prsystem/ports';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { SettlementRepository } from '../repositories/settlement.repository';
import type { BatchRow, PayableRow } from '../repositories/settlement.repository';
import {
  batchInstant,
  batchReconciles,
  outstandingMnt,
  payoutStateAfterSettlement,
  totalBatch,
} from '../domain/settlement';
import type { BatchLine } from '../domain/settlement';
import type { RequestContext, SettlementDependencies } from './settlement-context';
import { SettlementServiceBase, hotelTimeZone, newSettlementRequest } from './settlement-context';

/**
 * The `D+1 12:00 Asia/Ulaanbaatar` payout (`PAY-DEC-009`, doc 11 §8).
 *
 * Three properties are what this job exists to hold.
 *
 * **A retry is a new attempt.** A failed transfer is never overwritten:
 * `attempt_no` increments and the failure keeps its row, so "the bank was shut
 * on Monday" is visible rather than inferred. Eligibility does not move — the
 * batch date comes from the day the money was earned, not from the day a
 * transfer happened to succeed.
 *
 * **A payable is paid once.** The partial unique index on settled `PAYABLE`
 * lines is the enforcement; this code's job is to be refused by it rather than
 * to be the only thing preventing a double payout.
 *
 * **The batch balances.** Its six totals are computed from its own lines and
 * asserted before it is written, and the database repeats the arithmetic as a
 * CHECK.
 */
export class PayoutService extends SettlementServiceBase {
  constructor(deps: SettlementDependencies) {
    super(deps);
  }

  /**
   * Runs every batch that is due. Returns the batches that reached the bank.
   *
   * The candidate list is read without a lock and through the resolver: a job
   * has no tenant, and nothing is decided until each hotel's own transaction
   * re-reads its payables under their locks.
   */
  async runDue(
    limit = 50,
    request: RequestContext = newSettlementRequest(),
  ): Promise<readonly BatchRow[]> {
    const now = this.wallClock();
    const rows = await this.deps.pool.query<{ hotel_id: string; batch_local_date: string }>(
      `SELECT hotel_id, to_char(batch_local_date, 'YYYY-MM-DD') AS batch_local_date
         FROM platform.due_payout_batches($1::integer, $2::timestamptz)`,
      [limit, now],
    );
    const settled: BatchRow[] = [];
    for (const row of rows.rows) {
      const batch = await this.runOne(row.hotel_id, row.batch_local_date, request);
      if (batch !== undefined) settled.push(batch);
    }
    return settled;
  }

  /** Assembles, submits and settles one hotel's batch for one batch day. */
  async runOne(
    hotelId: string,
    batchLocalDate: string,
    request: RequestContext = newSettlementRequest(),
  ): Promise<BatchRow | undefined> {
    const assembled = await this.assemble(hotelId, batchLocalDate, request);
    if (assembled === undefined) return undefined;
    return this.submit(hotelId, assembled.batchId, request);
  }

  /**
   * Opens the attempt, takes its lines and totals it.
   *
   * Everything here is in one transaction on the payables' own locks, so two
   * runs of the same batch day serialize: the second finds no payable in a
   * batchable state and opens nothing.
   */
  async assemble(
    hotelId: string,
    batchLocalDate: string,
    request: RequestContext = newSettlementRequest(),
  ): Promise<{ batchId: string; totals: ReturnType<typeof totalBatch> } | undefined> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SettlementRepository(uow);
      // An attempt already open for this day is the one to submit; a second
      // would pay the same payables twice.
      const open = await repository.unsettledBatch(hotelId, batchLocalDate);
      if (open !== undefined) {
        return {
          batchId: open.batchId,
          totals: {
            grossPaidMnt: open.grossPaidMnt,
            refundedMnt: open.refundedMnt,
            retainedMnt: open.retainedMnt,
            commissionMnt: open.commissionMnt,
            adjustmentMnt: open.adjustmentMnt,
            hotelPayableMnt: open.hotelPayableMnt,
          },
        };
      }
      const due = await repository.lockDuePayables(batchLocalDate);
      const mine = due.filter((payable) => payable.hotelId === hotelId);
      if (mine.length === 0) return undefined;

      // What each payable would move, before anything is written.
      const moving = mine
        .map((payable) => ({
          payable,
          amountMnt: outstandingMnt(payable.hotelPayableMnt, payable.paidOutMnt),
        }))
        .filter((line) => line.amountMnt !== 0n);
      const net = moving.reduce((total, line) => total + line.amountMnt, 0n);
      // `PAY-DEC-009`: an adjustment is deducted from the next payout, and where
      // there is no next payout it stays a receivable. A batch that would pay
      // nothing is therefore not a batch: it is opened only when it moves money
      // to the hotel, and until then every `ADJUSTMENT_DUE` payable stands as
      // the receivable, visible on its own row rather than discharged by a
      // transfer that never happened.
      if (net <= 0n) return undefined;

      const zone = await hotelTimeZone(uow);
      const attemptNo = await repository.nextAttemptNo(hotelId, batchLocalDate);
      const batch = await repository.openBatch({
        hotelId,
        batchLocalDate,
        attemptNo,
        scheduledAt: batchInstant(batchLocalDate, zone),
      });

      const lines: BatchLine[] = [];
      for (const { payable, amountMnt: outstanding } of moving) {
        await repository.addItem({
          hotelId,
          batchId: batch.batchId,
          payableId: payable.payableId,
          kind: outstanding > 0n ? 'PAYABLE' : 'ADJUSTMENT',
          amountMnt: outstanding,
        });
        const moved = await repository.updatePayable({
          payableId: payable.payableId,
          expectedRevision: payable.revision,
          payoutState: 'BATCHED',
        });
        if (!moved) throw new ApiError('CONFLICT', 'a payable changed while the batch was formed');
        lines.push({
          grossPaidMnt: payable.grossPaidMnt,
          refundedMnt: payable.refundedMnt,
          retainedMnt: payable.retainedMnt,
          commissionMnt: payable.commissionMnt,
          outstandingMnt: outstanding,
        });
      }
      if (lines.length === 0) return undefined;

      const totals = totalBatch(lines);
      if (!batchReconciles(totals)) {
        // Refused with a reason rather than left to a constraint violation on a
        // row nobody could explain (doc 11 §8).
        throw new ApiError('PRECONDITION_FAILED', 'the payout batch does not reconcile');
      }
      const totalled = await repository.totalBatch({
        batchId: batch.batchId,
        expectedRevision: batch.revision,
        ...totals,
        state: 'SUBMITTED',
      });
      if (!totalled) throw new ApiError('CONFLICT', 'the batch changed while it was totalled');

      await recordPlatformAudit(uow, {
        action: 'settlement.payout_batched',
        outcome: 'allowed',
        targetType: 'payout_batch',
        targetRef: batch.batchId,
        payload: {
          batchLocalDate,
          attemptNo,
          lines: lines.length,
          hotelPayableMnt: totals.hotelPayableMnt.toString(),
        },
      });
      return { batchId: batch.batchId, totals };
    });
  }

  /**
   * Sends the batch to the bank and records what it answered.
   *
   * The transfer is made between transactions, for the same reason a refund is:
   * a lock held across a network call is a lock held for as long as the bank
   * takes. Every batch that reaches here pays something: one that would not is
   * never opened.
   */
  async submit(
    hotelId: string,
    batchId: string,
    request: RequestContext = newSettlementRequest(),
  ): Promise<BatchRow | undefined> {
    const pending = await this.inHotelScope(hotelId, request, async (uow) =>
      new SettlementRepository(uow).batchById(batchId),
    );
    if (pending === undefined || pending.state !== 'SUBMITTED') return undefined;

    const answer = await this.deps.payouts.transfer(
      {
        batchRef: batchId,
        hotelId,
        amountMnt: pending.hotelPayableMnt,
        currency: 'MNT',
        // The attempt's own identity: a redriven submission of *this* attempt
        // asks the bank for the same transfer, and a retry after a failure is a
        // different attempt with a different key.
        idempotencyKey: `payout:${batchId}`,
      },
      { correlationId: request.correlationId },
    );

    if (!answer.ok) {
      // Unreachable is not declined. The attempt stays submitted and the next
      // run asks the bank about the same one rather than opening a second.
      if (isRetryable(answer.error)) return undefined;
      return this.settle(hotelId, batchId, request, {
        state: 'FAILED',
        failureCode: answer.error.kind,
      });
    }
    return this.settle(
      hotelId,
      batchId,
      request,
      answer.value.state === 'PAID'
        ? {
            state: 'PAID',
            ...(answer.value.bankReference === undefined
              ? {}
              : { bankReference: answer.value.bankReference }),
          }
        : {
            state: 'FAILED',
            ...(answer.value.failureCode === undefined
              ? {}
              : { failureCode: answer.value.failureCode }),
          },
    );
  }

  private async settle(
    hotelId: string,
    batchId: string,
    request: RequestContext,
    outcome: { state: 'PAID'; bankReference?: string } | { state: 'FAILED'; failureCode?: string },
  ): Promise<BatchRow | undefined> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new SettlementRepository(uow);
      const batch = await repository.lockBatch(batchId);
      if (batch === undefined || batch.state !== 'SUBMITTED') return batch;
      const now = this.now(uow);
      const items = await repository.itemsOf(batchId);

      // doc 11 §8: a paid batch names the bank's own record of the transfer, so
      // the row can always be tied back to a statement line.
      const bankReference =
        outcome.state === 'PAID' ? (outcome.bankReference ?? `unreferenced:${batchId}`) : undefined;
      const settled = await repository.settleBatch({
        batchId,
        expectedRevision: batch.revision,
        state: outcome.state,
        ...(bankReference === undefined ? {} : { bankReference }),
        ...(outcome.state === 'FAILED' && outcome.failureCode !== undefined
          ? { failureCode: outcome.failureCode }
          : {}),
        settledAt: now,
      });
      if (!settled) throw new ApiError('CONFLICT', 'the batch changed under this command');

      for (const item of items) {
        const payable = await repository.lockPayable(item.payableId);
        if (payable === undefined) continue;
        if (outcome.state === 'PAID') {
          await this.applyPaidLine(
            repository,
            hotelId,
            batch,
            payable,
            item,
            bankReference as string,
          );
        } else {
          // The money did not move, so nothing about the payable moved either:
          // it goes back to being owed, and the next run makes a new attempt.
          await repository.updatePayable({
            payableId: payable.payableId,
            expectedRevision: payable.revision,
            payoutState: payoutStateAfterSettlement(payable.hotelPayableMnt, payable.paidOutMnt),
          });
        }
      }
      if (outcome.state === 'PAID') {
        // The database's own "one booking payable enters exactly one successful
        // payout": a second settled `PAYABLE` line for the same payable is
        // refused here, by the partial unique index.
        await repository.settleItems(batchId);
      }

      await recordPlatformAudit(uow, {
        action: outcome.state === 'PAID' ? 'settlement.payout_paid' : 'settlement.payout_failed',
        outcome: outcome.state === 'PAID' ? 'allowed' : 'failed',
        targetType: 'payout_batch',
        targetRef: batchId,
        payload: {
          batchLocalDate: batch.batchLocalDate,
          attemptNo: batch.attemptNo,
          hotelPayableMnt: batch.hotelPayableMnt.toString(),
          ...(outcome.state === 'FAILED' && outcome.failureCode !== undefined
            ? { failureCode: outcome.failureCode }
            : {}),
        },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'payout_batch',
        aggregateId: batchId,
        eventType: outcome.state === 'PAID' ? 'settlement.payout_paid' : 'settlement.payout_failed',
        payload: { batchId, hotelId, amountMnt: batch.hotelPayableMnt.toString() },
      });
      return repository.batchById(batchId);
    });
  }

  private async applyPaidLine(
    repository: SettlementRepository,
    hotelId: string,
    batch: BatchRow,
    payable: PayableRow,
    item: { payableId: string; kind: string; amountMnt: bigint },
    bankReference: string,
  ): Promise<void> {
    const paidOut = payable.paidOutMnt + item.amountMnt;
    const moved = await repository.updatePayable({
      payableId: payable.payableId,
      expectedRevision: payable.revision,
      paidOutMnt: paidOut,
      payoutState: payoutStateAfterSettlement(payable.hotelPayableMnt, paidOut),
    });
    if (!moved) throw new ApiError('CONFLICT', 'a payable changed while the batch was settled');
    await repository.post({
      hotelId,
      bookingId: payable.bookingId,
      payableId: payable.payableId,
      eventType: item.kind === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'PAYOUT',
      amountMnt: item.amountMnt,
      sourceRef: `payout:${batch.batchId}:${payable.payableId}`,
      bankReference,
    });
  }
}
