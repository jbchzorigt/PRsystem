import type { UnitOfWork } from '@prsystem/db';
import type {
  DailySeriesRow,
  DepositTotals,
  FinancialWindow,
  PaymentBreakdownRow,
  PaymentTotals,
  RoomDemandFact,
  RoomSalesRow,
  SalesFactsPort,
  SalesTotals,
} from '../../reporting/contracts/financial-facts';

/**
 * The money the billing module owns, answered for the Hotel Admin dashboard
 * (doc 23 §§2, 6, 7, 8; CLAUDE.md §3).
 *
 * doc 23 §1 exists because these figures are easy to mix up, so this file keeps
 * them apart in the most literal way available: four separate queries over four
 * different date bases, none of which can contribute to another's total.
 *
 * * **Sales** are finalized `folio_line` charges by `created_at`, which is when
 *   the charge was recognised — paid or not (doc 23 §2.1).
 * * **Money received** is successful `payment_transaction` rows by
 *   `effective_at`, in the `IN` direction, less the ones that went `OUT`
 *   (doc 23 §2.2). A pending or failed movement never becomes a row here,
 *   because this table only ever holds movements that happened.
 * * **A deposit** is a balance at the end of the window, not a sum over it
 *   (doc 23 §6.2), and a deposit paying a charge is an allocation rather than a
 *   new inflow (doc 23 §2.4).
 * * **Restaurant money is absent entirely.** doc 08 §13 sends it to the
 *   restaurant's own merchant and it writes no folio line and no payment
 *   transaction, so there is nothing here to exclude — which is a stronger
 *   guarantee than a filter would be.
 */

const CASH_IN_KINDS = `ARRAY['FOLIO_PAYMENT'::text, 'CORRECTED_PAYMENT'::text]`;

function bigintOf(value: unknown): bigint {
  return BigInt(String(value ?? '0'));
}

export class RepositoryFinancialReads implements SalesFactsPort {
  /**
   * doc 23 §2.1: finalized charges by kind, and the reversals against them.
   *
   * A `folio_line` is positive by CHECK, so a reversal is a `FOLIO_PAYMENT_
   * REVERSAL` movement rather than a negative charge — which is why the
   * reversal total comes from the payment table and the gross totals from the
   * charge table.
   */
  async sales(uow: UnitOfWork, window: FinancialWindow): Promise<SalesTotals> {
    const charges = await uow.query<{ kind: string; total: string }>(
      `SELECT l.kind, COALESCE(sum(l.amount_mnt), 0)::text AS total
         FROM platform.folio_line l
        WHERE l.hotel_id = $1::uuid
          AND l.created_at >= $2::timestamptz AND l.created_at < $3::timestamptz
        GROUP BY l.kind`,
      [window.hotelId, window.from, window.to],
    );
    const byKind = new Map(charges.rows.map((row) => [row.kind, bigintOf(row.total)]));
    const reversals = await uow.query<{ total: string }>(
      `SELECT COALESCE(sum(t.amount_mnt), 0)::text AS total
         FROM platform.payment_transaction t
        WHERE t.hotel_id = $1::uuid
          AND t.kind = 'FOLIO_PAYMENT_REVERSAL'
          AND t.effective_at >= $2::timestamptz AND t.effective_at < $3::timestamptz`,
      [window.hotelId, window.from, window.to],
    );
    return {
      roomGrossMnt: byKind.get('ROOM') ?? 0n,
      // doc 23 §2.1: a discount or waiver is a correction against the charge,
      // and the MVP records one as a reversal rather than as a negative line.
      roomDiscountMnt: 0n,
      minibarGrossMnt: byKind.get('MINIBAR') ?? 0n,
      minibarDiscountMnt: 0n,
      otherGrossMnt: byKind.get('OTHER') ?? 0n,
      reversalMnt: bigintOf(reversals.rows[0]?.total),
    };
  }

