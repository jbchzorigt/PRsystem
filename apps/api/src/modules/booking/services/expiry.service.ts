import { BookingRepository } from '../repositories/booking.repository';
import { hasLapsed } from '../domain/booking';
import type { BookingDependencies, RequestContext } from './booking-context';
import { newBookingRequest } from './booking-context';
import { BookingService } from './booking.service';

/**
 * The ten-minute sweep (`BK-DEC-009`, `PAY-DEC-002`, `PAY-DEC-006`).
 *
 * It reads the bookings whose hold has lapsed, then settles each one in its own
 * transaction, on its own row lock. That is deliberate: a sweep that took a
 * hundred bookings in one transaction would hold a hundred inventory rows
 * against every guest trying to book those nights, and a failure anywhere would
 * roll back the ninety-nine it had already settled.
 *
 * The race with a payment callback is resolved by the lock and by nothing else.
 * Whichever transaction takes the booking first wins; the other re-reads it and
 * sees a settled row. `hasLapsed` is checked *inside* the lock, so a booking
 * confirmed a millisecond earlier is not expired by a decision taken before it.
 */
export class BookingExpiryService {
  private readonly bookings: BookingService;

  constructor(private readonly deps: BookingDependencies) {
    this.bookings = new BookingService(deps);
  }

  /** Settles up to `limit` lapsed holds. Returns how many actually expired. */
  async sweep(limit = 100, request: RequestContext = newBookingRequest()): Promise<number> {
    const candidates = await this.candidates(limit);
    let expired = 0;
    for (const candidate of candidates) {
      if (await this.expireOne(candidate.bookingId, candidate.hotelId, request)) expired += 1;
    }
    return expired;
  }

  /**
   * The candidate list, read without a lock.
   *
   * Reading it unlocked is safe because nothing is decided here: every row is
   * re-read and re-judged under its own lock before anything is written.
   */
  private async candidates(
    limit: number,
  ): Promise<readonly { bookingId: string; hotelId: string }[]> {
    // The cutoff is the server's now — the same clock every command reads, so a
    // test that moves it moves the sweep with it rather than being told the
    // database disagrees.
    const now = this.deps.clock === undefined ? undefined : this.deps.clock();
    // Through the resolver function: the sweep has no tenant, and it has to see
    // across every hotel before it can settle anything in one.
    const rows = await this.deps.pool.query<{ booking_id: string; hotel_id: string }>(
      `SELECT booking_id, hotel_id FROM platform.lapsed_booking_holds($1::integer, $2::timestamptz)`,
      [limit, now ?? null],
    );
    return rows.rows.map((row) => ({ bookingId: row.booking_id, hotelId: row.hotel_id }));
  }

  /**
   * Expires one booking, or leaves it alone.
   *
   * `false` is not a failure: it means the booking was confirmed, cancelled or
   * expired by somebody else between the read and the lock, which is exactly
   * the race this design expects to lose sometimes.
   */
  async expireOne(bookingId: string, hotelId: string, request: RequestContext): Promise<boolean> {
    return this.bookings.runInHotelScope(hotelId, request, async (uow) => {
      const booking = await new BookingRepository(uow).lock(bookingId);
      if (booking === undefined) return false;
      // Judged under the lock, not before it: a booking confirmed a millisecond
      // ago is not expired by a decision taken against an older read.
      if (!hasLapsed(booking, this.bookings.serverNow(uow))) return false;
      await this.bookings.terminate(uow, booking, 'EXPIRED', {
        actorRef: 'system:hold-expiry',
        reason: 'the ten-minute payment hold lapsed',
        holdState: 'EXPIRED',
        paymentState: 'EXPIRED',
      });
      return true;
    });
  }
}
