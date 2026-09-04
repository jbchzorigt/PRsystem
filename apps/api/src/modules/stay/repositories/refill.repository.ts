import type { UnitOfWork } from '@prsystem/db';

/**
 * The active-stay refill task (doc 04 §5.1, doc 25 §6.1): a request that is not
 * a movement, and the Cleaner's confirmation that is.
 */

export type RefillTaskState = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'IMPOSSIBLE';

export interface RefillTaskRow {
  readonly taskId: string;
  readonly roomId: string;
  readonly stayId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly confirmedQuantity: number | null;
  readonly state: RefillTaskState;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly cleanerAccountId: string | null;
  readonly claimedAt: Date | null;
  readonly completedAt: Date | null;
  readonly reason: string | null;
  readonly movementId: string | null;
  readonly revision: number;
}

const COLUMNS = `task_id, room_id, stay_id, product_id, requested_quantity, confirmed_quantity,
  state, requested_by_account_id, requested_at, cleaner_account_id, claimed_at, completed_at,
  reason, movement_id, revision`;

function map(row: Record<string, unknown> | undefined): RefillTaskRow | undefined {
  if (row === undefined) return undefined;
  return {
    taskId: row['task_id'] as string,
    roomId: row['room_id'] as string,
    stayId: row['stay_id'] as string,
    productId: row['product_id'] as string,
    requestedQuantity: Number(row['requested_quantity']),
    confirmedQuantity:
      row['confirmed_quantity'] === null ? null : Number(row['confirmed_quantity']),
    state: row['state'] as RefillTaskState,
    requestedByAccountId: row['requested_by_account_id'] as string,
    requestedAt: row['requested_at'] as Date,
    cleanerAccountId: (row['cleaner_account_id'] as string | null) ?? null,
    claimedAt: (row['claimed_at'] as Date | null) ?? null,
    completedAt: (row['completed_at'] as Date | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    movementId: (row['movement_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class RefillRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async create(input: {
    roomId: string;
    stayId: string;
    productId: string;
    requestedQuantity: number;
    requestedByAccountId: string;
    requestedAt: Date;
  }): Promise<RefillTaskRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_refill_task
         (hotel_id, room_id, stay_id, product_id, requested_quantity, requested_by_account_id,
          requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.roomId,
        input.stayId,
        input.productId,
        input.requestedQuantity,
        input.requestedByAccountId,
        input.requestedAt,
      ],
    );
    return map(result.rows[0]) as RefillTaskRow;
  }

  async byId(taskId: string): Promise<RefillTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.minibar_refill_task
        WHERE hotel_id = $1 AND task_id = $2`,
      [this.hotelId, taskId],
    );
    return map(result.rows[0]);
  }

  async lock(taskId: string): Promise<RefillTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.minibar_refill_task
        WHERE hotel_id = $1 AND task_id = $2 FOR UPDATE`,
      [this.hotelId, taskId],
    );
    return map(result.rows[0]);
  }

  /** The open tasks of a stay: what refuses the start of its checkout. */
  async openOfStay(stayId: string): Promise<readonly RefillTaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.minibar_refill_task
        WHERE hotel_id = $1 AND stay_id = $2 AND state IN ('PENDING', 'IN_PROGRESS')
        ORDER BY requested_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => map(row) as RefillTaskRow);
  }

  /** What confirmed refills added to the room during the stay, per product. */
  async confirmedOfStay(stayId: string): Promise<readonly RefillTaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.minibar_refill_task
        WHERE hotel_id = $1 AND stay_id = $2 AND state = 'COMPLETED'
        ORDER BY completed_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => map(row) as RefillTaskRow);
  }

  async queue(): Promise<readonly RefillTaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.minibar_refill_task
        WHERE hotel_id = $1 AND state IN ('PENDING', 'IN_PROGRESS')
        ORDER BY requested_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => map(row) as RefillTaskRow);
  }

  async claim(input: {
    taskId: string;
    expectedRevision: number;
    accountId: string;
    at: Date;
  }): Promise<RefillTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_refill_task
          SET state = 'IN_PROGRESS', cleaner_account_id = $4, claimed_at = $5,
              revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3 AND state = 'PENDING'
        RETURNING ${COLUMNS}`,
      [this.hotelId, input.taskId, input.expectedRevision, input.accountId, input.at],
    );
    return map(result.rows[0]);
  }

  async complete(input: {
    taskId: string;
    expectedRevision: number;
    confirmedQuantity: number;
    movementId: string;
    completedAt: Date;
  }): Promise<RefillTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_refill_task
          SET state = 'COMPLETED', confirmed_quantity = $4, movement_id = $5, completed_at = $6,
              revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3
        RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.taskId,
        input.expectedRevision,
        input.confirmedQuantity,
        input.movementId,
        input.completedAt,
      ],
    );
    return map(result.rows[0]);
  }

  async abandon(input: {
    taskId: string;
    expectedRevision: number;
    toState: 'CANCELLED' | 'IMPOSSIBLE';
    reason: string;
  }): Promise<RefillTaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_refill_task
          SET state = $4, reason = $5, revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3
        RETURNING ${COLUMNS}`,
      [this.hotelId, input.taskId, input.expectedRevision, input.toState, input.reason],
    );
    return map(result.rows[0]);
  }
}
