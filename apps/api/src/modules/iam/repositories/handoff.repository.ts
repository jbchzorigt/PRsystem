import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';

/**
 * The IAM-owned work handoff queue (doc 19 §8.1–§8.4, `STAFF-DEC-007`).
 *
 * Security revocation commits immediately and never waits for open work, so the
 * open work lands here instead. The subject is opaque: a Reception shift, a
 * Cleaner task and a Restaurant order are owned by Phases 11, 09 and 15, and
 * this module holds a reference and a kind, never a foreign key into a table it
 * does not own.
 */

export type HandoffSubjectKind = 'reception_shift' | 'cleaner_task' | 'restaurant_order';

export type HandoffState =
  | 'TAKEOVER_REQUIRED'
  | 'REASSIGNMENT_REQUIRED'
  | 'CLAIMED'
  | 'ASSIGNED'
  | 'RESOLVED'
  | 'UNASSIGNED_REQUIRES_ACTION';

export interface HandoffItemRow {
  readonly itemId: string;
  readonly hotelId: string;
  readonly restaurantId: string | null;
  readonly subjectKind: HandoffSubjectKind;
  readonly subjectRef: string;
  readonly state: HandoffState;
  readonly openedReason: 'suspension' | 'termination';
  readonly previousActorMembershipId: string;
  readonly claimantMembershipId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly movementStarted: boolean;
  readonly continuationOfItemId: string | null;
  readonly assignmentVersion: number;
}

const COLUMNS = `item_id, hotel_id, restaurant_id, subject_kind, subject_ref, state,
                 opened_reason, previous_actor_membership_id, claimant_membership_id,
                 assignee_membership_id, movement_started, continuation_of_item_id,
                 assignment_version`;

function mapItem(row: Record<string, unknown> | undefined): HandoffItemRow | undefined {
  if (row === undefined) return undefined;
  return {
    itemId: String(row['item_id']),
    hotelId: String(row['hotel_id']),
    restaurantId: (row['restaurant_id'] as string | null) ?? null,
    subjectKind: row['subject_kind'] as HandoffSubjectKind,
    subjectRef: String(row['subject_ref']),
    state: row['state'] as HandoffState,
    openedReason: row['opened_reason'] as 'suspension' | 'termination',
    previousActorMembershipId: String(row['previous_actor_membership_id']),
    claimantMembershipId: (row['claimant_membership_id'] as string | null) ?? null,
    assigneeMembershipId: (row['assignee_membership_id'] as string | null) ?? null,
    movementStarted: row['movement_started'] === true,
    continuationOfItemId: (row['continuation_of_item_id'] as string | null) ?? null,
    assignmentVersion: Number(row['assignment_version']),
  };
}

export interface HandoffDiscoveryRow {
  readonly discoveryId: string;
  readonly hotelId: string;
  readonly membershipId: string;
  readonly openedReason: 'suspension' | 'termination';
  /** The membership state this marker was raised against. */
  readonly expectedState: 'SUSPENDED' | 'TERMINATED';
  /** The revision it was raised against. A later transition invalidates it. */
  readonly membershipRevision: number;
  readonly state: 'PENDING' | 'COMPLETED' | 'SUPERSEDED';
  readonly attempts: number;
  readonly idempotencySeed: string;
}

function mapDiscovery(row: Record<string, unknown> | undefined): HandoffDiscoveryRow | undefined {
  if (row === undefined) return undefined;
  return {
    discoveryId: String(row['discovery_id']),
    hotelId: String(row['hotel_id']),
    membershipId: String(row['membership_id']),
    openedReason: row['opened_reason'] as 'suspension' | 'termination',
    expectedState: row['expected_state'] as 'SUSPENDED' | 'TERMINATED',
    membershipRevision: Number(row['membership_revision']),
    state: row['state'] as 'PENDING' | 'COMPLETED' | 'SUPERSEDED',
    attempts: Number(row['attempts']),
    idempotencySeed: String(row['idempotency_seed']),
  };
}

const DISCOVERY_COLUMNS = `discovery_id, hotel_id, membership_id, opened_reason, expected_state,
                           membership_revision, state, attempts, idempotency_seed`;

/**
 * The durable marker that a suspended membership's open work still has to be
 * enumerated (doc 19 §8.1).
 *
 * Separate from the queue itself because it records a *question* rather than a
 * piece of work: which items exist is not yet known, and the security effect
 * that raised the question has already committed.
 */
