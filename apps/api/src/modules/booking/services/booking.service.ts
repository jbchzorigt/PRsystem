import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { BookingRepository } from '../repositories/booking.repository';
import type { BookingRow } from '../repositories/booking.repository';
import type { BookingState } from '../domain/booking';
import {
  attemptExpiry,
  captureOutcome,
  formatReference,
  holdExpiryFrom,
  isTerminal,
  nightsOf,
  refundOnHotelCancellation,
  releasesInventory,
  windowProblem,
} from '../domain/booking';
import type { BookingDependencies, RequestContext } from './booking-context';
import { BookingServiceBase, claim, isOverbookingRefusal } from './booking-context';

/**
 * The online booking, from the ten-minute hold to the terminal transition
 * (`BK-DEC-009`, `-012`, `-013`, `-014`; `PAY-DEC-002`, `-006`).
 *
 * Three rules shape every command here.
 *
 * **The database refuses the overbooking, not this file.** A hold takes one
 * unit of each night under a row lock taken in night order, and the
 * `category_night_inventory_within_capacity` CHECK is what turns the
 * (capacity + 1)-th into a refusal. Nothing here counts and then acts.
 *
 * **The Guest identity is the server's.** Every command that names a booking
 * checks it against the account the session resolved to. A booking id in a
 * request selects which of the caller's own bookings to act on; it never binds
 * authority, and a booking belonging to somebody else answers `NOT_FOUND` —
 * the same answer a booking that does not exist gets.
 *
 * **Expiry and the callback compete on one row.** Both take the booking `FOR
 * UPDATE` and both read the same clock. Whichever arrives second sees a settled
 * booking and, if it is carrying money, raises a refund obligation instead of
 * reopening anything.
 */

export interface HeldBooking {
  readonly bookingId: string;
  readonly bookingRef: string;
  readonly holdExpiresAt: Date;
  readonly nightCount: number;
  readonly totalAmountMnt: bigint;
  readonly attempt: {
    readonly attemptId: string;
    readonly provider: 'QPAY' | 'KHAAN';
    readonly expiresAt: Date;
  };
}

export interface BookingView {
  readonly bookingId: string;
  readonly bookingRef: string;
  readonly hotelId: string;
  readonly categoryId: string;
  readonly stayingGuestName: string;
  readonly checkInDate: Date;
  readonly checkOutDate: Date;
  readonly nightCount: number;
  readonly state: BookingState;
  readonly holdState: string;
  readonly paymentState: string;
  readonly refundState: string;
  readonly holdExpiresAt: Date;
  readonly totalAmountMnt: bigint | null;
}

export function bookingView(row: BookingRow): BookingView {
  return {
    bookingId: row.bookingId,
    bookingRef: row.bookingRef,
    hotelId: row.hotelId,
    categoryId: row.categoryId,
    stayingGuestName: row.stayingGuestName,
    checkInDate: row.checkInDate,
    checkOutDate: row.checkOutDate,
    nightCount: row.nightCount,
    state: row.state,
    holdState: row.holdState,
    paymentState: row.paymentState,
    refundState: row.refundState,
    holdExpiresAt: row.holdExpiresAt,
    totalAmountMnt: row.totalAmountMnt,
  };
}

const LIVE: readonly BookingState[] = ['HOLDING', 'CONFIRMED'];

export class BookingService extends BookingServiceBase {
  constructor(deps: BookingDependencies) {
    super(deps);
  }

