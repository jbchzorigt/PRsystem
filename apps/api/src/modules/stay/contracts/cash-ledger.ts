import type { UnitOfWork } from '@prsystem/db';

/**
 * What the shift needs from the cash ledger, from the module that owns it
 * (Phase 11), through a contract rather than a table (CLAUDE.md §3).
 *
 * The shift row belongs to this module: it is the bound a check-in reads. The
 * drawer it is opened over, the movements posted inside it and the transfers
 * still outstanding belong to the finance module. So the shift asks three
 * questions and never selects from `platform.cash_movement` itself: which
 * drawer to open on, seed the drawer's one-off float, and what the shift is
 * expected to hold now (doc 24 §§3, 6; `CASH-DEC-001`, `-006`).
 *
 * Until Phase 11 registers an implementation the ledger relation does not
 * exist and a shift is the Phase 08 row with no drawer behind it; once
 * `platform.cash_movement` exists, the default refuses rather than letting a
 * shift open over an unaccounted drawer.
 */

export interface ShiftCashSummary {
  /** The opening count plus every movement posted in the shift (doc 24 §6). */
  readonly expectedCashMnt: bigint;
  /** `CASH-DEC-006`: a shift with a transfer still pending cannot close. */
  readonly pendingTransferCount: number;
}

export interface CashLedgerPort {
  /**
   * The drawer a shift opens over — the one named, or the hotel's default. It
   * is `undefined` when the hotel has no such active drawer, which refuses the
   * opening rather than defaulting to another drawer's money.
   */
  drawerForOpening(uow: UnitOfWork, locationId?: string): Promise<string | undefined>;

  /**
   * doc 24 §3: a drawer's ledger starts once, with the amount first counted on
   * it. Called with the opening count of the drawer's first shift; a drawer
   * that already has its float is left alone.
   */
  seedInitialFloat(
    uow: UnitOfWork,
    input: {
      readonly locationId: string;
      readonly amountMnt: bigint;
      readonly accountId: string;
      readonly at: Date;
    },
  ): Promise<void>;

  /** The expected cash of a shift, and whether a transfer still blocks its close. */
  summarizeShift(
    uow: UnitOfWork,
    input: { readonly shiftId: string; readonly openingBalanceMnt: bigint },
  ): Promise<ShiftCashSummary>;
}

export class CashLedgerUnavailableError extends Error {
  override readonly name = 'CashLedgerUnavailableError';
  constructor() {
    super('platform.cash_movement exists but no cash ledger implementation is registered');
  }
}

async function ledgerExists(uow: UnitOfWork): Promise<boolean> {
  const result = await uow.query<{ present: boolean }>(
    `SELECT to_regclass('platform.cash_movement') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

/** The default until Phase 11: no ledger, no drawer accounting to do. */
export class UnprovisionedCashLedger implements CashLedgerPort {
  async drawerForOpening(uow: UnitOfWork): Promise<string | undefined> {
    if (await ledgerExists(uow)) throw new CashLedgerUnavailableError();
    return undefined;
  }

  async seedInitialFloat(uow: UnitOfWork): Promise<void> {
    if (await ledgerExists(uow)) throw new CashLedgerUnavailableError();
  }

  async summarizeShift(
    uow: UnitOfWork,
    input: { readonly shiftId: string; readonly openingBalanceMnt: bigint },
  ): Promise<ShiftCashSummary> {
    if (await ledgerExists(uow)) throw new CashLedgerUnavailableError();
    return { expectedCashMnt: input.openingBalanceMnt, pendingTransferCount: 0 };
  }
}
