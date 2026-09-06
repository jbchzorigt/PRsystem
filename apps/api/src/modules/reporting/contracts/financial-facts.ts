import type { UnitOfWork } from '@prsystem/db';

/**
 * What the Hotel Admin dashboard needs from the three modules that own the
 * money (CLAUDE.md §3).
 *
 * Three ports rather than one, because doc 23 §1's whole subject is that these
 * are *different things*: a finalized charge is not money received, money
 * received is not a deposit, and an inventory purchase is not an operating
 * expense. Keeping them in three contracts owned by three modules is the
 * structural version of that sentence — the dashboard has to ask for each
 * separately and cannot accidentally read one as another.
 *
 * Every method takes a half-open `[from, to)` instant range, and each uses the
 * date basis doc 23 §6.2 assigns to it: charges by `recognized_at`, payments
 * and refunds by their effective time, expenses by when they were paid, and
 * the top-five rooms by actual checkout.
 */

export interface FinancialWindow {
  readonly hotelId: string;
  readonly from: Date;
  readonly to: Date;
}

export interface SalesTotals {
  readonly roomGrossMnt: bigint;
  readonly roomDiscountMnt: bigint;
  readonly minibarGrossMnt: bigint;
  readonly minibarDiscountMnt: bigint;
  readonly otherGrossMnt: bigint;
  readonly reversalMnt: bigint;
}

export interface PaymentTotals {
  readonly successfulMnt: bigint;
  readonly refundedMnt: bigint;
  readonly byChannelMnt: Readonly<Record<string, bigint>>;
  /** doc 23 §2.4: a deposit paying a charge is not a new cash inflow. */
  readonly depositAllocationMnt: bigint;
  readonly paymentAllocationMnt: bigint;
}

export interface DepositTotals {
  /** doc 23 §2.4: received, less allocated, reversed and refunded. */
  readonly heldMnt: bigint;
}

export interface DailySeriesRow {
  readonly localDate: string;
  readonly roomNetSalesMnt: bigint;
  readonly minibarNetSalesMnt: bigint;
  readonly refundMnt: bigint;
}

export interface RoomDemandFact {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly categoryName: string;
  readonly completedStays: number;
  readonly hourlyStays: number;
  readonly nightlyStays: number;
  readonly totalMinutes: number;
  readonly roomGrossSalesMnt: bigint;
  readonly roomNetSalesMnt: bigint;
}

export interface RoomSalesRow {
  readonly stayId: string;
  readonly roomNumber: string;
  readonly categoryName: string;
  readonly stayType: string;
  readonly unitRateMnt: bigint;
  readonly sourceLevel: string;
  readonly sourceEntityId: string;
  readonly pricingConfigVersion: number;
  readonly effectiveCheckInAt: Date;
  readonly actualCheckoutAt: Date | null;
  readonly grossChargeMnt: bigint;
  readonly discountMnt: bigint;
  readonly netSalesMnt: bigint;
  readonly allocatedPaymentMnt: bigint;
  readonly receivableMnt: bigint;
  readonly paymentStatus: string;
  readonly paymentChannel: string | null;
  readonly recognizedAt: Date;
}

export interface PaymentBreakdownRow {
  readonly transactionId: string;
  readonly reference: string | null;
  readonly stayId: string;
  readonly channel: string;
  readonly grossMnt: bigint;
  readonly roomAllocationMnt: bigint;
  readonly minibarAllocationMnt: bigint;
  readonly otherAllocationMnt: bigint;
  readonly depositAllocationMnt: bigint;
  readonly refundMnt: bigint;
  readonly netMnt: bigint;
  readonly status: string;
  readonly effectiveAt: Date;
}

