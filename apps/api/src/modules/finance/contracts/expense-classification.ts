import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';

/**
 * What kind of cost an expense is, for the module that owns the expense but
 * not the categories (doc 23 §4.4, `FIN-DEC-004`; CLAUDE.md §3).
 *
 * The financial dashboard has to keep an inventory purchase apart from an
 * operating cost — a purchase already leaves the business as stock, and
 * counting it again as a cost of the sale would deduct it twice. The category
 * that decides which it is belongs to the reporting module, so the finance
 * module asks for its kind through this contract instead of selecting
 * `platform.expense_category` itself.
 */

export type ExpenseKind = 'INVENTORY_PURCHASE' | 'OPERATING';

export interface ExpenseClassificationPort {
  /** The kind of an active category of this hotel, or `undefined` if there is none. */
  kindOf(uow: UnitOfWork, categoryId: string): Promise<ExpenseKind | undefined>;
}

/**
 * The default before Phase 17 exists in a deployment: no category can be
 * resolved, so an expense may only be the operating cost it has always been.
 *
 * It fails closed rather than guessing once the relation exists — a caller
 * naming a category that nothing can classify must be refused, not silently
 * recorded as operating.
 */
export class UnprovisionedExpenseClassification implements ExpenseClassificationPort {
  async kindOf(uow: UnitOfWork, _categoryId: string): Promise<ExpenseKind | undefined> {
    const present = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.expense_category') IS NOT NULL AS present`,
    );
    if (present.rows[0]?.present === true) {
      throw new ApiError(
        'INTERNAL_ERROR',
        'expense categories exist but no classification contract is provisioned',
      );
    }
    return undefined;
  }
}
