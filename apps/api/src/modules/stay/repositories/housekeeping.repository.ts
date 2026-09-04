import type { UnitOfWork } from '@prsystem/db';
import type { CleaningState } from '../domain/readiness';

/**
 * The cleaning axis of a room and its append-only history (doc 06 §4, doc 05
 * §19.2). The history is what proves readiness at a past instant.
 */

export interface CleaningStateRow {
  readonly roomId: string;
  readonly state: CleaningState;
  readonly changedAt: Date;
  readonly changedByAccountId: string | null;
  readonly revision: number;
}

export interface CleaningEventRow {
  readonly eventId: string;
  readonly roomId: string;
  readonly fromState: CleaningState | null;
  readonly toState: CleaningState;
  readonly stayId: string | null;
  readonly actorAccountId: string | null;
  readonly occurredAt: Date;
}

const STATE_COLUMNS = `room_id, state, changed_at, changed_by_account_id, revision`;
const EVENT_COLUMNS = `event_id, room_id, from_state, to_state, stay_id, actor_account_id, occurred_at`;

function mapState(row: Record<string, unknown> | undefined): CleaningStateRow | undefined {
  if (row === undefined) return undefined;
  return {
    roomId: row['room_id'] as string,
    state: row['state'] as CleaningState,
    changedAt: row['changed_at'] as Date,
    changedByAccountId: (row['changed_by_account_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapEvent(row: Record<string, unknown>): CleaningEventRow {
  return {
    eventId: row['event_id'] as string,
    roomId: row['room_id'] as string,
    fromState: (row['from_state'] as CleaningState | null) ?? null,
    toState: row['to_state'] as CleaningState,
    stayId: (row['stay_id'] as string | null) ?? null,
    actorAccountId: (row['actor_account_id'] as string | null) ?? null,
    occurredAt: row['occurred_at'] as Date,
  };
}

export class HousekeepingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async state(roomId: string): Promise<CleaningStateRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STATE_COLUMNS} FROM platform.room_cleaning_state WHERE hotel_id = $1 AND room_id = $2`,
      [this.hotelId, roomId],
    );
    return mapState(result.rows[0]);
  }

  async statesOf(roomIds: readonly string[]): Promise<Map<string, CleaningStateRow>> {
    if (roomIds.length === 0) return new Map();
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STATE_COLUMNS} FROM platform.room_cleaning_state
        WHERE hotel_id = $1 AND room_id = ANY($2::uuid[])`,
      [this.hotelId, roomIds],
    );
    return new Map(
      result.rows.map((row) => [row['room_id'] as string, mapState(row) as CleaningStateRow]),
    );
  }

  async lockState(roomId: string): Promise<CleaningStateRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STATE_COLUMNS} FROM platform.room_cleaning_state
        WHERE hotel_id = $1 AND room_id = $2 FOR UPDATE`,
      [this.hotelId, roomId],
    );
    return mapState(result.rows[0]);
  }

  /**
   * Records a transition: the current row is created or advanced and the
   * event appended, both stamped with the same server time so the history
   * and the axis never disagree about when.
   */
  async transition(input: {
    roomId: string;
    from: CleaningState | null;
    to: CleaningState;
    actorAccountId: string | null;
    stayId?: string;
    at: Date;
  }): Promise<CleaningStateRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.room_cleaning_state (room_id, hotel_id, state, changed_at, changed_by_account_id)
       VALUES ($2, $1, $3, $4, $5)
       ON CONFLICT (room_id) DO UPDATE
         SET state = EXCLUDED.state, changed_at = EXCLUDED.changed_at,
             changed_by_account_id = EXCLUDED.changed_by_account_id,
             revision = platform.room_cleaning_state.revision + 1
       RETURNING ${STATE_COLUMNS}`,
      [this.hotelId, input.roomId, input.to, input.at, input.actorAccountId],
    );
    await this.uow.query(
      `INSERT INTO platform.room_cleaning_event
         (hotel_id, room_id, from_state, to_state, stay_id, actor_account_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.hotelId,
        input.roomId,
        input.from,
        input.to,
        input.stayId ?? null,
        input.actorAccountId,
        input.at,
      ],
    );
    const row = mapState(result.rows[0]);
    if (row === undefined) throw new Error('the cleaning state upsert returned no row');
    return row;
  }

  /** The cleaning state in force at `at`, from the history: the last event at or before it. */
  async stateAt(roomId: string, at: Date): Promise<CleaningState | null> {
    const result = await this.uow.query<{ to_state: string }>(
      `SELECT to_state FROM platform.room_cleaning_event
        WHERE hotel_id = $1 AND room_id = $2 AND occurred_at <= $3
        ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
      [this.hotelId, roomId, at],
    );
    return (result.rows[0]?.to_state as CleaningState | undefined) ?? null;
  }

  async history(roomId: string, limit = 50): Promise<readonly CleaningEventRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${EVENT_COLUMNS} FROM platform.room_cleaning_event
        WHERE hotel_id = $1 AND room_id = $2 ORDER BY occurred_at DESC, event_id DESC LIMIT $3`,
      [this.hotelId, roomId, limit],
    );
    return result.rows.map(mapEvent);
  }
}
