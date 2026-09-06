import { quietPool } from '@prsystem/testing';
import type { CommandActor } from '../../iam/services/iam-context';
import type { BookingHarness } from '../../booking/test-support/booking-harness';
import { createBookingHarness } from '../../booking/test-support/booking-harness';
import { RepositoryReviewEligibility } from '../../booking/contracts/booking-reads';
import type { ReviewDependencies } from '../services/review-context';
import { newReviewRequest } from '../services/review-context';
import { ReviewService } from '../services/review.service';
import { ReviewReportService } from '../services/report.service';
import { ReviewModerationService } from '../services/moderation.service';
import { ReviewReplyService } from '../services/reply.service';
import type { PublicSearchService } from '../../public/services/search.service';
import { newPublicRequest } from '../../public/services/search.service';

/**
 * The Phase 16 harness: the Phase 13 booking harness — which already gives a
 * published hotel, a bookable category, real Guest accounts and real bookings —
 * plus the review services over the same pool and the same movable clock.
 *
 * The eligibility contract is the **real** `RepositoryReviewEligibility`, not
 * the simulator, so what makes a review earned is the booking module's own SQL
 * over the booking and the stay rather than a stub that happens to agree.
 */

export interface ReviewedStay {
  readonly bookingId: string;
  readonly hotelId: string;
  readonly accountId: string;
  readonly stayId: string;
  readonly actualCheckoutAt: Date;
}

export interface ReviewHarness {
  readonly booking: BookingHarness;
  readonly admin: BookingHarness['db']['pool'];
  readonly api: BookingHarness['api'];
  readonly deps: ReviewDependencies;
  readonly reviews: ReviewService;
  readonly reports: ReviewReportService;
  readonly moderation: ReviewModerationService;
  readonly replies: ReviewReplyService;
  readonly publicSearch: PublicSearchService;
  /**
   * A booking that reached `COMPLETED` with a real stay behind it — the exact
   * shape `RV-DEC-002` calls a verified stay.
   *
   * Written over the owner connection rather than driven through Phase 08's
   * check-in and Phase 09's checkout: this phase's subject is the review, and
   * a fixture that replayed two other phases' whole flows would be asserting
   * about them. The rows it writes are the rows those flows produce.
   */
  completedStay(
    hotel: { hotelId: string; categoryId: string },
    accountId: string,
    checkoutDaysAgo?: number,
  ): Promise<ReviewedStay>;
  /** A booking of the same hotel that never completed. */
  unfinishedBooking(
    hotel: { hotelId: string; categoryId: string },
    accountId: string,
    state?: string,
  ): Promise<string>;
  /** A Platform account, optionally holding the `REVIEW_MODERATE` grant. */
  moderator(options?: { granted?: boolean; role?: string }): Promise<CommandActor>;
  advance(seconds: number): void;
  resetClock(): void;
  close(): Promise<void>;
}

