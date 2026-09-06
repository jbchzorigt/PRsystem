import type { UnitOfWork } from '@prsystem/db';

/**
 * What makes a review *earned*, from the module that owns the booking
 * (CLAUDE.md §3).
 *
 * `RV-DEC-002` and `BK-DEC-005`: the account itself made the booking, the
 * booking is `COMPLETED`, and the stay it became recorded an actual checkout.
 * All three come from one read of the booking module's own tables, because a
 * review module that queried `platform.booking` directly would be reaching into
 * another module's storage.
 *
 * Nothing the client sends contributes: doc 10 §3 is explicit that eligibility
 * is never decided from a booking status the request carried.
 */
export interface ReviewEligibility {
  readonly bookingId: string;
  readonly hotelId: string;
  readonly bookerAccountId: string;
  readonly state: string;
  /** The stay's own `actual_checkout_at`, absent until the stay completed. */
  readonly actualCheckoutAt: Date | null;
}

export interface ReviewEligibilityPort {
  /** The booking, read in the account's own scope. `undefined` if it is not theirs. */
  bookingForReviewer(
    uow: UnitOfWork,
    bookingId: string,
    accountId: string,
  ): Promise<ReviewEligibility | undefined>;
}

export class ReviewEligibilityUnavailableError extends Error {
  override readonly name = 'ReviewEligibilityUnavailableError';
  constructor() {
    super('platform.booking exists but no review-eligibility implementation is registered');
  }
}

/**
 * The default when the booking module is not registered.
 *
 * `platform.booking` has existed since Phase 13, so this refuses rather than
 * answering "not eligible" — a review module wired without its eligibility
 * source would otherwise refuse every legitimate reviewer and look correct.
 */
export class UnprovisionedReviewEligibility implements ReviewEligibilityPort {
  async bookingForReviewer(uow: UnitOfWork): Promise<ReviewEligibility | undefined> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new ReviewEligibilityUnavailableError();
    return undefined;
  }
}

/** A deterministic in-memory implementation for the review module's own tests. */
export class SimulatedReviewEligibility implements ReviewEligibilityPort {
  readonly bookings = new Map<string, ReviewEligibility>();

  bookingForReviewer(
    _uow: UnitOfWork,
    bookingId: string,
    accountId: string,
  ): Promise<ReviewEligibility | undefined> {
    const found = this.bookings.get(bookingId);
    if (found === undefined || found.bookerAccountId !== accountId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(found);
  }
}
