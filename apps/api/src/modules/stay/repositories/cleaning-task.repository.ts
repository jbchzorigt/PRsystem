import type { UnitOfWork } from '@prsystem/db';

/**
 * The Cleaner's cleaning work queue (doc 04 §3, §8): one open task per room,
 * claimed in one statement so two Cleaners cannot take the same one.
 */

export type CleaningTaskState = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface CleaningTaskRow {
  readonly taskId: string;
  readonly roomId: string;
  readonly stayId: string | null;
  readonly state: CleaningTaskState;
  readonly claimedByAccountId: string | null;
  readonly claimedAt: Date | null;
  readonly completedAt: Date | null;
  readonly reason: string | null;
  readonly openedAt: Date;
  readonly revision: number;
}

const COLUMNS = `task_id, room_id, stay_id, state, claimed_by_account_id, claimed_at,
  completed_at, reason, opened_at, revision`;

function map(row: Record<string, unknown> | undefined): CleaningTaskRow | undefined {
  if (row === undefined) return undefined;
  return {
    taskId: row['task_id'] as string,
    roomId: row['room_id'] as string,
    stayId: (row['stay_id'] as string | null) ?? null,
    state: row['state'] as CleaningTaskState,
    claimedByAccountId: (row['claimed_by_account_id'] as string | null) ?? null,
    claimedAt: (row['claimed_at'] as Date | null) ?? null,
    completedAt: (row['completed_at'] as Date | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    openedAt: row['opened_at'] as Date,
    revision: Number(row['revision']),
  };
}

export class CleaningTaskRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  /**
   * Opens the task the checkout leaves behind, or returns the one already
   * open: a repeated checkout of the same room never queues a second.
   */
  async open(input: {
    roomId: string;
    stayId: string;
    openedAt: Date;
  }): Promise<{ readonly task: CleaningTaskRow; readonly opened: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.cleaning_task (hotel_id, room_id, stay_id, opened_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hotel_id, room_id) WHERE state IN ('PENDING', 'IN_PROGRESS') DO NOTHING
       RETURNING ${COLUMNS}`,
      [this.hotelId, input.roomId, input.stayId, input.openedAt],
    );
    const row = map(inserted.rows[0]);
    if (row !== undefined) return { task: row, opened: true };
    const existing = await this.openOfRoom(input.roomId);
    if (existing === undefined) throw new Error('the cleaning task neither inserted nor exists');
    return { task: existing, opened: false };
  }

  async byId(taskId: string): Promise<CleaningTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.cleaning_task WHERE hotel_id = $1 AND task_id = $2`,
      [this.hotelId, taskId],
    );
    return map(result.rows[0]);
  }

  async lock(taskId: string): Promise<CleaningTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.cleaning_task
        WHERE hotel_id = $1 AND task_id = $2 FOR UPDATE`,
      [this.hotelId, taskId],
    );
    return map(result.rows[0]);
  }

  async openOfRoom(roomId: string): Promise<CleaningTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.cleaning_task
        WHERE hotel_id = $1 AND room_id = $2 AND state IN ('PENDING', 'IN_PROGRESS')`,
      [this.hotelId, roomId],
    );
    return map(result.rows[0]);
  }

  async queue(): Promise<readonly CleaningTaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.cleaning_task
        WHERE hotel_id = $1 AND state IN ('PENDING', 'IN_PROGRESS')
        ORDER BY opened_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => map(row) as CleaningTaskRow);
  }

  /** The claim: one statement, conditional on the row still being unclaimed. */
  async claim(input: {
    taskId: string;
    expectedRevision: number;
    accountId: string;
    at: Date;
  }): Promise<CleaningTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.cleaning_task
          SET state = 'IN_PROGRESS', claimed_by_account_id = $4, claimed_at = $5,
              revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3 AND state = 'PENDING'
        RETURNING ${COLUMNS}`,
      [this.hotelId, input.taskId, input.expectedRevision, input.accountId, input.at],
    );
    return map(result.rows[0]);
  }

  async finish(input: {
    taskId: string;
    expectedRevision: number;
    toState: 'COMPLETED' | 'CANCELLED';
    at: Date;
    reason?: string;
  }): Promise<CleaningTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.cleaning_task
          SET state = $4,
              completed_at = CASE WHEN $4 = 'COMPLETED' THEN $5 ELSE completed_at END,
              reason = COALESCE($6, reason),
              revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3
        RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.taskId,
        input.expectedRevision,
        input.toState,
        input.at,
        input.reason ?? null,
      ],
    );
    return map(result.rows[0]);
  }
}
