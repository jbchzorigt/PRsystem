import type { UnitOfWork } from '@prsystem/db';

/**
 * The drawer side of a cash transaction, from the module that owns the ledger
 * (Phase 11), through a contract rather than a table (CLAUDE.md §3).
 *
 * doc 24 §4: a guest paying cash puts money in a drawer, and the drawer's shift
 * is accountable for it. The billing module owns the payment and its state; it
 * does not own the drawer. So each cash-channel transaction it writes is
 * mirrored through this contract, in the same transaction, and a hotel where
 * the mirror fails records neither side.
 *
 * Until Phase 11 registers an implementation there is no ledger to mirror into;
 * once `platform.cash_movement` exists, the default refuses rather than letting
 * cash reach a folio without reaching a drawer.
 */

export type CashTransactionKind =
  | 'DEPOSIT_RECEIPT'
  | 'DEPOSIT_REFUND'
  | 'DEPOSIT_REVERSAL'
  | 'FOLIO_PAYMENT'
  | 'FOLIO_PAYMENT_REVERSAL'
  | 'CORRECTED_PAYMENT';

export interface CashPosting {
  readonly transactionId: string;
  readonly kind: CashTransactionKind;
  readonly direction: 'IN' | 'OUT';
  readonly amountMnt: bigint;
  /** The shift the payment named. Cash without one is refused before this point. */
  readonly shiftId: string | null;
  readonly accountId: string;
  readonly at: Date;
  readonly reason?: string;
}

export interface CashPostingsPort {
  /** Mirrors one cash-channel transaction into the drawer ledger. */
  record(uow: UnitOfWork, posting: CashPosting): Promise<void>;
}

export class CashPostingsUnavailableError extends Error {
  override readonly name = 'CashPostingsUnavailableError';
  constructor() {
    super('platform.cash_movement exists but no cash ledger implementation is registered');
  }
}

/** The default until Phase 11: no ledger, nothing to mirror. */
export class UnprovisionedCashPostings implements CashPostingsPort {
  async record(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.cash_movement') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new CashPostingsUnavailableError();
  }
}

/** A deterministic in-memory implementation for the billing module's own tests. */
export class SimulatedCashPostings implements CashPostingsPort {
  readonly posted: CashPosting[] = [];

  record(_uow: UnitOfWork, posting: CashPosting): Promise<void> {
    this.posted.push(posting);
    return Promise.resolve();
  }
}
