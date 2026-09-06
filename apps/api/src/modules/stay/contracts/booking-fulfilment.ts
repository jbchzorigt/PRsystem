import type { UnitOfWork } from '@prsystem/db';

/**
 * Consuming a confirmed booking at check-in, for the module that performs the
 * check-in but does not own the booking (`BK-DEC-013`; CLAUDE.md §3).
 *
 * doc 09 §5 requires the category reservation to become the stay's occupancy
 * **atomically**, so it is never counted twice and never briefly counted zero
 * times. That means the write happens inside the check-in's own transaction,
 * on the booking row it has just locked — which is what this contract is for.
 */
export interface BookingFulfilmentPort {
  /**
   * Moves a confirmed booking to `CHECKED_IN` and points it at the stay.
   *
   * Returns the booking's id, which the stay records as the booking it
   * fulfilled, or `undefined` when the booking is not in a state that can be
   * fulfilled — already checked in, cancelled, or expired between the read and
   * the lock. The caller then refuses the check-in rather than creating a stay
   * for a booking that no longer authorizes one.
   */
  consumeAtCheckIn(
    uow: UnitOfWork,
    input: { bookingRef: string; stayId: string; actorRef: string },
  ): Promise<string | undefined>;
}

/**
 * The default until Phase 13: no relation, no bookings — and a relation with no
 * implementation behind it is a refusal, never a silent success. A check-in
 * that consumed nothing would leave the booking `CONFIRMED` for ever and its
 * unit held against every later guest.
 */
export class UnprovisionedBookingFulfilment implements BookingFulfilmentPort {
  async consumeAtCheckIn(uow: UnitOfWork): Promise<string | undefined> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) {
      throw new Error(
        'platform.booking exists: a check-in must consume the booking it fulfils ' +
          'through a real BookingFulfilmentPort (Phase 13), not this default',
      );
    }
    return undefined;
  }
}

/** A deterministic in-memory implementation for the stay module's own tests. */
export class SimulatedBookingFulfilment implements BookingFulfilmentPort {
  readonly consumed: { bookingRef: string; stayId: string }[] = [];
  private refuse = false;
  private readonly ids = new Map<string, string>();

  refuseNext(): void {
    this.refuse = true;
  }

  /** Teaches the simulator which booking a reference names. */
  register(bookingRef: string, bookingId: string): void {
    this.ids.set(bookingRef, bookingId);
  }

  consumeAtCheckIn(
    _uow: UnitOfWork,
    input: { bookingRef: string; stayId: string },
  ): Promise<string | undefined> {
    if (this.refuse) {
      this.refuse = false;
      return Promise.resolve(undefined);
    }
    this.consumed.push({ bookingRef: input.bookingRef, stayId: input.stayId });
    return Promise.resolve(this.ids.get(input.bookingRef));
  }
}
