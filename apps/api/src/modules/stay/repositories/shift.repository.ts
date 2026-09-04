import type { UnitOfWork } from '@prsystem/db';

/**
 * The operational Reception shift (doc 05 §19.1; doc 03 for what Phase 11
 * adds). One open shift per hotel, held by a partial unique index.
 */

export interface ShiftRow {
  readonly shiftId: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly openedByAccountId: string;
  readonly openedAt: Date;
  readonly closedByAccountId: string | null;
  readonly closedAt: Date | null;
  readonly revision: number;
}

const COLUMNS = `shift_id, state, opened_by_account_id, opened_at, closed_by_account_id, closed_at, revision`;

function mapShift(row: Record<string, unknown> | undefined): ShiftRow | undefined {
  if (row === undefined) return undefined;
  return {
    shiftId: row['shift_id'] as string,
    state: row['state'] as ShiftRow['state'],
    openedByAccountId: row['opened_by_account_id'] as string,
    openedAt: row['opened_at'] as Date,
    closedByAccountId: (row['closed_by_account_id'] as string | null) ?? null,
    closedAt: (row['closed_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class ShiftRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async open(openedByAccountId: string, at: Date): Promise<ShiftRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.reception_shift (hotel_id, opened_by_account_id, opened_at)
       VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [this.hotelId, openedByAccountId, at],
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

  async close(
    shiftId: string,
    expectedRevision: number,
    closedByAccountId: string,
    at: Date,
  ): Promise<ShiftRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.reception_shift
          SET state = 'CLOSED', closed_by_account_id = $4, closed_at = $5, revision = revision + 1
        WHERE hotel_id = $1 AND shift_id = $2 AND revision = $3 AND state = 'OPEN'
        RETURNING ${COLUMNS}`,
      [this.hotelId, shiftId, expectedRevision, closedByAccountId, at],
    );
    return mapShift(result.rows[0]);
  }
}
