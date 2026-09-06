import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { expenseCashEffect } from '../domain/cash';
import type { ExpenseMethod, ExpenseRow } from '../repositories/finance.repository';
import { FinanceRepository } from '../repositories/finance.repository';
import type { CommandActor, FinanceDependencies, RequestContext } from './finance-context';
import { FinanceServiceBase, claim, serverNow } from './finance-context';
import { requireAmount, requireLocation, requireReason, requireSufficientCash } from './ledger';
import { requireDrawerShift } from './ledger';
import type { ExpenseView } from './finance-views';
import { expenseView } from './finance-views';

/**
 * Hotel expenses (doc 23 `FIN-DEC-005`, doc 24 §11, `CASH-DEC-005`).
 *
 * The rule this module exists to hold: **an approval is not an outflow**. An
 * approved expense has moved no money and appears in no cash total. Only the
 * payment moves anything, and only a cash payment touches a drawer — a card or
 * bank payment writes no movement at all, because the money never was in the
 * drawer.
 */

const SUBMIT = 'hotel.expense.request_submit';
const APPROVE = 'hotel.expense.approve';
const PAY = 'hotel.expense.payment_execute';
const OWN_VIEW = 'hotel.expense.own_request_view';

export class ExpenseService extends FinanceServiceBase {
  constructor(deps: FinanceDependencies) {
    super(deps);
  }

