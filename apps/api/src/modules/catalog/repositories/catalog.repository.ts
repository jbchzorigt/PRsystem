import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';
import type { EntityKind, EntityState } from '../domain/lifecycle';
import type { SourceLevel, StayType } from '../domain/tariffs';

/**
 * The catalog's tenant-scoped storage.
 *
 * Every statement runs under an established hotel scope, so the tenant policy
 * supplies one predicate and the explicit `hotel_id` here supplies the other
 * (ADR-0017 §4). What this file adds on top is the concurrency discipline the
 * lifecycle needs: entity rows are locked in a **fixed order** — the hotel's
 * configuration row, then the category, then the room — and every mutation is a
 * compare-and-set on the revision it read. Two commands that touch the same
 * entity therefore serialise, and the loser is told rather than silently
 * overwriting the winner.
 */

export interface StayConfigurationRow {
  readonly hotelId: string;
  readonly hourlyRateMnt: bigint | null;
  readonly nightlyRateMnt: bigint | null;
  readonly fixedCheckoutMinute: number | null;
  readonly cleaningBufferMinutes: number | null;
  readonly configVersion: number;
  readonly revision: number;
}

export interface CategoryRow {
  readonly categoryId: string;
  readonly hotelId: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: EntityState;
  readonly hourlyRateMnt: bigint | null;
  readonly nightlyRateMnt: bigint | null;
  readonly cleaningBufferMinutes: number | null;
  readonly retirementRequestedAt: Date | null;
  readonly retirementReason: string | null;
  readonly deactivatedAt: Date | null;
  readonly revision: number;
}

export interface RoomRow {
  readonly roomId: string;
  readonly hotelId: string;
  readonly roomNumber: string;
  readonly floorLabel: string | null;
  readonly categoryId: string;
  readonly state: EntityState;
  readonly hourlyRateMnt: bigint | null;
  readonly nightlyRateMnt: bigint | null;
  readonly retirementRequestedAt: Date | null;
  readonly retirementReason: string | null;
  readonly deactivatedAt: Date | null;
  readonly revision: number;
}

/** The lifecycle shape every catalog entity shares. */
export interface EntityRow {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly name: string;
  readonly state: EntityState;
  readonly retirementRequestedAt: Date | null;
  readonly retirementReason: string | null;
  readonly revision: number;
}

export interface SnapshotRow {
  readonly snapshotId: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly stayType: StayType;
  readonly unitPriceMnt: bigint;
  readonly sourceLevel: SourceLevel;
  readonly sourceEntityId: string;
  readonly pricingConfigVersion: number;
  readonly categoryId: string;
  readonly roomId: string | null;
  readonly cleaningBufferMinutes: number;
  readonly fixedCheckoutMinute: number | null;
}

export interface CatalogEventInput {
  readonly entityType: EntityKind | 'HOTEL_STAY_CONFIGURATION';
  readonly entityId: string;
  readonly eventType:
    | 'CREATED'
    | 'UPDATED'
    | 'TARIFF_SET'
    | 'TARIFF_CLEARED'
    | 'CONFIGURATION_SET'
    | 'RETIREMENT_REQUESTED'
    | 'RETIREMENT_CANCELLED'
    | 'DEACTIVATED'
    | 'REACTIVATED'
    | 'HARD_DELETED';
  readonly fromState?: EntityState;
  readonly toState?: EntityState;
  readonly reason?: string;
  readonly configVersion?: number;
  readonly payload?: Record<string, unknown>;
  readonly actorAccountId?: string;
}

/** Table and key column for each entity kind, in one place. */
const ENTITY_TABLES: Readonly<Record<EntityKind, { table: string; key: string; name: string }>> = {
  // A room has no name: its room number is what an operator knows it by.
  ROOM: { table: 'platform.room', key: 'room_id', name: 'room_number' },
  ROOM_CATEGORY: { table: 'platform.room_category', key: 'category_id', name: 'name' },
  MINIBAR_PRODUCT: { table: 'platform.minibar_product', key: 'product_id', name: 'name' },
  MINIBAR_TEMPLATE: { table: 'platform.minibar_template', key: 'template_id', name: 'name' },
};

