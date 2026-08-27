import type { UnitOfWork } from './unit-of-work';
import type { TenantContext } from './tenant-context';

/**
 * The foundation every module repository extends (CLAUDE.md §3, ADR-0017 §4).
 *
 * RLS supplements this layer; it does not replace it. A repository still carries
 * its own tenant predicate, so a query denied by RLS should already have been
 * denied here. Two independent mechanisms, one of which must hold.
 */
export abstract class ScopedRepository {
  protected constructor(protected readonly uow: UnitOfWork) {}

  protected get context(): TenantContext {
    return this.uow.context;
  }

  /** The scope every query must filter by, in addition to the RLS policy. */
  protected get hotelId(): string {
    return this.uow.context.hotelId;
  }

  /**
   * Server time for this transaction. A repository never calls `new Date()`: a
   * long transaction must not straddle two "nows".
   */
  protected get serverNow(): Date {
    return this.uow.serverNow;
  }

  /**
   * Optimistic concurrency (ADR-0011): a conditional update on `revision`.
   * Returns false when another writer moved first, so the caller can retry or
   * surface `REVISION_MISMATCH` — never a silent last-write-wins.
   */
  protected async compareAndSwap(
    table: string,
    keyColumn: string,
    keyValue: string,
    expectedRevision: number,
    assignments: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const columns = Object.keys(assignments);
    const setClause = columns
      .map((column, index) => `${column} = $${String(index + 4)}`)
      .concat('revision = revision + 1')
      .join(', ');

    const result = await this.uow.query(
      `UPDATE ${table} SET ${setClause}
        WHERE ${keyColumn} = $1 AND revision = $2 AND hotel_id = $3`,
      [keyValue, expectedRevision, this.hotelId, ...columns.map((column) => assignments[column])],
    );

    return result.rowCount === 1;
  }
}
