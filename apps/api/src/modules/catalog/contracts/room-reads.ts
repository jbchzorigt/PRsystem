import type { UnitOfWork } from '@prsystem/db';

/**
 * The catalog's room, as another module may read it (CLAUDE.md §3).
 *
 * A share lock, so a lifecycle transition on the room — which takes the row
 * `FOR UPDATE` — waits for the caller's transaction and the caller's decision
 * is made on a room that cannot retire under it (doc 26 §11).
 */
export interface RoomState {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly categoryId: string;
  readonly state: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
}

export async function shareRoom(uow: UnitOfWork, roomId: string): Promise<RoomState | undefined> {
  const result = await uow.query<Record<string, unknown>>(
    `SELECT room_id, room_number, category_id, state FROM platform.room
      WHERE hotel_id = $1 AND room_id = $2 FOR SHARE`,
    [uow.context.hotelId, roomId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    roomId: row['room_id'] as string,
    roomNumber: row['room_number'] as string,
    categoryId: row['category_id'] as string,
    state: row['state'] as RoomState['state'],
  };
}

export async function readRoom(uow: UnitOfWork, roomId: string): Promise<RoomState | undefined> {
  const result = await uow.query<Record<string, unknown>>(
    `SELECT room_id, room_number, category_id, state FROM platform.room
      WHERE hotel_id = $1 AND room_id = $2`,
    [uow.context.hotelId, roomId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    roomId: row['room_id'] as string,
    roomNumber: row['room_number'] as string,
    categoryId: row['category_id'] as string,
    state: row['state'] as RoomState['state'],
  };
}