export class HandoffDiscoveryRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  /**
   * Opens a marker, or returns the open one this membership already has.
   *
   * The partial unique index is the arbiter, so a second suspension of the same
   * person before the first was enumerated advances one marker rather than
   * queueing two enumerations of the same work.
   */
  async open(input: {
    membershipId: string;
    openedReason: 'suspension' | 'termination';
    expectedState: 'SUSPENDED' | 'TERMINATED';
    membershipRevision: number;
    idempotencySeed: string;
  }): Promise<HandoffDiscoveryRow> {
    await this.uow.query(
      `INSERT INTO platform.work_handoff_discovery
         (hotel_id, membership_id, opened_reason, expected_state, membership_revision,
          idempotency_seed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (hotel_id, membership_id) WHERE state = 'PENDING' DO NOTHING`,
      [
        this.hotelId,
        input.membershipId,
        input.openedReason,
        input.expectedState,
        input.membershipRevision,
        input.idempotencySeed,
      ],
    );
    const existing = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DISCOVERY_COLUMNS} FROM platform.work_handoff_discovery
        WHERE hotel_id = $1 AND membership_id = $2 AND state = 'PENDING'`,
      [this.hotelId, input.membershipId],
    );
    const row = mapDiscovery(existing.rows[0]);
    if (row === undefined) throw new Error('the discovery marker insert returned no row');
    return row;
  }

  /**
   * Settles every open marker for one membership as superseded.
   *
   * Called by a reactivation, in the same transaction as the state change: the
   * moment the person is working again, the question their suspension raised is
   * no longer a question anybody should answer.
   */
  async supersedeOpen(membershipId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.work_handoff_discovery
          SET state = 'SUPERSEDED', settled_at = now(), settled_reason = $3, updated_at = now()
        WHERE hotel_id = $1 AND membership_id = $2 AND state = 'PENDING'`,
      [this.hotelId, membershipId, reason],
    );
    return result.rowCount;
  }

  /** Settles one marker as superseded. Terminal, and it creates nothing. */
  async supersede(discoveryId: string, reason: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.work_handoff_discovery
          SET state = 'SUPERSEDED', settled_at = now(), settled_reason = $3,
              attempts = attempts + 1, updated_at = now()
        WHERE hotel_id = $1 AND discovery_id = $2 AND state = 'PENDING'`,
      [this.hotelId, discoveryId, reason],
    );
    return result.rowCount === 1;
  }

  /** Every marker still awaiting enumeration, optionally for one membership. */
  async listPending(membershipId?: string): Promise<readonly HandoffDiscoveryRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DISCOVERY_COLUMNS} FROM platform.work_handoff_discovery
        WHERE hotel_id = $1 AND state = 'PENDING'
          AND ($2::uuid IS NULL OR membership_id = $2::uuid)
        ORDER BY created_at
          FOR UPDATE`,
      [this.hotelId, membershipId ?? null],
    );
    return result.rows.map((row) => mapDiscovery(row)!);
  }

  /** Records that the owning module could not answer. The marker stays open. */
  async recordAttempt(discoveryId: string, reason: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.work_handoff_discovery
          SET attempts = attempts + 1, last_error = $3, updated_at = now()
        WHERE hotel_id = $1 AND discovery_id = $2 AND state = 'PENDING'`,
      [this.hotelId, discoveryId, reason.slice(0, 500)],
    );
  }

  /** The work has been enumerated and its items exist. Terminal. */
  async complete(discoveryId: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.work_handoff_discovery
          SET state = 'COMPLETED', settled_at = now(),
              attempts = attempts + 1, last_error = NULL, updated_at = now()
        WHERE hotel_id = $1 AND discovery_id = $2 AND state = 'PENDING'`,
      [this.hotelId, discoveryId],
    );
    return result.rowCount === 1;
  }
}

