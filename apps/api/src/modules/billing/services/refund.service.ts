import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { Channel } from '../domain/money';
import { availableDepositMnt, refundEffect } from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';
import { RefundRepository } from '../repositories/refund.repository';
import type { BillingDependencies, CommandActor, RequestContext } from './billing-context';
import { BillingServiceBase, claim, serverNow, sqlState } from './billing-context';
import type { FolioView } from './billing-views';
import { FolioService } from './folio.service';

/**
 * The refund of an unused deposit and everything that can happen to it
 * (doc 20 §§4, 5, 7, §3.1–3.2; `DEP-DEC-003`, `-004`, `-007`, `-009`).
 *
 * Raising a request reserves its amount at once, so the same money cannot also
 * be allocated to a charge. The refund is not refunded until the provider says
 * so — or, for cash, until it is handed over. A failure leaves the reservation
 * standing for a retry; only a Manager, on evidence that no money moved,
 * releases it. And a released request the provider then pays freezes the
 * aggregate and opens exactly one reconciliation case, which is Platform
 * Operation's to resolve.
 */

const EXECUTE = 'hotel.deposit.collect_deduct_refund';
const REQUEST_ALTERNATE = 'hotel.deposit.alternate_refund_request';
const DECIDE = 'hotel.deposit.alternate_refund_decide';
const RELEASE = 'hotel.deposit.refund_release';

export interface RequestRefundInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly originalTransactionId: string;
  readonly amountMnt: bigint;
  /** Absent means the channel the deposit came in on (`DEP-DEC-003`). */
  readonly channel?: Channel;
  readonly reason?: string;
}

export interface RefundDecisionInput {
  readonly hotelId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export interface ExecuteRefundInput {
  readonly hotelId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  /** For a cash refund: the recipient's confirmation, recorded with the shift. */
  readonly shiftId?: string;
  readonly providerReference?: string;
  readonly approvalCode?: string;
}

export class RefundService extends BillingServiceBase {
  private readonly folios: FolioService;

  constructor(deps: BillingDependencies) {
    super(deps);
    this.folios = new FolioService(deps);
  }

