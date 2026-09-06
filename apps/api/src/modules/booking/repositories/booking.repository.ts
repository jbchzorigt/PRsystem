import type { UnitOfWork } from '@prsystem/db';
import { fromPgDate, toDateString } from '../domain/booking';
import type {
  AttemptState,
  BookingState,
  HoldState,
  PaymentState,
  RefundState,
} from '../domain/booking';

/**
 * The booking aggregate's own tables (doc 09 §§7–10).
 *
 * Two things here are not ordinary repository work, and both are the reason
 * this phase exists.
 *
 * `lockInventory` takes the night rows **in night order**, always. A fixed
 * order is what turns two guests racing the last unit into one waiting for the
 * other rather than a deadlock.
 *
 * `occupy` and `release` write the counter the database checks. The refusal
 * when a category is full is `23514` from
 * `category_night_inventory_within_capacity` — a constraint, not a count this
 * code took and then trusted.
 */

export interface BookingRow {
  readonly bookingId: string;
  readonly hotelId: string;
  readonly bookingRef: string;
  readonly categoryId: string;
  readonly bookerAccountId: string;
  readonly stayingGuestName: string;
  readonly checkInDate: Date;
  readonly checkOutDate: Date;
  readonly nightCount: number;
  readonly rateSnapshotId: string | null;
  readonly unitRateMnt: bigint | null;
  readonly totalAmountMnt: bigint | null;
  readonly pricingConfigVersion: number | null;
  readonly state: BookingState;
  readonly holdExpiresAt: Date;
  readonly holdState: HoldState;
  readonly paymentState: PaymentState;
  readonly refundState: RefundState;
  readonly fulfilledStayId: string | null;
  readonly terminalReason: string | null;
  /** doc 11 §5: the policy the guest was shown before paying. */
  readonly cancellationPolicyVersion: number | null;
  readonly freeCancellationUntil: Date | null;
  readonly revision: number;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly bookingId: string;
  readonly provider: 'QPAY' | 'KHAAN';
  readonly providerInvoiceId: string | null;
  /** doc 11 §4.10: the captured transaction, unique to this attempt. */
  readonly providerPaymentId: string | null;
  readonly amountMnt: bigint;
  readonly state: AttemptState;
  readonly expiresAt: Date;
  readonly revision: number;
}

export interface InventoryRow {
  readonly night: Date;
  readonly unitsCapacity: number;
  readonly unitsHeld: number;
  readonly revision: number;
}

const BOOKING_COLUMNS = `booking_id, hotel_id, booking_ref, category_id, booker_account_id,
                         staying_guest_name, check_in_date, check_out_date, night_count,
                         rate_snapshot_id, unit_rate_mnt, total_amount_mnt,
                         pricing_config_version, state, hold_expires_at, hold_state,
                         payment_state, refund_state, fulfilled_stay_id, terminal_reason,
                         cancellation_policy_version, free_cancellation_until, revision`;
const ATTEMPT_COLUMNS = `attempt_id, booking_id, provider, provider_invoice_id,
                         provider_payment_id, amount_mnt, state, expires_at, revision`;