  async payments(uow: UnitOfWork, window: FinancialWindow): Promise<PaymentTotals> {
    const rows = await uow.query<{ channel: string; direction: string; total: string }>(
      `SELECT t.channel, t.direction, COALESCE(sum(t.amount_mnt), 0)::text AS total
         FROM platform.payment_transaction t
        WHERE t.hotel_id = $1::uuid
          AND t.kind = ANY (${CASH_IN_KINDS})
          AND t.effective_at >= $2::timestamptz AND t.effective_at < $3::timestamptz
        GROUP BY t.channel, t.direction`,
      [window.hotelId, window.from, window.to],
    );
    const byChannel: Record<string, bigint> = {};
    let successful = 0n;
    for (const row of rows.rows) {
      if (row.direction !== 'IN') continue;
      const amount = bigintOf(row.total);
      byChannel[row.channel] = (byChannel[row.channel] ?? 0n) + amount;
      successful += amount;
    }
    // doc 23 §2.2: a refund of a service payment reduces money received on the
    // day it succeeded. A *deposit* refund does not: doc 23 §2.4 makes it a
    // liability movement, so it is not in `CASH_IN_KINDS` at all.
    const refunds = await uow.query<{ total: string }>(
      `SELECT COALESCE(sum(t.amount_mnt), 0)::text AS total
         FROM platform.payment_transaction t
        WHERE t.hotel_id = $1::uuid
          AND t.kind = 'FOLIO_PAYMENT_REVERSAL'
          AND t.effective_at >= $2::timestamptz AND t.effective_at < $3::timestamptz`,
      [window.hotelId, window.from, window.to],
    );
    const allocation = await uow.query<{ paid: string; deposit: string }>(
      // doc 23 §2.3: allocation is a *balance*, so it is every folio opened
      // before the end of the window rather than only the ones opened inside it.
      `SELECT COALESCE(sum(f.paid_mnt), 0)::text AS paid,
              COALESCE(sum(f.deposit_applied_mnt), 0)::text AS deposit
         FROM platform.stay_folio f
        WHERE f.hotel_id = $1::uuid AND f.opened_at < $2::timestamptz`,
      [window.hotelId, window.to],
    );
    return {
      successfulMnt: successful,
      refundedMnt: bigintOf(refunds.rows[0]?.total),
      byChannelMnt: byChannel,
      depositAllocationMnt: bigintOf(allocation.rows[0]?.deposit),
      paymentAllocationMnt: bigintOf(allocation.rows[0]?.paid),
    };
  }

  /** doc 23 §6.2: the balance at the end of the window, not a sum over it. */
  async depositsHeld(uow: UnitOfWork, window: FinancialWindow): Promise<DepositTotals> {
    const rows = await uow.query<{ held: string }>(
      `SELECT COALESCE(sum(d.received_mnt - d.reversed_mnt - d.allocated_mnt
                           - d.refund_reserved_mnt - d.refunded_mnt), 0)::text AS held
         FROM platform.deposit_aggregate d
        WHERE d.hotel_id = $1::uuid AND d.created_at < $2::timestamptz`,
      [window.hotelId, window.to],
    );
    return { heldMnt: bigintOf(rows.rows[0]?.held) };
  }

  /** doc 23 §6.3: one point per hotel-local day, and a quiet day is a zero. */
  async dailySeries(
    uow: UnitOfWork,
    window: FinancialWindow,
    timeZone: string,
  ): Promise<readonly DailySeriesRow[]> {
    const charges = await uow.query<{ day: string; kind: string; total: string }>(
      `SELECT to_char(l.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              l.kind, COALESCE(sum(l.amount_mnt), 0)::text AS total
         FROM platform.folio_line l
        WHERE l.hotel_id = $1::uuid
          AND l.created_at >= $2::timestamptz AND l.created_at < $3::timestamptz
        GROUP BY 1, 2`,
      [window.hotelId, window.from, window.to, timeZone],
    );
    const refunds = await uow.query<{ day: string; total: string }>(
      `SELECT to_char(t.effective_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              COALESCE(sum(t.amount_mnt), 0)::text AS total
         FROM platform.payment_transaction t
        WHERE t.hotel_id = $1::uuid
          AND t.kind = 'FOLIO_PAYMENT_REVERSAL'
          AND t.effective_at >= $2::timestamptz AND t.effective_at < $3::timestamptz
        GROUP BY 1`,
      [window.hotelId, window.from, window.to, timeZone],
    );
    const days = new Map<string, { room: bigint; minibar: bigint; refund: bigint }>();
    const at = (day: string) => {
      const found = days.get(day) ?? { room: 0n, minibar: 0n, refund: 0n };
      days.set(day, found);
      return found;
    };
    for (const row of charges.rows) {
      const entry = at(row.day);
      if (row.kind === 'ROOM') entry.room += bigintOf(row.total);
      if (row.kind === 'MINIBAR') entry.minibar += bigintOf(row.total);
    }
    for (const row of refunds.rows) at(row.day).refund += bigintOf(row.total);
    return [...days.entries()]
      .map(([localDate, totals]) => ({
        localDate,
        roomNetSalesMnt: totals.room,
        minibarNetSalesMnt: totals.minibar,
        refundMnt: totals.refund,
      }))
      .sort((left, right) => left.localDate.localeCompare(right.localDate));
  }

