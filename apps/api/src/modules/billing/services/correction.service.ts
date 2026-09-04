import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { Channel } from '../domain/money';
import { availableDepositMnt } from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';
import { RefundRepository } from '../repositories/refund.repository';
import type { BillingDependencies, CommandActor, RequestContext } from './billing-context';
import { BillingServiceBase, claim, serverNow, sqlState } from './billing-context';
import type { FolioView } from './billing-views';
import { FolioService } from './folio.service';

/**
 * The financial correction (doc 20 §8, `DEP-DEC-006`).
 *
 * A wrong movement is never edited or deleted. Reception raises a request with
 * a reason; a Manager or Manager Plus decides it; approving posts the reversal
 * and the corrected record in one transaction, both as ordinary immutable
 * ledger rows, and moves the deposit's totals with them. One non-terminal
 * request per original transaction, held by index, so a duplicate approval
 * cannot reverse twice.
 */

const REQUEST = 'hotel.deposit.alternate_refund_request';
const DECIDE = 'hotel.deposit.alternate_refund_decide';

export interface RequestCorrectionInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly originalTransactionId: string;
  readonly reason: string;
  /** Absent for a plain reversal; present when the movement is re-recorded. */
  readonly correctedAmountMnt?: bigint;
  readonly correctedChannel?: Channel;
  readonly correctedReference?: string;
}

export interface DecideCorrectionInput {
  readonly hotelId: string;
  readonly correctionId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly approve: boolean;
  readonly decisionReason: string;
}

export class FinancialCorrectionService extends BillingServiceBase {
  private readonly folios: FolioService;

  constructor(deps: BillingDependencies) {
    super(deps);
    this.folios = new FolioService(deps);
  }

