import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';
import type { StockLine, TaskBound } from '../domain/inventory';
import type { ChangeState } from '../domain/versions';

/**
 * Room configuration, the pending change, the Cleaner task, the batch and the
 * shortage override, plus the minibar history.
 *
 * Lock order inside this module, always: product(s) → template → version →
 * room configuration → change → task. A command that needs the catalog's room
 * row locks it before all of these (the catalog's own order ends at the room).
 */

export type MinibarStatus = 'FULL' | 'SHORT' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface ConfigurationRow {
  readonly roomId: string;
  readonly mode: 'ON' | 'OFF';
  readonly templateId: string | null;
  readonly currentVersionId: string | null;
  readonly minibarStatus: MinibarStatus;
  readonly overrideId: string | null;
  readonly revision: number;
}

export type ChangeKind = 'ON_TO_OFF' | 'OFF_TO_ON' | 'TEMPLATE_SWITCH' | 'VERSION_ROLLOUT';

export interface ChangeRow {
  readonly changeId: string;
  readonly roomId: string;
  readonly kind: ChangeKind;
  readonly targetTemplateId: string | null;
  readonly targetVersionId: string | null;
  readonly state: ChangeState;
  readonly batchId: string | null;
  readonly movementStarted: boolean;
  readonly blockerDetail: Record<string, unknown>;
  readonly reason: string | null;
  readonly requestedBy: string | null;
  readonly requestedAt: Date;
  readonly terminalAt: Date | null;
  readonly revision: number;
}

export type TaskState = 'OPEN' | 'CLAIMED' | 'COMPLETED' | 'CANCELLED';

export interface TaskRow {
  readonly taskId: string;
  readonly changeId: string;
  readonly roomId: string;
  readonly kind: 'RECONCILE' | 'ROLLBACK';
  readonly state: TaskState;
  readonly bounds: readonly TaskBound[];
  readonly counted: readonly StockLine[] | null;
  readonly assignedAccountId: string | null;
  readonly revision: number;
}

export interface BatchRow {
  readonly batchId: string;
  readonly templateId: string;
  readonly targetVersionId: string;
  readonly retryOfBatchId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface BatchRoomRow {
  readonly roomId: string;
  readonly result: 'ACCEPTED' | 'SKIPPED';
  readonly reasonCode: string | null;
  readonly changeId: string | null;
}

export interface OverrideRow {
  readonly overrideId: string;
  readonly roomId: string;
  readonly snapshot: Record<string, unknown>;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly consumedAt: Date | null;
}

export type MinibarEntityType =
  | 'PRODUCT'
  | 'TEMPLATE_VERSION'
  | 'ROOM_CONFIGURATION'
  | 'CONFIGURATION_CHANGE'
  | 'RECONCILIATION_TASK'
  | 'ROLLOUT_BATCH'
  | 'SHORTAGE_OVERRIDE';

export interface MinibarEventInput {
  readonly entityType: MinibarEntityType;
  readonly entityId: string;
  readonly eventType: string;
  readonly fromState?: string;
  readonly toState?: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
  readonly actorAccountId?: string;
}

const CONFIG_COLUMNS = `room_id, mode, template_id, current_version_id, minibar_status, override_id,
  revision`;
const CHANGE_COLUMNS = `change_id, room_id, kind, target_template_id, target_version_id, state,
  batch_id, movement_started, blocker_detail, reason, requested_by, requested_at, terminal_at,
  revision`;
const TASK_COLUMNS = `task_id, change_id, room_id, kind, state, bounds, counted, assigned_account_id,
  revision`;

function mapConfiguration(row: Record<string, unknown> | undefined): ConfigurationRow | undefined {
  if (row === undefined) return undefined;
  return {
    roomId: row['room_id'] as string,
    mode: row['mode'] as 'ON' | 'OFF',
    templateId: (row['template_id'] ?? null) as string | null,
    currentVersionId: (row['current_version_id'] ?? null) as string | null,
    minibarStatus: row['minibar_status'] as MinibarStatus,
    overrideId: (row['override_id'] ?? null) as string | null,
    revision: Number(row['revision']),
  };
}

function mapChange(row: Record<string, unknown> | undefined): ChangeRow | undefined {
  if (row === undefined) return undefined;
  return {
    changeId: row['change_id'] as string,
    roomId: row['room_id'] as string,
    kind: row['kind'] as ChangeKind,
    targetTemplateId: (row['target_template_id'] ?? null) as string | null,
    targetVersionId: (row['target_version_id'] ?? null) as string | null,
    state: row['state'] as ChangeState,
    batchId: (row['batch_id'] ?? null) as string | null,
    movementStarted: row['movement_started'] === true,
    blockerDetail: (row['blocker_detail'] ?? {}) as Record<string, unknown>,
    reason: (row['reason'] ?? null) as string | null,
    requestedBy: (row['requested_by'] ?? null) as string | null,
    requestedAt: row['requested_at'] as Date,
    terminalAt: (row['terminal_at'] ?? null) as Date | null,
    revision: Number(row['revision']),
  };
}

function mapTask(row: Record<string, unknown> | undefined): TaskRow | undefined {
  if (row === undefined) return undefined;
  return {
    taskId: row['task_id'] as string,
    changeId: row['change_id'] as string,
    roomId: row['room_id'] as string,
    kind: row['kind'] as 'RECONCILE' | 'ROLLBACK',
    state: row['state'] as TaskState,
    bounds: (row['bounds'] ?? []) as readonly TaskBound[],
    counted: (row['counted'] ?? null) as readonly StockLine[] | null,
    assignedAccountId: (row['assigned_account_id'] ?? null) as string | null,
    revision: Number(row['revision']),
  };
}

export class ConfigurationRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  get unitOfWork(): UnitOfWork {
    return this.uow;
  }

