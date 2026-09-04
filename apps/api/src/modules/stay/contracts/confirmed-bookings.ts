import type { UnitOfWork } from '@prsystem/db';

/**
 * What the stay module needs to know about confirmed online bookings, from
 * the module that will own them (Phase 13), through a contract rather than a
 * table (CLAUDE.md §3).
 *
 * Two questions: the next confirmed booking a room is committed to — the
 * availability and overdue-conflict rules of doc 05 §6 and §23 — and the
 * confirmed booking a check-in is fulfilling, whose planned start bounds a
 * backdate (doc 05 §19.1). Until Phase 13 registers an implementation, the
 * relation it will create does not exist, and that absence is evidence that
 * there is no booking — exactly as the catalog and minibar registries treat a
 * not-yet-provisioned relation. Once `platform.booking` exists, this default
 * refuses rather than answering "none" from a table it does not read.
 */

export interface NextBookingFacts {
  readonly bookingRef: string;
  readonly categoryId: string;
  /** The physical room the booking is assigned to, when it has one. */
  readonly assignedRoomId: string | null;
  readonly plannedCheckInAt: Date;
  readonly plannedCheckoutAt: Date;
  readonly cleaningBufferMinutes: number;
}

export interface ConfirmedBookingsPort {
  /** Confirmed bookings assigned to this room that start at or after `from`, earliest first. */
  nextForRoom(uow: UnitOfWork, roomId: string, from: Date): Promise<readonly NextBookingFacts[]>;
  /** The confirmed booking with this reference, for the check-in that fulfils it. */
  byReference(uow: UnitOfWork, bookingRef: string): Promise<NextBookingFacts | undefined>;
  /** Confirmed bookings of the category whose cleaning-preparation boundary has been reached. */
  dueForCategory(
    uow: UnitOfWork,
    categoryId: string,
    now: Date,
  ): Promise<readonly NextBookingFacts[]>;
}

export class BookingsUnavailableError extends Error {
  override readonly name = 'BookingsUnavailableError';
  constructor() {
    super('platform.booking exists but no confirmed-bookings implementation is registered');
  }
}

/**
 * The default until Phase 13: no relation, no bookings — and a relation with
 * no implementation behind it is a refusal, never an empty answer.
 */
export class UnprovisionedConfirmedBookings implements ConfirmedBookingsPort {
  private async ensureAbsent(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new BookingsUnavailableError();
  }

  async nextForRoom(uow: UnitOfWork): Promise<readonly NextBookingFacts[]> {
    await this.ensureAbsent(uow);
    return [];
  }

  async byReference(uow: UnitOfWork): Promise<NextBookingFacts | undefined> {
    await this.ensureAbsent(uow);
    return undefined;
  }

  async dueForCategory(uow: UnitOfWork): Promise<readonly NextBookingFacts[]> {
    await this.ensureAbsent(uow);
    return [];
  }
}

/** A deterministic in-memory implementation for the stay module's own tests. */
export class SimulatedConfirmedBookings implements ConfirmedBookingsPort {
  private readonly bookings: NextBookingFacts[] = [];

  add(booking: NextBookingFacts): void {
    this.bookings.push(booking);
  }

  clear(): void {
    this.bookings.length = 0;
  }

  nextForRoom(_uow: UnitOfWork, roomId: string, from: Date): Promise<readonly NextBookingFacts[]> {
    return Promise.resolve(
      this.bookings
        .filter(
          (b) => b.assignedRoomId === roomId && b.plannedCheckInAt.getTime() >= from.getTime(),
        )
        .sort((a, b) => a.plannedCheckInAt.getTime() - b.plannedCheckInAt.getTime()),
    );
  }

  byReference(_uow: UnitOfWork, bookingRef: string): Promise<NextBookingFacts | undefined> {
    return Promise.resolve(this.bookings.find((b) => b.bookingRef === bookingRef));
  }

  dueForCategory(
    _uow: UnitOfWork,
    categoryId: string,
    now: Date,
  ): Promise<readonly NextBookingFacts[]> {
    return Promise.resolve(
      this.bookings.filter(
        (b) =>
          b.categoryId === categoryId &&
          b.plannedCheckInAt.getTime() - b.cleaningBufferMinutes * 60_000 <= now.getTime() &&
          b.plannedCheckInAt.getTime() > now.getTime() - 24 * 60 * 60_000,
      ),
    );
  }
}
