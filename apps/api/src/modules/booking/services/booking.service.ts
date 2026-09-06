import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  completeIdempotencyKey,
  recordPlatformAudit,
  registerProviderEvent,
} from '@prsystem/db';
import type { PaymentProvider, RawCallback } from '@prsystem/ports';
import { hotelLocalDate, instant } from '@prsystem/time';
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
  toDateString,
  windowProblem,
} from '../domain/booking';
import {
  cancellationRetention,
  freeCancellationDeadline,
  hotelCancellationRetention,
  noShowCutoff,
  noShowRetention,
} from '../../settlement/domain/settlement';
import type { SettlementRefundReason } from '../contracts/settlement';
import type { CommandActor, BookingDependencies, RequestContext } from './booking-context';
import { BookingServiceBase, claim, hotelTimeZone, isOverbookingRefusal } from './booking-context';

/** doc 18 §3.3: the two hotel-staff actions on an online booking. */
const NO_SHOW_CONFIRM = 'booking.no_show_confirm';
const CANCELLED_HOTEL = 'booking.cancelled_hotel';

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
  /**
   * doc 11 §5: the cancellation terms, shown before the guest pays and
   * snapshotted on the booking so the deadline that decides a refund is the one
   * they agreed to.
   */
  readonly cancellationPolicyVersion: number;
  readonly freeCancellationUntil: Date;
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

      // `PAY-DEC-001` / `BK-DEC-008`: a hotel with no explicit commission rate
      // takes no online payment at all. Checked before a unit is taken, because
      // a hold nobody may pay for is a unit withheld from somebody who could.
      // There is no default rate to fall back to.
      const contract = await this.deps.settlement.contractFor(uow, now);
      if (contract === undefined) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'NO_COMMISSION_CONTRACT: this hotel has no active commission contract',
        );
      }
      // doc 11 §5: the deadline the guest is shown, fixed now and never
      // recomputed. Hotel-local, because the arrival day is the hotel's.
      const zone = await hotelTimeZone(uow);
      const freeCancellationUntil = freeCancellationDeadline(toDateString(input.checkInDate), zone);

      // The price next, so a category with no valid rate is refused before any
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
        cancellationPolicyVersion: contract.cancellationPolicyVersion,
        freeCancellationUntil,
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
        cancellationPolicyVersion: contract.cancellationPolicyVersion,
        freeCancellationUntil,
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
   * Opens the provider invoice for the live attempt (`PAY-DEC-005`).
   *
   * The provider call is made **between** two transactions, never inside one: a
   * transaction held open across a network call holds the booking's row for as
   * long as the provider takes to answer. So the attempt is read, the invoice is
   * created, and the reference is written back under the lock — and because the
   * idempotency key is the attempt's own, a lost acknowledgement followed by a
   * retry gets the same invoice rather than a second one.
   */
  async issueInvoice(
    input: { bookingId: string; attemptId: string },
    request: RequestContext,
  ): Promise<{ attemptId: string; provider: PaymentProvider; payUrl?: string }> {
    const opened = await this.onOwnBooking(input.bookingId, request, async (uow, booking) => {
      const attempt = await new BookingRepository(uow).attemptById(input.attemptId);
      if (attempt === undefined || attempt.bookingId !== booking.bookingId) {
        throw new ApiError('NOT_FOUND', 'no such payment attempt');
      }
      if (attempt.state !== 'ACTIVE') {
        throw new ApiError('CONFLICT', 'that payment attempt is no longer live');
      }
      return { attempt, hotelId: booking.hotelId, bookingRef: booking.bookingRef };
    });
    if (opened.attempt.providerInvoiceId !== null) {
      return { attemptId: opened.attempt.attemptId, provider: opened.attempt.provider };
    }

    const gateway = this.deps.payments.gateway(opened.attempt.provider);
    const created = await gateway.createInvoice(
      {
        intentId: opened.attempt.attemptId,
        amountMnt: opened.attempt.amountMnt,
        currency: 'MNT',
        merchantRef: opened.bookingRef,
        expiresAt: opened.attempt.expiresAt,
        // The attempt's own identity: a redriven request asks the provider for
        // the same invoice, and a new attempt is a different one.
        idempotencyKey: `booking-attempt:${opened.attempt.attemptId}`,
      },
      { correlationId: request.correlationId },
    );
    if (!created.ok) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `PAYMENT_UNAVAILABLE: the payment provider refused to open an invoice (${created.error.kind})`,
      );
    }

    await this.inHotelScope(opened.hotelId, request, async (uow) => {
      const bookings = new BookingRepository(uow);
      const attempt = await bookings.attemptById(opened.attempt.attemptId);
      if (attempt === undefined || attempt.providerInvoiceId !== null) return;
      await bookings.setInvoice({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        providerInvoiceId: created.value.providerInvoiceId,
      });
    });
    return {
      attemptId: opened.attempt.attemptId,
      provider: opened.attempt.provider,
      ...(created.value.payUrl === undefined ? {} : { payUrl: created.value.payUrl }),
    };
  }

  /**
   * A provider callback, from the wire to a domain transition
   * (`PAY-DEC-005`, `PAY-DEC-006`; CLAUDE.md §7).
   *
   * The order is the one the requirements fix, and none of it is negotiable:
   *
   *  1. the signature, before anything is looked up, so a forged callback
   *     learns nothing about which invoices exist;
   *  2. the hotel, resolved on the server from the invoice — a callback names
   *     no tenant and must never be able to choose one;
   *  3. the provider event, deduplicated, so a redelivery changes nothing;
   *  4. the provider's *own* status, re-queried server to server, because doc
   *     11 §4.6 is explicit that a callback, a redirect and a screenshot are
   *     not evidence of payment;
   *  5. the provider, reference, amount and currency, matched against the
   *     attempt this platform stored — never against what the callback claims;
   *  6. and only then the transition, idempotently, on the locked booking.
   */
  async handleCallback(
    raw: RawCallback,
    request: RequestContext,
  ): Promise<{ outcome: string; bookingId?: string }> {
    const gateway = this.deps.payments.gateway(raw.provider);
    const verified = await gateway.verifyCallback(raw, { correlationId: request.correlationId });
    if (!verified.ok) {
      // Nothing is written and nothing is disclosed: an unverifiable callback
      // and one naming an invoice that does not exist get the same answer.
      return { outcome: 'rejected' };
    }

    const located = await this.attemptOfInvoice(
      raw.provider,
      verified.value.payload.providerInvoiceId,
    );
    if (located === undefined) return { outcome: 'rejected' };

    const claimed = await this.inHotelScope(located.hotelId, request, async (uow) => {
      const outcome = await registerProviderEvent(uow, {
        provider: raw.provider,
        providerEventId: verified.value.providerEventId,
        eventKind: 'booking.payment',
        rawPayload: JSON.stringify({
          providerInvoiceId: verified.value.payload.providerInvoiceId,
          providerPaymentId: verified.value.payload.providerPaymentId ?? null,
          status: raw.status ?? null,
        }),
        // Sanitised: a reference and a status, never a payer or an instrument.
        metadata: {
          providerInvoiceId: verified.value.payload.providerInvoiceId,
          status: raw.status ?? 'unknown',
        },
      });
      return outcome.kind === 'first_delivery';
    });
    if (!claimed) return { outcome: 'duplicate', bookingId: located.bookingId };

    // The provider's own answer, asked for directly. What the callback said
    // about the amount, the status or the payer decides nothing.
    const status = await gateway.queryStatus(
      { providerInvoiceId: verified.value.payload.providerInvoiceId },
      { correlationId: request.correlationId },
    );
    if (!status.ok) return { outcome: 'unverified', bookingId: located.bookingId };
    if (status.value.state !== 'PAID') {
      return { outcome: status.value.state.toLowerCase(), bookingId: located.bookingId };
    }
    const providerPaymentId = status.value.providerPaymentId;
    if (providerPaymentId === undefined) {
      return { outcome: 'unverified', bookingId: located.bookingId };
    }

    return this.applyCapture(
      {
        attemptId: located.attemptId,
        hotelId: located.hotelId,
        providerInvoiceId: verified.value.payload.providerInvoiceId,
        providerPaymentId,
        ...(status.value.paidAmountMnt === undefined
          ? {}
          : { paidAmountMnt: status.value.paidAmountMnt }),
        ...(status.value.currency === undefined ? {} : { currency: status.value.currency }),
        ...(status.value.merchantRef === undefined
          ? {}
          : { merchantRef: status.value.merchantRef }),
        ...(status.value.providerFeeMnt === undefined
          ? {}
          : { providerFeeMnt: status.value.providerFeeMnt }),
      },
      request,
    );
  }

  /** The hotel a provider invoice belongs to, resolved on the server. */
  private async attemptOfInvoice(
    provider: PaymentProvider,
    providerInvoiceId: string,
  ): Promise<{ attemptId: string; hotelId: string; bookingId: string } | undefined> {
    const rows = await this.deps.pool.query<{
      attempt_id: string;
      hotel_id: string;
      booking_id: string;
    }>(`SELECT attempt_id, hotel_id, booking_id FROM platform.booking_attempt_of_invoice($1, $2)`, [
      provider,
      providerInvoiceId,
    ]);
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return { attemptId: row.attempt_id, hotelId: row.hotel_id, bookingId: row.booking_id };
  }

  /**
   * Applies a verified provider capture (`PAY-DEC-006`, `PAY-DEC-008`).
   *
   * The booking is locked first and every decision is taken on the locked row.
   * A capture that arrives after the hold has gone does not reopen the booking
   * and does not retake inventory; it makes the payment `PAID` and the refund
   * `REQUIRED`, and Phase 14's refund axis owes the guest the money back in
   * full. A capture that arrives while the hold is alive confirms the booking,
   * snapshots the price and opens the payable the hotel will be paid from.
   */
  async applyCapture(
    input: {
      attemptId: string;
      providerInvoiceId: string;
      hotelId: string;
      providerPaymentId: string;
      paidAmountMnt?: bigint;
      currency?: string;
      merchantRef?: string;
      providerFeeMnt?: bigint;
    },
    request: RequestContext,
  ): Promise<{ outcome: string; bookingId: string }> {
    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const bookings = new BookingRepository(uow);
      const attempt = await bookings.attemptById(input.attemptId);
      if (attempt === undefined) throw new ApiError('NOT_FOUND', 'no such payment attempt');
      const booking = await bookings.lock(attempt.bookingId);
      if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');

      // doc 11 §9: the provider's claims are matched against what this platform
      // stored, not the other way round. A mismatch is a reconciliation case,
      // never an automatic entitlement change.
      const mismatch = this.mismatchOf(attempt, booking, input);
      if (mismatch !== undefined) {
        await bookings.record({
          hotelId: booking.hotelId,
          bookingId: booking.bookingId,
          eventType: 'booking.capture_mismatch',
          fromState: booking.state,
          toState: booking.state,
          actorRef: 'provider',
          reason: mismatch,
        });
        await recordPlatformAudit(uow, {
          action: 'booking.capture_mismatch',
          outcome: 'denied',
          targetType: 'booking',
          targetRef: booking.bookingId,
          payload: { field: mismatch },
        });
        return { outcome: 'mismatch', bookingId: booking.bookingId };
      }

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
        // doc 11 §4.10: the captured transaction is recorded against exactly one
        // attempt, whether that attempt was still live or had already lapsed.
        if (attempt.state === 'ACTIVE') {
          await bookings.settleAttempt({
            attemptId: attempt.attemptId,
            expectedRevision: attempt.revision,
            state: 'PAID',
            reason: `late capture: ${outcome.reason}`,
            providerPaymentId: input.providerPaymentId,
          });
        } else if (attempt.providerPaymentId === null) {
          await bookings.recordCapturedPayment({
            attemptId: attempt.attemptId,
            expectedRevision: attempt.revision,
            providerPaymentId: input.providerPaymentId,
          });
        }
        // `PAY-DEC-006`: the full amount goes back. It never touches the payable
        // — the hotel earns what the first valid payment earned.
        await this.deps.settlement.raiseUnmatchedRefund(uow, {
          hotelId: booking.hotelId,
          bookingId: booking.bookingId,
          amountMnt: input.paidAmountMnt ?? attempt.amountMnt,
          reason: outcome.reason === 'duplicate' ? 'DUPLICATE_CAPTURE' : 'LATE_PAYMENT_AFTER_HOLD',
          provider: attempt.provider,
          providerPaymentId: input.providerPaymentId,
          sourceRef: `capture:${input.providerPaymentId}`,
        });
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

      // `PAY-DEC-001`: the rate is snapshotted at the moment payment is
      // confirmed, from the contract in force then. A hotel whose contract
      // lapsed between the hold and the capture cannot be settled, so the money
      // is not accepted as a confirmation at all.
      const contract = await this.deps.settlement.contractFor(uow, now);
      if (contract === undefined) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'NO_COMMISSION_CONTRACT: this hotel has no active commission contract',
        );
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
      const total = unitRate * BigInt(booking.nightCount);
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
          totalAmountMnt: total,
          pricingConfigVersion: quote.snapshot.pricingConfigVersion,
        },
      });
      if (!advanced) throw new ApiError('CONFLICT', 'that booking changed under this capture');
      await bookings.settleAttempt({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        state: 'PAID',
        reason: input.providerInvoiceId,
        providerPaymentId: input.providerPaymentId,
      });
      // The money half of the same transaction: the payable, the commission and
      // the gateway fee. A confirmation that could not open it does not commit.
      await this.deps.settlement.openPayable(uow, {
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        grossPaidMnt: input.paidAmountMnt ?? total,
        provider: attempt.provider,
        providerPaymentId: input.providerPaymentId,
        providerFeeMnt: input.providerFeeMnt ?? 0n,
        contract,
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

  /**
   * doc 11 §9 step 3: provider, reference, amount and currency, against the
   * stored attempt. Returns the field that disagreed, or nothing.
   */
  private mismatchOf(
    attempt: { provider: string; amountMnt: bigint; providerPaymentId: string | null },
    booking: { bookingRef: string },
    input: {
      providerPaymentId: string;
      paidAmountMnt?: bigint;
      currency?: string;
      merchantRef?: string;
    },
  ): string | undefined {
    if (input.currency !== undefined && input.currency !== 'MNT') return 'currency';
    if (input.merchantRef !== undefined && input.merchantRef !== booking.bookingRef) {
      return 'merchant';
    }
    if (input.paidAmountMnt !== undefined && input.paidAmountMnt !== attempt.amountMnt) {
      return 'amount';
    }
    // doc 11 §4.10: one captured transaction, one attempt. A second attempt
    // claiming an id another already holds is a mismatch, not a capture.
    if (
      attempt.providerPaymentId !== null &&
      attempt.providerPaymentId !== input.providerPaymentId
    ) {
      return 'payment';
    }
    return undefined;
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

  /**
   * Ends a booking, releases what it held and settles what it retained.
   *
   * Every terminal path goes through here, which is deliberate: the numbers
   * `PAY-DEC-007` fixes — a full refund before the deadline, a first-night fee
   * after it, the same fee for a confirmed no-show, and nothing at all for a
   * hotel that could not honour the booking — are decided in one place, so a
   * cancellation and a no-show cannot drift into charging differently for the
   * same rule.
   *
   * The inventory goes back at the terminal transaction and does not wait for
   * the money (doc 11 §5). A refund that later fails does not revive the
   * booking; it leaves an obligation on its own axis.
   */
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
    const retention = this.retentionFor(booking, to, now);
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
      ...(retention === undefined
        ? to === 'CANCELLED_HOTEL'
          ? { refundState: refundOnHotelCancellation(booking.paymentState) }
          : {}
        : { refundState: 'REQUIRED' as const }),
    });
    if (!advanced) throw new ApiError('CONFLICT', 'that booking changed under this command');

    // `PAY-DEC-007` / `PAY-DEC-008`: what the hotel keeps and what goes back.
    // The payable is held rather than reduced — doc 11 §5 keeps the refund on
    // its own axis until a verified provider result completes it.
    if (retention !== undefined) {
      const zone = await hotelTimeZone(uow);
      await this.deps.settlement.recordRetention(uow, {
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        refundMnt: retention.refundMnt,
        reason: retention.reason,
        sourceRef: `terminal:${to}:${booking.bookingId}`,
        at: now,
        localDate: hotelLocalDate(instant(now), zone),
      });
      await bookings.record({
        hotelId: booking.hotelId,
        bookingId: booking.bookingId,
        eventType: 'booking.retention_recorded',
        fromState: booking.state,
        toState: to,
        actorRef: context.actorRef,
        reason: `${retention.reason} fee ${retention.feeMnt.toString()}`,
      });
    }

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

  /**
   * `PAY-DEC-007`: the numbers a terminal transition produces, in one place.
   *
   * A booking that was never paid produces none: money that was not taken is
   * not money to give back, and an expired hold is exactly that case.
   */
  private retentionFor(
    booking: BookingRow,
    to: BookingState,
    now: Date,
  ): { refundMnt: bigint; feeMnt: bigint; reason: SettlementRefundReason } | undefined {
    if (booking.paymentState !== 'PAID') return undefined;
    const total = booking.totalAmountMnt ?? 0n;
    const unit = booking.unitRateMnt ?? 0n;
    if (to === 'CANCELLED_GUEST') {
      // The deadline is the snapshot the guest was shown, not one recomputed
      // now (doc 11 §5). A booking with none never reached a price, and a
      // booking with no price was never paid.
      const outcome = cancellationRetention(total, unit, now, booking.freeCancellationUntil ?? now);
      return {
        refundMnt: outcome.refundMnt,
        feeMnt: outcome.feeMnt,
        reason: outcome.free ? 'GUEST_CANCELLATION' : 'LATE_CANCELLATION_BALANCE',
      };
    }
    if (to === 'NO_SHOW') {
      const outcome = noShowRetention(total, unit);
      return { refundMnt: outcome.refundMnt, feeMnt: outcome.feeMnt, reason: 'NO_SHOW_BALANCE' };
    }
    if (to === 'CANCELLED_HOTEL') {
      const outcome = hotelCancellationRetention(total);
      return {
        refundMnt: outcome.refundMnt,
        feeMnt: outcome.feeMnt,
        reason: 'HOTEL_CANCELLATION',
      };
    }
    return undefined;
  }

  /**
   * doc 18 §3.3: Reception or Manager confirms a no-show, after the cutoff.
   *
   * `PAY-DEC-007` puts the cutoff at the arrival date's `23:59:59` in the
   * *hotel's* timezone, and nothing here happens automatically: a guest who has
   * not arrived by the planned hour is not a no-show, and the server refuses to
   * record one before the cutoff whatever the request says.
   */
  async confirmNoShow(
    input: { hotelId: string; bookingId: string; idempotencyKey: string; reason?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<BookingView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      NO_SHOW_CONFIRM,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'booking.no_show', input.idempotencyKey, {
          bookingId: input.bookingId,
        });
        if (claimed.kind === 'replay') return claimed.body as BookingView;
        const bookings = new BookingRepository(uow);
        const peek = await bookings.byId(input.bookingId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'no such booking');
        }
        const booking = await bookings.lock(input.bookingId);
        await authorize();
        if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');
        if (booking.state !== 'CONFIRMED') {
          // A booking that has been checked in, cancelled or already ended is
          // not a no-show. The row lock is what decides the race with a
          // concurrent check-in (doc 18 §3.3).
          throw new ApiError('CONFLICT', 'only a confirmed booking can be a no-show');
        }
        const now = this.now(uow);
        const zone = await hotelTimeZone(uow);
        const cutoff = noShowCutoff(toDateString(booking.checkInDate), zone);
        if (now.getTime() <= cutoff.getTime()) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'BEFORE_NO_SHOW_CUTOFF: the arrival date has not ended in the hotel timezone',
          );
        }
        const view = await this.terminate(uow, booking, 'NO_SHOW', {
          actorRef: gate.principal.accountId,
          reason: input.reason ?? 'no-show confirmed after the arrival-date cutoff',
        });
        await recordPlatformAudit(uow, {
          action: 'booking.no_show_confirm',
          outcome: 'allowed',
          targetType: 'booking',
          targetRef: booking.bookingId,
          payload: { cutoff: cutoff.toISOString() },
        });
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /**
   * doc 18 §3.3 / `BK-DEC-014`: the hotel cannot honour the booking.
   *
   * The guest is refunded in full and the commission base is zero — a hotel is
   * not paid a commission on a booking it failed to provide. Manager or Manager
   * Plus only; Reception needs one of those roles.
   */
  async cancelByHotel(
    input: { hotelId: string; bookingId: string; idempotencyKey: string; reason: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<BookingView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CANCELLED_HOTEL,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'booking.cancel_hotel', input.idempotencyKey, {
          bookingId: input.bookingId,
        });
        if (claimed.kind === 'replay') return claimed.body as BookingView;
        const bookings = new BookingRepository(uow);
        const peek = await bookings.byId(input.bookingId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'no such booking');
        }
        const booking = await bookings.lock(input.bookingId);
        await authorize();
        if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');
        if (isTerminal(booking.state)) {
          throw new ApiError('CONFLICT', 'that booking has already ended');
        }
        if (booking.state === 'CHECKED_IN') {
          throw new ApiError('CONFLICT', 'that stay has begun');
        }
        const view = await this.terminate(uow, booking, 'CANCELLED_HOTEL', {
          actorRef: gate.principal.accountId,
          reason: input.reason,
        });
        await recordPlatformAudit(uow, {
          action: 'booking.cancelled_hotel',
          outcome: 'allowed',
          targetType: 'booking',
          targetRef: booking.bookingId,
          payload: { reason: input.reason },
        });
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
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
