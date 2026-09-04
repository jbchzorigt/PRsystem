import type { UnitOfWork } from '@prsystem/db';

/**
 * The Reception shift: the bound a check-in reads (doc 05 §19.1) and the unit
 * of cash accountability of doc 03 §§4–6.
 *
 * Two states live on the row and are never collapsed: the operational one — is
 * the Reception still working, counting, handing over — and the financial
 * review the close needs (`SHIFT-DEC-001`). The amount counted at the opening
 * is written with the row and never rewritten; a later disagreement is a
 * correction in the shift it happened in (`SHIFT-DEC-006`).
 */

export type ShiftState =
  | 'OPEN'
  | 'CLOSING'
  | 'HANDED_OVER'
  | 'RECOUNT_REQUIRED'
  | 'CASH_ACCEPTED'
  | 'SELF_CLOSED'
  | 'CLOSED';

export type ShiftReviewState =
  'NOT_REQUIRED' | 'PENDING_MANAGER' | 'PENDING_HOTEL_ADMIN' | 'DISPUTED' | 'RESOLVED';

export interface ShiftRow {
  readonly shiftId: string;
  readonly state: ShiftState;
  readonly openedByAccountId: string;
  readonly openedAt: Date;
  readonly closedByAccountId: string | null;
  readonly closedAt: Date | null;
  readonly locationId: string | null;
  readonly openingBalanceMnt: bigint | null;
  readonly expectedCashMnt: bigint | null;
  readonly countedCashMnt: bigint | null;
  readonly varianceMnt: bigint | null;
  readonly incomingCountedMnt: bigint | null;
  readonly handedToAccountId: string | null;
  readonly reviewState: ShiftReviewState;
  readonly reviewedByAccountId: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewReason: string | null;
  readonly selfReviewed: boolean;
  readonly closeReason: string | null;
  readonly revision: number;
}

const COLUMNS = `shift_id, state, opened_by_account_id, opened_at, closed_by_account_id, closed_at,
  location_id, opening_balance_mnt, expected_cash_mnt, counted_cash_mnt, variance_mnt,
  incoming_counted_mnt, handed_to_account_id, review_state, reviewed_by_account_id, reviewed_at,
  review_reason, self_reviewed, close_reason, revision`;

const ACTIVE = `state <> ALL (ARRAY['SELF_CLOSED', 'CLOSED'])`;

const bigOrNull = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : BigInt(value as string);

