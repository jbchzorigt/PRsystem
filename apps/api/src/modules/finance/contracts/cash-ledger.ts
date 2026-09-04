import type { UnitOfWork } from '@prsystem/db';
import type { CashLedgerPort, ShiftCashSummary } from '../../stay/contracts/cash-ledger';
import { expectedCashMnt } from '../domain/cash';
import { FinanceRepository } from '../repositories/finance.repository';

/**
 * The cash ledger behind the Reception shift (doc 24 §§3, 6; `CASH-DEC-001`,
 * `-006`).
 *
 * The finance module answers the shift's three questions on the same
 * transaction the shift is being written in, so the drawer it locks, the
 * movements it sums and the transfers it finds are the ones that exist at that
 * instant — not a snapshot read earlier.
 */
export class LedgerCashLedger implements CashLedgerPort {
  async drawerForOpening(uow: UnitOfWork, locationId?: string): Promise<string | undefined> {
    const repository = new FinanceRepository(uow);
    const location =
      locationId === undefined
        ? await repository.defaultDrawer()
        : await repository.location(locationId);
    if (location === undefined) return undefined;
    if (location.kind !== 'DRAWER' || location.state !== 'ACTIVE') return undefined;
    return location.locationId;
  }

  async seedInitialFloat(
    uow: UnitOfWork,
    input: {
      readonly locationId: string;
      readonly amountMnt: bigint;
      readonly accountId: string;
      readonly at: Date;
    },
  ): Promise<void> {
    if (input.amountMnt <= 0n) return;
    const repository = new FinanceRepository(uow);
    if (await repository.hasInitialFloat(input.locationId)) return;
    await repository.post({
      locationId: input.locationId,
      movementType: 'INITIAL_FLOAT',
      direction: 'IN',
      amountMnt: input.amountMnt,
      effectiveAt: input.at,
      reason: 'the drawer opening float, counted at the first shift',
      accountId: input.accountId,
    });
  }

  async summarizeShift(
    uow: UnitOfWork,
    input: { readonly shiftId: string; readonly openingBalanceMnt: bigint },
  ): Promise<ShiftCashSummary> {
    const repository = new FinanceRepository(uow);
    // The order matters. A transfer confirmation racing this close either is
    // still pending when the first read runs — and the close is refused — or
    // has already committed, in which case the movements it posted are visible
    // to the second read. Reading the movements first would let a confirmation
    // that commits between the two reads escape both (`CASH-DEC-006`).
    const pending = await repository.pendingTransfersOfShift(input.shiftId);
    const movements = await repository.movementsOfShift(input.shiftId);
    return {
      expectedCashMnt: expectedCashMnt(input.openingBalanceMnt, movements),
      pendingTransferCount: pending.length,
    };
  }
}
