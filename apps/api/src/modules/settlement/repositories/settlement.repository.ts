import type { UnitOfWork } from '@prsystem/db';
import type { LedgerEventType, PayoutState, RefundReason, RefundState } from '../domain/settlement';

/**
 * The settlement module's own tables (doc 11 §§3, 7–9).
 *
 * Two habits run through it. Every money row is written with the figures
 * already decided by `domain/settlement.ts`, so the database's CHECKs are a
 * second opinion rather than the only one. And every insert that a retry could
 * repeat carries its cause: `booking_ledger_event` and `booking_refund` both
 * key on a `source_ref`, so a duplicated callback, a redriven job or a replayed
 * batch reaches an `ON CONFLICT DO NOTHING` instead of a second effect.
 */

export interface ContractRow {
  readonly contractId: string;
  readonly hotelId: string;
  readonly contractVersion: number;
  readonly commissionRateBps: number;
  readonly cancellationPolicyVersion: number;
  readonly state: string;
}

export interface PayableRow {
  readonly payableId: string;
  readonly hotelId: string;
  readonly bookingId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly commissionRateBps: number;
  readonly grossPaidMnt: bigint;
  readonly refundedMnt: bigint;
  readonly retainedMnt: bigint;
  readonly commissionMnt: bigint;
  readonly hotelPayableMnt: bigint;
  readonly providerFeeMnt: bigint;
  readonly paidOutMnt: bigint;
  readonly payoutState: PayoutState;
  readonly eligibleAt: Date | null;
  readonly eligibleLocalDate: string | null;
  readonly holdReason: string | null;
  readonly revision: number;
}

export interface RefundRow {
  readonly refundId: string;
  readonly hotelId: string;
  readonly bookingId: string;
  readonly payableId: string | null;
  readonly reason: RefundReason;
  readonly amountMnt: bigint;
  readonly state: RefundState;
  readonly provider: 'QPAY' | 'KHAAN';
  readonly providerPaymentId: string | null;
  readonly providerRefundId: string | null;
  readonly sourceRef: string;
  readonly revision: number;
}

export interface BatchRow {
  readonly batchId: string;
  readonly hotelId: string;
  readonly batchLocalDate: string;
  readonly attemptNo: number;
  readonly scheduledAt: Date;
  readonly state: 'OPEN' | 'SUBMITTED' | 'PAID' | 'FAILED';
  readonly grossPaidMnt: bigint;
  readonly refundedMnt: bigint;
  readonly retainedMnt: bigint;
  readonly commissionMnt: bigint;
  readonly adjustmentMnt: bigint;
  readonly hotelPayableMnt: bigint;
  readonly bankReference: string | null;
  readonly revision: number;
}

const CONTRACT_COLUMNS = `contract_id, hotel_id, contract_version, commission_rate_bps,
                          cancellation_policy_version, state`;
const PAYABLE_COLUMNS = `payable_id, hotel_id, booking_id, contract_id, contract_version,
                         commission_rate_bps, gross_paid_mnt, refunded_mnt, retained_mnt,
                         commission_mnt, hotel_payable_mnt, provider_fee_mnt, paid_out_mnt,
                         payout_state, eligible_at, to_char(eligible_local_date, 'YYYY-MM-DD')
                           AS eligible_local_date,
                         hold_reason, revision`;
const REFUND_COLUMNS = `refund_id, hotel_id, booking_id, payable_id, reason, amount_mnt, state,
                        provider, provider_payment_id, provider_refund_id, source_ref, revision`;
const BATCH_COLUMNS = `batch_id, hotel_id, to_char(batch_local_date, 'YYYY-MM-DD')
                         AS batch_local_date,
                       attempt_no, scheduled_at, state, gross_paid_mnt, refunded_mnt,
                       retained_mnt, commission_mnt, adjustment_mnt, hotel_payable_mnt,
                       bank_reference, revision`;

