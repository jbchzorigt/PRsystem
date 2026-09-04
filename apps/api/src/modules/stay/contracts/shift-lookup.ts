import type { UnitOfWork } from '@prsystem/db';
import { ShiftRepository } from '../repositories/shift.repository';
import type { ShiftState } from '../repositories/shift.repository';

/**
 * Which shift a cash movement belongs to, for the module that owns the ledger
 * but not the shift (doc 24 §2.2; CLAUDE.md §3).
 *
 * A drawer movement names the shift it happened in. That fact lives in this
 * module's table, so the finance module asks for it through this contract
 * rather than selecting `platform.reception_shift` itself.
 */

export interface ActiveShift {
  readonly shiftId: string;
  readonly state: ShiftState;
  readonly openedByAccountId: string;
  readonly locationId: string | null;
}

export interface ShiftLookupPort {
  /**
   * The shift currently accountable for the drawer — the one that has not
   * closed. A drawer being counted (`CLOSING`) or handed over still owns the
   * movements posted against it until it closes.
   */
  activeShiftOnDrawer(uow: UnitOfWork, locationId: string): Promise<ActiveShift | undefined>;

  /** The drawer a shift is accountable for — the other direction, for a
   * movement that knows its shift but not its location. */
  drawerOfShift(uow: UnitOfWork, shiftId: string): Promise<string | undefined>;
}

/** The implementation, over this module's own repository. */
export class RepositoryShiftLookup implements ShiftLookupPort {
  async activeShiftOnDrawer(uow: UnitOfWork, locationId: string): Promise<ActiveShift | undefined> {
    const rows = await new ShiftRepository(uow).activeOnDrawer(locationId);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      shiftId: row.shiftId,
      state: row.state,
      openedByAccountId: row.openedByAccountId,
      locationId: row.locationId,
    };
  }

  async drawerOfShift(uow: UnitOfWork, shiftId: string): Promise<string | undefined> {
    const row = await new ShiftRepository(uow).byId(shiftId);
    return row?.locationId ?? undefined;
  }
}
