import { ApiError } from '@prsystem/contracts';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { availableDepositMnt, lateRefundPosting } from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';
import { RefundRepository } from '../repositories/refund.repository';
import type { BillingDependencies, CommandActor, RequestContext } from './billing-context';
import { BillingServiceBase, claim, serverNow } from './billing-context';
import type { CaseView } from './billing-views';
import { caseView } from './billing-views';

/**
 * The late-success reconciliation (doc 20 §3.2, `DEP-DEC-010`).
 *
 * A released refund the provider then paid is not a refund the hotel can post
 * again: the aggregate is frozen and the case belongs to a Platform Operation
 * account holding `operation.deposit_refund_reconcile` with a recent step-up.
 * No hotel role reaches it. The case ends in one of two terminal outcomes — the
 * provider corrected itself and nothing moved, or the money did leave, in which
 * case what the deposit can cover is posted as an immutable refund and the rest
 * as the hotel's own loss. Neither outcome sends anything to the guest.
 */

const RECONCILE = 'operation.deposit_refund_reconcile';

export interface CaseInput {
  readonly hotelId: string;
  readonly caseId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface ResolveCaseInput extends CaseInput {
  readonly outcome: 'PROVIDER_STATUS_CORRECTED_NOT_SUCCESS' | 'PROVIDER_SUCCESS_POSTED';
  readonly note: string;
}

export class ReconciliationService extends BillingServiceBase {
  constructor(deps: BillingDependencies) {
    super(deps);
  }