  /**
   * doc 20 §4: the unused deposit goes back the way it came, unless the
   * Reception asks for another channel — which is an exception a Manager
   * decides (`DEP-DEC-004`). Either way the amount is reserved now.
   */
  async request(
    input: RequestRefundInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    if (input.amountMnt <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'a refund is a positive amount');
    }
    const alternate = input.channel !== undefined;
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      alternate ? REQUEST_ALTERNATE : EXECUTE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.refund_request', input.idempotencyKey, {
          stayId: input.stayId,
          originalTransactionId: input.originalTransactionId,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const refunds = new RefundRepository(uow);
        const deposit = await billing.lockDeposit(input.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (deposit.frozen) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'DEPOSIT_FROZEN: a reconciliation case is open on this deposit',
          );
        }
        const original = await billing.transaction(input.originalTransactionId);
        if (original === undefined || original.stayId !== input.stayId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (original.kind !== 'DEPOSIT_RECEIPT') {
          throw new ApiError(
            'VALIDATION_FAILED',
            'NOT_A_DEPOSIT_RECEIPT: a refund is against the receipt it returns',
          );
        }
        const available = availableDepositMnt(deposit);
        if (input.amountMnt > available) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'REFUND_ABOVE_AVAILABLE: the deposit does not have that much left',
            [{ field: 'amountMnt', issue: `at most ${available.toString()}` }],
          );
        }
        if (alternate && (input.reason === undefined || input.reason.trim() === '')) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'an alternate channel states why the original one could not be used',
          );
        }
        const now = serverNow(this.deps, uow);
        let row;
        try {
          row = await refunds.createRefund({
            stayId: input.stayId,
            originalTransactionId: original.transactionId,
            channel: input.channel ?? original.channel,
            alternateChannel: alternate,
            amountMnt: input.amountMnt,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            accountId: gate.principal.accountId,
            at: now,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'REFUND_ALREADY_OPEN: this receipt already has a refund in flight',
            );
          }
          throw error;
        }
        // doc 20 §3.1: the reservation exists from this moment, not from the
        // moment the provider is called.
        const reserved = await billing.updateDeposit({
          stayId: input.stayId,
          expectedRevision: deposit.revision,
          refundReservedMnt: deposit.refundReservedMnt + input.amountMnt,
        });
        if (reserved === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.refund_request',
          outcome: 'allowed',
          targetType: 'refund_request',
          targetRef: row.requestId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: {
            stayId: input.stayId,
            channel: row.channel,
            alternateChannel: alternate,
            amountMnt: input.amountMnt.toString(),
          },
        });
        const result = await this.folios.load(
          uow,
          await this.folios.ensureFolio(uow, input.stayId, gate.principal.accountId),
        );
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** `DEP-DEC-004`: a Manager or Manager Plus decides the alternate channel. */
  async decide(
    input: RefundDecisionInput & { readonly approve: boolean },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DECIDE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.refund_decide', input.idempotencyKey, {
          requestId: input.requestId,
          approve: input.approve,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockRefund(input.requestId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        if (!row.alternateChannel || row.approvalState !== 'PENDING') {
          throw new ApiError(
            'CONFLICT',
            'NOT_AWAITING_APPROVAL: only a pending alternate-channel refund is decided',
          );
        }
        const now = serverNow(this.deps, uow);
        const decided = await refunds.updateRefund({
          requestId: row.requestId,
          expectedRevision: row.revision,
          approvalState: input.approve ? 'APPROVED' : 'REJECTED',
          decidedByAccountId: gate.principal.accountId,
          decidedAt: now,
        });
        if (decided === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.refund_decide',
          outcome: 'allowed',
          targetType: 'refund_request',
          targetRef: row.requestId,
          reason: input.reason,
          payload: { approve: input.approve, stayId: row.stayId },
        });
        return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
      },
    );
  }

  /**
   * doc 20 §4: the refund is actually sent. A gateway channel goes to the
   * provider and only its success ends the reservation; cash is handed over in
   * the shift it belongs to. A failure leaves the money reserved for a retry
   * (`DEP-DEC-009`).
   */
  async execute(
    input: ExecuteRefundInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      EXECUTE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.refund_execute', input.idempotencyKey, {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockRefund(input.requestId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        if (row.state !== 'PENDING' && row.state !== 'FAILED') {
          throw new ApiError('CONFLICT', 'REFUND_NOT_OPEN: this request is already resolved');
        }
        if (row.alternateChannel && row.approvalState !== 'APPROVED') {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'APPROVAL_REQUIRED: an alternate channel is sent only after a Manager approves it',
          );
        }
        const deposit = await billing.lockDeposit(row.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (deposit.frozen) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'DEPOSIT_FROZEN: a reconciliation case is open on this deposit',
          );
        }
        const now = serverNow(this.deps, uow);
        const outcome = await this.send(uow, row, input);
        const effect = refundEffect(outcome.outcome);
        if (!effect.paysOut) {
          const failed = await refunds.updateRefund({
            requestId: row.requestId,
            expectedRevision: row.revision,
            state: effect.state,
            ...(outcome.reference === undefined ? {} : { providerReference: outcome.reference }),
            failureReason: outcome.detail,
          });
          if (failed === undefined) {
            throw new ApiError('CONFLICT', 'the request changed; reload and retry');
          }
          await recordPlatformAudit(uow, {
            action: 'billing.refund_execute',
            outcome: 'allowed',
            targetType: 'refund_request',
            targetRef: row.requestId,
            payload: { state: effect.state, detail: outcome.detail, stayId: row.stayId },
          });
          return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
        }
        const transaction = await billing.post({
          stayId: row.stayId,
          kind: 'DEPOSIT_REFUND',
          channel: row.channel,
          direction: 'OUT',
          amountMnt: row.amountMnt,
          ...(outcome.reference === undefined ? {} : { providerReference: outcome.reference }),
          ...(input.approvalCode === undefined ? {} : { approvalCode: input.approvalCode }),
          originalTransactionId: row.originalTransactionId,
          refundRequestId: row.requestId,
          ...(input.shiftId === undefined ? {} : { shiftId: input.shiftId }),
          accountId: gate.principal.accountId,
          at: now,
        });
        const succeeded = await refunds.updateRefund({
          requestId: row.requestId,
          expectedRevision: row.revision,
          state: 'SUCCEEDED',
          settledAt: now,
          ...(outcome.reference === undefined ? {} : { providerReference: outcome.reference }),
        });
        if (succeeded === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        // The reservation becomes money actually paid out, in one step.
        const moved = await billing.updateDeposit({
          stayId: row.stayId,
          expectedRevision: deposit.revision,
          refundReservedMnt: deposit.refundReservedMnt - row.amountMnt,
          refundedMnt: deposit.refundedMnt + row.amountMnt,
        });
        if (moved === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.refund_execute',
          outcome: 'allowed',
          targetType: 'payment_transaction',
          targetRef: transaction.transactionId,
          payload: {
            requestId: row.requestId,
            stayId: row.stayId,
            amountMnt: row.amountMnt.toString(),
          },
        });
        return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
      },
    );
  }

  /**
   * `DEP-DEC-009`: the reservation is released only when it is certain no money
   * moved — cash never handed over, or the provider stating it never processed
   * the request. The provider is asked again here rather than believed.
   */
  async release(
    input: RefundDecisionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RELEASE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.refund_release', input.idempotencyKey, {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockRefund(input.requestId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        if (row.state !== 'PENDING' && row.state !== 'FAILED') {
          throw new ApiError('CONFLICT', 'REFUND_NOT_OPEN: this request is already resolved');
        }
        if (row.channel !== 'CASH') {
          const reference = await this.providerReferenceOf(uow, row);
          const status = await this.gatewayFor(row.channel).queryStatus(
            { providerInvoiceId: reference },
            { correlationId: uow.context.correlationId },
          );
          const authoritative =
            status.ok && (status.value.state === 'FAILED' || status.value.state === 'EXPIRED');
          if (!authoritative) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'PROVIDER_NOT_AUTHORITATIVE: the provider has not confirmed that no money moved',
            );
          }
        }
        const deposit = await billing.lockDeposit(row.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const now = serverNow(this.deps, uow);
        const released = await refunds.updateRefund({
          requestId: row.requestId,
          expectedRevision: row.revision,
          state: 'RELEASED',
          releasedByAccountId: gate.principal.accountId,
          releasedAt: now,
          releaseReason: input.reason,
        });
        if (released === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        const freed = await billing.updateDeposit({
          stayId: row.stayId,
          expectedRevision: deposit.revision,
          refundReservedMnt: deposit.refundReservedMnt - row.amountMnt,
        });
        if (freed === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.refund_release',
          outcome: 'allowed',
          targetType: 'refund_request',
          targetRef: row.requestId,
          reason: input.reason,
          payload: { stayId: row.stayId, amountMnt: row.amountMnt.toString() },
        });
        return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
      },
    );
  }

  /**
   * doc 20 §3.2: a released request is asked about once more. If the provider
   * now says it paid, the aggregate freezes and exactly one `LATE_REFUND_SUCCESS`
   * case opens — no second refund is posted, and no allocation may proceed
   * until Platform Operation resolves it (`DEP-DEC-009`, `-010`).
   */
  async checkForLateSuccess(
    input: { hotelId: string; requestId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [EXECUTE, RELEASE],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.refund_late_check', input.idempotencyKey, {
          requestId: input.requestId,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const refunds = new RefundRepository(uow);
        const row = await refunds.lockRefund(input.requestId);
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (row.state !== 'RELEASED') {
          throw new ApiError(
            'CONFLICT',
            'REFUND_NOT_RELEASED: only a released request can be paid late',
          );
        }
        const status = await this.gatewayFor(row.channel).queryStatus(
          { providerInvoiceId: await this.providerReferenceOf(uow, row) },
          { correlationId: uow.context.correlationId },
        );
        if (!status.ok || status.value.state !== 'PAID') {
          return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
        }
        const deposit = await billing.lockDeposit(row.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const now = serverNow(this.deps, uow);
        const reconciling = await refunds.updateRefund({
          requestId: row.requestId,
          expectedRevision: row.revision,
          state: 'RECONCILING',
        });
        if (reconciling === undefined) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        const opened = await refunds.openCase({
          stayId: row.stayId,
          refundRequestId: row.requestId,
          // The reference the provider knows this money by, so the case — and
          // the covered movement it may post — can be traced to it.
          providerReference: await this.providerReferenceOf(uow, row),
          providerAmountMnt: status.value.paidAmountMnt ?? row.amountMnt,
        });
        const frozen = await billing.updateDeposit({
          stayId: row.stayId,
          expectedRevision: deposit.revision,
          frozen: true,
        });
        if (frozen === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.refund_late_success',
          outcome: 'allowed',
          targetType: 'deposit_reconciliation_case',
          targetRef: opened.caseId,
          payload: {
            stayId: row.stayId,
            requestId: row.requestId,
            providerAmountMnt: (status.value.paidAmountMnt ?? row.amountMnt).toString(),
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'deposit_reconciliation_case',
          aggregateId: opened.caseId,
          eventType: 'billing.late_refund_success',
          payload: {
            caseId: opened.caseId,
            stayId: row.stayId,
            requestId: row.requestId,
            openedAt: now.toISOString(),
          },
        });
        return this.reload(uow, row.stayId, gate.principal.accountId, claimed.idempotencyId);
      },
    );
  }

  // ------------------------------------------------------------ internals

  private async send(
    uow: UnitOfWork,
    row: {
      requestId: string;
      channel: Channel;
      amountMnt: bigint;
      providerReference: string | null;
    },
    input: ExecuteRefundInput,
  ): Promise<{
    outcome: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'VOIDED';
    reference?: string;
    detail: string;
  }> {
    if (row.channel === 'CASH') {
      if (input.shiftId === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'SHIFT_REQUIRED: a cash refund belongs to a shift');
      }
      return { outcome: 'SUCCEEDED', detail: 'cash handed to the guest' };
    }
    if (row.channel === 'MANUAL_POS') {
      if (input.providerReference === undefined || input.approvalCode === undefined) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'REFERENCE_REQUIRED: a manual POS refund carries its reference and approval code',
        );
      }
      return {
        outcome: 'SUCCEEDED',
        reference: input.providerReference,
        detail: 'manual POS refund recorded',
      };
    }
    const result = await this.gatewayFor(row.channel).refund(
      {
        providerPaymentId: row.providerReference ?? (input.providerReference as string),
        amountMnt: row.amountMnt,
        reason: 'deposit refund',
        idempotencyKey: row.requestId,
      },
      { correlationId: uow.context.correlationId },
    );
    if (!result.ok) {
      return { outcome: 'FAILED', detail: 'the provider could not be reached' };
    }
    switch (result.value.state) {
      case 'REFUNDED':
        return {
          outcome: 'SUCCEEDED',
          reference: result.value.providerRefundId,
          detail: 'provider confirmed the refund',
        };
      case 'PENDING':
        return {
          outcome: 'PENDING',
          reference: result.value.providerRefundId,
          detail: 'the provider has not settled the refund yet',
        };
      case 'FAILED':
        return {
          outcome: 'FAILED',
          reference: result.value.providerRefundId,
          detail: 'the provider refused the refund',
        };
    }
  }

  /**
   * What the provider knows this refund by: its own reference once it has been
   * sent, and otherwise the payment it is refunding — a refund of a QPay
   * receipt is queried against that receipt's invoice.
   */
  private async providerReferenceOf(
    uow: UnitOfWork,
    row: { requestId: string; providerReference: string | null; originalTransactionId: string },
  ): Promise<string> {
    if (row.providerReference !== null) return row.providerReference;
    const original = await new BillingRepository(uow).transaction(row.originalTransactionId);
    return original?.providerReference ?? row.requestId;
  }

  private async reload(
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
