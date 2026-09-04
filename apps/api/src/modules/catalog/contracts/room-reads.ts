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

/** The lifecycle state of a category, for a consumer that must refuse a retiring or inactive one. */
export async function readCategoryState(
  uow: UnitOfWork,
  categoryId: string,
): Promise<RoomState['state'] | undefined> {
  const result = await uow.query<{ state: string }>(
    `SELECT state FROM platform.room_category WHERE hotel_id = $1 AND category_id = $2`,
    [uow.context.hotelId, categoryId],
  );
  return result.rows[0]?.state as RoomState['state'] | undefined;
}

/** Every active room of the hotel with its category and number, for a board or an eligibility search. */
export async function listRooms(
  uow: UnitOfWork,
): Promise<readonly (RoomState & { readonly categoryName: string })[]> {
  const result = await uow.query<Record<string, unknown>>(
    `SELECT r.room_id, r.room_number, r.category_id, r.state, c.name AS category_name
       FROM platform.room r JOIN platform.room_category c
         ON c.hotel_id = r.hotel_id AND c.category_id = r.category_id
      WHERE r.hotel_id = $1 ORDER BY r.room_number`,
    [uow.context.hotelId],
  );
  return result.rows.map((row) => ({
    roomId: row['room_id'] as string,
    roomNumber: row['room_number'] as string,
    categoryId: row['category_id'] as string,
    state: row['state'] as RoomState['state'],
    categoryName: row['category_name'] as string,
  }));
}

/**
 * The room taken `FOR UPDATE`, for a consumer that commits the room to
 * something — an assignment — and must serialise against every share-locked
 * reader. Lock order stays room-first, so no consumer holding a later row
 * ever waits for this one.
 */
export async function lockRoom(uow: UnitOfWork, roomId: string): Promise<RoomState | undefined> {
  const result = await uow.query<Record<string, unknown>>(
    `SELECT room_id, room_number, category_id, state FROM platform.room
      WHERE hotel_id = $1 AND room_id = $2 FOR UPDATE`,
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
