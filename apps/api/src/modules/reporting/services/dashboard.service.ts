import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import type { FinancialWindow } from '../contracts/financial-facts';
import {
  EXPORT_ROW_CAP,
  cogsMnt,
  lastSevenDays,
  localDatesOf,
  marginBps,
  netSalesMnt,
  operatingResultMnt,
  rangeOfLocalDates,
  receivableMnt,
  receivedMnt,
  refuseRange,
  thisMonth,
  topByDemand,
  topByRevenue,
} from '../domain/reporting';
import type { QuickRange, RoomDemandRow } from '../domain/reporting';
import type { CommandActor, ReportingDependencies, RequestContext } from './reporting-context';
import { DASHBOARD_FULL, ReportingServiceBase, hotelTimeZone } from './reporting-context';

/**
 * The Hotel Admin financial dashboard (doc 23 §§2–7, `FIN-DEC-001`–`010`).
 *
 * doc 23 §1 states the purpose in one sentence: stop confirmed sales, money
 * actually received, receivables, deposits, refunds and expenses from being
 * reported as one another. This service is that sentence as code — each figure
 * comes from its own contract call over its own date basis, and the only
 * *derived* numbers are the three doc 23 defines arithmetically.
 *
 * Two of those derivations carry the weight of the phase.
 *
 * `FIN-DEC-004`: the operating result subtracts minibar **COGS**, not the
 * inventory purchase. Both figures are shown — the purchase on its own cash
 * card — so a reader can see the money left; only one of them is deducted.
 *
 * `FIN-DEC-010`: the whole thing is Hotel Admin's. Manager, Manager Plus,
 * Reception and Cleaner reach none of it, and the permission cell says so.
 */

export interface DashboardQuery {
  readonly hotelId: string;
  readonly range?: QuickRange;
  readonly from?: string;
  readonly to?: string;
  readonly topBy?: 'DEMAND' | 'REVENUE';
}

export interface DashboardKpis {
  readonly grossSalesMnt: bigint;
  readonly netSalesMnt: bigint;
  readonly receivedMnt: bigint;
  readonly receivableMnt: bigint;
  readonly refundMnt: bigint;
  readonly paidOperatingExpenseMnt: bigint;
  readonly inventoryPurchaseOutflowMnt: bigint;
  readonly minibarCogsMnt: bigint;
  readonly minibarGrossProfitMnt: bigint;
  readonly minibarGrossMarginBps: number | undefined;
  readonly operatingResultMnt: bigint;
  readonly operatingMarginBps: number | undefined;
  readonly depositsHeldMnt: bigint;
}

export interface DashboardSeriesPoint {
  readonly localDate: string;
  readonly roomNetSalesMnt: bigint;
  readonly minibarNetSalesMnt: bigint;
  readonly paidOperatingExpenseMnt: bigint;
  readonly inventoryPurchaseMnt: bigint;
  readonly refundMnt: bigint;
  readonly operatingResultMnt: bigint;
}

export interface TopRoom extends RoomDemandRow {
  readonly categoryName: string;
  readonly hourlyStays: number;
  readonly nightlyStays: number;
  readonly totalMinutes: number;
  readonly roomGrossSalesMnt: bigint;
}

export interface Dashboard {
  readonly window: { readonly from: Date; readonly to: Date; readonly timeZone: string };
  readonly kpis: DashboardKpis;
  readonly paymentChannels: Readonly<Record<string, bigint>>;
  readonly depositAllocationMnt: bigint;
  readonly series: readonly DashboardSeriesPoint[];
  readonly topRooms: readonly TopRoom[];
  readonly topBy: 'DEMAND' | 'REVENUE';
}

export class FinancialDashboardService extends ReportingServiceBase {
  constructor(deps: ReportingDependencies) {
    super(deps);
  }