  async list(
    input: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly CaseView[]> {
    return this.runOperationCommand(
      actor,
      RECONCILE,
      input.hotelId,
      { targetType: 'hotel', targetRef: input.hotelId },
      request,
      async (uow) => (await new RefundRepository(uow).openCases()).map(caseView),
    );
  }

  /** One claimant per case, and the claim is what lets the same account resolve it. */
  async claimCase(
    input: CaseInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CaseView> {
    return this.runOperationCommand(
      actor,
      RECONCILE,
      input.hotelId,
      { targetType: 'deposit_reconciliation_case', targetRef: input.caseId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'billing.case_claim', input.idempotencyKey, {
          caseId: input.caseId,
        });
        if (claimed.kind === 'replay') return claimed.body as CaseView;
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockCase(input.caseId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the case changed; reload and retry');
        }
        if (row.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'CASE_CLAIMED: this case already has a claimant');
        }
        const now = serverNow(this.deps, uow);
        const taken = await refunds.updateCase({
          caseId: row.caseId,
          expectedRevision: row.revision,
          state: 'RECONCILING',
          claimedByAccountId: actor.principal.accountId,
          claimedAt: now,
        });
        if (taken === undefined) {
          throw new ApiError('CONFLICT', 'the case changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.case_claim',
          outcome: 'allowed',
          targetType: 'deposit_reconciliation_case',
          targetRef: row.caseId,
          payload: { stayId: row.stayId, refundRequestId: row.refundRequestId },
        });
        const result = caseView(taken);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The terminal posting. `PROVIDER_STATUS_CORRECTED_NOT_SUCCESS` unfreezes the
   * aggregate with no movement at all; `PROVIDER_SUCCESS_POSTED` posts
   * `min(available, provider amount)` as an immutable covered refund and the
   * remainder as a `LATE_REFUND_SHORTFALL` finance event, then unfreezes.
   */
  async resolve(
    input: ResolveCaseInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CaseView> {
    return this.runOperationCommand(
      actor,
      RECONCILE,
      input.hotelId,
      { targetType: 'deposit_reconciliation_case', targetRef: input.caseId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'billing.case_resolve', input.idempotencyKey, {
          caseId: input.caseId,
          outcome: input.outcome,
        });
        if (claimed.kind === 'replay') return claimed.body as CaseView;
        const billing = new BillingRepository(uow);
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockCase(input.caseId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the case changed; reload and retry');
        }
        if (row.state !== 'RECONCILING') {
          throw new ApiError('CONFLICT', 'CASE_NOT_CLAIMED: claim the case before resolving it');
        }
        if (row.claimedByAccountId !== actor.principal.accountId) {
          throw new ApiError('FORBIDDEN', 'CASE_NOT_YOURS: a case is resolved by its claimant');
        }
        const deposit = await billing.lockDeposit(row.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const refund = await refunds.lockRefund(row.refundRequestId);
        if (refund === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const now = serverNow(this.deps, uow);

        if (input.outcome === 'PROVIDER_STATUS_CORRECTED_NOT_SUCCESS') {
          const unfrozen = await billing.updateDeposit({
            stayId: row.stayId,
            expectedRevision: deposit.revision,
            frozen: false,
          });
          if (unfrozen === undefined) {
            throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
          }
          const closed = await refunds.updateRefund({
            requestId: refund.requestId,
            expectedRevision: refund.revision,
            state: 'RECONCILED',
          });
          if (closed === undefined) {
            throw new ApiError('CONFLICT', 'the request changed; reload and retry');
          }
          const resolved = await refunds.updateCase({
            caseId: row.caseId,
            expectedRevision: row.revision,
            state: 'RESOLVED',
            outcome: input.outcome,
            resolvedByAccountId: actor.principal.accountId,
            resolvedAt: now,
            resolutionNote: input.note,
          });
          if (resolved === undefined) {
            throw new ApiError('CONFLICT', 'the case changed; reload and retry');
          }
          await recordPlatformAudit(uow, {
            action: 'billing.case_resolve',
            outcome: 'allowed',
            targetType: 'deposit_reconciliation_case',
            targetRef: row.caseId,
            reason: input.note,
            payload: { outcome: input.outcome, stayId: row.stayId },
          });
          const result = caseView(resolved);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }

        const posting = lateRefundPosting({
          availableMnt: availableDepositMnt(deposit),
          providerRefundedMnt: row.providerAmountMnt ?? refund.amountMnt,
        });
        if (posting.coveredMnt > 0n) {
          await billing.post({
            stayId: row.stayId,
            kind: 'LATE_REFUND_COVERED',
            channel: refund.channel,
            direction: 'OUT',
            amountMnt: posting.coveredMnt,
            ...(row.providerReference === null
              ? {}
              : { providerReference: `${row.providerReference}-late` }),
            ...(refund.channel === 'MANUAL_POS' ? { approvalCode: 'LATE_REFUND' } : {}),
            originalTransactionId: refund.originalTransactionId,
            refundRequestId: refund.requestId,
            reason: 'late provider success',
            accountId: actor.principal.accountId,
            at: now,
          });
        }
        if (posting.shortfallMnt > 0n) {
          await refunds.postFinanceEvent({
            stayId: row.stayId,
            caseId: row.caseId,
            amountMnt: posting.shortfallMnt,
            reference: row.providerReference,
            note: 'the deposit could not cover the provider’s late refund',
          });
        }
        const paid = await billing.updateDeposit({
          stayId: row.stayId,
          expectedRevision: deposit.revision,
          refundedMnt: deposit.refundedMnt + posting.coveredMnt,
          frozen: false,
        });
        if (paid === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        const closed = await refunds.updateRefund({
          requestId: refund.requestId,
          expectedRevision: refund.revision,
          state: 'RECONCILED',
        });
        if (closed === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        const resolved = await refunds.updateCase({
          caseId: row.caseId,
          expectedRevision: row.revision,
          state: 'RESOLVED',
          outcome: input.outcome,
          coveredAmountMnt: posting.coveredMnt,
          shortfallAmountMnt: posting.shortfallMnt,
          resolvedByAccountId: actor.principal.accountId,
          resolvedAt: now,
          resolutionNote: input.note,
        });
        if (resolved === undefined) {
          throw new ApiError('CONFLICT', 'the case changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.case_resolve',
          outcome: 'allowed',
          targetType: 'deposit_reconciliation_case',
          targetRef: row.caseId,
          reason: input.note,
          payload: {
            outcome: input.outcome,
            stayId: row.stayId,
            coveredAmountMnt: posting.coveredMnt.toString(),
            shortfallAmountMnt: posting.shortfallMnt.toString(),
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'deposit_reconciliation_case',
          aggregateId: row.caseId,
          eventType: 'billing.late_refund_posted',
          payload: {
            caseId: row.caseId,
            stayId: row.stayId,
            coveredAmountMnt: posting.coveredMnt.toString(),
            shortfallAmountMnt: posting.shortfallMnt.toString(),
          },
        });
        const result = caseView(resolved);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }
}
