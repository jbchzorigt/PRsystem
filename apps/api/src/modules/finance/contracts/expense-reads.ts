import type { UnitOfWork } from '@prsystem/db';
import type {
  ExpenseFactsPort,
  ExpenseRow,
  ExpenseTotals,
  FinancialWindow,
} from '../../reporting/contracts/financial-facts';

/**
 * What the hotel actually paid out (doc 23 §4, `FIN-DEC-004`, `FIN-DEC-005`).
 *
 * Two rules, and both are `WHERE` clauses rather than notes.
 *
 * **Only `PAID` counts.** doc 23 §4.1: an approved-for-payment request is not a
 * cash outflow, and the MVP has no payables lifecycle. Every query here filters
 * on the state and dates by `paid_at`.
 *
 * **The two kinds never merge.** An `INVENTORY_PURCHASE` is a cash outflow
 * whose cost reaches the operating result later, as COGS on what was sold; an
 * `OPERATING` expense reaches it when it is paid. Returning them as two totals
 * rather than one is what makes the double deduction `FIN-DEC-004` forbids
 * impossible to write by accident.
 */

function bigintOf(value: unknown): bigint {
  return BigInt(String(value ?? '0'));
}

export class RepositoryExpenseReads implements ExpenseFactsPort {
  async totals(uow: UnitOfWork, window: FinancialWindow): Promise<ExpenseTotals> {
    const rows = await uow.query<{ expense_type: string; total: string }>(
      `SELECT e.expense_type, COALESCE(sum(e.amount_mnt), 0)::text AS total
         FROM platform.expense e
        WHERE e.hotel_id = $1::uuid
          AND e.state = 'PAID'
          AND e.paid_at >= $2::timestamptz AND e.paid_at < $3::timestamptz
        GROUP BY e.expense_type`,
      [window.hotelId, window.from, window.to],
    );
    const byType = new Map(rows.rows.map((row) => [row.expense_type, bigintOf(row.total)]));
    return {
      paidOperatingMnt: byType.get('OPERATING') ?? 0n,
      paidInventoryPurchaseMnt: byType.get('INVENTORY_PURCHASE') ?? 0n,
    };
  }

  /**
   * doc 23 §8.3: every expense in the window, in whatever state.
   *
   * The export lists requests as well as payments — its `Status` column is one
   * of the approved ones — so this is deliberately not filtered to `PAID`. The
   * *totals* above are; a row in the file is not a claim that money moved.
   */
  async rows(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly ExpenseRow[]> {
    const rows = await uow.query<Record<string, unknown>>(
      `SELECT e.expense_id, e.expense_type, e.category, e.description, e.supplier,
              e.amount_mnt, e.method, e.state, e.stock_movement_id,
              e.created_by_account_id, e.decided_by_account_id, e.decided_at,
              e.paid_at, e.paid_by_account_id, e.provider_reference, e.shift_id,
              e.location_id
         FROM platform.expense e
        WHERE e.hotel_id = $1::uuid
          AND COALESCE(e.paid_at, e.created_at) >= $2::timestamptz
          AND COALESCE(e.paid_at, e.created_at) < $3::timestamptz
        ORDER BY COALESCE(e.paid_at, e.created_at), e.expense_id
        LIMIT $4`,
      [window.hotelId, window.from, window.to, cap + 1],
    );
    return rows.rows.map((row) => ({
      expenseId: String(row['expense_id']),
      expenseType: String(row['expense_type']),
      category: String(row['category']),
      description: String(row['description']),
      supplier: (row['supplier'] as string | null) ?? null,
      amountMnt: bigintOf(row['amount_mnt']),
      method: String(row['method']),
      state: String(row['state']),
      stockMovementId: (row['stock_movement_id'] as string | null) ?? null,
      createdByAccountId: String(row['created_by_account_id']),
      decidedByAccountId: (row['decided_by_account_id'] as string | null) ?? null,
      decidedAt: (row['decided_at'] as Date | null) ?? null,
      paidAt: (row['paid_at'] as Date | null) ?? null,
      paidByAccountId: (row['paid_by_account_id'] as string | null) ?? null,
      providerReference: (row['provider_reference'] as string | null) ?? null,
      shiftId: (row['shift_id'] as string | null) ?? null,
      locationId: (row['location_id'] as string | null) ?? null,
    }));
  }

  async dailyPaid(
    uow: UnitOfWork,
    window: FinancialWindow,
    timeZone: string,
  ): Promise<readonly { localDate: string; operatingMnt: bigint; purchaseMnt: bigint }[]> {
    const rows = await uow.query<{ day: string; expense_type: string; total: string }>(
      `SELECT to_char(e.paid_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              e.expense_type, COALESCE(sum(e.amount_mnt), 0)::text AS total
         FROM platform.expense e
        WHERE e.hotel_id = $1::uuid
          AND e.state = 'PAID'
          AND e.paid_at >= $2::timestamptz AND e.paid_at < $3::timestamptz
        GROUP BY 1, 2`,
      [window.hotelId, window.from, window.to, timeZone],
    );
    const days = new Map<string, { operatingMnt: bigint; purchaseMnt: bigint }>();
    for (const row of rows.rows) {
      const entry = days.get(row.day) ?? { operatingMnt: 0n, purchaseMnt: 0n };
      if (row.expense_type === 'OPERATING') entry.operatingMnt += bigintOf(row.total);
      else entry.purchaseMnt += bigintOf(row.total);
      days.set(row.day, entry);
    }
    return [...days.entries()]
      .map(([localDate, totals]) => ({ localDate, ...totals }))
      .sort((left, right) => left.localDate.localeCompare(right.localDate));
  }
}