export function entityTableOf(kind: EntityKind): { table: string; key: string; name: string } {
  return ENTITY_TABLES[kind];
}

function bigintOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as string);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapConfiguration(
  row: Record<string, unknown> | undefined,
): StayConfigurationRow | undefined {
  if (row === undefined) return undefined;
  return {
    hotelId: row['hotel_id'] as string,
    hourlyRateMnt: bigintOrNull(row['hourly_rate_mnt']),
    nightlyRateMnt: bigintOrNull(row['nightly_rate_mnt']),
    fixedCheckoutMinute: numberOrNull(row['fixed_checkout_minute']),
    cleaningBufferMinutes: numberOrNull(row['cleaning_buffer_minutes']),
    configVersion: Number(row['config_version']),
    revision: Number(row['revision']),
  };
}

function mapCategory(row: Record<string, unknown> | undefined): CategoryRow | undefined {
  if (row === undefined) return undefined;
  return {
    categoryId: row['category_id'] as string,
    hotelId: row['hotel_id'] as string,
    name: row['name'] as string,
    description: (row['description'] ?? null) as string | null,
    state: row['state'] as EntityState,
    hourlyRateMnt: bigintOrNull(row['hourly_rate_mnt']),
    nightlyRateMnt: bigintOrNull(row['nightly_rate_mnt']),
    cleaningBufferMinutes: numberOrNull(row['cleaning_buffer_minutes']),
    retirementRequestedAt: (row['retirement_requested_at'] ?? null) as Date | null,
    retirementReason: (row['retirement_reason'] ?? null) as string | null,
    deactivatedAt: (row['deactivated_at'] ?? null) as Date | null,
    revision: Number(row['revision']),
  };
}

function mapRoom(row: Record<string, unknown> | undefined): RoomRow | undefined {
  if (row === undefined) return undefined;
  return {
    roomId: row['room_id'] as string,
    hotelId: row['hotel_id'] as string,
    roomNumber: row['room_number'] as string,
    floorLabel: (row['floor_label'] ?? null) as string | null,
    categoryId: row['category_id'] as string,
    state: row['state'] as EntityState,
    hourlyRateMnt: bigintOrNull(row['hourly_rate_mnt']),
    nightlyRateMnt: bigintOrNull(row['nightly_rate_mnt']),
    retirementRequestedAt: (row['retirement_requested_at'] ?? null) as Date | null,
    retirementReason: (row['retirement_reason'] ?? null) as string | null,
    deactivatedAt: (row['deactivated_at'] ?? null) as Date | null,
    revision: Number(row['revision']),
  };
}

const CONFIGURATION_COLUMNS = `hotel_id, hourly_rate_mnt, nightly_rate_mnt, fixed_checkout_minute,
  cleaning_buffer_minutes, config_version, revision`;
const CATEGORY_COLUMNS = `category_id, hotel_id, name, description, state, hourly_rate_mnt,
  nightly_rate_mnt, cleaning_buffer_minutes, retirement_requested_at, retirement_reason,
  deactivated_at, revision`;
const ROOM_COLUMNS = `room_id, hotel_id, room_number, floor_label, category_id, state,
  hourly_rate_mnt, nightly_rate_mnt, retirement_requested_at, retirement_reason,
  deactivated_at, revision`;

