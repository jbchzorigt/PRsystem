import type { UnitOfWork } from '@prsystem/db';

/**
 * The overdue conflict of a confirmed booking (doc 05 §23, `STAY-DEC-013`):
 * one open row per booking, opened idempotently, closed by one of four
 * terminal outcomes.
 */

export type ConflictState =
  | 'OPEN'
  | 'RESOLVED_READY'
  | 'RESOLVED_REASSIGNED'
  | 'RESOLVED_HIGHER_CATEGORY'
  | 'CANCELLED_HOTEL';

export interface ConflictRow {
  readonly conflictId: string;
  readonly bookingRef: string;
  readonly categoryId: string;
  readonly roomId: string;
  readonly overdueStayId: string;
  readonly plannedCheckInAt: Date;
  readonly cleaningBufferMinutes: number;
  readonly state: ConflictState;
  readonly assignedRoomId: string | null;
  readonly resolvedByAccountId: string | null;
  readonly resolvedAt: Date | null;
  readonly reason: string | null;
  readonly selfApproved: boolean;
  readonly detectedAt: Date;
  readonly revision: number;
}

const COLUMNS = `conflict_id, booking_ref, category_id, room_id, overdue_stay_id, planned_checkin_at,
  cleaning_buffer_minutes, state, assigned_room_id, resolved_by_account_id, resolved_at, reason,
  self_approved, detected_at, revision`;

function mapConflict(row: Record<string, unknown> | undefined): ConflictRow | undefined {
  if (row === undefined) return undefined;
  return {
    conflictId: row['conflict_id'] as string,
    bookingRef: row['booking_ref'] as string,
    categoryId: row['category_id'] as string,
    roomId: row['room_id'] as string,
    overdueStayId: row['overdue_stay_id'] as string,
    plannedCheckInAt: row['planned_checkin_at'] as Date,
    cleaningBufferMinutes: Number(row['cleaning_buffer_minutes']),
    state: row['state'] as ConflictState,
    assignedRoomId: (row['assigned_room_id'] as string | null) ?? null,
    resolvedByAccountId: (row['resolved_by_account_id'] as string | null) ?? null,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    selfApproved: row['self_approved'] as boolean,
    detectedAt: row['detected_at'] as Date,
    revision: Number(row['revision']),
  };
}

export class ConflictRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  /**
   * Opens the conflict, or returns the one already open for the booking: the
   * partial unique index is the deduplication, so a scheduler, a query and a
   * refresh racing each other open exactly one (doc 05 §23.1).
   */
  async open(input: {
    bookingRef: string;
    categoryId: string;
    roomId: string;
    overdueStayId: string;
    plannedCheckInAt: Date;
    cleaningBufferMinutes: number;
    detectedAt: Date;
  }): Promise<{ readonly conflict: ConflictRow; readonly opened: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.booking_fulfillment_conflict
         (hotel_id, booking_ref, category_id, room_id, overdue_stay_id, planned_checkin_at,
          cleaning_buffer_minutes, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hotel_id, booking_ref) WHERE state = 'OPEN' DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.bookingRef,
        input.categoryId,
        input.roomId,
        input.overdueStayId,
        input.plannedCheckInAt,
        input.cleaningBufferMinutes,
        input.detectedAt,
      ],
    );
    const row = mapConflict(inserted.rows[0]);
    if (row !== undefined) return { conflict: row, opened: true };
    const existing = await this.openByBooking(input.bookingRef);
    if (existing === undefined) throw new Error('the conflict was neither inserted nor found');
    return { conflict: existing, opened: false };
  }

  async openByBooking(bookingRef: string): Promise<ConflictRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND booking_ref = $2 AND state = 'OPEN'`,
      [this.hotelId, bookingRef],
    );
    return mapConflict(result.rows[0]);
  }

  async openForRoom(roomId: string): Promise<readonly ConflictRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND room_id = $2 AND state = 'OPEN' ORDER BY planned_checkin_at`,
      [this.hotelId, roomId],
    );
    return result.rows.map((row) => mapConflict(row) as ConflictRow);
  }

  /**
   * Resolutions that assigned this room to a booking whose start is still
   * ahead: until the booking module applies them, they are the room's
   * commitments as far as this module knows.
   */
  async assignedToRoom(roomId: string, from: Date): Promise<readonly ConflictRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND assigned_room_id = $2
          AND state IN ('RESOLVED_REASSIGNED', 'RESOLVED_HIGHER_CATEGORY')
          AND planned_checkin_at >= $3
        ORDER BY planned_checkin_at`,
      [this.hotelId, roomId, from],
    );
    return result.rows.map((row) => mapConflict(row) as ConflictRow);
  }

  async listOpen(): Promise<readonly ConflictRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND state = 'OPEN' ORDER BY planned_checkin_at, conflict_id`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapConflict(row) as ConflictRow);
  }

  async byId(conflictId: string): Promise<ConflictRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND conflict_id = $2`,
      [this.hotelId, conflictId],
    );
    return mapConflict(result.rows[0]);
  }

  async lock(conflictId: string): Promise<ConflictRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.booking_fulfillment_conflict
        WHERE hotel_id = $1 AND conflict_id = $2 FOR UPDATE`,
      [this.hotelId, conflictId],
    );
    return mapConflict(result.rows[0]);
  }

  async resolve(input: {
    conflictId: string;
    expectedRevision: number;
    state: Exclude<ConflictState, 'OPEN'>;
    assignedRoomId: string | null;
    resolvedByAccountId: string | null;
    resolvedAt: Date;
    reason: string | null;
    selfApproved: boolean;
  }): Promise<ConflictRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.booking_fulfillment_conflict
          SET state = $4, assigned_room_id = $5, resolved_by_account_id = $6, resolved_at = $7,
              reason = $8, self_approved = $9, revision = revision + 1
        WHERE hotel_id = $1 AND conflict_id = $2 AND revision = $3 AND state = 'OPEN'
        RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.conflictId,
        input.expectedRevision,
        input.state,
        input.assignedRoomId,
        input.resolvedByAccountId,
        input.resolvedAt,
        input.reason,
        input.selfApproved,
      ],
    );
    return mapConflict(result.rows[0]);
  }
}