export class BookingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ------------------------------------------------------------------ booking
  async byId(bookingId: string): Promise<BookingRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking WHERE booking_id = $1`,
      [bookingId],
    );
    return mapBooking(result.rows[0]);
  }

  async byReference(bookingRef: string): Promise<BookingRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking WHERE booking_ref = $1`,
      [bookingRef],
    );
    return mapBooking(result.rows[0]);
  }

  /** The row every money- or state-changing command takes first. */
  async lock(bookingId: string): Promise<BookingRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    return mapBooking(result.rows[0]);
  }

  /** The booking a stay fulfilled, locked. `BK-DEC-013` makes it at most one. */
  async lockByStay(stayId: string): Promise<BookingRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking
        WHERE fulfilled_stay_id = $1 FOR UPDATE`,
      [stayId],
    );
    return mapBooking(result.rows[0]);
  }

  async forBooker(bookerAccountId: string, limit: number): Promise<readonly BookingRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking
        WHERE booker_account_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [bookerAccountId, limit],
    );
    return result.rows
      .map((row) => mapBooking(row))
      .filter((row): row is BookingRow => row !== undefined);
  }

  async create(input: {
    bookingId: string;
    hotelId: string;
    bookingRef: string;
    categoryId: string;
    bookerAccountId: string;
    stayingGuestName: string;
    stayingGuestPhoneToken: string | null;
    checkInDate: Date;
    checkOutDate: Date;
    nightCount: number;
    holdExpiresAt: Date;
    cancellationPolicyVersion: number;
    freeCancellationUntil: Date;
  }): Promise<BookingRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.booking
         (booking_id, hotel_id, booking_ref, category_id, booker_account_id, staying_guest_name,
          staying_guest_phone_token, check_in_date, check_out_date, night_count, hold_expires_at,
          cancellation_policy_version, free_cancellation_until)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7::text, $8::date, $9::date,
               $10, $11::timestamptz, $12::integer, $13::timestamptz)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        input.bookingId,
        input.hotelId,
        input.bookingRef,
        input.categoryId,
        input.bookerAccountId,
        input.stayingGuestName,
        input.stayingGuestPhoneToken,
        toDateString(input.checkInDate),
        toDateString(input.checkOutDate),
        input.nightCount,
        input.holdExpiresAt,
        input.cancellationPolicyVersion,
        input.freeCancellationUntil,
      ],
    );
    const row = mapBooking(result.rows[0]);
    if (row === undefined) throw new Error('the booking insert returned no row');
    return row;
  }

  async addNights(input: {
    bookingId: string;
    hotelId: string;
    categoryId: string;
    nights: readonly Date[];
  }): Promise<void> {
    for (const night of input.nights) {
      await this.uow.query(
        `INSERT INTO platform.booking_night (booking_id, hotel_id, category_id, night)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date)`,
        [input.bookingId, input.hotelId, input.categoryId, toDateString(night)],
      );
    }
  }

  async nightsOf(bookingId: string): Promise<readonly Date[]> {
    const result = await this.uow.query<{ night: Date }>(
      `SELECT night FROM platform.booking_night WHERE booking_id = $1 ORDER BY night`,
      [bookingId],
    );
    return result.rows.map((row) => fromPgDate(row.night));
  }

  /**
   * Advances a booking. Guarded by the revision *and* by the states the caller
   * believed it was in, so a decision taken on a stale read cannot land.
   */
  async transition(input: {
    bookingId: string;
    expectedRevision: number;
    from: readonly BookingState[];
    state?: BookingState;
    holdState?: HoldState;
    paymentState?: PaymentState;
    refundState?: RefundState;
    confirmedAt?: Date;
    terminalAt?: Date;
    terminalReason?: string;
    fulfilledStayId?: string;
    snapshot?: {
      rateSnapshotId: string;
      unitRateMnt: bigint;
      totalAmountMnt: bigint;
      pricingConfigVersion: number;
    };
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.booking
          SET state = COALESCE($4::text, state),
              hold_state = COALESCE($5::text, hold_state),
              payment_state = COALESCE($6::text, payment_state),
              refund_state = COALESCE($7::text, refund_state),
              confirmed_at = COALESCE($8::timestamptz, confirmed_at),
              terminal_at = COALESCE($9::timestamptz, terminal_at),
              terminal_reason = COALESCE($10::text, terminal_reason),
              fulfilled_stay_id = COALESCE($11::uuid, fulfilled_stay_id),
              rate_snapshot_id = COALESCE($12::uuid, rate_snapshot_id),
              unit_rate_mnt = COALESCE($13::bigint, unit_rate_mnt),
              total_amount_mnt = COALESCE($14::bigint, total_amount_mnt),
              pricing_config_version = COALESCE($15::integer, pricing_config_version),
              revision = revision + 1
        WHERE booking_id = $1::uuid AND revision = $2 AND state = ANY ($3::text[])`,
      [
        input.bookingId,
        input.expectedRevision,
        input.from,
        input.state ?? null,
        input.holdState ?? null,
        input.paymentState ?? null,
        input.refundState ?? null,
        input.confirmedAt ?? null,
        input.terminalAt ?? null,
        input.terminalReason ?? null,
        input.fulfilledStayId ?? null,
        input.snapshot?.rateSnapshotId ?? null,
        input.snapshot === undefined ? null : String(input.snapshot.unitRateMnt),
        input.snapshot === undefined ? null : String(input.snapshot.totalAmountMnt),
        input.snapshot?.pricingConfigVersion ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ---------------------------------------------------------------- inventory
  /**
   * Takes the inventory rows for these nights, creating any that do not exist,
   * and returns them locked — **always in night order**, which is what stops
   * two overlapping bookings from deadlocking on each other.
   *
   * `unitsCapacity` is refreshed from the rooms as they are right now: eligible
   * `ACTIVE` rooms of the category, minus the ones a stay occupies that night.
   */
  async lockInventory(
    hotelId: string,
    categoryId: string,
    nights: readonly Date[],
  ): Promise<readonly InventoryRow[]> {
    const ordered = [...nights].sort((a, b) => a.getTime() - b.getTime());
    const rows: InventoryRow[] = [];
    for (const night of ordered) {
      await this.uow.query(
        `INSERT INTO platform.category_night_inventory
           (hotel_id, category_id, night, units_capacity, units_held)
         VALUES ($1::uuid, $2::uuid, $3::date, 0, 0)
         ON CONFLICT (hotel_id, category_id, night) DO NOTHING`,
        [hotelId, categoryId, toDateString(night)],
      );
      const locked = await this.uow.query<Record<string, unknown>>(
        `SELECT night, units_capacity, units_held, revision
           FROM platform.category_night_inventory
          WHERE hotel_id = $1::uuid AND category_id = $2::uuid AND night = $3::date
          FOR UPDATE`,
        [hotelId, categoryId, toDateString(night)],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error('the inventory row vanished under its own lock');
      rows.push({
        night: fromPgDate(row['night'] as Date),
        unitsCapacity: Number(row['units_capacity']),
        unitsHeld: Number(row['units_held']),
        revision: Number(row['revision']),
      });
    }
    return rows;
  }

  /**
   * The capacity of a category on one night, as the rooms are at this instant:
   * eligible `ACTIVE` rooms, minus the ones an active stay occupies, minus the
   * ones a non-terminal minibar configuration change has taken out of service
   * (doc 09 §5).
   */
  async capacityFor(hotelId: string, categoryId: string, night: Date): Promise<number> {
    const result = await this.uow.query<{ capacity: string }>(
      `SELECT count(*) AS capacity
         FROM platform.room r
        WHERE r.hotel_id = $1::uuid
          AND r.category_id = $2::uuid
          AND r.state = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM platform.room_configuration_change rc
             WHERE rc.room_id = r.room_id
               AND rc.state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])
          )
          AND NOT EXISTS (
            SELECT 1 FROM platform.stay s
             WHERE s.room_id = r.room_id
               AND s.state = ANY (ARRAY['ACTIVE', 'CHECKOUT_IN_PROGRESS'])
               AND s.fulfilled_booking_id IS NULL
               AND date_trunc('day', COALESCE(s.actual_check_in_at, s.created_at)) <= $3::date
               AND date_trunc('day', COALESCE(s.actual_checkout_at, s.planned_checkout_at)) > $3::date
          )`,
      [hotelId, categoryId, toDateString(night)],
    );
    return Number(result.rows[0]?.capacity ?? 0);
  }

  /**
   * Takes one unit of each night, refreshing the capacity as it goes.
   *
   * The `CHECK` is what refuses the unit past capacity; this returns the
   * refusal's SQLSTATE to the caller rather than pre-checking, because a
   * pre-check is a race and the constraint is not.
   */
  async occupy(
    hotelId: string,
    categoryId: string,
    nights: readonly Date[],
    delta: 1 | -1,
  ): Promise<void> {
    for (const night of [...nights].sort((a, b) => a.getTime() - b.getTime())) {
      const capacity = await this.capacityFor(hotelId, categoryId, night);
      await this.uow.query(
        `UPDATE platform.category_night_inventory
            SET units_capacity = $4,
                units_held = units_held + $5,
                updated_at = now(),
                revision = revision + 1
          WHERE hotel_id = $1::uuid AND category_id = $2::uuid AND night = $3::date`,
        [hotelId, categoryId, toDateString(night), capacity, delta],
      );
    }
  }

  /** What a category can still sell for each night of a window. */
  async availability(
    hotelId: string,
    categoryId: string,
    nights: readonly Date[],
  ): Promise<number> {
    let free = Number.POSITIVE_INFINITY;
    for (const night of nights) {
      const capacity = await this.capacityFor(hotelId, categoryId, night);
      const held = await this.uow.query<{ units_held: string }>(
        `SELECT units_held FROM platform.category_night_inventory
          WHERE hotel_id = $1::uuid AND category_id = $2::uuid AND night = $3::date`,
        [hotelId, categoryId, toDateString(night)],
      );
      free = Math.min(free, capacity - Number(held.rows[0]?.units_held ?? 0));
    }
    return free === Number.POSITIVE_INFINITY ? 0 : Math.max(0, free);
  }

  // ----------------------------------------------------------------- attempts
  async activeAttempt(bookingId: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.booking_payment_attempt
        WHERE booking_id = $1 AND state = 'ACTIVE'
        FOR UPDATE`,
      [bookingId],
    );
    return mapAttempt(result.rows[0]);
  }

  async attemptById(attemptId: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.booking_payment_attempt
        WHERE attempt_id = $1 FOR UPDATE`,
      [attemptId],
    );
    return mapAttempt(result.rows[0]);
  }

  async createAttempt(input: {
    hotelId: string;
    bookingId: string;
    provider: 'QPAY' | 'KHAAN';
    providerInvoiceId: string | null;
    amountMnt: bigint;
    expiresAt: Date;
  }): Promise<AttemptRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.booking_payment_attempt
         (hotel_id, booking_id, provider, provider_invoice_id, amount_mnt, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::text, $5::bigint, $6::timestamptz)
       RETURNING ${ATTEMPT_COLUMNS}`,
      [
        input.hotelId,
        input.bookingId,
        input.provider,
        input.providerInvoiceId,
        String(input.amountMnt),
        input.expiresAt,
      ],
    );
    const row = mapAttempt(result.rows[0]);
    if (row === undefined) throw new Error('the payment attempt insert returned no row');
    return row;
  }

  async settleAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    state: Exclude<AttemptState, 'ACTIVE'>;
    reason: string;
    /** The transaction the provider captured, written once (doc 11 §4.10). */
    providerPaymentId?: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.booking_payment_attempt
          SET state = $3::text, settled_at = now(), settled_reason = $4::text,
              provider_payment_id = coalesce($5::text, provider_payment_id),
              revision = revision + 1
        WHERE attempt_id = $1::uuid AND revision = $2 AND state = 'ACTIVE'`,
      [
        input.attemptId,
        input.expectedRevision,
        input.state,
        input.reason,
        input.providerPaymentId ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Records the provider invoice an attempt was opened with.
   *
   * The guard freezes it once written, so a redriven invoice creation that got
   * the same invoice back writes nothing and a *different* one is refused.
   */
  async setInvoice(input: {
    attemptId: string;
    expectedRevision: number;
    providerInvoiceId: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.booking_payment_attempt
          SET provider_invoice_id = $3::text, revision = revision + 1
        WHERE attempt_id = $1::uuid AND revision = $2 AND state = 'ACTIVE'
          AND provider_invoice_id IS NULL`,
      [input.attemptId, input.expectedRevision, input.providerInvoiceId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Records the captured transaction on an attempt that is already settled.
   *
   * A late capture arrives on an `EXPIRED` or `SUPERSEDED` attempt, and doc 11
   * §4.10 still requires the transaction id to be recorded exactly once — the
   * partial unique index is what makes a second attempt claiming it fail.
   */
  async recordCapturedPayment(input: {
    attemptId: string;
    expectedRevision: number;
    providerPaymentId: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.booking_payment_attempt
          SET provider_payment_id = $3::text, revision = revision + 1
        WHERE attempt_id = $1::uuid AND revision = $2 AND provider_payment_id IS NULL`,
      [input.attemptId, input.expectedRevision, input.providerPaymentId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // -------------------------------------------------------------------- events
  async record(input: {
    hotelId: string;
    bookingId: string;
    eventType: string;
    fromState: string | null;
    toState: string | null;
    actorRef: string;
    reason?: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.booking_event
         (hotel_id, booking_id, event_type, from_state, to_state, actor_ref, reason)
       VALUES ($1::uuid, $2::uuid, $3, $4::text, $5::text, $6, $7::text)`,
      [
        input.hotelId,
        input.bookingId,
        input.eventType,
        input.fromState,
        input.toState,
        input.actorRef,
        input.reason ?? null,
      ],
    );
  }

  /** The bookings whose ten minutes are up, oldest first. */
  async lapsed(limit: number): Promise<readonly BookingRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BOOKING_COLUMNS} FROM platform.booking
        WHERE hold_state = 'ACTIVE' AND state = 'HOLDING' AND hold_expires_at <= now()
        ORDER BY hold_expires_at
        LIMIT $1`,
      [limit],
    );
    return result.rows
      .map((row) => mapBooking(row))
      .filter((r): r is BookingRow => r !== undefined);
  }

  /** Confirmed bookings of a category overlapping a window, for availability. */
  async confirmedInWindow(
    hotelId: string,
    nights: readonly Date[],
  ): Promise<readonly { categoryId: string; held: number }[]> {
    if (nights.length === 0) return [];
    const result = await this.uow.query<{ category_id: string; held: string }>(
      `SELECT category_id, max(taken) AS held
         FROM (
           SELECT n.category_id, n.night, count(*) AS taken
             FROM platform.booking_night n
             JOIN platform.booking b ON b.booking_id = n.booking_id
            WHERE n.hotel_id = $1::uuid
              AND n.night = ANY ($2::date[])
              AND b.state = ANY (ARRAY['HOLDING', 'CONFIRMED'])
              AND b.hold_state <> 'EXPIRED'
            GROUP BY n.category_id, n.night
         ) per_night
        GROUP BY category_id`,
      [hotelId, nights.map(toDateString)],
    );
    return result.rows.map((row) => ({
      categoryId: row.category_id,
      held: Number(row.held),
    }));
  }
}

function mapBooking(row: Record<string, unknown> | undefined): BookingRow | undefined {
  if (row === undefined) return undefined;
  return {
    bookingId: String(row['booking_id']),
    hotelId: String(row['hotel_id']),
    bookingRef: String(row['booking_ref']),
    categoryId: String(row['category_id']),
    bookerAccountId: String(row['booker_account_id']),
    stayingGuestName: String(row['staying_guest_name']),
    checkInDate: fromPgDate(row['check_in_date'] as Date),
    checkOutDate: fromPgDate(row['check_out_date'] as Date),
    nightCount: Number(row['night_count']),
    rateSnapshotId: (row['rate_snapshot_id'] as string | null) ?? null,
    unitRateMnt: row['unit_rate_mnt'] === null ? null : BigInt(String(row['unit_rate_mnt'])),
    totalAmountMnt:
      row['total_amount_mnt'] === null ? null : BigInt(String(row['total_amount_mnt'])),
    pricingConfigVersion:
      row['pricing_config_version'] === null ? null : Number(row['pricing_config_version']),
    state: row['state'] as BookingState,
    holdExpiresAt: row['hold_expires_at'] as Date,
    holdState: row['hold_state'] as HoldState,
    paymentState: row['payment_state'] as PaymentState,
    refundState: row['refund_state'] as RefundState,
    fulfilledStayId: (row['fulfilled_stay_id'] as string | null) ?? null,
    terminalReason: (row['terminal_reason'] as string | null) ?? null,
    cancellationPolicyVersion:
      row['cancellation_policy_version'] === null
        ? null
        : Number(row['cancellation_policy_version']),
    freeCancellationUntil: (row['free_cancellation_until'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapAttempt(row: Record<string, unknown> | undefined): AttemptRow | undefined {
  if (row === undefined) return undefined;
  return {
    attemptId: String(row['attempt_id']),
    bookingId: String(row['booking_id']),
    provider: row['provider'] as 'QPAY' | 'KHAAN',
    providerInvoiceId: (row['provider_invoice_id'] as string | null) ?? null,
    providerPaymentId: (row['provider_payment_id'] as string | null) ?? null,
    amountMnt: BigInt(String(row['amount_mnt'])),
    state: row['state'] as AttemptState,
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}
