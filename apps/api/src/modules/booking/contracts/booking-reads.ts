import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent } from '@prsystem/db';
import { hotelLocalDate, instant } from '@prsystem/time';
import type {
  ConfirmedBookingsPort,
  NextBookingFacts,
} from '../../stay/contracts/confirmed-bookings';
import type { CategoryHold, CategoryHoldsPort } from '../../public/contracts/category-holds';
import type { BookingFulfilmentPort } from '../../stay/contracts/booking-fulfilment';
import type {
  ReviewEligibility,
  ReviewEligibilityPort,
} from '../../review/contracts/review-eligibility';
import { fromPgDate, nightsOf, toDateString } from '../domain/booking';
import { BookingRepository } from '../repositories/booking.repository';
import { hotelTimeZone } from '../services/booking-context';
import type { SettlementPort } from './settlement';
import { RepositorySettlement } from '../../settlement/contracts/booking-settlement';

/**
 * What the booking module answers for the two modules that need bookings but do
 * not own them (CLAUDE.md §3).
 *
 * Both defaults refused the moment `platform.booking` existed, which is why
 * they are implemented together: implementing one and forgetting the other
 * would have left public availability over-reporting, and the refusal is what
 * made that impossible to miss.
 *
 * The two answer different questions of the same table. The stay wants the
 * commitments on **one physical room**, because a check-in is assigned a room.
 * A public search never sees a room — `BK-DEC-013` offers a category and a
 * count — so the other aggregates by category.
 */

/** The stay's view: what a room is committed to (doc 05 §§5–6, §19.1). */
export class RepositoryConfirmedBookings implements ConfirmedBookingsPort {
  /**
   * `BK-DEC-013` assigns the physical room at check-in, so before that moment a
   * confirmed booking is committed to a *category*, not to a room. A room
   * therefore has no booking commitments of its own until one is assigned, and
   * this answers exactly that: the bookings already fulfilled into a stay in
   * this room, whose interval has not ended.
   */
  async commitmentsForRoom(
    uow: UnitOfWork,
    roomId: string,
    at: Date,
  ): Promise<readonly NextBookingFacts[]> {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT b.booking_ref, b.category_id, s.room_id, b.check_in_date, b.check_out_date,
              s.cleaning_buffer_minutes
         FROM platform.booking b
         JOIN platform.stay s ON s.fulfilled_booking_id = b.booking_id
        WHERE s.room_id = $1
          AND b.state = ANY (ARRAY['CONFIRMED', 'CHECKED_IN'])
          AND b.check_out_date > $2::date
        ORDER BY b.check_in_date`,
      [roomId, at],
    );
    return result.rows.map(mapFacts);
  }

  async byReference(uow: UnitOfWork, bookingRef: string): Promise<NextBookingFacts | undefined> {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT b.booking_ref, b.category_id, NULL::uuid AS room_id, b.check_in_date,
              b.check_out_date,
              COALESCE(c.cleaning_buffer_minutes, h.cleaning_buffer_minutes) AS cleaning_buffer_minutes
         FROM platform.booking b
         JOIN platform.room_category c
           ON c.hotel_id = b.hotel_id AND c.category_id = b.category_id
         JOIN platform.hotel_stay_configuration h ON h.hotel_id = b.hotel_id
        WHERE b.booking_ref = $1
          AND b.state = 'CONFIRMED'`,
      [bookingRef],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapFacts(row);
  }

