import type { UnitOfWork } from '@prsystem/db';

/**
 * What a confirmed check-in owes the billing module, from the module that will
 * own the money (Phase 10), through a contract rather than a table
 * (CLAUDE.md §3).
 *
 * doc 02 §3.4 and `DEP-DEC-001`: a walk-in checks in against a configured
 * deposit, and a hotel that has configured none cannot take a walk-in at all.
 * The confirmation is where that requirement and the configuration behind it
 * are snapshotted, so it is the confirmation that opens the aggregate
 * (`DEP-DEC-008`).
 *
 * Until Phase 10 registers an implementation the relation it will create does
 * not exist, and its absence is evidence that no deposit is tracked yet; once
 * `platform.deposit_aggregate` exists, this default refuses rather than
 * silently letting a walk-in check in with no deposit at all.
 */

export interface StayDepositFacts {
  readonly stayId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly source: 'WALK_IN' | 'ONLINE';
}

export interface DepositsPort {
  /** Opens the folio and the deposit aggregate of a confirmed stay. */
  openForStay(uow: UnitOfWork, facts: StayDepositFacts): Promise<void>;
}

export class DepositsUnavailableError extends Error {
  override readonly name = 'DepositsUnavailableError';
  constructor() {
    super('platform.deposit_aggregate exists but no deposit implementation is registered');
  }
}

/** The default until Phase 10: no relation, no deposit to open. */
export class UnprovisionedDeposits implements DepositsPort {
  async openForStay(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.deposit_aggregate') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new DepositsUnavailableError();
  }
}

/** A deterministic in-memory implementation for the stay module's own tests. */
export class SimulatedDeposits implements DepositsPort {
  readonly opened: StayDepositFacts[] = [];

  openForStay(_uow: UnitOfWork, facts: StayDepositFacts): Promise<void> {
    this.opened.push(facts);
    return Promise.resolve();
  }
}
