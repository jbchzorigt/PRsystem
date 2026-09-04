import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import type {
  CashPosting,
  CashPostingsPort,
  CashTransactionKind,
} from '../../billing/contracts/cash-postings';
import type { ShiftLookupPort } from '../../stay/contracts/shift-lookup';
import type { CashMovementType } from '../domain/cash';
import { directionOf } from '../domain/cash';
import { FinanceRepository } from '../repositories/finance.repository';

/**
 * The drawer side of a guest's cash (doc 24 §4).
 *
 * The mapping is fixed by the transaction's kind, never by the caller: money in
 * for a deposit or a service, money out for the refund or reversal of either.
 * A reversal is the cash actually handed back, so it is the refund movement of
 * its kind rather than a ledger correction — the correction of a *movement*
 * that never matched reality is `CashService.correct`, and this is not that.
 */

const MOVEMENT_OF_KIND: Record<CashTransactionKind, CashMovementType> = {
  DEPOSIT_RECEIPT: 'DEPOSIT_CASH_RECEIPT',
  DEPOSIT_REFUND: 'DEPOSIT_CASH_REFUND',
  DEPOSIT_REVERSAL: 'DEPOSIT_CASH_REFUND',
  FOLIO_PAYMENT: 'SERVICE_CASH_PAYMENT',
  FOLIO_PAYMENT_REVERSAL: 'SERVICE_CASH_REFUND',
  CORRECTED_PAYMENT: 'SERVICE_CASH_PAYMENT',
};

export class LedgerCashPostings implements CashPostingsPort {
  constructor(private readonly shifts: ShiftLookupPort) {}

  async record(uow: UnitOfWork, posting: CashPosting): Promise<void> {
    if (posting.shiftId === null) {
      throw new ApiError('VALIDATION_FAILED', 'SHIFT_REQUIRED: cash belongs to a shift');
    }
    const locationId = await this.shifts.drawerOfShift(uow, posting.shiftId);
    if (locationId === undefined) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'NO_CASH_DRAWER: the shift this cash names has no drawer',
      );
    }
    const movementType = MOVEMENT_OF_KIND[posting.kind];
    const direction = directionOf(movementType);
    if (direction !== posting.direction) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `a ${posting.kind} is a ${direction} movement, not ${posting.direction}`,
      );
    }
    await new FinanceRepository(uow).post({
      locationId,
      shiftId: posting.shiftId,
      movementType,
      direction,
      amountMnt: posting.amountMnt,
      effectiveAt: posting.at,
      ...(posting.reason === undefined ? {} : { reason: posting.reason }),
      paymentTransactionId: posting.transactionId,
      accountId: posting.accountId,
    });
  }
}