export class HandoffRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  /**
   * Opens an item, or returns the one that is already open for this subject.
   *
   * The partial unique index on a non-terminal item per subject is the arbiter,
   * so two suspensions racing on the same shift produce one item.
   */
  async open(input: {
    subjectKind: HandoffSubjectKind;
    subjectRef: string;
    state: HandoffState;
    openedReason: 'suspension' | 'termination';
    previousActorMembershipId: string;
    restaurantId?: string | null;
    continuationOfItemId?: string | null;
  }): Promise<{ item: HandoffItemRow; created: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.work_handoff_item
         (hotel_id, restaurant_id, subject_kind, subject_ref, state, opened_reason,
          previous_actor_membership_id, continuation_of_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.restaurantId ?? null,
        input.subjectKind,
        input.subjectRef,
        input.state,
        input.openedReason,
        input.previousActorMembershipId,
        input.continuationOfItemId ?? null,
      ],
    );
    const created = mapItem(inserted.rows[0]);
    if (created !== undefined) return { item: created, created: true };

    const existing = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND subject_kind = $2 AND subject_ref = $3 AND state <> 'RESOLVED'`,
      [this.hotelId, input.subjectKind, input.subjectRef],
    );
    const found = mapItem(existing.rows[0]);
    if (found === undefined) throw new Error('the handoff item could neither be created nor found');
    return { item: found, created: false };
  }

  async lock(itemId: string): Promise<HandoffItemRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND item_id = $2
          FOR UPDATE`,
      [this.hotelId, itemId],
    );
    return mapItem(result.rows[0]);
  }

  async find(itemId: string): Promise<HandoffItemRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND item_id = $2`,
      [this.hotelId, itemId],
    );
    return mapItem(result.rows[0]);
  }

  async listOpen(): Promise<readonly HandoffItemRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.work_handoff_item
        WHERE hotel_id = $1 AND state <> 'RESOLVED'
        ORDER BY created_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapItem(row)!);
  }

  /**
   * Compare-and-set on `assignment_version` (doc 19 §8.4).
   *
   * Two Managers claiming one item both read version N; exactly one update
   * matches, and the loser sees zero rows rather than overwriting the winner.
   */
  async transition(input: {
    itemId: string;
    expectedVersion: number;
    state: HandoffState;
    claimantMembershipId?: string | null;
    assigneeMembershipId?: string | null;
    movementStarted?: boolean;
  }): Promise<boolean> {
    const assignments = ['state = $4', 'assignment_version = assignment_version + 1'];
    const values: unknown[] = [this.hotelId, input.itemId, input.expectedVersion, input.state];
    if (input.claimantMembershipId !== undefined) {
      values.push(input.claimantMembershipId);
      assignments.push(`claimant_membership_id = $${String(values.length)}`);
    }
    if (input.assigneeMembershipId !== undefined) {
      values.push(input.assigneeMembershipId);
      assignments.push(`assignee_membership_id = $${String(values.length)}`);
    }
    if (input.movementStarted !== undefined) {
      values.push(input.movementStarted);
      assignments.push(`movement_started = $${String(values.length)}`);
    }
    if (input.state === 'RESOLVED') assignments.push('resolved_at = now()');

    const result = await this.uow.query(
      `UPDATE platform.work_handoff_item
          SET ${assignments.join(', ')}
        WHERE hotel_id = $1 AND item_id = $2 AND assignment_version = $3`,
      values,
    );
    return result.rowCount === 1;
  }

  /**
   * Appends one movement record.
   *
   * `seq` is derived under the item's row lock, and the idempotency key is
   * unique per item, so a retried command records one event rather than two.
   */
  async appendEvent(input: {
    itemId: string;
    kind:
      | 'opened'
      | 'claimed'
      | 'released'
      | 'assigned'
      | 'resolved'
      | 'unassigned'
      | 'continuation_created';
    actorMembershipId?: string | null;
    previousAssigneeMembershipId?: string | null;
    newAssigneeMembershipId?: string | null;
    reason?: string | null;
    idempotencyKey: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `INSERT INTO platform.work_handoff_event
         (hotel_id, item_id, seq, kind, actor_membership_id,
          previous_assignee_membership_id, new_assignee_membership_id, reason, idempotency_key)
       SELECT $1, $2,
              coalesce(max(seq), 0) + 1,
              $3, $4, $5, $6, $7, $8
         FROM platform.work_handoff_event
        WHERE hotel_id = $1 AND item_id = $2
       ON CONFLICT DO NOTHING`,
      [
        this.hotelId,
        input.itemId,
        input.kind,
        input.actorMembershipId ?? null,
        input.previousAssigneeMembershipId ?? null,
        input.newAssigneeMembershipId ?? null,
        input.reason ?? null,
        input.idempotencyKey,
      ],
    );
    return result.rowCount === 1;
  }

  async history(itemId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT seq, kind, actor_membership_id, previous_assignee_membership_id,
              new_assignee_membership_id, reason, occurred_at
         FROM platform.work_handoff_event
        WHERE hotel_id = $1 AND item_id = $2
        ORDER BY seq`,
      [this.hotelId, itemId],
    );
    return result.rows;
  }
}
