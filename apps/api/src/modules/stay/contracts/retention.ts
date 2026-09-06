import type { UnitOfWork } from '@prsystem/db';

/**
 * What a completed checkout owes the module that owns guest-data retention
 * (`GUEST-DEC-008`, doc 12 §9; CLAUDE.md §3).
 *
 * The countdown starts at the checkout and nowhere else, so the snapshot is
 * written inside the checkout's own transaction: a stay that completed without
 * one would be a guest record with no deadline at all, which is the one state
 * doc 12 §9 does not allow.
 */

export interface RetentionPort {
  recordCheckout(
    uow: UnitOfWork,
    input: { readonly hotelId: string; readonly stayId: string; readonly checkoutAt: Date },
  ): Promise<void>;
}

export class RetentionUnavailableError extends Error {
  override readonly name = 'RetentionUnavailableError';
  constructor() {
    super('platform.stay_retention exists but no retention implementation is registered');
  }
}

/**
 * The default until the reporting module is registered.
 *
 * Once `platform.stay_retention` exists its absence is no longer evidence, so
 * this refuses rather than letting a checkout complete and leave the guest's
 * identity with no retention deadline attached to it.
 */
export class UnprovisionedRetention implements RetentionPort {
  async recordCheckout(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.stay_retention') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new RetentionUnavailableError();
  }
}

/** A deterministic in-memory implementation for the stay module's own tests. */
export class SimulatedRetention implements RetentionPort {
  readonly recorded: { hotelId: string; stayId: string; checkoutAt: Date }[] = [];

  recordCheckout(
    _uow: UnitOfWork,
    input: { hotelId: string; stayId: string; checkoutAt: Date },
  ): Promise<void> {
    this.recorded.push(input);
    return Promise.resolve();
  }
}