  /**
   * Takes the ten-minute hold and opens a payment attempt (doc 09 §7 steps 5–6).
   *
   * The hotel is resolved from the category on the server. The window, the
   * price and the availability are all re-checked inside the transaction that
   * takes the units — doc 09 §10 requires exactly that, and a check made before
   * the lock would be a check made against a different world.
   */
  async hold(
    input: {
      categoryId: string;
      checkInDate: Date;
      checkOutDate: Date;
      stayingGuestName: string;
      stayingGuestPhoneToken?: string;
      provider: 'QPAY' | 'KHAAN';
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<HeldBooking> {
    const bookerAccountId = request.accountId;
    if (bookerAccountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a booking is made by a signed-in guest');
    }
    // The window is checked before anything is looked up: a malformed request
    // is malformed whatever category it names, and refusing it first keeps a
    // bad window from reading as a missing category.
    const shape = windowProblem(
      input.checkInDate,
      input.checkOutDate,
      this.deps.clock === undefined ? new Date() : this.deps.clock(),
    );
    if (shape !== undefined) {
      throw new ApiError('VALIDATION_FAILED', `the window is not bookable: ${shape}`);
    }
    const hotelId = await this.hotelOfCategory(input.categoryId);
    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimed = await claim(uow, 'booking.hold', input.idempotencyKey, {
        categoryId: input.categoryId,
        checkInDate: input.checkInDate.toISOString(),
        checkOutDate: input.checkOutDate.toISOString(),
        bookerAccountId,
      });
      if (claimed.kind === 'replay') return claimed.body as HeldBooking;

      const now = this.now(uow);
      // Re-checked inside the transaction against the transaction's own clock,
      // which is the authoritative one (doc 09 §10).
      const problem = windowProblem(input.checkInDate, input.checkOutDate, now);
      if (problem !== undefined) {
        throw new ApiError('VALIDATION_FAILED', `the window is not bookable: ${problem}`);
      }
      const nights = nightsOf(input.checkInDate, input.checkOutDate);
      const bookings = new BookingRepository(uow);

      // The price first, so a category with no valid rate is refused before any
      // unit is taken. Quoted here; snapshotted for good at confirmation.
      const bookingId = randomUUID();
      const quote = await this.deps.tariffs.captureRateSnapshot(uow, {
        subjectType: 'ONLINE_BOOKING',
        subjectRef: bookingId,
        stayType: 'NIGHTLY',
        categoryId: input.categoryId,
      });
      const unitRate = BigInt(quote.snapshot.unitPriceMnt);
      const total = unitRate * BigInt(nights.length);

      // The units, in night order, under the lock that serializes the race.
      await bookings.lockInventory(hotelId, input.categoryId, nights);

      const booking = await bookings.create({
        bookingId,
        hotelId,
        bookingRef: formatReference(randomBytes(16)),
        categoryId: input.categoryId,
        bookerAccountId,
        stayingGuestName: input.stayingGuestName,
        stayingGuestPhoneToken: input.stayingGuestPhoneToken ?? null,
        checkInDate: input.checkInDate,
        checkOutDate: input.checkOutDate,
        nightCount: nights.length,
        holdExpiresAt: holdExpiryFrom(now),
      });
      await bookings.addNights({
        bookingId: booking.bookingId,
        hotelId,
        categoryId: input.categoryId,
        nights,
      });

      try {
        await bookings.occupy(hotelId, input.categoryId, nights, 1);
      } catch (error) {
        // The CHECK, not a count: the last unit went to somebody else between
        // this caller reading the page and reaching for it.
        if (isOverbookingRefusal(error)) {
          throw new ApiError('CONFLICT', 'NO_UNITS_LEFT: that category is fully booked');
        }
        throw error;
      }

      const attempt = await bookings.createAttempt({
        hotelId,
        bookingId: booking.bookingId,
        provider: input.provider,
        providerInvoiceId: null,
        amountMnt: total,
        expiresAt: attemptExpiry(booking.holdExpiresAt, now),
      });

      await bookings.record({
        hotelId,
        bookingId: booking.bookingId,
        eventType: 'booking.held',
        fromState: null,
        toState: 'HOLDING',
        actorRef: bookerAccountId,
      });
      await recordPlatformAudit(uow, {
        action: 'booking.hold',
        outcome: 'allowed',
        targetType: 'booking',
        targetRef: booking.bookingId,
        payload: { categoryId: input.categoryId, nights: nights.length },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'booking',
        aggregateId: booking.bookingId,
        eventType: 'booking.held',
        payload: {
          bookingId: booking.bookingId,
          hotelId,
          categoryId: input.categoryId,
          holdExpiresAt: booking.holdExpiresAt.toISOString(),
        },
      });

      const held: HeldBooking = {
        bookingId: booking.bookingId,
        bookingRef: booking.bookingRef,
        holdExpiresAt: booking.holdExpiresAt,
        nightCount: nights.length,
        totalAmountMnt: total,
        attempt: {
          attemptId: attempt.attemptId,
          provider: attempt.provider,
          expiresAt: attempt.expiresAt,
        },
      };
      // Recorded against the key, so a retry replays this hold rather than
      // taking a second unit (CLAUDE.md §6).
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, held);
      return held;
    });
  }

  /**
   * Supersedes the live attempt and opens another (doc 09 §8).
   *
   * A guest who switches provider does not get a second live invoice: the
   * partial unique index allows exactly one `ACTIVE` attempt, and the old one
   * is settled `SUPERSEDED` in the same transaction.
   */
  async switchProvider(
    input: { bookingId: string; provider: 'QPAY' | 'KHAAN' },
    request: RequestContext,
  ): Promise<HeldBooking['attempt']> {
    return this.onOwnBooking(input.bookingId, request, async (uow, booking) => {
      const bookings = new BookingRepository(uow);
      const now = this.now(uow);
      if (booking.state !== 'HOLDING' || booking.holdState !== 'ACTIVE') {
        throw new ApiError('CONFLICT', 'that booking is no longer taking payment');
      }
      if (booking.holdExpiresAt.getTime() <= now.getTime()) {
        throw new ApiError('CONFLICT', 'HOLD_EXPIRED: the ten minutes are up');
      }
      const live = await bookings.activeAttempt(booking.bookingId);
      if (live !== undefined) {
        if (live.provider === input.provider) {
          return { attemptId: live.attemptId, provider: live.provider, expiresAt: live.expiresAt };
        }
        const settled = await bookings.settleAttempt({
          attemptId: live.attemptId,
          expectedRevision: live.revision,
          state: 'SUPERSEDED',
          reason: `superseded by ${input.provider}`,
        });
        if (!settled) throw new ApiError('CONFLICT', 'that attempt changed under this one');
      }
      const attempt = await bookings.createAttempt({
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        provider: input.provider,
        providerInvoiceId: null,
        amountMnt: booking.totalAmountMnt ?? live?.amountMnt ?? 0n,
        expiresAt: attemptExpiry(booking.holdExpiresAt, now),
      });
      await bookings.record({
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        eventType: 'booking.attempt_superseded',
        fromState: booking.state,
        toState: booking.state,
        actorRef: request.accountId ?? 'system',
        reason: input.provider,
      });
      return {
        attemptId: attempt.attemptId,
        provider: attempt.provider,
        expiresAt: attempt.expiresAt,
      };
    });
  }

  /**
   * Applies a provider capture (`PAY-DEC-006`).
   *
   * The booking is locked first and every decision is taken on the locked row.
   * A capture that arrives after the hold has gone does not reopen the booking
   * and does not retake inventory; it makes the payment `PAID` and the refund
   * `REQUIRED`, which is a full refund obligation for Phase 14 to settle.
   */
  async applyCapture(
    input: { attemptId: string; providerInvoiceId: string; hotelId: string },
    request: RequestContext,
  ): Promise<{ outcome: string; bookingId: string }> {
    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const bookings = new BookingRepository(uow);
      const attempt = await bookings.attemptById(input.attemptId);
      if (attempt === undefined) throw new ApiError('NOT_FOUND', 'no such payment attempt');
      const booking = await bookings.lock(attempt.bookingId);
      if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');

      const now = this.now(uow);
      const outcome = captureOutcome(booking, attempt, now);

      if (outcome.kind === 'stale' || outcome.kind === 'already_confirmed') {
        await bookings.record({
          hotelId: booking.hotelId,
          bookingId: booking.bookingId,
          eventType: `booking.capture_${outcome.kind}`,
          fromState: booking.state,
          toState: booking.state,
          actorRef: 'provider',
        });
        return { outcome: outcome.kind, bookingId: booking.bookingId };
      }

      if (outcome.kind === 'refund_obligation') {
        // The money is real, so it is recorded as received; the booking is not
        // revived and the inventory it released stays released.
        await bookings.transition({
          bookingId: booking.bookingId,
          expectedRevision: booking.revision,
          from: [booking.state],
          paymentState: 'PAID',
          refundState: 'REQUIRED',
        });
        if (attempt.state === 'ACTIVE') {
          await bookings.settleAttempt({
            attemptId: attempt.attemptId,
            expectedRevision: attempt.revision,
            state: 'PAID',
            reason: `late capture: ${outcome.reason}`,
          });
        }
        await bookings.record({
          hotelId: booking.hotelId,
          bookingId: booking.bookingId,
          eventType: 'booking.refund_obligation_raised',
          fromState: booking.state,
          toState: booking.state,
          actorRef: 'provider',
          reason: outcome.reason,
        });
        await recordPlatformAudit(uow, {
          action: 'booking.refund_obligation',
          outcome: 'allowed',
          targetType: 'booking',
          targetRef: booking.bookingId,
          payload: { reason: outcome.reason },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'booking',
          aggregateId: booking.bookingId,
          eventType: 'booking.refund_required',
          payload: { bookingId: booking.bookingId, reason: outcome.reason },
        });
        return { outcome: 'refund_obligation', bookingId: booking.bookingId };
      }

      // The hold is alive and the money is good: the booking is confirmed and
      // its price becomes the snapshot it will be honoured at (doc 09 §7).
      const quote = await this.deps.tariffs.captureRateSnapshot(uow, {
        subjectType: 'ONLINE_BOOKING',
        subjectRef: booking.bookingId,
        stayType: 'NIGHTLY',
        categoryId: booking.categoryId,
      });
      const unitRate = BigInt(quote.snapshot.unitPriceMnt);
      const advanced = await bookings.transition({
        bookingId: booking.bookingId,
        expectedRevision: booking.revision,
        from: ['HOLDING'],
        state: 'CONFIRMED',
        holdState: 'CONSUMED',
        paymentState: 'PAID',
        confirmedAt: now,
        snapshot: {
          rateSnapshotId: quote.snapshot.snapshotId,
          unitRateMnt: unitRate,
          totalAmountMnt: unitRate * BigInt(booking.nightCount),
          pricingConfigVersion: quote.snapshot.pricingConfigVersion,
        },
      });
      if (!advanced) throw new ApiError('CONFLICT', 'that booking changed under this capture');
      await bookings.settleAttempt({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        state: 'PAID',
        reason: input.providerInvoiceId,
      });
      await bookings.record({
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        eventType: 'booking.confirmed',
        fromState: 'HOLDING',
        toState: 'CONFIRMED',
        actorRef: 'provider',
      });
      await recordPlatformAudit(uow, {
        action: 'booking.confirm',
        outcome: 'allowed',
        targetType: 'booking',
        targetRef: booking.bookingId,
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'booking',
        aggregateId: booking.bookingId,
        eventType: 'booking.confirmed',
        payload: {
          bookingId: booking.bookingId,
          hotelId: booking.hotelId,
          bookingRef: booking.bookingRef,
        },
      });
      return { outcome: 'confirmed', bookingId: booking.bookingId };
    });
  }

  /** The guest cancels their own booking; the units go back at once. */
  async cancelByGuest(
    input: { bookingId: string; reason?: string },
    request: RequestContext,
  ): Promise<BookingView> {
    return this.onOwnBooking(input.bookingId, request, async (uow, booking) => {
      if (isTerminal(booking.state)) {
        throw new ApiError('CONFLICT', 'that booking has already ended');
      }
      if (booking.state === 'CHECKED_IN') {
        throw new ApiError('CONFLICT', 'that stay has begun');
      }
      return this.terminate(uow, booking, 'CANCELLED_GUEST', {
        actorRef: request.accountId ?? 'guest',
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    });
  }

  /** A booking the caller owns, or the same answer a missing one gets. */
  private async onOwnBooking<T>(
    bookingId: string,
    request: RequestContext,
    work: (uow: UnitOfWork, booking: BookingRow) => Promise<T>,
  ): Promise<T> {
    const accountId = request.accountId;
    if (accountId === undefined) throw new ApiError('UNAUTHENTICATED', 'sign in first');
    const owned = await this.inBookerScope(request, async (uow) =>
      new BookingRepository(uow).byId(bookingId),
    );
    // The account policy is what decided this, so another guest's booking and a
    // booking that does not exist are the same answer (doc 09 §11).
    if (owned === undefined || owned.bookerAccountId !== accountId) {
      throw new ApiError('NOT_FOUND', 'no such booking');
    }
    return this.inHotelScope(owned.hotelId, request, async (uow) => {
      const booking = await new BookingRepository(uow).lock(bookingId);
      if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');
      if (booking.bookerAccountId !== accountId) {
        throw new ApiError('NOT_FOUND', 'no such booking');
      }
      return work(uow, booking);
    });
  }

  /** Ends a booking and releases what it held. Shared by every terminal path. */
  async terminate(
    uow: UnitOfWork,
    booking: BookingRow,
    to: BookingState,
    context: {
      actorRef: string;
      reason?: string;
      /** The hold's own ending, where it differs from a cancellation. */
      holdState?: 'EXPIRED' | 'CANCELLED';
      /** The payment's, likewise: an unpaid hold that lapses expires with it. */
      paymentState?: 'EXPIRED' | 'FAILED';
    },
  ): Promise<BookingView> {
    const bookings = new BookingRepository(uow);
    const now = this.now(uow);
    const advanced = await bookings.transition({
      bookingId: booking.bookingId,
      expectedRevision: booking.revision,
      from: [booking.state],
      state: to,
      holdState:
        booking.holdState === 'ACTIVE' ? (context.holdState ?? 'CANCELLED') : booking.holdState,
      ...(context.paymentState !== undefined && booking.paymentState === 'PENDING'
        ? { paymentState: context.paymentState }
        : {}),
      terminalAt: now,
      ...(context.reason === undefined ? {} : { terminalReason: context.reason }),
      ...(to === 'CANCELLED_HOTEL'
        ? { refundState: refundOnHotelCancellation(booking.paymentState) }
        : {}),
    });
    if (!advanced) throw new ApiError('CONFLICT', 'that booking changed under this command');

    if (releasesInventory(booking.state, to)) {
      const nights = await bookings.nightsOf(booking.bookingId);
      await bookings.occupy(booking.hotelId, booking.categoryId, nights, -1);
    }
    const live = await bookings.activeAttempt(booking.bookingId);
    if (live !== undefined) {
      await bookings.settleAttempt({
        attemptId: live.attemptId,
        expectedRevision: live.revision,
        state: to === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
        reason: `booking ${to}`,
      });
    }
    await bookings.record({
      hotelId: booking.hotelId,
      bookingId: booking.bookingId,
      eventType: `booking.${to.toLowerCase()}`,
      fromState: booking.state,
      toState: to,
      actorRef: context.actorRef,
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'booking',
      aggregateId: booking.bookingId,
      eventType: `booking.${to.toLowerCase()}`,
      payload: { bookingId: booking.bookingId, hotelId: booking.hotelId },
    });
    const after = await bookings.byId(booking.bookingId);
    if (after === undefined) throw new Error('the booking vanished under its own lock');
    return bookingView(after);
  }

  /** The bookings this Guest made, and only those. */
  async mine(request: RequestContext, limit = 50): Promise<readonly BookingView[]> {
    const accountId = request.accountId;
    if (accountId === undefined) throw new ApiError('UNAUTHENTICATED', 'sign in first');
    return this.inBookerScope(request, async (uow) => {
      const rows = await new BookingRepository(uow).forBooker(accountId, limit);
      return rows.map(bookingView);
    });
  }

  /** One of the caller's own bookings. */
  async byId(bookingId: string, request: RequestContext): Promise<BookingView> {
    const accountId = request.accountId;
    if (accountId === undefined) throw new ApiError('UNAUTHENTICATED', 'sign in first');
    return this.inBookerScope(request, async (uow) => {
      const row = await new BookingRepository(uow).byId(bookingId);
      if (row === undefined || row.bookerAccountId !== accountId) {
        throw new ApiError('NOT_FOUND', 'no such booking');
      }
      return bookingView(row);
    });
  }

  /** What a category can still sell across a window, for the public surface. */
  async availability(
    input: { hotelId: string; categoryId: string; checkInDate: Date; checkOutDate: Date },
    request: RequestContext,
  ): Promise<number> {
    const nights = nightsOf(input.checkInDate, input.checkOutDate);
    return this.inHotelScope(input.hotelId, request, async (uow) =>
      new BookingRepository(uow).availability(input.hotelId, input.categoryId, nights),
    );
  }

  /** The hotel a category belongs to. Resolved on the server, never sent. */
  private async hotelOfCategory(categoryId: string): Promise<string> {
    // Through the resolver function, because `room_category` is a tenant row
    // and this call has no tenant yet — which is the point: the request does
    // not get to say which hotel its command runs in.
    const result = await this.deps.pool.query<{ hotel_id: string | null }>(
      `SELECT platform.hotel_of_category($1::uuid) AS hotel_id`,
      [categoryId],
    );
    const hotelId = result.rows[0]?.hotel_id ?? undefined;
    if (hotelId === undefined) throw new ApiError('NOT_FOUND', 'no such room category');
    return hotelId;
  }

  /** The sweep and the check-in contract run their own transactions. */
  runInHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.inHotelScope(hotelId, request, work);
  }

  serverNow(uow: UnitOfWork): Date {
    return this.now(uow);
  }

  /** The states a booking may still be acted on in. */
  static get LIVE_STATES(): readonly BookingState[] {
    return LIVE;
  }
}