  /** Confirmed bookings of a category whose arrival is due (doc 05 §6). */
  async dueForCategory(
    uow: UnitOfWork,
    categoryId: string,
    now: Date,
  ): Promise<readonly NextBookingFacts[]> {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT b.booking_ref, b.category_id, NULL::uuid AS room_id, b.check_in_date,
              b.check_out_date,
              COALESCE(c.cleaning_buffer_minutes, h.cleaning_buffer_minutes) AS cleaning_buffer_minutes
         FROM platform.booking b
         JOIN platform.room_category c
           ON c.hotel_id = b.hotel_id AND c.category_id = b.category_id
         JOIN platform.hotel_stay_configuration h ON h.hotel_id = b.hotel_id
        WHERE b.category_id = $1
          AND b.state = 'CONFIRMED'
          AND b.check_in_date <= $2::date
        ORDER BY b.check_in_date`,
      [categoryId, now],
    );
    return result.rows.map(mapFacts);
  }
}

/** The public surface's view: how many units of a category are taken. */
export class RepositoryCategoryHolds implements CategoryHoldsPort {
  async heldInWindow(
    uow: UnitOfWork,
    window: { start: Date; end: Date },
    hotelIds: readonly string[],
  ): Promise<readonly CategoryHold[]> {
    if (hotelIds.length === 0) return [];
    const nights = nightsOf(window.start, window.end);
    if (nights.length === 0) return [];
    // Through the resolver function, because a public search has no tenant of
    // its own and these are tenant tables — the same boundary Phase 12's
    // listing projection crosses, and the only one that crosses it.
    const result = await uow.query<{ hotel_id: string; category_id: string; held: string }>(
      `SELECT hotel_id, category_id, held
         FROM platform.public_category_holds($1::uuid[], $2::date[])`,
      [hotelIds, nights.map(toDateString)],
    );
    return result.rows.map((row) => ({
      hotelId: row.hotel_id,
      categoryId: row.category_id,
      held: Number(row.held),
    }));
  }
}

function mapFacts(row: Record<string, unknown>): NextBookingFacts {
  const checkIn = fromPgDate(row['check_in_date'] as Date);
  const checkOut = fromPgDate(row['check_out_date'] as Date);
  return {
    bookingRef: String(row['booking_ref']),
    categoryId: String(row['category_id']),
    assignedRoomId: (row['room_id'] as string | null) ?? null,
    plannedCheckInAt: checkIn,
    plannedCheckoutAt: checkOut,
    cleaningBufferMinutes: Number(row['cleaning_buffer_minutes']),
  };
}

/**
 * The write half: the check-in consuming the booking it fulfils.
 *
 * It runs inside the check-in's transaction, so the category unit becomes the
 * stay's occupancy atomically (`BK-DEC-013`). The unit is not released here and
 * that is deliberate: the booking's `units_held` stays taken while the stay
 * that replaced it carries `fulfilled_booking_id`, and the capacity query
 * excludes exactly those stays — so the night is subtracted once, by one of the
 * two, at every instant.
 */
export class RepositoryBookingFulfilment implements BookingFulfilmentPort {
  /**
   * The ledger side of a checkout, from the module that owns it (Phase 14).
   *
   * Injected rather than reached for, so the check-in half of this contract
   * stays a pure booking concern and the checkout half is the one place the two
   * modules meet.
   */
  constructor(private readonly settlement: SettlementPort = new RepositorySettlement()) {}

  async consumeAtCheckIn(
    uow: UnitOfWork,
    input: { bookingRef: string; stayId: string; actorRef: string },
  ): Promise<string | undefined> {
    const locked = await uow.query<{ booking_id: string; hotel_id: string; revision: number }>(
      `SELECT booking_id, hotel_id, revision FROM platform.booking
        WHERE booking_ref = $1 FOR UPDATE`,
      [input.bookingRef],
    );
    const row = locked.rows[0];
    if (row === undefined) return undefined;

    const advanced = await uow.query(
      `UPDATE platform.booking
          SET state = 'CHECKED_IN', hold_state = 'CONSUMED', fulfilled_stay_id = $3::uuid,
              revision = revision + 1
        WHERE booking_id = $1::uuid AND revision = $2 AND state = 'CONFIRMED'`,
      [row.booking_id, row.revision, input.stayId],
    );
    if ((advanced.rowCount ?? 0) !== 1) return undefined;

    await uow.query(
      `INSERT INTO platform.booking_event
         (hotel_id, booking_id, event_type, from_state, to_state, actor_ref)
       VALUES ($1::uuid, $2::uuid, 'booking.checked_in', 'CONFIRMED', 'CHECKED_IN', $3)`,
      [row.hotel_id, row.booking_id, input.actorRef],
    );
    return row.booking_id;
  }

  /**
   * doc 11 §8: the stay completed, so the booking it fulfilled is honoured.
   *
   * `COMPLETED` is the one terminal state that releases no inventory — the unit
   * was consumed by the stay rather than given back — and it is what makes the
   * retained room charge eligible for the `D+1` payout. A stay that fulfilled
   * no booking is a walk-in and completes nothing here.
   */
  async completeAtCheckout(
    uow: UnitOfWork,
    input: { stayId: string; actorRef: string },
  ): Promise<string | undefined> {
    const bookings = new BookingRepository(uow);
    const booking = await bookings.lockByStay(input.stayId);
    if (booking === undefined || booking.state !== 'CHECKED_IN') return undefined;
    const now = uow.serverNow;
    const advanced = await bookings.transition({
      bookingId: booking.bookingId,
      expectedRevision: booking.revision,
      from: ['CHECKED_IN'],
      state: 'COMPLETED',
      terminalAt: now,
      terminalReason: 'the stay was checked out',
    });
    if (!advanced) return undefined;
    await bookings.record({
      hotelId: booking.hotelId,
      bookingId: booking.bookingId,
      eventType: 'booking.completed',
      fromState: 'CHECKED_IN',
      toState: 'COMPLETED',
      actorRef: input.actorRef,
    });
    const zone = await hotelTimeZone(uow);
    await this.settlement.markEligible(uow, {
      bookingId: booking.bookingId,
      at: now,
      localDate: hotelLocalDate(instant(now), zone),
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'booking',
      aggregateId: booking.bookingId,
      eventType: 'booking.completed',
      payload: { bookingId: booking.bookingId, hotelId: booking.hotelId },
    });
    return booking.bookingId;
  }
}

/**
 * The review module's view: what makes a review earned (`RV-DEC-002`).
 *
 * One read, answering all three of doc 10 §3's conditions — the account made
 * the booking, the booking is `COMPLETED`, and the checkout that completed it.
 *
 * The checkout time comes from the booking's own `terminal_at`, not from a join
 * to `platform.stay`. Two reasons, and they agree. The value is the same
 * instant: `recordActualCheckout` stamps `stay.actual_checkout_at` and calls
 * `completeAtCheckout` in one transaction, both from that transaction's server
 * time. And the reviewer reads this in their *own* account scope, where the
 * only rows visible are their own bookings — `platform.stay` is a hotel tenant
 * row and is invisible there, so a join to it would silently answer NULL for
 * every legitimate reviewer.
 *
 * A booking that is not theirs is simply not visible, so the ownership check
 * and the tenant check are the same read rather than two that have to agree.
 */
export class RepositoryReviewEligibility implements ReviewEligibilityPort {
  async bookingForReviewer(
    uow: UnitOfWork,
    bookingId: string,
    accountId: string,
  ): Promise<ReviewEligibility | undefined> {
    const result = await uow.query<{
      booking_id: string;
      hotel_id: string;
      booker_account_id: string;
      state: string;
      actual_checkout_at: Date | null;
    }>(
      `SELECT b.booking_id, b.hotel_id, b.booker_account_id, b.state,
              CASE WHEN b.state = 'COMPLETED' THEN b.terminal_at END AS actual_checkout_at
         FROM platform.booking b
        WHERE b.booking_id = $1::uuid AND b.booker_account_id = $2::uuid`,
      [bookingId, accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      bookingId: row.booking_id,
      hotelId: row.hotel_id,
      bookerAccountId: row.booker_account_id,
      state: row.state,
      actualCheckoutAt: row.actual_checkout_at,
    };
  }
}