  /**
   * The category's kind, or a refusal.
   *
   * A category that does not exist for this hotel, or one that was
   * deactivated, classifies nothing — and an expense that named it must be
   * refused rather than quietly recorded as operating, which would put an
   * inventory purchase into the operating line the dashboard reports.
   */
  private async classify(
    uow: UnitOfWork,
    categoryId: string,
  ): Promise<'INVENTORY_PURCHASE' | 'OPERATING'> {
    const kind = await this.deps.classification.kindOf(uow, categoryId);
    if (kind === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'no such active expense category');
    }
    return kind;
  }

  async expenses(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ expenses: readonly ExpenseView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      target,
      [APPROVE, SUBMIT, OWN_VIEW],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const rows = await new FinanceRepository(uow).expenses();
        return { expenses: rows.map(expenseView) };
      },
    );
  }

  async submit(
    input: {
      hotelId: string;
      idempotencyKey: string;
      category: string;
      description: string;
      amountMnt: bigint;
      method: ExpenseMethod;
      /**
       * An expense category of this hotel (doc 23 §4.4). Its kind decides
       * whether this is an inventory purchase or an operating cost; with no
       * category the expense is operating, which is what every expense before
       * Phase 17 was.
       */
      categoryId?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ExpenseView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      SUBMIT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.expense_submit', input.idempotencyKey, {
          category: input.category,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as ExpenseView;
        await authorize();
        const amount = requireAmount(input.amountMnt, 'an expense');
        const description = requireReason(input.description, 'an expense');
        const expenseType =
          input.categoryId === undefined ? 'OPERATING' : await this.classify(uow, input.categoryId);
        const row = await new FinanceRepository(uow).createExpense({
          category: input.category,
          description,
          amountMnt: amount,
          method: input.method,
          accountId: gate.principal.accountId,
          at: serverNow(this.deps, uow),
          submit: true,
          expenseType,
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
        });
        await recordPlatformAudit(uow, {
          action: 'finance.expense.submit',
          outcome: 'allowed',
          targetType: 'expense',
          targetRef: row.expenseId,
          payload: { amountMnt: row.amountMnt.toString(), method: row.method },
        });
        const result = expenseView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** `FIN-DEC-005`: the approval decides that it may be paid — nothing more. */
  async decide(
    input: {
      hotelId: string;
      idempotencyKey: string;
      expenseId: string;
      expectedRevision: number;
      decision: 'APPROVE' | 'REJECT';
      reason?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ExpenseView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      APPROVE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.expense_decide', input.idempotencyKey, {
          expenseId: input.expenseId,
          decision: input.decision,
        });
        if (claimed.kind === 'replay') return claimed.body as ExpenseView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockExpense(input.expenseId);
        await authorize();
        const expense = this.expenseIn(locked, input.expectedRevision, ['SUBMITTED']);
        const decisionReason =
          input.decision === 'REJECT' ? requireReason(input.reason, 'a rejection') : input.reason;
        const decided = await repository.updateExpense({
          expenseId: expense.expenseId,
          expectedRevision: expense.revision,
          state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          accountId: gate.principal.accountId,
          at: serverNow(this.deps, uow),
          selfApproved: gate.principal.accountId === expense.createdByAccountId,
          ...(decisionReason === undefined ? {} : { decisionReason }),
        });
        return this.finish(uow, claimed.idempotencyId, decided, 'finance.expense.decide');
      },
    );
  }

  /**
   * `CASH-DEC-005`: the payment. A cash payment is an outflow from the paying
   * drawer, inside the shift accountable for it; a card or bank payment records
   * the provider's reference and moves no drawer at all.
   */
  async pay(
    input: {
      hotelId: string;
      idempotencyKey: string;
      expenseId: string;
      expectedRevision: number;
      locationId?: string;
      providerReference?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ExpenseView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PAY,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.expense_pay', input.idempotencyKey, {
          expenseId: input.expenseId,
        });
        if (claimed.kind === 'replay') return claimed.body as ExpenseView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockExpense(input.expenseId);
        await authorize();
        const expense = this.expenseIn(locked, input.expectedRevision, ['APPROVED']);
        const at = serverNow(this.deps, uow);
        const effect = expenseCashEffect({ state: 'PAID', method: expense.method });
        if (!effect.movesDrawer) {
          const reference = requireReason(input.providerReference, 'a non-cash expense payment');
          const paid = await repository.updateExpense({
            expenseId: expense.expenseId,
            expectedRevision: expense.revision,
            state: 'PAID',
            accountId: gate.principal.accountId,
            at,
            providerReference: reference,
          });
          return this.finish(uow, claimed.idempotencyId, paid, 'finance.expense.pay');
        }
        if (input.locationId === undefined) {
          throw new ApiError('VALIDATION_FAILED', 'a cash payment names the drawer it comes from');
        }
        const location = await requireLocation(repository, input.locationId, 'DRAWER');
        await requireSufficientCash(repository, location.locationId, expense.amountMnt);
        const shiftId = await requireDrawerShift(this.deps, uow, location.locationId);
        const movement = await repository.post({
          locationId: location.locationId,
          shiftId,
          movementType: 'PAID_CASH_EXPENSE',
          direction: 'OUT',
          amountMnt: expense.amountMnt,
          effectiveAt: at,
          reason: expense.description,
          expenseId: expense.expenseId,
          accountId: gate.principal.accountId,
        });
        const paid = await repository.updateExpense({
          expenseId: expense.expenseId,
          expectedRevision: expense.revision,
          state: 'PAID',
          accountId: gate.principal.accountId,
          at,
          locationId: location.locationId,
          shiftId,
          movementId: movement.movementId,
        });
        return this.finish(uow, claimed.idempotencyId, paid, 'finance.expense.pay', {
          movementId: movement.movementId,
        });
      },
    );
  }

  // --------------------------------------------------------------- helpers

  private expenseIn(
    row: ExpenseRow | undefined,
    expectedRevision: number,
    states: readonly ExpenseRow['state'][],
  ): ExpenseRow {
    if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
    if (row.revision !== expectedRevision) {
      throw new ApiError('CONFLICT', 'the expense changed; reload and retry');
    }
    if (!states.includes(row.state)) {
      throw new ApiError('CONFLICT', `an expense in ${row.state} does not take this decision`);
    }
    return row;
  }

  private async finish(
    uow: UnitOfWork,
    idempotencyId: string,
    row: ExpenseRow | undefined,
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<ExpenseView> {
    if (row === undefined) throw new ApiError('CONFLICT', 'the expense changed; retry');
    await recordPlatformAudit(uow, {
      action,
      outcome: 'allowed',
      targetType: 'expense',
      targetRef: row.expenseId,
      payload: { state: row.state, selfApproved: row.selfApproved, ...payload },
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'expense',
      aggregateId: row.expenseId,
      eventType: `finance.expense.${row.state.toLowerCase()}`,
      payload: {
        expenseId: row.expenseId,
        state: row.state,
        method: row.method,
        amountMnt: row.amountMnt.toString(),
        movesDrawer: expenseCashEffect({ state: row.state, method: row.method }).movesDrawer,
      },
    });
    const result = expenseView(row);
    await completeIdempotencyKey(uow, idempotencyId, 200, result);
    return result;
  }
}