  /**
   * `FIN-DEC-007`: completed, non-cancelled stays whose *actual checkout* fell
   * in the window.
   *
   * A stay is cancelled by never completing, so `state = 'COMPLETED'` is the
   * whole filter — and an unpaid but completed stay counts, because doc 23
   * §7.1 says demand is demand whether or not the bill was settled.
   */
  async roomDemand(uow: UnitOfWork, window: FinancialWindow): Promise<readonly RoomDemandFact[]> {
    const rows = await uow.query<Record<string, unknown>>(
      `SELECT s.room_id, r.room_number, c.name AS category_name,
              count(*)::int AS completed_stays,
              count(*) FILTER (WHERE s.stay_type = 'HOURLY')::int AS hourly_stays,
              count(*) FILTER (WHERE s.stay_type = 'NIGHTLY')::int AS nightly_stays,
              COALESCE(sum(EXTRACT(EPOCH FROM (s.actual_checkout_at - s.actual_check_in_at))
                           / 60), 0)::int AS total_minutes,
              COALESCE(sum(s.room_charge_mnt), 0)::text AS gross_mnt
         FROM platform.stay s
         JOIN platform.room r ON r.hotel_id = s.hotel_id AND r.room_id = s.room_id
         JOIN platform.room_category c
           ON c.hotel_id = s.hotel_id AND c.category_id = s.category_id
        WHERE s.hotel_id = $1::uuid
          AND s.state = 'COMPLETED'
          AND s.actual_checkout_at >= $2::timestamptz
          AND s.actual_checkout_at < $3::timestamptz
        GROUP BY s.room_id, r.room_number, c.name`,
      [window.hotelId, window.from, window.to],
    );
    return rows.rows.map((row) => ({
      roomId: String(row['room_id']),
      roomNumber: String(row['room_number']),
      categoryName: String(row['category_name']),
      completedStays: Number(row['completed_stays']),
      hourlyStays: Number(row['hourly_stays']),
      nightlyStays: Number(row['nightly_stays']),
      totalMinutes: Number(row['total_minutes']),
      roomGrossSalesMnt: bigintOf(row['gross_mnt']),
      // No discount ledger in the MVP, so net equals gross here and the
      // dashboard's own reversal figure carries the corrections.
      roomNetSalesMnt: bigintOf(row['gross_mnt']),
    }));
  }

