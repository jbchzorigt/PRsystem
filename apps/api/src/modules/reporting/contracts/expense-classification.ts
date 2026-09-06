import type { UnitOfWork } from '@prsystem/db';
import type {
  ExpenseClassificationPort,
  ExpenseKind,
} from '../../finance/contracts/expense-classification';

/**
 * The reporting module's answer to `ExpenseClassificationPort` (doc 23 §4.4).
 *
 * Only an `ACTIVE` category classifies: deactivating one stops it being
 * chosen for new expenses without touching the expenses already recorded
 * under it, which is what "deactivate rather than delete" means here. The read
 * runs in the caller's transaction and therefore in the caller's tenant scope,
 * so no hotel can classify an expense with another's category.
 */
export class RepositoryExpenseClassification implements ExpenseClassificationPort {
  async kindOf(uow: UnitOfWork, categoryId: string): Promise<ExpenseKind | undefined> {
    const result = await uow.query<{ kind: ExpenseKind }>(
      `SELECT kind FROM platform.expense_category
        WHERE category_id = $1::uuid AND state = 'ACTIVE'`,
      [categoryId],
    );
    return result.rows[0]?.kind;
  }
}
