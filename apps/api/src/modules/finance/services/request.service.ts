import { ApiError } from '@prsystem/contracts';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { RequestKind, RequestRow } from '../repositories/finance.repository';
import { FinanceRepository } from '../repositories/finance.repository';
import type { CommandActor, FinanceDependencies, RequestContext } from './finance-context';
import { FinanceServiceBase, claim, serverNow } from './finance-context';
import {
  requireAmount,
  requireLocation,
  requireReason,
  requireSufficientCash,
  shiftOf,
} from './ledger';
import type { RequestView } from './finance-views';
import { requestView } from './finance-views';

/**
 * Bank deposits and owner withdrawals (doc 24 §10, `CASH-DEC-007`).
 *
 * Cash leaving the hotel for the bank or for an owner is a request first and a
 * movement only once it is approved: the approval and the outflow happen in one
 * transaction, so an approved request always has the movement it caused, and a
 * refused one never moved anything. An approver who is also the requester is
 * recorded as `self_approved` rather than refused — the hotels this serves have
 * one Hotel Admin (doc 18 §3).
 */

const BANK_DEPOSIT = 'hotel.cash.bank_deposit_request';
const WITHDRAWAL = 'hotel.cash.withdrawal_request';
const APPROVE = 'hotel.cash.withdrawal_approve';
const REPORT_FULL = 'hotel.cash.report_full';

export class CashRequestService extends FinanceServiceBase {
  constructor(deps: FinanceDependencies) {
    super(deps);
  }

  async requests(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ requests: readonly RequestView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      target,
      [REPORT_FULL, APPROVE, BANK_DEPOSIT, WITHDRAWAL],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const rows = await new FinanceRepository(uow).requests();
        return { requests: rows.map(requestView) };
      },
    );
  }

  async create(
    input: {
      hotelId: string;
      idempotencyKey: string;
      kind: RequestKind;
      locationId: string;
      amountMnt: bigint;
      reason: string;
      reference?: string;
      recipient?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RequestView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      input.kind === 'BANK_DEPOSIT' ? BANK_DEPOSIT : WITHDRAWAL,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.cash_request', input.idempotencyKey, {
          kind: input.kind,
          locationId: input.locationId,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as RequestView;
        const repository = new FinanceRepository(uow);
        const location = await requireLocation(repository, input.locationId);
        await authorize();
        const amount = requireAmount(input.amountMnt, 'a request');
        const reason = requireReason(input.reason, 'a cash request');
        // The request holds cash that is still in the location; the balance is
        // checked again at the approval, which is when it actually leaves.
        await requireSufficientCash(repository, location.locationId, amount);
        const shiftId = await shiftOf(this.deps, uow, location);
        const row = await repository.createRequest({
          kind: input.kind,
          locationId: location.locationId,
          ...(shiftId === undefined ? {} : { shiftId }),
          amountMnt: amount,
          reason,
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          ...(input.recipient === undefined ? {} : { recipient: input.recipient }),
          accountId: gate.principal.accountId,
          at: serverNow(this.deps, uow),
        });
        await recordPlatformAudit(uow, {
          action: 'finance.cash_request.create',
          outcome: 'allowed',
          targetType: 'cash_request',
          targetRef: row.requestId,
          payload: { kind: row.kind, amountMnt: row.amountMnt.toString() },
        });
        const result = requestView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  async decide(
    input: {
      hotelId: string;
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      decision: 'APPROVE' | 'REJECT';
      reason?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RequestView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      APPROVE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.cash_request_decide', input.idempotencyKey, {
          requestId: input.requestId,
          decision: input.decision,
        });
        if (claimed.kind === 'replay') return claimed.body as RequestView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockRequest(input.requestId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (locked.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the request changed; reload and retry');
        }
        if (locked.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'the request is already decided');
        }
        const at = serverNow(this.deps, uow);
        const selfApproved = gate.principal.accountId === locked.requestedByAccountId;
        const decisionReason =
          input.decision === 'REJECT' ? requireReason(input.reason, 'a rejection') : input.reason;
        let movementId: string | undefined;
        if (input.decision === 'APPROVE') {
          const location = await requireLocation(repository, locked.locationId);
          await requireSufficientCash(repository, location.locationId, locked.amountMnt);
          const movementType =
            locked.kind === 'BANK_DEPOSIT' ? 'BANK_DEPOSIT_OUT' : 'OWNER_OTHER_WITHDRAWAL';
          const shiftId = await shiftOf(this.deps, uow, location);
          const movement = await repository.post({
            locationId: location.locationId,
            ...(shiftId === undefined ? {} : { shiftId }),
            movementType,
            direction: 'OUT',
            amountMnt: locked.amountMnt,
            effectiveAt: at,
            reason: locked.reason,
            ...(locked.reference === null ? {} : { reference: locked.reference }),
            requestId: locked.requestId,
            accountId: gate.principal.accountId,
          });
          movementId = movement.movementId;
        }
        const decided = await repository.decideRequest({
          requestId: locked.requestId,
          expectedRevision: locked.revision,
          state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          accountId: gate.principal.accountId,
          at,
          selfApproved,
          ...(decisionReason === undefined ? {} : { decisionReason }),
          ...(movementId === undefined ? {} : { movementId }),
        });
        if (decided === undefined) throw new ApiError('CONFLICT', 'the request changed; retry');
        await recordPlatformAudit(uow, {
          action: 'finance.cash_request.decide',
          outcome: 'allowed',
          targetType: 'cash_request',
          targetRef: decided.requestId,
          payload: {
            state: decided.state,
            selfApproved,
            movementId: movementId ?? null,
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'cash_request',
          aggregateId: decided.requestId,
          eventType: `finance.cash_request.${decided.state.toLowerCase()}`,
          payload: {
            requestId: decided.requestId,
            kind: decided.kind,
            state: decided.state,
            amountMnt: decided.amountMnt.toString(),
          },
        });
        const result = requestView(decided as RequestRow);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }
}