export class CatalogRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  // ------------------------------------------------------- configuration

  async configuration(): Promise<StayConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIGURATION_COLUMNS} FROM platform.hotel_stay_configuration WHERE hotel_id = $1`,
      [this.hotelId],
    );
    return mapConfiguration(result.rows[0]);
  }

  /**
   * The lock every configuration-changing command takes first.
   *
   * It is also the lock a category or room tariff edit takes, because every such
   * edit advances the hotel's `config_version` — so the configuration row is the
   * one place per hotel where tariff writers serialise, and the version a
   * snapshot stores can never be one two writers both produced.
   */
  async lockConfiguration(): Promise<StayConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIGURATION_COLUMNS} FROM platform.hotel_stay_configuration
        WHERE hotel_id = $1 FOR UPDATE`,
      [this.hotelId],
    );
    return mapConfiguration(result.rows[0]);
  }

  /**
   * The read a rate resolution takes.
   *
   * `FOR SHARE` rather than `FOR UPDATE`: many confirmations may resolve at
   * once and none of them changes the configuration, but every one of them has
   * to wait for a tariff writer that holds the row and be waited for by the
   * next. The version a snapshot records is therefore the version of a
   * configuration that was fully committed when the price was resolved.
   */
  async shareConfiguration(): Promise<StayConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIGURATION_COLUMNS} FROM platform.hotel_stay_configuration
        WHERE hotel_id = $1 FOR SHARE`,
      [this.hotelId],
    );
    return mapConfiguration(result.rows[0]);
  }

  /** Creates the hotel's configuration row if it has none, and locks it either way. */
  async ensureConfiguration(): Promise<StayConfigurationRow> {
    const existing = await this.lockConfiguration();
    if (existing !== undefined) return existing;
    const created = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.hotel_stay_configuration (hotel_id) VALUES ($1)
       ON CONFLICT (hotel_id) DO UPDATE SET revision = platform.hotel_stay_configuration.revision
       RETURNING ${CONFIGURATION_COLUMNS}`,
      [this.hotelId],
    );
    const row = mapConfiguration(created.rows[0]);
    if (row === undefined) throw new Error('the configuration insert returned no row');
    return row;
  }

  /**
   * Writes the hotel-level configuration and advances the version.
   *
   * `undefined` leaves a field alone; `null` clears it back to unset. The two are
   * different requests and the caller has to say which it means.
   */
  async writeConfiguration(input: {
    expectedRevision: number;
    hourlyRateMnt?: bigint | null;
    nightlyRateMnt?: bigint | null;
    fixedCheckoutMinute?: number | null;
    cleaningBufferMinutes?: number | null;
  }): Promise<StayConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.hotel_stay_configuration
          SET hourly_rate_mnt = CASE WHEN $4 THEN $3::bigint ELSE hourly_rate_mnt END,
              nightly_rate_mnt = CASE WHEN $6 THEN $5::bigint ELSE nightly_rate_mnt END,
              fixed_checkout_minute = CASE WHEN $8 THEN $7::integer ELSE fixed_checkout_minute END,
              cleaning_buffer_minutes = CASE WHEN $10 THEN $9::integer ELSE cleaning_buffer_minutes END,
              config_version = config_version + 1,
              updated_at = now(),
              revision = revision + 1
        WHERE hotel_id = $1 AND revision = $2
        RETURNING ${CONFIGURATION_COLUMNS}`,
      [
        this.hotelId,
        input.expectedRevision,
        input.hourlyRateMnt ?? null,
        input.hourlyRateMnt !== undefined,
        input.nightlyRateMnt ?? null,
        input.nightlyRateMnt !== undefined,
        input.fixedCheckoutMinute ?? null,
        input.fixedCheckoutMinute !== undefined,
        input.cleaningBufferMinutes ?? null,
        input.cleaningBufferMinutes !== undefined,
      ],
    );
    return mapConfiguration(result.rows[0]);
  }

  /**
   * Advances the version without changing the hotel's own values.
   *
   * A category or room override is part of the same configuration, so an edit at
   * either level moves the number a snapshot records.
   */
  async advanceConfigVersion(expectedRevision: number): Promise<StayConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.hotel_stay_configuration
          SET config_version = config_version + 1, updated_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND revision = $2
        RETURNING ${CONFIGURATION_COLUMNS}`,
      [this.hotelId, expectedRevision],
    );
    return mapConfiguration(result.rows[0]);
  }

  // ------------------------------------------------------------ categories

  async categoryById(categoryId: string): Promise<CategoryRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CATEGORY_COLUMNS} FROM platform.room_category
        WHERE hotel_id = $1 AND category_id = $2`,
      [this.hotelId, categoryId],
    );
    return mapCategory(result.rows[0]);
  }

  /** A share lock: a lifecycle transition on this category waits for the resolution to finish. */
  async shareCategory(categoryId: string): Promise<CategoryRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CATEGORY_COLUMNS} FROM platform.room_category
        WHERE hotel_id = $1 AND category_id = $2 FOR SHARE`,
      [this.hotelId, categoryId],
    );
    return mapCategory(result.rows[0]);
  }

  async lockCategory(categoryId: string): Promise<CategoryRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CATEGORY_COLUMNS} FROM platform.room_category
        WHERE hotel_id = $1 AND category_id = $2 FOR UPDATE`,
      [this.hotelId, categoryId],
    );
    return mapCategory(result.rows[0]);
  }

  async createCategory(input: {
    name: string;
    description?: string;
    state: EntityState;
    hourlyRateMnt?: bigint;
    nightlyRateMnt?: bigint;
    cleaningBufferMinutes?: number;
  }): Promise<CategoryRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.room_category
         (hotel_id, name, description, state, hourly_rate_mnt, nightly_rate_mnt,
          cleaning_buffer_minutes, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'INACTIVE' THEN now() END)
       RETURNING ${CATEGORY_COLUMNS}`,
      [
        this.hotelId,
        input.name,
        input.description ?? null,
        input.state,
        input.hourlyRateMnt ?? null,
        input.nightlyRateMnt ?? null,
        input.cleaningBufferMinutes ?? null,
      ],
    );
    const row = mapCategory(result.rows[0]);
    if (row === undefined) throw new Error('the category insert returned no row');
    return row;
  }

  async updateCategory(input: {
    categoryId: string;
    expectedRevision: number;
    name?: string;
    description?: string | null;
    hourlyRateMnt?: bigint | null;
    nightlyRateMnt?: bigint | null;
    cleaningBufferMinutes?: number | null;
  }): Promise<CategoryRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_category
          SET name = COALESCE($3, name),
              description = CASE WHEN $5 THEN $4 ELSE description END,
              hourly_rate_mnt = CASE WHEN $7 THEN $6::bigint ELSE hourly_rate_mnt END,
              nightly_rate_mnt = CASE WHEN $9 THEN $8::bigint ELSE nightly_rate_mnt END,
              cleaning_buffer_minutes = CASE WHEN $11 THEN $10::integer ELSE cleaning_buffer_minutes END,
              revision = revision + 1
        WHERE hotel_id = $1 AND category_id = $2 AND revision = $12
        RETURNING ${CATEGORY_COLUMNS}`,
      [
        this.hotelId,
        input.categoryId,
        input.name ?? null,
        input.description ?? null,
        input.description !== undefined,
        input.hourlyRateMnt ?? null,
        input.hourlyRateMnt !== undefined,
        input.nightlyRateMnt ?? null,
        input.nightlyRateMnt !== undefined,
        input.cleaningBufferMinutes ?? null,
        input.cleaningBufferMinutes !== undefined,
        input.expectedRevision,
      ],
    );
    return mapCategory(result.rows[0]);
  }

  async categories(): Promise<readonly CategoryRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CATEGORY_COLUMNS} FROM platform.room_category
        WHERE hotel_id = $1 ORDER BY name`,
      [this.hotelId],
    );
    return result.rows
      .map((row) => mapCategory(row))
      .filter((row): row is CategoryRow => row !== undefined);
  }

  // ----------------------------------------------------------------- rooms

  async roomById(roomId: string): Promise<RoomRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ROOM_COLUMNS} FROM platform.room WHERE hotel_id = $1 AND room_id = $2`,
      [this.hotelId, roomId],
    );
    return mapRoom(result.rows[0]);
  }

  async shareRoom(roomId: string): Promise<RoomRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ROOM_COLUMNS} FROM platform.room
        WHERE hotel_id = $1 AND room_id = $2 FOR SHARE`,
      [this.hotelId, roomId],
    );
    return mapRoom(result.rows[0]);
  }

  async rooms(): Promise<readonly RoomRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ROOM_COLUMNS} FROM platform.room WHERE hotel_id = $1 ORDER BY room_number`,
      [this.hotelId],
    );
    return result.rows
      .map((row) => mapRoom(row))
      .filter((row): row is RoomRow => row !== undefined);
  }

  async lockRoom(roomId: string): Promise<RoomRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ROOM_COLUMNS} FROM platform.room
        WHERE hotel_id = $1 AND room_id = $2 FOR UPDATE`,
      [this.hotelId, roomId],
    );
    return mapRoom(result.rows[0]);
  }

  async createRoom(input: {
    roomNumber: string;
    floorLabel?: string;
    categoryId: string;
    state: EntityState;
    hourlyRateMnt?: bigint;
    nightlyRateMnt?: bigint;
  }): Promise<RoomRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.room
         (hotel_id, room_number, floor_label, category_id, state, hourly_rate_mnt,
          nightly_rate_mnt, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'INACTIVE' THEN now() END)
       RETURNING ${ROOM_COLUMNS}`,
      [
        this.hotelId,
        input.roomNumber,
        input.floorLabel ?? null,
        input.categoryId,
        input.state,
        input.hourlyRateMnt ?? null,
        input.nightlyRateMnt ?? null,
      ],
    );
    const row = mapRoom(result.rows[0]);
    if (row === undefined) throw new Error('the room insert returned no row');
    return row;
  }

  async updateRoom(input: {
    roomId: string;
    expectedRevision: number;
    roomNumber?: string;
    floorLabel?: string | null;
    categoryId?: string;
    hourlyRateMnt?: bigint | null;
    nightlyRateMnt?: bigint | null;
  }): Promise<RoomRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room
          SET room_number = COALESCE($3, room_number),
              floor_label = CASE WHEN $5 THEN $4 ELSE floor_label END,
              category_id = COALESCE($6, category_id),
              hourly_rate_mnt = CASE WHEN $8 THEN $7::bigint ELSE hourly_rate_mnt END,
              nightly_rate_mnt = CASE WHEN $10 THEN $9::bigint ELSE nightly_rate_mnt END,
              revision = revision + 1
        WHERE hotel_id = $1 AND room_id = $2 AND revision = $11
        RETURNING ${ROOM_COLUMNS}`,
      [
        this.hotelId,
        input.roomId,
        input.roomNumber ?? null,
        input.floorLabel ?? null,
        input.floorLabel !== undefined,
        input.categoryId ?? null,
        input.hourlyRateMnt ?? null,
        input.hourlyRateMnt !== undefined,
        input.nightlyRateMnt ?? null,
        input.nightlyRateMnt !== undefined,
        input.expectedRevision,
      ],
    );
    return mapRoom(result.rows[0]);
  }

  // -------------------------------------------------- the shared lifecycle

  /** The lifecycle view of any catalog entity, whichever table it lives in. */
  async entity(kind: EntityKind, entityId: string): Promise<EntityRow | undefined> {
    const { table, key, name } = entityTableOf(kind);
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${key} AS entity_id, ${name} AS name, state, retirement_requested_at,
              retirement_reason, revision
         FROM ${table} WHERE hotel_id = $1 AND ${key} = $2`,
      [this.hotelId, entityId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      entityId: row['entity_id'] as string,
      kind,
      name: row['name'] as string,
      state: row['state'] as EntityState,
      retirementRequestedAt: (row['retirement_requested_at'] ?? null) as Date | null,
      retirementReason: (row['retirement_reason'] ?? null) as string | null,
      revision: Number(row['revision']),
    };
  }

  /**
   * Takes the row lock a lifecycle command holds for the rest of its
   * transaction, so a concurrent transition, assignment or deletion waits here
   * rather than racing the state machine.
   */
  async lockEntity(kind: EntityKind, entityId: string): Promise<EntityRow | undefined> {
    const { table, key } = entityTableOf(kind);
    const locked = await this.uow.query<Record<string, unknown>>(
      `SELECT ${key} AS entity_id FROM ${table}
        WHERE hotel_id = $1 AND ${key} = $2 FOR UPDATE`,
      [this.hotelId, entityId],
    );
    if (locked.rows[0] === undefined) return undefined;
    return this.entity(kind, entityId);
  }

  /** A state transition, as a compare-and-set on the revision that was read. */
  async transition(input: {
    kind: EntityKind;
    entityId: string;
    expectedRevision: number;
    toState: EntityState;
    reason?: string | null;
    requestedAt?: Date | null;
  }): Promise<EntityRow | undefined> {
    const { table, key, name } = entityTableOf(input.kind);
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE ${table}
          SET state = $4,
              retirement_requested_at =
                CASE WHEN $4 = 'RETIRING' THEN COALESCE(retirement_requested_at, now())
                     WHEN $4 = 'ACTIVE' THEN NULL
                     ELSE retirement_requested_at END,
              retirement_reason =
                CASE WHEN $4 = 'ACTIVE' THEN NULL
                     WHEN $5::text IS NOT NULL THEN $5::text
                     ELSE retirement_reason END,
              deactivated_at =
                CASE WHEN $4 = 'INACTIVE' THEN now()
                     WHEN $4 = 'ACTIVE' THEN NULL
                     ELSE deactivated_at END,
              revision = revision + 1
        WHERE hotel_id = $1 AND ${key} = $2 AND revision = $3
        RETURNING ${key} AS entity_id, ${name} AS name, state, retirement_requested_at,
                  retirement_reason, revision`,
      [this.hotelId, input.entityId, input.expectedRevision, input.toState, input.reason ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      entityId: row['entity_id'] as string,
      kind: input.kind,
      name: row['name'] as string,
      state: row['state'] as EntityState,
      retirementRequestedAt: (row['retirement_requested_at'] ?? null) as Date | null,
      retirementReason: (row['retirement_reason'] ?? null) as string | null,
      revision: Number(row['revision']),
    };
  }

  /**
   * The hard delete (`RML-DEC-005`).
   *
   * Conditional on the revision that was read, so a delete cannot overtake a
   * concurrent edit. The foreign keys are the second refusal: a referenced row
   * raises `23503` here even if a probe somehow missed it.
   */
  async deleteEntity(
    kind: EntityKind,
    entityId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    const { table, key } = entityTableOf(kind);
    const result = await this.uow.query(
      `DELETE FROM ${table} WHERE hotel_id = $1 AND ${key} = $2 AND revision = $3`,
      [this.hotelId, entityId, expectedRevision],
    );
    return result.rowCount === 1;
  }

  async createMinibarEntity(
    kind: 'MINIBAR_PRODUCT' | 'MINIBAR_TEMPLATE',
    input: { name: string; state: EntityState },
  ): Promise<EntityRow> {
    const { table, key } = entityTableOf(kind);
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO ${table} (hotel_id, name, state, deactivated_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'INACTIVE' THEN now() END)
       RETURNING ${key} AS entity_id, name, state, retirement_requested_at,
                 retirement_reason, revision`,
      [this.hotelId, input.name, input.state],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the minibar entity insert returned no row');
    return {
      entityId: row['entity_id'] as string,
      kind,
      name: row['name'] as string,
      state: row['state'] as EntityState,
      retirementRequestedAt: (row['retirement_requested_at'] ?? null) as Date | null,
      retirementReason: (row['retirement_reason'] ?? null) as string | null,
      revision: Number(row['revision']),
    };
  }

  // ------------------------------------------------------ dependency probes

  /** Whether the relation a future consumer will own exists in this database. */
  async relationExists(relation: string): Promise<boolean> {
    const result = await this.uow.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [relation],
    );
    return result.rows[0]?.present === true;
  }

  /**
   * Counts the references a dependency source holds.
   *
   * The relation, column and predicate come from the registry — a module
   * constant, never from a request — and the tenant and the entity are bound
   * parameters.
   *
   * The statement runs inside a savepoint. A relation that exists but does not
   * carry the column the registry names — an owning phase that shipped a
   * different shape without updating the entry — raises here, and without the
   * savepoint that error would abort the whole transaction. With it, the probe
   * reports `unavailable` and the caller decides: a lifecycle command fails
   * closed on that answer and a view shows it. Neither turns it into zero.
   */
  async countReferences(input: {
    relation: string;
    column: string;
    predicate?: string;
    entityId: string;
  }): Promise<number | 'unavailable'> {
    const predicate = input.predicate === undefined ? '' : ` AND (${input.predicate})`;
    await this.uow.query('SAVEPOINT catalog_probe');
    try {
      const result = await this.uow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${input.relation}
          WHERE hotel_id = $1 AND ${input.column} = $2${predicate}`,
        [this.hotelId, input.entityId],
      );
      await this.uow.query('RELEASE SAVEPOINT catalog_probe');
      const n = result.rows[0]?.n;
      if (n === undefined) return 'unavailable';
      return Number(n);
    } catch {
      await this.uow.query('ROLLBACK TO SAVEPOINT catalog_probe');
      return 'unavailable';
    }
  }

  // ------------------------------------------------------------- snapshots

  async snapshotFor(subjectType: string, subjectRef: string): Promise<SnapshotRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT snapshot_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
              source_entity_id, pricing_config_version, category_id, room_id,
              cleaning_buffer_minutes, fixed_checkout_minute
         FROM platform.stay_rate_snapshot
        WHERE hotel_id = $1 AND subject_type = $2 AND subject_ref = $3`,
      [this.hotelId, subjectType, subjectRef],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      snapshotId: row['snapshot_id'] as string,
      subjectType: row['subject_type'] as string,
      subjectRef: row['subject_ref'] as string,
      stayType: row['stay_type'] as StayType,
      unitPriceMnt: BigInt(row['unit_price_mnt'] as string),
      sourceLevel: row['source_level'] as SourceLevel,
      sourceEntityId: row['source_entity_id'] as string,
      pricingConfigVersion: Number(row['pricing_config_version']),
      categoryId: row['category_id'] as string,
      roomId: (row['room_id'] ?? null) as string | null,
      cleaningBufferMinutes: Number(row['cleaning_buffer_minutes']),
      fixedCheckoutMinute: numberOrNull(row['fixed_checkout_minute']),
    };
  }

  /**
   * Captures a snapshot, once.
   *
   * `ON CONFLICT DO NOTHING` on the subject key: two confirmations racing for
   * one stay or booking produce one snapshot, and the loser reads the winner's
   * row rather than writing a second price.
   */
  async captureSnapshot(input: {
    subjectType: string;
    subjectRef: string;
    stayType: StayType;
    unitPriceMnt: bigint;
    sourceLevel: SourceLevel;
    sourceEntityId: string;
    pricingConfigVersion: number;
    categoryId: string;
    roomId: string | null;
    cleaningBufferMinutes: number;
    fixedCheckoutMinute: number | null;
  }): Promise<{ readonly captured: boolean }> {
    const result = await this.uow.query(
      `INSERT INTO platform.stay_rate_snapshot
         (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
          source_entity_id, pricing_config_version, category_id, room_id,
          cleaning_buffer_minutes, fixed_checkout_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (hotel_id, subject_type, subject_ref) DO NOTHING`,
      [
        this.hotelId,
        input.subjectType,
        input.subjectRef,
        input.stayType,
        input.unitPriceMnt.toString(),
        input.sourceLevel,
        input.sourceEntityId,
        input.pricingConfigVersion,
        input.categoryId,
        input.roomId,
        input.cleaningBufferMinutes,
        input.fixedCheckoutMinute,
      ],
    );
    return { captured: result.rowCount === 1 };
  }

  // ----------------------------------------------------------------- history

  async appendEvent(event: CatalogEventInput): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.catalog_event
         (hotel_id, entity_type, entity_id, event_type, from_state, to_state, reason,
          config_version, payload, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        this.hotelId,
        event.entityType,
        event.entityId,
        event.eventType,
        event.fromState ?? null,
        event.toState ?? null,
        event.reason ?? null,
        event.configVersion ?? null,
        JSON.stringify(event.payload ?? {}),
        event.actorAccountId ?? null,
      ],
    );
  }

  async events(
    entityType: EntityKind | 'HOTEL_STAY_CONFIGURATION',
    entityId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT event_type, from_state, to_state, reason, config_version, payload,
              actor_account_id, occurred_at
         FROM platform.catalog_event
        WHERE hotel_id = $1 AND entity_type = $2 AND entity_id = $3
        ORDER BY occurred_at, event_id`,
      [this.hotelId, entityType, entityId],
    );
    return result.rows;
  }
}