function big(value: unknown): bigint {
  return BigInt(String(value));
}

function mapContract(row: Record<string, unknown> | undefined): ContractRow | undefined {
  if (row === undefined) return undefined;
  return {
    contractId: row['contract_id'] as string,
    hotelId: row['hotel_id'] as string,
    contractVersion: Number(row['contract_version']),
    commissionRateBps: Number(row['commission_rate_bps']),
    cancellationPolicyVersion: Number(row['cancellation_policy_version']),
    state: row['state'] as string,
  };
}

function mapPayable(row: Record<string, unknown> | undefined): PayableRow | undefined {
  if (row === undefined) return undefined;
  return {
    payableId: row['payable_id'] as string,
    hotelId: row['hotel_id'] as string,
    bookingId: row['booking_id'] as string,
    contractId: row['contract_id'] as string,
    contractVersion: Number(row['contract_version']),
    commissionRateBps: Number(row['commission_rate_bps']),
    grossPaidMnt: big(row['gross_paid_mnt']),
    refundedMnt: big(row['refunded_mnt']),
    retainedMnt: big(row['retained_mnt']),
    commissionMnt: big(row['commission_mnt']),
    hotelPayableMnt: big(row['hotel_payable_mnt']),
    providerFeeMnt: big(row['provider_fee_mnt']),
    paidOutMnt: big(row['paid_out_mnt']),
    payoutState: row['payout_state'] as PayoutState,
    eligibleAt: (row['eligible_at'] as Date | null) ?? null,
    eligibleLocalDate: (row['eligible_local_date'] as string | null) ?? null,
    holdReason: (row['hold_reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapRefund(row: Record<string, unknown> | undefined): RefundRow | undefined {
  if (row === undefined) return undefined;
  return {
    refundId: row['refund_id'] as string,
    hotelId: row['hotel_id'] as string,
    bookingId: row['booking_id'] as string,
    payableId: (row['payable_id'] as string | null) ?? null,
    reason: row['reason'] as RefundReason,
    amountMnt: big(row['amount_mnt']),
    state: row['state'] as RefundState,
    provider: row['provider'] as 'QPAY' | 'KHAAN',
    providerPaymentId: (row['provider_payment_id'] as string | null) ?? null,
    providerRefundId: (row['provider_refund_id'] as string | null) ?? null,
    sourceRef: row['source_ref'] as string,
    revision: Number(row['revision']),
  };
}

function mapBatch(row: Record<string, unknown> | undefined): BatchRow | undefined {
  if (row === undefined) return undefined;
  return {
    batchId: row['batch_id'] as string,
    hotelId: row['hotel_id'] as string,
    batchLocalDate: row['batch_local_date'] as string,
    attemptNo: Number(row['attempt_no']),
    scheduledAt: row['scheduled_at'] as Date,
    state: row['state'] as BatchRow['state'],
    grossPaidMnt: big(row['gross_paid_mnt']),
    refundedMnt: big(row['refunded_mnt']),
    retainedMnt: big(row['retained_mnt']),
    commissionMnt: big(row['commission_mnt']),
    adjustmentMnt: big(row['adjustment_mnt']),
    hotelPayableMnt: big(row['hotel_payable_mnt']),
    bankReference: (row['bank_reference'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class SettlementRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ----------------------------------------------------------------- contract

  /**
   * `PAY-DEC-001`: the hotel's one valid contract, or nothing.
   *
   * Nothing is the answer that refuses the payment. There is deliberately no
   * "or the default rate" branch anywhere below it.
   */
  async activeContract(at: Date): Promise<ContractRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONTRACT_COLUMNS}
         FROM platform.hotel_commission_contract
        WHERE state = 'ACTIVE'
          AND effective_from <= $1::timestamptz
          AND (effective_to IS NULL OR effective_to > $1::timestamptz)`,
      [at],
    );
    return mapContract(result.rows[0]);
  }

  // ------------------------------------------------------------------ payable

  async createPayable(input: {
    hotelId: string;
    bookingId: string;
    contractId: string;
    contractVersion: number;
    commissionRateBps: number;
    grossPaidMnt: bigint;
    retainedMnt: bigint;
    commissionMnt: bigint;
    hotelPayableMnt: bigint;
    providerFeeMnt: bigint;
  }): Promise<PayableRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.booking_payable
         (hotel_id, booking_id, contract_id, contract_version, commission_rate_bps,
          gross_paid_mnt, retained_mnt, commission_mnt, hotel_payable_mnt, provider_fee_mnt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7::bigint, $8::bigint,
               $9::bigint, $10::bigint)
       ON CONFLICT (booking_id) DO NOTHING
       RETURNING ${PAYABLE_COLUMNS}`,
      [
        input.hotelId,
        input.bookingId,
        input.contractId,
        input.contractVersion,
        input.commissionRateBps,
        input.grossPaidMnt.toString(),
        input.retainedMnt.toString(),
        input.commissionMnt.toString(),
        input.hotelPayableMnt.toString(),
        input.providerFeeMnt.toString(),
      ],
    );
    const inserted = mapPayable(result.rows[0]);
    if (inserted !== undefined) return inserted;
    // A retry of the same confirmation: the payable is already there, and one
    // booking has exactly one (`PAY-DEC-006`).
    const existing = await this.payableForBooking(input.bookingId);
    if (existing === undefined) throw new Error('the payable insert returned no row');
    return existing;
  }

  async payableForBooking(bookingId: string): Promise<PayableRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PAYABLE_COLUMNS} FROM platform.booking_payable WHERE booking_id = $1`,
      [bookingId],
    );
    return mapPayable(result.rows[0]);
  }

  /** The row every money-changing command on a payable takes first. */
  async lockPayable(payableId: string): Promise<PayableRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PAYABLE_COLUMNS} FROM platform.booking_payable
        WHERE payable_id = $1 FOR UPDATE`,
      [payableId],
    );
    return mapPayable(result.rows[0]);
  }

  async lockPayableForBooking(bookingId: string): Promise<PayableRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PAYABLE_COLUMNS} FROM platform.booking_payable
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    return mapPayable(result.rows[0]);
  }

  /** Compare-and-set on `revision`. `false` means somebody else moved it first. */
  async updatePayable(input: {
    payableId: string;
    expectedRevision: number;
    refundedMnt?: bigint;
    retainedMnt?: bigint;
    commissionMnt?: bigint;
    hotelPayableMnt?: bigint;
    providerFeeMnt?: bigint;
    paidOutMnt?: bigint;
    payoutState?: PayoutState;
    eligibleAt?: Date;
    eligibleLocalDate?: string;
    holdReason?: string | null;
  }): Promise<boolean> {
    const sets: string[] = ['revision = revision + 1'];
    const values: unknown[] = [input.payableId, input.expectedRevision];
    const add = (fragment: string, value: unknown): void => {
      values.push(value);
      sets.push(`${fragment} = $${String(values.length)}`);
    };
    if (input.refundedMnt !== undefined) add('refunded_mnt', input.refundedMnt.toString());
    if (input.retainedMnt !== undefined) add('retained_mnt', input.retainedMnt.toString());
    if (input.commissionMnt !== undefined) add('commission_mnt', input.commissionMnt.toString());
    if (input.hotelPayableMnt !== undefined) {
      add('hotel_payable_mnt', input.hotelPayableMnt.toString());
    }
    if (input.providerFeeMnt !== undefined)
      add('provider_fee_mnt', input.providerFeeMnt.toString());
    if (input.paidOutMnt !== undefined) add('paid_out_mnt', input.paidOutMnt.toString());
    if (input.payoutState !== undefined) add('payout_state', input.payoutState);
    if (input.eligibleAt !== undefined) add('eligible_at', input.eligibleAt);
    if (input.eligibleLocalDate !== undefined) add('eligible_local_date', input.eligibleLocalDate);
    if (input.holdReason !== undefined) add('hold_reason', input.holdReason);
    const result = await this.uow.query(
      `UPDATE platform.booking_payable SET ${sets.join(', ')}
        WHERE payable_id = $1 AND revision = $2`,
      values,
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ------------------------------------------------------------------- ledger

  /**
   * doc 11 §9: one event per money movement, and one row per cause.
   *
   * `ON CONFLICT DO NOTHING` on `(event_type, source_ref)` is what makes a
   * repeated delivery a no-op rather than a second entry. The return says
   * whether this call is the one that posted it.
   */
  async post(input: {
    hotelId: string;
    bookingId: string;
    payableId: string | null;
    eventType: LedgerEventType;
    amountMnt: bigint;
    sourceRef: string;
    provider?: 'QPAY' | 'KHAAN';
    providerPaymentId?: string;
    providerRefundId?: string;
    bankReference?: string;
    occurredAt?: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `INSERT INTO platform.booking_ledger_event
         (hotel_id, booking_id, payable_id, event_type, amount_mnt, source_ref,
          provider, provider_payment_id, provider_refund_id, bank_reference, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::text, $8::text, $9::text,
               $10::text, coalesce($11::timestamptz, now()))
       ON CONFLICT (event_type, source_ref) DO NOTHING`,
      [
        input.hotelId,
        input.bookingId,
        input.payableId,
        input.eventType,
        input.amountMnt.toString(),
        input.sourceRef,
        input.provider ?? null,
        input.providerPaymentId ?? null,
        input.providerRefundId ?? null,
        input.bankReference ?? null,
        input.occurredAt ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * The provider and payment id of the capture this booking was paid by.
   *
   * Read from the ledger rather than carried through the booking module: the
   * refund a cancellation owes goes back to the transaction that took the
   * money, and the ledger is where that transaction is recorded.
   */
  async capturedPayment(
    bookingId: string,
  ): Promise<{ provider: 'QPAY' | 'KHAAN'; providerPaymentId: string } | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT provider, provider_payment_id FROM platform.booking_ledger_event
        WHERE booking_id = $1 AND event_type = 'PAYMENT' AND provider_payment_id IS NOT NULL
        ORDER BY occurred_at LIMIT 1`,
      [bookingId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      provider: row['provider'] as 'QPAY' | 'KHAAN',
      providerPaymentId: row['provider_payment_id'] as string,
    };
  }

  async ledgerFor(
    bookingId: string,
  ): Promise<readonly { eventType: LedgerEventType; amountMnt: bigint; sourceRef: string }[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT event_type, amount_mnt, source_ref FROM platform.booking_ledger_event
        WHERE booking_id = $1 ORDER BY occurred_at, event_type`,
      [bookingId],
    );
    return result.rows.map((row) => ({
      eventType: row['event_type'] as LedgerEventType,
      amountMnt: big(row['amount_mnt']),
      sourceRef: row['source_ref'] as string,
    }));
  }

  // ------------------------------------------------------------------ refunds

  /** Raises the obligation, or returns the one this cause already raised. */
  async createRefund(input: {
    hotelId: string;
    bookingId: string;
    payableId: string | null;
    reason: RefundReason;
    amountMnt: bigint;
    provider: 'QPAY' | 'KHAAN';
    providerPaymentId: string | null;
    sourceRef: string;
  }): Promise<{ refund: RefundRow; created: boolean }> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.booking_refund
         (hotel_id, booking_id, payable_id, reason, amount_mnt, provider, provider_payment_id,
          source_ref)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::text, $8)
       ON CONFLICT (booking_id, source_ref) DO NOTHING
       RETURNING ${REFUND_COLUMNS}`,
      [
        input.hotelId,
        input.bookingId,
        input.payableId,
        input.reason,
        input.amountMnt.toString(),
        input.provider,
        input.providerPaymentId,
        input.sourceRef,
      ],
    );
    const created = mapRefund(result.rows[0]);
    if (created !== undefined) return { refund: created, created: true };
    const existing = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.booking_refund
        WHERE booking_id = $1 AND source_ref = $2`,
      [input.bookingId, input.sourceRef],
    );
    const found = mapRefund(existing.rows[0]);
    if (found === undefined) throw new Error('the refund insert returned no row');
    return { refund: found, created: false };
  }

  async lockRefund(refundId: string): Promise<RefundRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.booking_refund
        WHERE refund_id = $1 FOR UPDATE`,
      [refundId],
    );
    return mapRefund(result.rows[0]);
  }

  async refundsFor(bookingId: string): Promise<readonly RefundRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.booking_refund
        WHERE booking_id = $1 ORDER BY requested_at`,
      [bookingId],
    );
    return result.rows
      .map((row) => mapRefund(row))
      .filter((row): row is RefundRow => row !== undefined);
  }

  async settleRefund(input: {
    refundId: string;
    expectedRevision: number;
    state: RefundState;
    providerRefundId?: string;
    failureCode?: string;
    settledAt?: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.booking_refund
          SET state = $3,
              provider_refund_id = coalesce($4::text, provider_refund_id),
              failure_code = $5::text,
              settled_at = $6::timestamptz,
              revision = revision + 1
        WHERE refund_id = $1 AND revision = $2`,
      [
        input.refundId,
        input.expectedRevision,
        input.state,
        input.providerRefundId ?? null,
        input.failureCode ?? null,
        input.settledAt ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Whether anything about this booking's money is still open (doc 11 §8). */
  async hasOpenRefund(bookingId: string): Promise<boolean> {
    const result = await this.uow.query<{ open: string }>(
      `SELECT count(*)::text AS open FROM platform.booking_refund
        WHERE booking_id = $1 AND state IN ('REQUIRED', 'PENDING')`,
      [bookingId],
    );
    return Number(result.rows[0]?.open ?? '0') > 0;
  }

  // ------------------------------------------------------------------ payouts

  /**
   * The payables a batch for this hotel-local day would carry, locked in a
   * fixed order so two batch runs serialize instead of deadlocking.
   */
  async lockDuePayables(batchLocalDate: string): Promise<readonly PayableRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PAYABLE_COLUMNS} FROM platform.booking_payable
        WHERE payout_state IN ('ELIGIBLE', 'ADJUSTMENT_DUE')
          AND eligible_local_date IS NOT NULL
          AND (eligible_local_date + 1) <= $1::date
        ORDER BY payable_id
          FOR UPDATE`,
      [batchLocalDate],
    );
    return result.rows
      .map((row) => mapPayable(row))
      .filter((row): row is PayableRow => row !== undefined);
  }

  async openBatch(input: {
    hotelId: string;
    batchLocalDate: string;
    attemptNo: number;
    scheduledAt: Date;
  }): Promise<BatchRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.payout_batch (hotel_id, batch_local_date, attempt_no, scheduled_at)
       VALUES ($1::uuid, $2::date, $3, $4::timestamptz)
       RETURNING ${BATCH_COLUMNS}`,
      [input.hotelId, input.batchLocalDate, input.attemptNo, input.scheduledAt],
    );
    const row = mapBatch(result.rows[0]);
    if (row === undefined) throw new Error('the batch insert returned no row');
    return row;
  }

  /** The next attempt number for a hotel's batch day: a retry never overwrites. */
  async nextAttemptNo(hotelId: string, batchLocalDate: string): Promise<number> {
    const result = await this.uow.query<{ next: string }>(
      `SELECT coalesce(max(attempt_no), 0)::text AS next FROM platform.payout_batch
        WHERE hotel_id = $1 AND batch_local_date = $2::date`,
      [hotelId, batchLocalDate],
    );
    return Number(result.rows[0]?.next ?? '0') + 1;
  }

  async unsettledBatch(hotelId: string, batchLocalDate: string): Promise<BatchRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BATCH_COLUMNS} FROM platform.payout_batch
        WHERE hotel_id = $1 AND batch_local_date = $2::date AND state IN ('OPEN', 'SUBMITTED')
        ORDER BY attempt_no DESC LIMIT 1`,
      [hotelId, batchLocalDate],
    );
    return mapBatch(result.rows[0]);
  }

  async batchById(batchId: string): Promise<BatchRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BATCH_COLUMNS} FROM platform.payout_batch WHERE batch_id = $1`,
      [batchId],
    );
    return mapBatch(result.rows[0]);
  }

  async lockBatch(batchId: string): Promise<BatchRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${BATCH_COLUMNS} FROM platform.payout_batch WHERE batch_id = $1 FOR UPDATE`,
      [batchId],
    );
    return mapBatch(result.rows[0]);
  }

  async addItem(input: {
    hotelId: string;
    batchId: string;
    payableId: string;
    kind: 'PAYABLE' | 'ADJUSTMENT';
    amountMnt: bigint;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.payout_batch_item (hotel_id, batch_id, payable_id, kind, amount_mnt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint)`,
      [input.hotelId, input.batchId, input.payableId, input.kind, input.amountMnt.toString()],
    );
  }

  async itemsOf(
    batchId: string,
  ): Promise<readonly { payableId: string; kind: string; amountMnt: bigint }[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT payable_id, kind, amount_mnt FROM platform.payout_batch_item
        WHERE batch_id = $1 ORDER BY payable_id`,
      [batchId],
    );
    return result.rows.map((row) => ({
      payableId: row['payable_id'] as string,
      kind: row['kind'] as string,
      amountMnt: big(row['amount_mnt']),
    }));
  }

  async totalBatch(input: {
    batchId: string;
    expectedRevision: number;
    grossPaidMnt: bigint;
    refundedMnt: bigint;
    retainedMnt: bigint;
    commissionMnt: bigint;
    adjustmentMnt: bigint;
    hotelPayableMnt: bigint;
    state: 'SUBMITTED';
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.payout_batch
          SET gross_paid_mnt = $3::bigint, refunded_mnt = $4::bigint, retained_mnt = $5::bigint,
              commission_mnt = $6::bigint, adjustment_mnt = $7::bigint,
              hotel_payable_mnt = $8::bigint, state = $9, revision = revision + 1
        WHERE batch_id = $1 AND revision = $2 AND state = 'OPEN'`,
      [
        input.batchId,
        input.expectedRevision,
        input.grossPaidMnt.toString(),
        input.refundedMnt.toString(),
        input.retainedMnt.toString(),
        input.commissionMnt.toString(),
        input.adjustmentMnt.toString(),
        input.hotelPayableMnt.toString(),
        input.state,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async settleBatch(input: {
    batchId: string;
    expectedRevision: number;
    state: 'PAID' | 'FAILED';
    bankReference?: string;
    failureCode?: string;
    settledAt: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.payout_batch
          SET state = $3, bank_reference = $4::text, failure_code = $5::text,
              settled_at = $6::timestamptz, revision = revision + 1
        WHERE batch_id = $1 AND revision = $2 AND state = 'SUBMITTED'`,
      [
        input.batchId,
        input.expectedRevision,
        input.state,
        input.bankReference ?? null,
        input.failureCode ?? null,
        input.settledAt,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Marks a paid batch's lines settled.
   *
   * The partial unique index on settled `PAYABLE` lines is doc 11 §8's "one
   * booking payable enters exactly one successful payout", so a second batch
   * that carried the same payable is refused here by the database.
   */
  async settleItems(batchId: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.payout_batch_item SET settled = true WHERE batch_id = $1`,
      [batchId],
    );
  }
}
