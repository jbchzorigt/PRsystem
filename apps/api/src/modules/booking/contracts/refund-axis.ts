import type { UnitOfWork } from '@prsystem/db';
import type { BookingRefundAxisPort } from '../../settlement/contracts/booking-refund-axis';
import { BookingRepository } from '../repositories/booking.repository';

/**
 * The booking module's answer to the settlement module's contract
 * (CLAUDE.md §3).
 *
 * Only the refund axis moves here. The booking's own state, its payment axis
 * and its inventory are untouched, because doc 11 §5 is explicit that a refund
 * reaching or failing at the provider does neither of two things people expect
 * it to: it does not revive a cancelled booking, and it does not un-capture a
 * payment that really was taken.
 */
export class RepositoryBookingRefundAxis implements BookingRefundAxisPort {
  async setRefundState(
    uow: UnitOfWork,
    input: {
      bookingId: string;
      state: 'PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED';
      actorRef: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const bookings = new BookingRepository(uow);
    const booking = await bookings.lock(input.bookingId);
    if (booking === undefined) return false;
    // Already there, or already past it: `REFUNDED` is terminal on this axis and
    // the database refuses to move it, so a repeated delivery is a no-op here
    // rather than a constraint violation two layers down.
    if (booking.refundState === input.state || booking.refundState === 'REFUNDED') return true;
    const moved = await bookings.transition({
      bookingId: booking.bookingId,
      expectedRevision: booking.revision,
      from: [booking.state],
      refundState: input.state,
    });
    if (!moved) return false;
    await bookings.record({
      hotelId: booking.hotelId,
      bookingId: booking.bookingId,
      eventType: `booking.refund_${input.state.toLowerCase()}`,
      fromState: booking.state,
      toState: booking.state,
      actorRef: input.actorRef,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return true;
  }

  async factsOf(
    uow: UnitOfWork,
    bookingId: string,
  ): Promise<
    | {
        hotelId: string;
        bookingRef: string;
        state: string;
        paymentState: string;
        refundState: string;
      }
    | undefined
  > {
    const booking = await new BookingRepository(uow).byId(bookingId);
    if (booking === undefined) return undefined;
    return {
      hotelId: booking.hotelId,
      bookingRef: booking.bookingRef,
      state: booking.state,
      paymentState: booking.paymentState,
      refundState: booking.refundState,
    };
  }
}
