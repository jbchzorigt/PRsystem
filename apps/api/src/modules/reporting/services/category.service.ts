import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReportingRepository } from '../repositories/reporting.repository';
import type { ExpenseCategoryRow } from '../repositories/reporting.repository';
import type { CommandActor, ReportingDependencies, RequestContext } from './reporting-context';
import { CATEGORY_MANAGE, ReportingServiceBase, claim } from './reporting-context';

/**
 * Expense categories (doc 23 §4.4, `FIN-DEC-004`).
 *
 * Two rules the database also holds. A category's **reporting kind is fixed at
 * creation**, because past expenses were booked under it and changing it would
 * move money between the two halves of the operating result retroactively. And
 * a used category is **deactivated, never deleted** — the expenses that named
 * it keep naming it.
 */

export interface CategoryView {
  readonly categoryId: string;
  readonly name: string;
  readonly kind: string;
  readonly state: string;
}

function view(row: ExpenseCategoryRow): CategoryView {
  return { categoryId: row.categoryId, name: row.name, kind: row.kind, state: row.state };
}

export class ExpenseCategoryService extends ReportingServiceBase {
  constructor(deps: ReportingDependencies) {
    super(deps);
  }

  async list(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly CategoryView[]> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId },
      CATEGORY_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const rows = await new ReportingRepository(uow).categories(hotelId);
        return rows.map((row) => view(row));
      },
    );
  }

  async create(
    input: {
      hotelId: string;
      name: string;
      kind: 'INVENTORY_PURCHASE' | 'OPERATING';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CategoryView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CATEGORY_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'reporting.expense_category', input.idempotencyKey, {
          name: input.name,
        });
        if (claimed.kind === 'replay') return claimed.body as CategoryView;
        await authorize();
        const repository = new ReportingRepository(uow);
        let created: ExpenseCategoryRow;
        try {
          created = await repository.createCategory({
            hotelId: input.hotelId,
            name: input.name,
            kind: input.kind,
            createdByAccountId: gate.principal.accountId,
          });
        } catch (error) {
          if (isDuplicateName(error)) {
            throw new ApiError('CONFLICT', 'that category name is already in use');
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'finance.expense_category_created',
          outcome: 'allowed',
          targetType: 'expense_category',
          targetRef: created.categoryId,
          payload: { name: input.name, kind: input.kind },
        });
        const body = view(created);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, body);
        return body;
      },
    );
  }

  async setState(
    input: {
      hotelId: string;
      categoryId: string;
      state: 'ACTIVE' | 'INACTIVE';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CategoryView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CATEGORY_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'reporting.category_state', input.idempotencyKey, {
          categoryId: input.categoryId,
          state: input.state,
        });
        if (claimed.kind === 'replay') return claimed.body as CategoryView;
        await authorize();
        const repository = new ReportingRepository(uow);
        const category = await repository.lockCategory(input.categoryId);
        if (category === undefined) throw new ApiError('NOT_FOUND', 'no such category');
        if (category.state === input.state) {
          throw new ApiError('CONFLICT', `that category is already ${input.state.toLowerCase()}`);
        }
        const moved = await repository.setCategoryState({
          categoryId: category.categoryId,
          expectedRevision: category.revision,
          state: input.state,
          at: this.now(uow),
        });
        if (!moved) throw new ApiError('CONFLICT', 'that category changed under this command');
        await recordPlatformAudit(uow, {
          action: 'finance.expense_category_state_changed',
          outcome: 'allowed',
          targetType: 'expense_category',
          targetRef: category.categoryId,
          payload: { state: input.state },
        });
        const body = { ...view(category), state: input.state };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, body);
        return body;
      },
    );
  }
}

function isDuplicateName(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (
    (error as { code?: unknown }).code === '23505' &&
    (error as { constraint?: unknown }).constraint === 'expense_category_name_uq'
  );
}