export async function createReviewHarness(suite: string): Promise<ReviewHarness> {
  const booking = await createBookingHarness(suite);
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const deps: ReviewDependencies = {
    pool: booking.api,
    subscription: booking.minibar.catalog.subscription,
    eligibility: new RepositoryReviewEligibility(),
    clock,
  };
  let sequence = 0;

  return {
    booking,
    admin: booking.db.pool,
    api: booking.api,
    deps,
    reviews: new ReviewService(deps),
    reports: new ReviewReportService(deps),
    moderation: new ReviewModerationService(deps),
    replies: new ReviewReplyService(deps),
    publicSearch: booking.search,

    async completedStay(hotel, accountId, checkoutDaysAgo = 1) {
      sequence += 1;
      const admin = booking.db.pool;
      const shiftId = await receptionShift(admin, hotel.hotelId, sequence);
      const roomId = await activeRoom(admin, hotel.hotelId, hotel.categoryId, sequence);
      const staffId = await staffAccount(admin, sequence, suite);
      const result = await admin.query<{ booking_id: string; stay_id: string; checkout: Date }>(
        `WITH r AS (
           INSERT INTO platform.stay_rate_snapshot
             (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
              source_entity_id, pricing_config_version, category_id, room_id,
              cleaning_buffer_minutes, fixed_checkout_minute)
           VALUES ($1::uuid, 'ONLINE_BOOKING', gen_random_uuid(), 'NIGHTLY', 120000, 'CATEGORY',
                   $3::uuid, 1, $3::uuid, $2::uuid, 60, 720)
           RETURNING snapshot_id),
         b AS (
           INSERT INTO platform.booking
             (hotel_id, booking_ref, category_id, booker_account_id, staying_guest_name,
              check_in_date, check_out_date, night_count, hold_expires_at, state, hold_state,
              payment_state, confirmed_at, terminal_at, rate_snapshot_id, unit_rate_mnt,
              total_amount_mnt, pricing_config_version, fulfilled_stay_id,
              cancellation_policy_version, free_cancellation_until)
           VALUES ($1::uuid, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
                   $3::uuid, $4::uuid, 'Синтетик зочин',
                   (now() - make_interval(days => $5 + 1))::date,
                   (now() - make_interval(days => $5))::date, 1,
                   now() - make_interval(days => $5 + 1), 'CONFIRMED', 'CONSUMED', 'PAID',
                   now() - make_interval(days => $5 + 2), NULL,
                   gen_random_uuid(), 120000, 120000, 1, NULL,
                   1, now() - make_interval(days => $5 + 3))
           RETURNING booking_id),
         s AS (
           INSERT INTO platform.stay
             (hotel_id, room_id, category_id, source, booking_ref, stay_type, state,
              actual_check_in_at, check_in_recorded_at, planned_checkout_at, night_count,
              fixed_checkout_minute, cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt,
              room_charge_mnt, pricing_config_version, deposit_required, shift_id,
              checked_in_by_account_id, actual_checkout_at, checkout_recorded_by_account_id,
              fulfilled_booking_id)
           SELECT $1::uuid, $2::uuid, $3::uuid, 'ONLINE', b.booking_id, 'NIGHTLY', 'COMPLETED',
                  now() - make_interval(days => $5 + 1), now() - make_interval(days => $5 + 1),
                  now() - make_interval(days => $5), 1, 720, 60, r.snapshot_id, 120000,
                  120000, 1, false, $6::uuid, $7::uuid,
                  now() - make_interval(days => $5), $7::uuid, b.booking_id
             FROM b, r RETURNING stay_id, actual_checkout_at, fulfilled_booking_id)
         SELECT s.fulfilled_booking_id AS booking_id, s.stay_id,
                s.actual_checkout_at AS checkout
           FROM s`,
        [hotel.hotelId, roomId, hotel.categoryId, accountId, checkoutDaysAgo, shiftId, staffId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('the completed-stay fixture wrote no row');
      // A second statement, because a data-modifying CTE cannot see the row an
      // earlier CTE in the same statement inserted. The checkout is what moves
      // the booking to COMPLETED in production too.
      await admin.query(
        `UPDATE platform.booking
            SET state = 'COMPLETED', fulfilled_stay_id = $2::uuid, terminal_at = $3,
                revision = revision + 1
          WHERE booking_id = $1::uuid`,
        [row.booking_id, row.stay_id, row.checkout],
      );
      return {
        bookingId: row.booking_id,
        hotelId: hotel.hotelId,
        accountId,
        stayId: row.stay_id,
        actualCheckoutAt: row.checkout,
      };
    },

    async unfinishedBooking(hotel, accountId, state = 'CONFIRMED') {
      const admin = booking.db.pool;
      const confirmed = state !== 'HOLDING';
      const result = await admin.query<{ booking_id: string }>(
        `INSERT INTO platform.booking
           (hotel_id, booking_ref, category_id, booker_account_id, staying_guest_name,
            check_in_date, check_out_date, night_count, hold_expires_at, state, hold_state,
            payment_state, confirmed_at, terminal_at, rate_snapshot_id, unit_rate_mnt,
            total_amount_mnt, pricing_config_version, cancellation_policy_version,
            free_cancellation_until)
         VALUES ($1::uuid, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
                 $2::uuid, $3::uuid, 'Синтетик зочин',
                 current_date + 30, current_date + 31, 1, now() + interval '10 minutes',
                 $4, CASE WHEN $4 = 'HOLDING' THEN 'ACTIVE' ELSE 'CONSUMED' END,
                 CASE WHEN $5 THEN 'PAID' ELSE 'PENDING' END,
                 CASE WHEN $5 THEN now() ELSE NULL END,
                 CASE WHEN $4 = ANY (ARRAY['EXPIRED','CANCELLED_GUEST','CANCELLED_HOTEL',
                                           'NO_SHOW']) THEN now() ELSE NULL END,
                 CASE WHEN $5 THEN gen_random_uuid() ELSE NULL END,
                 CASE WHEN $5 THEN 120000 ELSE NULL END,
                 CASE WHEN $5 THEN 120000 ELSE NULL END,
                 CASE WHEN $5 THEN 1 ELSE NULL END,
                 CASE WHEN $5 THEN 1 ELSE NULL END,
                 CASE WHEN $5 THEN now() ELSE NULL END)
         RETURNING booking_id`,
        [hotel.hotelId, hotel.categoryId, accountId, state, confirmed],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('the unfinished-booking fixture wrote no row');
      return row.booking_id;
    },

    async moderator(options = {}) {
      sequence += 1;
      const admin = booking.db.pool;
      const role = options.role ?? 'OPERATION_ADMIN';
      const email = `moderator-${String(sequence)}-${suite}@platform.test`;
      const created = await admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
         VALUES ('operation', $1, $2, now()) RETURNING account_id`,
        [role, email],
      );
      const accountId = created.rows[0]?.account_id;
      if (accountId === undefined) throw new Error('the moderator fixture wrote no account');
      if (options.granted !== false) {
        await admin.query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1::uuid, 'operation', $2, 'REVIEW_MODERATE', $1::uuid)`,
          [accountId, role],
        );
      }
      return {
        principal: {
          accountId,
          realm: 'operation' as const,
          accountState: 'ACTIVE' as const,
          memberships: [],
          directPermissions: options.granted === false ? [] : ['REVIEW_MODERATE'],
          realmRole: role as 'OPERATION_ADMIN',
          // A fresh sign-in is the step-up proof; the fixture stamps the same
          // recency the sign-in would (doc 05 §5).
          stepUpAt: clock(),
        },
        sessionId: undefined as unknown as string,
      } as unknown as CommandActor;
    },

    advance(seconds) {
      offsetMs += seconds * 1000;
      booking.advance(seconds);
    },

    resetClock() {
      offsetMs = 0;
      booking.resetClock();
    },

    close() {
      return booking.close();
    },
  };
}

interface AdminPool {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
}

/** An ACTIVE room of that category, for the stay a completed booking became. */
async function activeRoom(
  admin: AdminPool,
  hotelId: string,
  categoryId: string,
  n: number,
): Promise<string> {
  const result = await admin.query<{ room_id: string }>(
    `INSERT INTO platform.room (hotel_id, category_id, room_number, state)
     VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE') RETURNING room_id`,
    [hotelId, categoryId, `p16-${String(n).padStart(4, '0')}`],
  );
  const roomId = result.rows[0]?.room_id;
  if (roomId === undefined) throw new Error('the room fixture wrote no row');
  return roomId;
}

/**
 * The closed shift a past check-in belonged to.
 *
 * `stay.shift_id` is NOT NULL and references a real shift, so the fixture makes
 * one and closes it — one open shift per hotel is a partial unique index, and a
 * fixture that left several open would be fighting that invariant.
 */
async function receptionShift(admin: AdminPool, hotelId: string, n: number): Promise<string> {
  const result = await admin.query<{ shift_id: string }>(
    `WITH a AS (
       INSERT INTO platform.user_account (realm, email_normalized, email_verified_at)
       VALUES ('hotel', $3, now()) RETURNING account_id)
     INSERT INTO platform.reception_shift
       (hotel_id, state, opened_by_account_id, opened_at, closed_by_account_id, closed_at)
     SELECT $1::uuid, 'CLOSED', a.account_id, now() - make_interval(days => $2 + 40),
            a.account_id, now() - make_interval(days => $2 + 39)
       FROM a RETURNING shift_id`,
    [hotelId, n, `p16-shift-${String(n)}-${hotelId.slice(0, 8)}@review.test`],
  );
  const shiftId = result.rows[0]?.shift_id;
  if (shiftId === undefined) throw new Error('the shift fixture wrote no row');
  return shiftId;
}

/** The Reception account a past check-in and checkout were recorded by. */
async function staffAccount(admin: AdminPool, n: number, suite: string): Promise<string> {
  const result = await admin.query<{ account_id: string }>(
    `INSERT INTO platform.user_account (realm, email_normalized, email_verified_at)
     VALUES ('hotel', $1, now()) RETURNING account_id`,
    [`p16-staff-${String(n)}-${suite}@review.test`],
  );
  const accountId = result.rows[0]?.account_id;
  if (accountId === undefined) throw new Error('the staff fixture wrote no row');
  return accountId;
}

export { newReviewRequest, newPublicRequest, quietPool };