  async read(
    query: DashboardQuery,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<Dashboard> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: query.hotelId },
      DASHBOARD_FULL,
      request,
      async (uow, gate, authorize) => {
        await authorize();
        const timeZone = await hotelTimeZone(uow);
        const window = this.resolveWindow(query, timeZone, this.now(uow));

        // Six reads, six date bases (doc 23 §6.2). None of them can contribute
        // to another's total, because none of them shares a query.
        const sales = await this.deps.sales.sales(uow, window);
        const payments = await this.deps.sales.payments(uow, window);
        const deposits = await this.deps.sales.depositsHeld(uow, window);
        const expenses = await this.deps.expenses.totals(uow, window);
        const minibarLines = await this.deps.minibar.sales(uow, window, EXPORT_ROW_CAP);
        const demand = await this.deps.sales.roomDemand(uow, window);

        const gross = sales.roomGrossMnt + sales.minibarGrossMnt + sales.otherGrossMnt;
        const net = netSalesMnt({
          grossSalesMnt: gross,
          discountMnt: sales.roomDiscountMnt + sales.minibarDiscountMnt,
          reversalMnt: sales.reversalMnt,
        });
        const minibarNet = sales.minibarGrossMnt - sales.minibarDiscountMnt;
        const cogs = cogsMnt(
          minibarLines.map((line) => ({
            quantity: line.quantity,
            unitCostMnt: line.unitCostMnt ?? 0n,
          })),
        );
        const minibarProfit = minibarNet - cogs;
        const result = operatingResultMnt({
          netSalesMnt: net,
          minibarCogsMnt: cogs,
          paidOperatingExpenseMnt: expenses.paidOperatingMnt,
        });

        const kpis: DashboardKpis = {
          grossSalesMnt: gross,
          netSalesMnt: net,
          receivedMnt: receivedMnt({
            successfulPaymentsMnt: payments.successfulMnt,
            successfulRefundsMnt: payments.refundedMnt,
          }),
          receivableMnt: receivableMnt({
            netSalesMnt: net,
            paymentAllocationMnt: payments.paymentAllocationMnt,
            depositAllocationMnt: payments.depositAllocationMnt,
          }),
          refundMnt: payments.refundedMnt,
          paidOperatingExpenseMnt: expenses.paidOperatingMnt,
          inventoryPurchaseOutflowMnt: expenses.paidInventoryPurchaseMnt,
          minibarCogsMnt: cogs,
          minibarGrossProfitMnt: minibarProfit,
          minibarGrossMarginBps: marginBps(minibarProfit, minibarNet),
          operatingResultMnt: result,
          operatingMarginBps: marginBps(result, net),
          depositsHeldMnt: deposits.heldMnt,
        };

        const series = await this.buildSeries(uow, window, timeZone);
        const rooms: TopRoom[] = demand.map((row) => ({
          roomId: row.roomId,
          roomNumber: row.roomNumber,
          categoryName: row.categoryName,
          completedStays: row.completedStays,
          hourlyStays: row.hourlyStays,
          nightlyStays: row.nightlyStays,
          totalMinutes: row.totalMinutes,
          roomGrossSalesMnt: row.roomGrossSalesMnt,
          roomNetSalesMnt: row.roomNetSalesMnt,
        }));
        const topBy = query.topBy ?? 'DEMAND';

        await recordPlatformAudit(uow, {
          action: 'finance.dashboard_read',
          outcome: 'allowed',
          targetType: 'hotel',
          targetRef: query.hotelId,
          payload: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            by: gate.principal.accountId,
          },
        });

        return {
          window: { from: window.from, to: window.to, timeZone },
          kpis,
          paymentChannels: payments.byChannelMnt,
          depositAllocationMnt: payments.depositAllocationMnt,
          series,
          topRooms: topBy === 'REVENUE' ? topByRevenue(rooms) : topByDemand(rooms),
          topBy,
        };
      },
    );
  }

  /**
   * doc 23 §6.3: one point per hotel-local day, and a day with no activity is
   * a zero rather than a gap — a chart that skipped quiet days would misstate
   * the shape of a month.
   */
  private async buildSeries(
    uow: Parameters<typeof hotelTimeZone>[0],
    window: FinancialWindow,
    timeZone: string,
  ): Promise<readonly DashboardSeriesPoint[]> {
    const sales = await this.deps.sales.dailySeries(uow, window, timeZone);
    const spend = await this.deps.expenses.dailyPaid(uow, window, timeZone);
    const salesByDay = new Map(sales.map((row) => [row.localDate, row]));
    const spendByDay = new Map(spend.map((row) => [row.localDate, row]));
    return localDatesOf({ from: window.from, to: window.to }, timeZone).map((localDate) => {
      const sale = salesByDay.get(localDate);
      const paid = spendByDay.get(localDate);
      const room = sale?.roomNetSalesMnt ?? 0n;
      const minibar = sale?.minibarNetSalesMnt ?? 0n;
      const refund = sale?.refundMnt ?? 0n;
      const operating = paid?.operatingMnt ?? 0n;
      return {
        localDate,
        roomNetSalesMnt: room,
        minibarNetSalesMnt: minibar,
        paidOperatingExpenseMnt: operating,
        inventoryPurchaseMnt: paid?.purchaseMnt ?? 0n,
        refundMnt: refund,
        // The daily result uses the same rule as the KPI card: sales less
        // paid operating expense. The day's COGS is not attributed here,
        // because a sale and the stock movement that costs it can fall on
        // different days and doc 23 §6.3 lists the two series separately.
        operatingResultMnt: room + minibar - refund - operating,
      };
    });
  }

  /** doc 23 §6.1: the last seven days, this month, or a custom range. */
  resolveWindow(query: DashboardQuery, timeZone: string, now: Date): FinancialWindow {
    const range = query.range ?? 'LAST_7_DAYS';
    if (range === 'LAST_7_DAYS') {
      return { hotelId: query.hotelId, ...lastSevenDays(now, timeZone) };
    }
    if (range === 'THIS_MONTH') {
      return { hotelId: query.hotelId, ...thisMonth(now, timeZone) };
    }
    if (query.from === undefined || query.to === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'a custom range needs both from and to');
    }
    const custom = rangeOfLocalDates(query.from, query.to, timeZone);
    const refusal = refuseRange(custom);
    if (refusal === 'INVERTED') {
      throw new ApiError('VALIDATION_FAILED', 'the date range ends before it starts');
    }
    if (refusal === 'TOO_LONG') {
      throw new ApiError('VALIDATION_FAILED', 'RANGE_TOO_LONG: a range may not exceed 365 days');
    }
    return { hotelId: query.hotelId, ...custom };
  }
}