function mapShift(row: Record<string, unknown> | undefined): ShiftRow | undefined {
  if (row === undefined) return undefined;
  return {
    shiftId: row['shift_id'] as string,
    state: row['state'] as ShiftState,
    openedByAccountId: row['opened_by_account_id'] as string,
    openedAt: row['opened_at'] as Date,
    closedByAccountId: (row['closed_by_account_id'] as string | null) ?? null,
    closedAt: (row['closed_at'] as Date | null) ?? null,
    locationId: (row['location_id'] as string | null) ?? null,
    openingBalanceMnt: bigOrNull(row['opening_balance_mnt']),
    expectedCashMnt: bigOrNull(row['expected_cash_mnt']),
    countedCashMnt: bigOrNull(row['counted_cash_mnt']),
    varianceMnt: bigOrNull(row['variance_mnt']),
    incomingCountedMnt: bigOrNull(row['incoming_counted_mnt']),
    handedToAccountId: (row['handed_to_account_id'] as string | null) ?? null,
    reviewState: row['review_state'] as ShiftReviewState,
    reviewedByAccountId: (row['reviewed_by_account_id'] as string | null) ?? null,
    reviewedAt: (row['reviewed_at'] as Date | null) ?? null,
    reviewReason: (row['review_reason'] as string | null) ?? null,
    selfReviewed: row['self_reviewed'] === true,
    closeReason: (row['close_reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class ShiftRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async open(input: {
    openedByAccountId: string;
    at: Date;
    locationId: string | null;
    openingBalanceMnt: bigint | null;
  }): Promise<ShiftRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.reception_shift
         (hotel_id, opened_by_account_id, opened_at, location_id, opening_balance_mnt)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.openedByAccountId,
        input.at,
        input.locationId,
        input.openingBalanceMnt?.toString() ?? null,
      ],
    );
    const row = mapShift(result.rows[0]);
    if (row === undefined) throw new Error('the shift insert returned no row');
    return row;
  }

  /** The hotel's open shift, share-locked so a close waits for the check-in that reads it. */
  async shareOpen(): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.reception_shift
        WHERE hotel_id = $1 AND state = 'OPEN' FOR SHARE`,
      [this.hotelId],
    );
    return mapShift(result.rows[0]);
  }

  async currentOpen(): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.reception_shift WHERE hotel_id = $1 AND state = 'OPEN'`,
      [this.hotelId],
    );
    return mapShift(result.rows[0]);
  }

  /** Every shift on the drawer that has not finished, newest first. */
  async activeOnDrawer(locationId: string): Promise<readonly ShiftRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.reception_shift
        WHERE hotel_id = $1 AND location_id = $2 AND ${ACTIVE}
        ORDER BY opened_at DESC`,
      [this.hotelId, locationId],
    );
    return result.rows.map((row) => mapShift(row) as ShiftRow);
  }

  /**
   * `SHIFT-DEC-005`: whether a later shift has already started on the drawer —
   * the fact that turns a rejection into a dispute instead of a recount.
   */
  async laterShiftStarted(locationId: string, after: Date): Promise<boolean> {
    const result = await this.uow.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM platform.reception_shift
         WHERE hotel_id = $1 AND location_id = $2 AND opened_at > $3) AS present`,
      [this.hotelId, locationId, after],
    );
    return result.rows[0]?.present === true;
  }

  async byId(shiftId: string): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.reception_shift WHERE hotel_id = $1 AND shift_id = $2`,
      [this.hotelId, shiftId],
    );
    return mapShift(result.rows[0]);
  }

  async lock(shiftId: string): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.reception_shift
        WHERE hotel_id = $1 AND shift_id = $2 FOR UPDATE`,
      [this.hotelId, shiftId],
    );
    return mapShift(result.rows[0]);
  }

  /**
   * One guarded transition. Every lifecycle write goes through here so the CAS
   * on `revision`, the expected prior state and the columns that move together
   * are stated once; the database's own guard refuses anything this misses.
   */
  async transition(input: {
    shiftId: string;
    expectedRevision: number;
    from: readonly ShiftState[];
    to: ShiftState;
    expectedCashMnt?: bigint;
    countedCashMnt?: bigint;
    varianceMnt?: bigint;
    incomingCountedMnt?: bigint;
    handedToAccountId?: string;
    reviewState?: ShiftReviewState;
    reviewedByAccountId?: string;
    reviewedAt?: Date;
    reviewReason?: string;
    selfReviewed?: boolean;
    closeReason?: string;
    closedByAccountId?: string;
    closedAt?: Date;
  }): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.reception_shift
          SET state = $5::text,
              expected_cash_mnt = COALESCE($6::bigint, expected_cash_mnt),
              counted_cash_mnt = COALESCE($7::bigint, counted_cash_mnt),
              variance_mnt = COALESCE($8::bigint, variance_mnt),
              incoming_counted_mnt = COALESCE($9::bigint, incoming_counted_mnt),
              handed_to_account_id = COALESCE($10::uuid, handed_to_account_id),
              review_state = COALESCE($11::text, review_state),
              reviewed_by_account_id = COALESCE($12::uuid, reviewed_by_account_id),
              reviewed_at = COALESCE($13::timestamptz, reviewed_at),
              review_reason = COALESCE($14::text, review_reason),
              self_reviewed = COALESCE($15::boolean, self_reviewed),
              close_reason = COALESCE($16::text, close_reason),
              closed_by_account_id = COALESCE($17::uuid, closed_by_account_id),
              closed_at = COALESCE($18::timestamptz, closed_at),
              revision = revision + 1
        WHERE hotel_id = $1 AND shift_id = $2 AND revision = $3 AND state = ANY ($4)
        RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.shiftId,
        input.expectedRevision,
        input.from,
        input.to,
        input.expectedCashMnt?.toString() ?? null,
        input.countedCashMnt?.toString() ?? null,
        input.varianceMnt?.toString() ?? null,
        input.incomingCountedMnt?.toString() ?? null,
        input.handedToAccountId ?? null,
        input.reviewState ?? null,
        input.reviewedByAccountId ?? null,
        input.reviewedAt ?? null,
        input.reviewReason ?? null,
        input.selfReviewed ?? null,
        input.closeReason ?? null,
        input.closedByAccountId ?? null,
        input.closedAt ?? null,
      ],
    );
    return mapShift(result.rows[0]);
  }
}