  async request(
    input: RequestCorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REQUEST,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.correction_request', input.idempotencyKey, {
          originalTransactionId: input.originalTransactionId,
          reason: input.reason,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const original = await billing.transaction(input.originalTransactionId);
        if (original === undefined || original.stayId !== input.stayId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const now = serverNow(this.deps, uow);
        let row;
        try {
          row = await new RefundRepository(uow).createCorrection({
            stayId: input.stayId,
            originalTransactionId: original.transactionId,
            reason: input.reason,
            correctedAmountMnt: input.correctedAmountMnt ?? null,
            correctedChannel: input.correctedChannel ?? null,
            correctedReference: input.correctedReference ?? null,
            accountId: gate.principal.accountId,
            at: now,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'CORRECTION_ALREADY_OPEN: this movement already has a correction request',
            );
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'billing.correction_request',
          outcome: 'allowed',
          targetType: 'financial_correction',
          targetRef: row.correctionId,
          reason: input.reason,
          payload: {
            stayId: input.stayId,
            originalTransactionId: original.transactionId,
            correctedAmountMnt: input.correctedAmountMnt?.toString() ?? null,
          },
        });
        const folio = await this.folios.ensureFolio(uow, input.stayId, gate.principal.accountId);
        const result = await this.folios.load(uow, folio);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * The decision, and — when it is an approval — the execution in the same
   * transaction: the reversal, the corrected record and the balance effect are
   * one atomic step, so a repeated approval returns the first result rather
   * than reversing twice.
   */
  async decide(
    input: DecideCorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DECIDE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.correction_decide', input.idempotencyKey, {
          correctionId: input.correctionId,
          approve: input.approve,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const corrections = new RefundRepository(uow);
        const row = await corrections.lockCorrection(input.correctionId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        if (row.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'CORRECTION_DECIDED: this request already has a decision');
        }
        const now = serverNow(this.deps, uow);
        if (!input.approve) {
          const rejected = await corrections.decideCorrection({
            correctionId: row.correctionId,
            expectedRevision: row.revision,
            state: 'REJECTED',
            accountId: gate.principal.accountId,
            at: now,
            decisionReason: input.decisionReason,
          });
          if (rejected === undefined) {
            throw new ApiError('CONFLICT', 'the request changed; reload and retry');
          }
          await recordPlatformAudit(uow, {
            action: 'billing.correction_reject',
            outcome: 'allowed',
            targetType: 'financial_correction',
            targetRef: row.correctionId,
            reason: input.decisionReason,
            payload: { stayId: row.stayId },
          });
          return this.finish(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
        }
        const original = await billing.transaction(row.originalTransactionId);
        if (original === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const deposit = await billing.lockDeposit(row.stayId);
        const folio = await billing.lockFolio(row.stayId);
        // The reversal is the mirror of the movement it corrects.
        const reversalKind =
          original.kind === 'DEPOSIT_RECEIPT' ? 'DEPOSIT_REVERSAL' : 'FOLIO_PAYMENT_REVERSAL';
        const reversal = await billing.post({
          stayId: row.stayId,
          ...(original.folioId === null ? {} : { folioId: original.folioId }),
          kind: reversalKind,
          channel: original.channel,
          direction: 'OUT',
          amountMnt: original.amountMnt,
          originalTransactionId: original.transactionId,
          ...(original.shiftId === null ? {} : { shiftId: original.shiftId }),
          reason: row.reason,
          accountId: gate.principal.accountId,
          at: now,
        });
        await this.mirrorCash(uow, reversal, gate.principal.accountId);
        let corrected;
        if (row.correctedAmountMnt !== null) {
          const channel = row.correctedChannel ?? original.channel;
          // doc 20 §6: the corrected record carries what its own channel needs.
          if (
            (channel === 'QPAY' || channel === 'CARD_GATEWAY' || channel === 'MANUAL_POS') &&
            row.correctedReference === null
          ) {
            throw new ApiError(
              'VALIDATION_FAILED',
              'REFERENCE_REQUIRED: the corrected movement carries its own reference',
            );
          }
          corrected = await billing.post({
            stayId: row.stayId,
            ...(original.folioId === null ? {} : { folioId: original.folioId }),
            kind: 'CORRECTED_PAYMENT',
            channel,
            direction: 'IN',
            amountMnt: row.correctedAmountMnt,
            ...(row.correctedReference === null
              ? {}
              : { providerReference: row.correctedReference }),
            ...(channel === 'MANUAL_POS'
              ? { approvalCode: row.correctedReference ?? 'CORRECTION' }
              : {}),
            originalTransactionId: original.transactionId,
            ...(original.shiftId === null ? {} : { shiftId: original.shiftId }),
            reason: row.reason,
            accountId: gate.principal.accountId,
            at: now,
          });
          await this.mirrorCash(uow, corrected, gate.principal.accountId);
        }
        // The balance follows the ledger: a corrected deposit receipt moves the
        // aggregate's totals, a corrected folio payment moves the folio's.
        if (original.kind === 'DEPOSIT_RECEIPT' && deposit !== undefined) {
          const received =
            deposit.receivedMnt + (corrected === undefined ? 0n : corrected.amountMnt);
          const reversed = deposit.reversedMnt + original.amountMnt;
          const totals = {
            receivedMnt: received,
            reversedMnt: reversed,
            allocatedMnt: deposit.allocatedMnt,
            refundReservedMnt: deposit.refundReservedMnt,
            refundedMnt: deposit.refundedMnt,
          };
          try {
            availableDepositMnt(totals);
          } catch {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'CORRECTION_WOULD_OVERDRAW: the deposit has already been used beyond the corrected amount',
            );
          }
          const moved = await billing.updateDeposit({
            stayId: row.stayId,
            expectedRevision: deposit.revision,
            receivedMnt: received,
            reversedMnt: reversed,
          });
          if (moved === undefined) {
            throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
          }
        } else if (folio !== undefined && folio.state === 'OPEN') {
          const paid =
            folio.paidMnt -
            original.amountMnt +
            (corrected === undefined ? 0n : corrected.amountMnt);
          if (paid < 0n) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'CORRECTION_WOULD_OVERDRAW: the folio has less paid than this correction reverses',
            );
          }
          const updated = await billing.updateFolio({
            folioId: folio.folioId,
            expectedRevision: folio.revision,
            paidMnt: paid,
          });
          if (updated === undefined) {
            throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
          }
        }
        const executed = await corrections.decideCorrection({
          correctionId: row.correctionId,
          expectedRevision: row.revision,
          state: 'EXECUTED',
          accountId: gate.principal.accountId,
          at: now,
          decisionReason: input.decisionReason,
          reversalTransactionId: reversal.transactionId,
          ...(corrected === undefined ? {} : { correctedTransactionId: corrected.transactionId }),
        });
        if (executed === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.correction_execute',
          outcome: 'allowed',
          targetType: 'financial_correction',
          targetRef: row.correctionId,
          reason: input.decisionReason,
          payload: {
            stayId: row.stayId,
            reversalTransactionId: reversal.transactionId,
            correctedTransactionId: corrected?.transactionId ?? null,
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'financial_correction',
          aggregateId: row.correctionId,
          eventType: 'billing.correction_executed',
          payload: {
            correctionId: row.correctionId,
            stayId: row.stayId,
            reversedAmountMnt: original.amountMnt.toString(),
            correctedAmountMnt: corrected?.amountMnt.toString() ?? null,
          },
        });
        return this.finish(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
      },
    );
  }

  private async finish(
    uow: UnitOfWork,
    stayId: string,
    accountId: string,
    idempotencyId: string,
  ): Promise<FolioView> {
    const folio = await this.folios.ensureFolio(uow, stayId, accountId);
    const result = await this.folios.load(uow, folio);
    await completeIdempotencyKey(uow, idempotencyId, 200, result);
    return result;
  }
}