  /** doc 23 §8.1: one row per stay, with its snapshotted price and its source. */
  async roomSalesRows(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly RoomSalesRow[]> {
    const rows = await uow.query<Record<string, unknown>>(
      `SELECT s.stay_id, r.room_number, c.name AS category_name, s.stay_type,
              s.unit_rate_mnt, snap.source_level, snap.source_entity_id,
              s.pricing_config_version,
              COALESCE(
                (SELECT tc.corrected_actual_check_in_at
                   FROM platform.stay_time_correction tc
                  WHERE tc.stay_id = s.stay_id AND tc.state = 'APPROVED'
                  ORDER BY tc.decided_at DESC LIMIT 1),
                s.actual_check_in_at) AS effective_check_in_at,
              s.actual_checkout_at,
              s.room_charge_mnt,
              COALESCE(f.paid_mnt, 0) AS allocated_payment_mnt,
              COALESCE(f.deposit_applied_mnt, 0) AS deposit_applied_mnt,
              COALESCE(f.state, 'NONE') AS payment_status,
              (SELECT t.channel FROM platform.payment_transaction t
                WHERE t.stay_id = s.stay_id AND t.direction = 'IN'
                ORDER BY t.effective_at DESC LIMIT 1) AS payment_channel,
              s.actual_checkout_at AS recognized_at
         FROM platform.stay s
         JOIN platform.room r ON r.hotel_id = s.hotel_id AND r.room_id = s.room_id
         JOIN platform.room_category c
           ON c.hotel_id = s.hotel_id AND c.category_id = s.category_id
         JOIN platform.stay_rate_snapshot snap ON snap.snapshot_id = s.rate_snapshot_id
         LEFT JOIN platform.stay_folio f ON f.hotel_id = s.hotel_id AND f.stay_id = s.stay_id
        WHERE s.hotel_id = $1::uuid
          AND s.state = 'COMPLETED'
          AND s.actual_checkout_at >= $2::timestamptz
          AND s.actual_checkout_at < $3::timestamptz
        ORDER BY s.actual_checkout_at, s.stay_id
        LIMIT $4`,
      [window.hotelId, window.from, window.to, cap + 1],
    );
    return rows.rows.map((row) => {
      const gross = bigintOf(row['room_charge_mnt']);
      const allocated = bigintOf(row['allocated_payment_mnt']);
      const deposit = bigintOf(row['deposit_applied_mnt']);
      const owed = gross - allocated - deposit;
      return {
        stayId: String(row['stay_id']),
        roomNumber: String(row['room_number']),
        categoryName: String(row['category_name']),
        stayType: String(row['stay_type']),
        unitRateMnt: bigintOf(row['unit_rate_mnt']),
        sourceLevel: String(row['source_level']),
        sourceEntityId: String(row['source_entity_id']),
        pricingConfigVersion: Number(row['pricing_config_version']),
        effectiveCheckInAt: row['effective_check_in_at'] as Date,
        actualCheckoutAt: (row['actual_checkout_at'] as Date | null) ?? null,
        grossChargeMnt: gross,
        discountMnt: 0n,
        netSalesMnt: gross,
        allocatedPaymentMnt: allocated + deposit,
        receivableMnt: owed > 0n ? owed : 0n,
        paymentStatus: String(row['payment_status']),
        paymentChannel: (row['payment_channel'] as string | null) ?? null,
        recognizedAt: row['recognized_at'] as Date,
      };
    });
  }

  /** doc 23 §8.4: one row per successful movement, and what it paid for. */
  async paymentRows(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly PaymentBreakdownRow[]> {
    const rows = await uow.query<Record<string, unknown>>(
      `SELECT t.transaction_id, t.provider_reference, t.stay_id, t.channel, t.kind,
              t.direction, t.amount_mnt, t.effective_at,
              COALESCE(f.deposit_applied_mnt, 0) AS deposit_applied_mnt
         FROM platform.payment_transaction t
         LEFT JOIN platform.stay_folio f ON f.hotel_id = t.hotel_id AND f.stay_id = t.stay_id
        WHERE t.hotel_id = $1::uuid
          AND t.effective_at >= $2::timestamptz AND t.effective_at < $3::timestamptz
        ORDER BY t.effective_at, t.transaction_id
        LIMIT $4`,
      [window.hotelId, window.from, window.to, cap + 1],
    );
    return rows.rows.map((row) => {
      const amount = bigintOf(row['amount_mnt']);
      const kind = String(row['kind']);
      const isRefund = String(row['direction']) === 'OUT';
      const isDeposit = kind.startsWith('DEPOSIT');
      return {
        transactionId: String(row['transaction_id']),
        reference: (row['provider_reference'] as string | null) ?? null,
        stayId: String(row['stay_id']),
        channel: String(row['channel']),
        grossMnt: amount,
        // The MVP folio does not split a payment across charge kinds, so the
        // allocation a report can honestly state is the whole of it against the
        // folio, and a deposit movement against the deposit.
        roomAllocationMnt: isDeposit || isRefund ? 0n : amount,
        minibarAllocationMnt: 0n,
        otherAllocationMnt: 0n,
        depositAllocationMnt: isDeposit && !isRefund ? amount : 0n,
        refundMnt: isRefund ? amount : 0n,
        netMnt: isRefund ? -amount : amount,
        status: kind,
        effectiveAt: row['effective_at'] as Date,
      };
    });
  }
}
