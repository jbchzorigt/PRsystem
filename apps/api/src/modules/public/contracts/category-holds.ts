import type { UnitOfWork } from '@prsystem/db';

/**
 * Category inventory held by a confirmed online booking, for the module that
 * shows availability but does not own bookings (doc 09 §5; CLAUDE.md §3).
 *
 * Distinct from the stay module's `CategoryHoldsPort`, which asks a
 * different question of the same future table: that one wants the commitments
 * on *one physical room*, because a check-in is assigned a room. A public
 * search never sees a room — `BK-DEC-013` offers a category and its count —
 * so this one aggregates by category. Phase 13 implements both.
 *
 * Phase 12 shows what the *stays* say. Phase 13 adds `platform.booking` and the
 * category inventory a booking holds (`BK-DEC-013`), and supplies the real
 * implementation here. Until then the honest answer is that no booking holds
 * anything, because no booking exists.
 *
 * That answer stops being honest the moment the table does exist, and a default
 * that quietly over-reported availability would be the worst kind of wrong — it
 * would sell a room twice. So the default checks: if `platform.booking` is
 * there, it refuses rather than answering, and Phase 13 is told exactly what it
 * forgot to wire.
 */

export interface CategoryHold {
  readonly hotelId: string;
  readonly categoryId: string;
  /** Units of that category held for the whole of the requested window. */
  readonly held: number;
}

export interface CategoryHoldsPort {
  /**
   * How many units of each category are already committed in `[start, end)`.
   * Half-open, like every other occupancy interval (`STAY-DEC-008`).
   */
  heldInWindow(
    uow: UnitOfWork,
    window: { start: Date; end: Date },
    hotelIds: readonly string[],
  ): Promise<readonly CategoryHold[]>;
}

/** The Phase 12 default: nothing is held, and it fails closed once that changes. */
export class UnprovisionedCategoryHolds implements CategoryHoldsPort {
  async heldInWindow(
    uow: UnitOfWork,
    _window: { start: Date; end: Date },
    _hotelIds: readonly string[],
  ): Promise<readonly CategoryHold[]> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) {
      throw new Error(
        'platform.booking exists: public availability must read confirmed bookings ' +
          'through a real CategoryHoldsPort (Phase 13), not this default',
      );
    }
    return [];
  }
}