/** The billing module's answers: charges, payments, deposits, receivables. */
export interface SalesFactsPort {
  sales(uow: UnitOfWork, window: FinancialWindow): Promise<SalesTotals>;
  payments(uow: UnitOfWork, window: FinancialWindow): Promise<PaymentTotals>;
  /** doc 23 §6.2: the balance at the *end* of the window, not a sum over it. */
  depositsHeld(uow: UnitOfWork, window: FinancialWindow): Promise<DepositTotals>;
  dailySeries(
    uow: UnitOfWork,
    window: FinancialWindow,
    timeZone: string,
  ): Promise<readonly DailySeriesRow[]>;
  roomDemand(uow: UnitOfWork, window: FinancialWindow): Promise<readonly RoomDemandFact[]>;
  roomSalesRows(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly RoomSalesRow[]>;
  paymentRows(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly PaymentBreakdownRow[]>;
}

export interface MinibarSaleRow {
  readonly stayId: string;
  readonly roomNumber: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly sellingUnitPriceMnt: bigint;
  readonly grossSalesMnt: bigint;
  readonly discountMnt: bigint;
  readonly netSalesMnt: bigint;
  /** `FIN-DEC-003`: the weighted average snapshotted when the sale moved stock. */
  readonly unitCostMnt: bigint | null;
  readonly cogsMnt: bigint;
  readonly recognizedAt: Date;
  readonly paymentStatus: string;
}

/** The minibar module's answers: what was sold, and what it cost. */
export interface MinibarFactsPort {
  /**
   * `FIN-DEC-003`: sold quantities with the cost snapshot each sale carried.
   *
   * A line whose consumption movement carries no cost — a sale from before the
   * snapshot existed — reports `unitCostMnt: null` and a COGS of zero rather
   * than being priced at today's average, which would be exactly the
   * retrospective repricing doc 23 §12 forbids.
   */
  sales(uow: UnitOfWork, window: FinancialWindow, cap: number): Promise<readonly MinibarSaleRow[]>;
}

export interface ExpenseRow {
  readonly expenseId: string;
  readonly expenseType: string;
  readonly category: string;
  readonly description: string;
  readonly supplier: string | null;
  readonly amountMnt: bigint;
  readonly method: string;
  readonly state: string;
  readonly stockMovementId: string | null;
  readonly createdByAccountId: string;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly paidAt: Date | null;
  readonly paidByAccountId: string | null;
  readonly providerReference: string | null;
  readonly shiftId: string | null;
  readonly locationId: string | null;
}

export interface ExpenseTotals {
  /** doc 23 §4.1: only `PAID`. An approved-but-unpaid request is not an outflow. */
  readonly paidOperatingMnt: bigint;
  readonly paidInventoryPurchaseMnt: bigint;
}

/** The finance module's answers: what was actually paid out, and under which kind. */
export interface ExpenseFactsPort {
  totals(uow: UnitOfWork, window: FinancialWindow): Promise<ExpenseTotals>;
  rows(uow: UnitOfWork, window: FinancialWindow, cap: number): Promise<readonly ExpenseRow[]>;
  dailyPaid(
    uow: UnitOfWork,
    window: FinancialWindow,
    timeZone: string,
  ): Promise<readonly { localDate: string; operatingMnt: bigint; purchaseMnt: bigint }[]>;
}

const ZERO_SALES: SalesTotals = {
  roomGrossMnt: 0n,
  roomDiscountMnt: 0n,
  minibarGrossMnt: 0n,
  minibarDiscountMnt: 0n,
  otherGrossMnt: 0n,
  reversalMnt: 0n,
};

/**
 * The defaults, each refusing once the relation it reads exists.
 *
 * Every one of these tables has existed since Phase 10, 11 or 07, so a
 * dashboard wired without its sources would answer zero for every card — which
 * is the one wrong answer a financial report must never give quietly.
 */
async function refuseIfProvisioned(uow: UnitOfWork, relation: string): Promise<void> {
  const result = await uow.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [relation],
  );
  if (result.rows[0]?.present === true) {
    throw new Error(`${relation} exists but no reporting implementation is registered`);
  }
}

export class UnprovisionedSalesFacts implements SalesFactsPort {
  async sales(uow: UnitOfWork): Promise<SalesTotals> {
    await refuseIfProvisioned(uow, 'platform.folio_line');
    return ZERO_SALES;
  }

  async payments(uow: UnitOfWork): Promise<PaymentTotals> {
    await refuseIfProvisioned(uow, 'platform.payment_transaction');
    return {
      successfulMnt: 0n,
      refundedMnt: 0n,
      byChannelMnt: {},
      depositAllocationMnt: 0n,
      paymentAllocationMnt: 0n,
    };
  }

  async depositsHeld(uow: UnitOfWork): Promise<DepositTotals> {
    await refuseIfProvisioned(uow, 'platform.deposit_aggregate');
    return { heldMnt: 0n };
  }

  async dailySeries(uow: UnitOfWork): Promise<readonly DailySeriesRow[]> {
    await refuseIfProvisioned(uow, 'platform.folio_line');
    return [];
  }

  async roomDemand(uow: UnitOfWork): Promise<readonly RoomDemandFact[]> {
    await refuseIfProvisioned(uow, 'platform.stay');
    return [];
  }

  async roomSalesRows(uow: UnitOfWork): Promise<readonly RoomSalesRow[]> {
    await refuseIfProvisioned(uow, 'platform.stay');
    return [];
  }

  async paymentRows(uow: UnitOfWork): Promise<readonly PaymentBreakdownRow[]> {
    await refuseIfProvisioned(uow, 'platform.payment_transaction');
    return [];
  }
}

export class UnprovisionedMinibarFacts implements MinibarFactsPort {
  async sales(uow: UnitOfWork): Promise<readonly MinibarSaleRow[]> {
    await refuseIfProvisioned(uow, 'platform.minibar_usage_report_line');
    return [];
  }
}

export class UnprovisionedExpenseFacts implements ExpenseFactsPort {
  async totals(uow: UnitOfWork): Promise<ExpenseTotals> {
    await refuseIfProvisioned(uow, 'platform.expense');
    return { paidOperatingMnt: 0n, paidInventoryPurchaseMnt: 0n };
  }

  async rows(uow: UnitOfWork): Promise<readonly ExpenseRow[]> {
    await refuseIfProvisioned(uow, 'platform.expense');
    return [];
  }

  async dailyPaid(
    uow: UnitOfWork,
  ): Promise<readonly { localDate: string; operatingMnt: bigint; purchaseMnt: bigint }[]> {
    await refuseIfProvisioned(uow, 'platform.expense');
    return [];
  }
}