  // --------------------------------------------------------- configuration

  async configuration(roomId: string): Promise<ConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS} FROM platform.room_minibar_configuration
        WHERE hotel_id = $1 AND room_id = $2`,
      [this.hotelId, roomId],
    );
    return mapConfiguration(result.rows[0]);
  }

  /**
   * The configuration share-locked for a check-in: an apply, which takes the
   * row `FOR UPDATE`, waits for the check-in that pinned it, and the check-in
   * reads a version that cannot switch under it (doc 25 §7.1). `updatedAt` is
   * when the row last changed, which a backdated check-in compares with the
   * chosen arrival (doc 05 §19.2).
   */
  async shareConfiguration(
    roomId: string,
  ): Promise<(ConfigurationRow & { readonly updatedAt: Date }) | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS}, updated_at FROM platform.room_minibar_configuration
        WHERE hotel_id = $1 AND room_id = $2 FOR SHARE`,
      [this.hotelId, roomId],
    );
    const row = mapConfiguration(result.rows[0]);
    if (row === undefined) return undefined;
    return { ...row, updatedAt: result.rows[0]?.['updated_at'] as Date };
  }

  /** The next stay has opened under the override: the pointer is cleared (doc 22 §8). */
  async clearOverride(
    roomId: string,
    expectedRevision: number,
  ): Promise<ConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_minibar_configuration
          SET override_id = NULL, updated_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND room_id = $2 AND revision = $3
        RETURNING ${CONFIG_COLUMNS}`,
      [this.hotelId, roomId, expectedRevision],
    );
    return mapConfiguration(result.rows[0]);
  }

  /** Creates the OFF row a room starts from if it has none, and locks it either way. */
  async ensureConfiguration(roomId: string): Promise<ConfigurationRow> {
    await this.uow.query(
      `INSERT INTO platform.room_minibar_configuration (room_id, hotel_id)
       VALUES ($1, $2) ON CONFLICT (room_id) DO NOTHING`,
      [roomId, this.hotelId],
    );
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS} FROM platform.room_minibar_configuration
        WHERE hotel_id = $1 AND room_id = $2 FOR UPDATE`,
      [this.hotelId, roomId],
    );
    const row = mapConfiguration(result.rows[0]);
    if (row === undefined) throw new Error('the configuration row is missing after insert');
    return row;
  }

  async configurations(): Promise<readonly ConfigurationRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS} FROM platform.room_minibar_configuration
        WHERE hotel_id = $1 ORDER BY room_id`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapConfiguration(row) as ConfigurationRow);
  }

  async writeConfiguration(input: {
    roomId: string;
    expectedRevision: number;
    mode: 'ON' | 'OFF';
    templateId: string | null;
    currentVersionId: string | null;
    minibarStatus: MinibarStatus;
    overrideId: string | null;
  }): Promise<ConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_minibar_configuration
          SET mode = $4, template_id = $5, current_version_id = $6, minibar_status = $7,
              override_id = $8, updated_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND room_id = $2 AND revision = $3
        RETURNING ${CONFIG_COLUMNS}`,
      [
        this.hotelId,
        input.roomId,
        input.expectedRevision,
        input.mode,
        input.templateId,
        input.currentVersionId,
        input.minibarStatus,
        input.overrideId,
      ],
    );
    return mapConfiguration(result.rows[0]);
  }

  async setStatus(
    roomId: string,
    expectedRevision: number,
    minibarStatus: MinibarStatus,
  ): Promise<ConfigurationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_minibar_configuration
          SET minibar_status = $4, updated_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND room_id = $2 AND revision = $3
        RETURNING ${CONFIG_COLUMNS}`,
      [this.hotelId, roomId, expectedRevision, minibarStatus],
    );
    return mapConfiguration(result.rows[0]);
  }

  // --------------------------------------------------------------- changes

  async changeById(changeId: string): Promise<ChangeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CHANGE_COLUMNS} FROM platform.room_configuration_change
        WHERE hotel_id = $1 AND change_id = $2`,
      [this.hotelId, changeId],
    );
    return mapChange(result.rows[0]);
  }

  async lockChange(changeId: string): Promise<ChangeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CHANGE_COLUMNS} FROM platform.room_configuration_change
        WHERE hotel_id = $1 AND change_id = $2 FOR UPDATE`,
      [this.hotelId, changeId],
    );
    return mapChange(result.rows[0]);
  }

  /** The room's non-terminal change, if one exists. */
  async pendingChangeOf(roomId: string): Promise<ChangeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CHANGE_COLUMNS} FROM platform.room_configuration_change
        WHERE hotel_id = $1 AND room_id = $2
          AND state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])`,
      [this.hotelId, roomId],
    );
    return mapChange(result.rows[0]);
  }

  async changesOfBatch(batchId: string): Promise<readonly ChangeRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CHANGE_COLUMNS} FROM platform.room_configuration_change
        WHERE hotel_id = $1 AND batch_id = $2 ORDER BY room_id`,
      [this.hotelId, batchId],
    );
    return result.rows.map((row) => mapChange(row) as ChangeRow);
  }

  async createChange(input: {
    roomId: string;
    kind: ChangeKind;
    targetTemplateId: string | null;
    targetVersionId: string | null;
    state: 'SCHEDULED_AFTER_STAY' | 'READY_FOR_RECONCILIATION';
    batchId?: string;
    reason?: string;
    requestedBy?: string;
  }): Promise<ChangeRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.room_configuration_change
         (hotel_id, room_id, kind, target_template_id, target_version_id, state, batch_id, reason,
          requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CHANGE_COLUMNS}`,
      [
        this.hotelId,
        input.roomId,
        input.kind,
        input.targetTemplateId,
        input.targetVersionId,
        input.state,
        input.batchId ?? null,
        input.reason ?? null,
        input.requestedBy ?? null,
      ],
    );
    const row = mapChange(result.rows[0]);
    if (row === undefined) throw new Error('the change insert returned no row');
    return row;
  }

  async transitionChange(input: {
    changeId: string;
    expectedRevision: number;
    toState: ChangeState;
    movementStarted?: true;
    blockerDetail?: Record<string, unknown>;
  }): Promise<ChangeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_configuration_change
          SET state = $4,
              movement_started = movement_started OR $5,
              blocker_detail = COALESCE($6::jsonb, blocker_detail),
              terminal_at = CASE WHEN $4 = ANY (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])
                                 THEN now() ELSE terminal_at END,
              revision = revision + 1
        WHERE hotel_id = $1 AND change_id = $2 AND revision = $3
        RETURNING ${CHANGE_COLUMNS}`,
      [
        this.hotelId,
        input.changeId,
        input.expectedRevision,
        input.toState,
        input.movementStarted === true,
        input.blockerDetail === undefined ? null : JSON.stringify(input.blockerDetail),
      ],
    );
    return mapChange(result.rows[0]);
  }

  /** Records that a movement has been posted against the change, without a state change. */
  async markMovementStarted(
    changeId: string,
    expectedRevision: number,
  ): Promise<ChangeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.room_configuration_change
          SET movement_started = true, revision = revision + 1
        WHERE hotel_id = $1 AND change_id = $2 AND revision = $3
        RETURNING ${CHANGE_COLUMNS}`,
      [this.hotelId, changeId, expectedRevision],
    );
    return mapChange(result.rows[0]);
  }

  // ----------------------------------------------------------------- tasks

  async taskById(taskId: string): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM platform.minibar_reconciliation_task
        WHERE hotel_id = $1 AND task_id = $2`,
      [this.hotelId, taskId],
    );
    return mapTask(result.rows[0]);
  }

  async lockTask(taskId: string): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM platform.minibar_reconciliation_task
        WHERE hotel_id = $1 AND task_id = $2 FOR UPDATE`,
      [this.hotelId, taskId],
    );
    return mapTask(result.rows[0]);
  }

  async openTaskOf(changeId: string): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM platform.minibar_reconciliation_task
        WHERE hotel_id = $1 AND change_id = $2 AND state = ANY (ARRAY['OPEN', 'CLAIMED'])`,
      [this.hotelId, changeId],
    );
    return mapTask(result.rows[0]);
  }

  /** Tasks a Cleaner may see: open ones, and the ones assigned to them. */
  async tasksVisibleTo(accountId: string): Promise<readonly TaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM platform.minibar_reconciliation_task
        WHERE hotel_id = $1
          AND (state = 'OPEN' OR (assigned_account_id = $2 AND state = 'CLAIMED'))
        ORDER BY created_at`,
      [this.hotelId, accountId],
    );
    return result.rows.map((row) => mapTask(row) as TaskRow);
  }

  async tasksOfChange(changeId: string): Promise<readonly TaskRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM platform.minibar_reconciliation_task
        WHERE hotel_id = $1 AND change_id = $2 ORDER BY created_at`,
      [this.hotelId, changeId],
    );
    return result.rows.map((row) => mapTask(row) as TaskRow);
  }

  /**
   * Creates the one open task of a change. Idempotent through the partial
   * unique index: a second creation for a change that already has an open
   * task returns that task rather than a duplicate (doc 26 §33.2).
   */
  async createTask(input: {
    changeId: string;
    roomId: string;
    kind: 'RECONCILE' | 'ROLLBACK';
    bounds: readonly TaskBound[];
  }): Promise<TaskRow> {
    const existing = await this.openTaskOf(input.changeId);
    if (existing !== undefined) return existing;
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_reconciliation_task (hotel_id, change_id, room_id, kind, bounds)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING ${TASK_COLUMNS}`,
      [this.hotelId, input.changeId, input.roomId, input.kind, JSON.stringify(input.bounds)],
    );
    const row = mapTask(result.rows[0]);
    if (row === undefined) throw new Error('the task insert returned no row');
    return row;
  }

  async claimTask(
    taskId: string,
    expectedRevision: number,
    accountId: string,
  ): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_reconciliation_task
          SET state = 'CLAIMED', assigned_account_id = $4, claimed_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3 AND state = 'OPEN'
        RETURNING ${TASK_COLUMNS}`,
      [this.hotelId, taskId, expectedRevision, accountId],
    );
    return mapTask(result.rows[0]);
  }

  async finishTask(input: {
    taskId: string;
    expectedRevision: number;
    state: 'COMPLETED' | 'CANCELLED';
    counted?: readonly StockLine[];
  }): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_reconciliation_task
          SET state = $4, counted = COALESCE($5::jsonb, counted),
              completed_at = CASE WHEN $4 = 'COMPLETED' THEN now() ELSE completed_at END,
              revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3
        RETURNING ${TASK_COLUMNS}`,
      [
        this.hotelId,
        input.taskId,
        input.expectedRevision,
        input.state,
        input.counted === undefined ? null : JSON.stringify(input.counted),
      ],
    );
    return mapTask(result.rows[0]);
  }

  /** Rewrites the open bounds of a task: after a partial posting, or on a resume after a block. */
  async reboundTask(taskId: string, bounds: readonly TaskBound[]): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_reconciliation_task
          SET bounds = $3::jsonb, revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND state = ANY (ARRAY['OPEN', 'CLAIMED'])
        RETURNING ${TASK_COLUMNS}`,
      [this.hotelId, taskId, JSON.stringify(bounds)],
    );
    return mapTask(result.rows[0]);
  }

  async recordCount(
    taskId: string,
    expectedRevision: number,
    counted: readonly StockLine[],
  ): Promise<TaskRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_reconciliation_task
          SET counted = $4::jsonb, revision = revision + 1
        WHERE hotel_id = $1 AND task_id = $2 AND revision = $3
        RETURNING ${TASK_COLUMNS}`,
      [this.hotelId, taskId, expectedRevision, JSON.stringify(counted)],
    );
    return mapTask(result.rows[0]);
  }

  // --------------------------------------------------------------- batches

  async createBatch(input: {
    templateId: string;
    targetVersionId: string;
    retryOfBatchId?: string;
    createdBy?: string;
  }): Promise<BatchRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.rollout_batch (hotel_id, template_id, target_version_id, retry_of_batch_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING batch_id, template_id, target_version_id, retry_of_batch_id, created_by, created_at`,
      [
        this.hotelId,
        input.templateId,
        input.targetVersionId,
        input.retryOfBatchId ?? null,
        input.createdBy ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the batch insert returned no row');
    return {
      batchId: row['batch_id'] as string,
      templateId: row['template_id'] as string,
      targetVersionId: row['target_version_id'] as string,
      retryOfBatchId: (row['retry_of_batch_id'] ?? null) as string | null,
      createdBy: (row['created_by'] ?? null) as string | null,
      createdAt: row['created_at'] as Date,
    };
  }

  async batchById(batchId: string): Promise<BatchRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT batch_id, template_id, target_version_id, retry_of_batch_id, created_by, created_at
         FROM platform.rollout_batch WHERE hotel_id = $1 AND batch_id = $2`,
      [this.hotelId, batchId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      batchId: row['batch_id'] as string,
      templateId: row['template_id'] as string,
      targetVersionId: row['target_version_id'] as string,
      retryOfBatchId: (row['retry_of_batch_id'] ?? null) as string | null,
      createdBy: (row['created_by'] ?? null) as string | null,
      createdAt: row['created_at'] as Date,
    };
  }

  async addBatchRoom(input: {
    batchId: string;
    roomId: string;
    result: 'ACCEPTED' | 'SKIPPED';
    reasonCode?: string;
    changeId?: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.rollout_batch_room (batch_id, room_id, hotel_id, result, reason_code, change_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.batchId,
        input.roomId,
        this.hotelId,
        input.result,
        input.reasonCode ?? null,
        input.changeId ?? null,
      ],
    );
  }

  async batchRooms(batchId: string): Promise<readonly BatchRoomRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT room_id, result, reason_code, change_id FROM platform.rollout_batch_room
        WHERE hotel_id = $1 AND batch_id = $2 ORDER BY room_id`,
      [this.hotelId, batchId],
    );
    return result.rows.map((row) => ({
      roomId: row['room_id'] as string,
      result: row['result'] as 'ACCEPTED' | 'SKIPPED',
      reasonCode: (row['reason_code'] ?? null) as string | null,
      changeId: (row['change_id'] ?? null) as string | null,
    }));
  }

  // ------------------------------------------------------------- overrides

  async createOverride(input: {
    roomId: string;
    snapshot: Record<string, unknown>;
    reason: string;
    createdBy?: string;
  }): Promise<OverrideRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_shortage_override (hotel_id, room_id, snapshot, reason, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING override_id, room_id, snapshot, reason, created_by, created_at, consumed_at`,
      [
        this.hotelId,
        input.roomId,
        JSON.stringify(input.snapshot),
        input.reason,
        input.createdBy ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the override insert returned no row');
    return {
      overrideId: row['override_id'] as string,
      roomId: row['room_id'] as string,
      snapshot: row['snapshot'] as Record<string, unknown>,
      reason: row['reason'] as string,
      createdBy: (row['created_by'] ?? null) as string | null,
      createdAt: row['created_at'] as Date,
      consumedAt: (row['consumed_at'] ?? null) as Date | null,
    };
  }

  async overrideById(overrideId: string): Promise<OverrideRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT override_id, room_id, snapshot, reason, created_by, created_at, consumed_at
         FROM platform.minibar_shortage_override WHERE hotel_id = $1 AND override_id = $2`,
      [this.hotelId, overrideId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      overrideId: row['override_id'] as string,
      roomId: row['room_id'] as string,
      snapshot: row['snapshot'] as Record<string, unknown>,
      reason: row['reason'] as string,
      createdBy: (row['created_by'] ?? null) as string | null,
      createdAt: row['created_at'] as Date,
      consumedAt: (row['consumed_at'] ?? null) as Date | null,
    };
  }

  // --------------------------------------------------------------- history

  async appendEvent(event: MinibarEventInput): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.minibar_event
         (hotel_id, entity_type, entity_id, event_type, from_state, to_state, reason, payload,
          actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        this.hotelId,
        event.entityType,
        event.entityId,
        event.eventType,
        event.fromState ?? null,
        event.toState ?? null,
        event.reason ?? null,
        JSON.stringify(event.payload ?? {}),
        event.actorAccountId ?? null,
      ],
    );
  }

  async events(
    entityType: MinibarEntityType,
    entityId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT event_type, from_state, to_state, reason, payload, actor_account_id, occurred_at
         FROM platform.minibar_event
        WHERE hotel_id = $1 AND entity_type = $2 AND entity_id = $3
        ORDER BY occurred_at, event_id`,
      [this.hotelId, entityType, entityId],
    );
    return result.rows;
  }
}
