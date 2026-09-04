import type { EntityKind } from '../domain/lifecycle';

/**
 * Every consumer that may hold a reference to a catalog entity, and where that
 * reference will live (`RML-DEC-002`, `RML-DEC-003`, `RML-DEC-005`, doc 26 §§4–8).
 *
 * This registry is the phase's answer to a question a lifecycle command cannot
 * avoid: *what still depends on this entity?* Most of the consumers arrive in
 * later phases, and the tempting shortcut — assume "no rows" for anything not
 * built yet — turns a missing integration into a silent "no blockers". So each
 * source names the relation its owning phase will create, and the probe reports
 * three distinct answers:
 *
 *  - `blocked` — the relation exists and holds matching rows;
 *  - `clear` — the relation exists and holds none;
 *  - `not_yet_provisioned` — the relation does not exist yet, so it can hold no
 *    row at all. That is evidence, not an assumption, and it is reported to the
 *    caller rather than folded into `clear`.
 *
 * A probe that fails for any other reason makes the command fail closed.
 *
 * **The integration duty.** When the owning phase creates its aggregate it must
 * either use the relation and column named here or update this entry in the same
 * change. `catalog.dependency.test.ts` holds every entry to a declared owning
 * phase and to the live schema, so an entry can neither be dropped nor left
 * pointing at nothing without a test saying so.
 */
export interface DependencySource {
  /** Stable id, used in blocker facts and in the API response. */
  readonly id: string;
  readonly entityKinds: readonly EntityKind[];
  /**
   * `operational` blocks the transition to `INACTIVE`; `historical` never does,
   * and blocks only a hard delete (doc 26 §8, `RML-DEC-004`).
   */
  readonly kind: 'operational' | 'historical';
  /** The phase that owns the relation. `06` means it exists now. */
  readonly owningPhase: string;
  /** `schema.table` the reference lives in. */
  readonly relation: string;
  /** The column naming the catalog entity. */
  readonly column: string;
  /** An additional predicate: which rows are a blocker rather than history. */
  readonly predicate?: string;
  /** What an operator is told when this source blocks. */
  readonly detail: string;
}

export const DEPENDENCY_SOURCES: readonly DependencySource[] = [
  // ------------------------------------------------------------- Phase 06
  {
    id: 'category.child_room',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'operational',
    owningPhase: '06',
    relation: 'platform.room',
    column: 'category_id',
    // doc 26 §5: the child rooms must have moved to another active category or
    // become inactive themselves before the category can.
    predicate: "state <> 'INACTIVE'",
    detail: 'rooms still assigned to this category are not inactive',
  },
  {
    id: 'category.room_history',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'historical',
    owningPhase: '06',
    relation: 'platform.room',
    column: 'category_id',
    // Any room, in any state: a category that ever had a room assigned has been
    // in operational use, and the composite foreign key on `platform.room` is
    // the database's own refusal of the delete (doc 26 §8).
    detail: 'rooms have been assigned to this category',
  },
  {
    id: 'category.rate_snapshot',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'historical',
    owningPhase: '06',
    relation: 'platform.stay_rate_snapshot',
    column: 'category_id',
    detail: 'a confirmed price was captured against this category',
  },
  {
    id: 'room.rate_snapshot',
    entityKinds: ['ROOM'],
    kind: 'historical',
    owningPhase: '06',
    relation: 'platform.stay_rate_snapshot',
    column: 'room_id',
    detail: 'a confirmed price was captured against this room',
  },

  // ------------------------------------------------------------- Phase 07
  {
    id: 'room.minibar_configuration',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_minibar_configuration',
    column: 'room_id',
    // doc 26 §4: a minibar-enabled room reconciles its stock and configuration
    // before it can be inactive; a room whose minibar is off has nothing left.
    predicate: "mode = 'ON'",
    detail: 'the room still carries a minibar configuration',
  },
  {
    id: 'room.pending_configuration_change',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_configuration_change',
    column: 'room_id',
    predicate: "state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])",
    detail: 'a configuration change of this room has not reached a terminal state',
  },
  {
    id: 'template.room_assignment',
    entityKinds: ['MINIBAR_TEMPLATE'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_minibar_configuration',
    column: 'template_id',
    detail: 'rooms are still configured with this template',
  },
  {
    id: 'template.pending_target',
    entityKinds: ['MINIBAR_TEMPLATE'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_configuration_change',
    column: 'target_template_id',
    predicate: "state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])",
    detail: 'a pending configuration change targets this template',
  },
  {
    id: 'product.template_version_item',
    entityKinds: ['MINIBAR_PRODUCT'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.minibar_template_version_item',
    column: 'product_id',
    // doc 26 §6: a product may not leave an *active* configuration — a version
    // some room is on, or one a pending change is pinned to. A listing in a
    // draft or an archived version, or in a published version no room uses,
    // is history and is the next entry's business.
    predicate: `version_id IN (
      SELECT current_version_id FROM platform.room_minibar_configuration
       WHERE current_version_id IS NOT NULL
      UNION
      SELECT target_version_id FROM platform.room_configuration_change
       WHERE target_version_id IS NOT NULL
         AND state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK']))`,
    detail: 'the product is still listed by a template version in active use',
  },
  {
    id: 'product.template_version_history',
    entityKinds: ['MINIBAR_PRODUCT'],
    kind: 'historical',
    owningPhase: '07',
    relation: 'platform.minibar_template_version_item',
    column: 'product_id',
    detail: 'the product is listed by a template version',
  },
  {
    id: 'template.version',
    entityKinds: ['MINIBAR_TEMPLATE'],
    kind: 'historical',
    owningPhase: '07',
    relation: 'platform.minibar_template_version',
    column: 'template_id',
    detail: 'published versions of this template exist',
  },
  {
    id: 'product.room_stock',
    entityKinds: ['MINIBAR_PRODUCT'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_minibar_stock',
    column: 'product_id',
    predicate: 'quantity > 0',
    detail: 'stock of this product is still in a room',
  },
  {
    id: 'room.minibar_stock',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '07',
    relation: 'platform.room_minibar_stock',
    column: 'room_id',
    predicate: 'quantity > 0',
    detail: 'the room still holds minibar stock',
  },
  {
    id: 'product.inventory_movement',
    entityKinds: ['MINIBAR_PRODUCT'],
    kind: 'historical',
    owningPhase: '07',
    relation: 'platform.inventory_movement',
    column: 'product_id',
    detail: 'the product appears in the immutable movement ledger',
  },
  {
    id: 'product.refill_task',
    entityKinds: ['MINIBAR_PRODUCT'],
    kind: 'operational',
    // doc 22 §6.3: a refill is raised against an active stay, so the task
    // relation is Phase 09's, with the stay it needs (doc 26 §22).
    owningPhase: '09',
    relation: 'platform.minibar_refill_task',
    column: 'product_id',
    predicate: "state NOT IN ('COMPLETED', 'CANCELLED', 'IMPOSSIBLE')",
    detail: 'a refill task for this product has not reached a terminal state',
  },

  // ------------------------------------------------------------- Phase 08
  {
    id: 'room.active_stay',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '08',
    relation: 'platform.stay',
    column: 'room_id',
    predicate: "state = 'ACTIVE'",
    detail: 'a stay is in progress in this room',
  },
  {
    id: 'category.active_stay',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'operational',
    owningPhase: '08',
    relation: 'platform.stay',
    column: 'category_id',
    predicate: "state = 'ACTIVE'",
    detail: 'a stay in this category is in progress',
  },
  {
    id: 'room.stay_history',
    entityKinds: ['ROOM'],
    kind: 'historical',
    owningPhase: '08',
    relation: 'platform.stay',
    column: 'room_id',
    detail: 'the room appears in stay history',
  },
  {
    id: 'category.stay_history',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'historical',
    owningPhase: '08',
    relation: 'platform.stay',
    column: 'category_id',
    detail: 'the category appears in stay history',
  },

  // ------------------------------------------------------------- Phase 09
  {
    id: 'room.cleaning_task',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '09',
    relation: 'platform.cleaning_task',
    column: 'room_id',
    predicate: "state NOT IN ('COMPLETED', 'CANCELLED')",
    detail: 'a cleaning or checkout task for this room is still open',
  },

  // ------------------------------------------------------------- Phase 13
  {
    id: 'room.future_booking',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '13',
    relation: 'platform.booking',
    column: 'assigned_room_id',
    predicate: "state = 'CONFIRMED'",
    detail: 'a confirmed booking is assigned to this room',
  },
  {
    id: 'category.future_booking',
    entityKinds: ['ROOM_CATEGORY'],
    kind: 'operational',
    owningPhase: '13',
    relation: 'platform.booking',
    column: 'category_id',
    predicate: "state = 'CONFIRMED'",
    detail: 'a confirmed booking holds inventory in this category',
  },
];

export function sourcesFor(kind: EntityKind): readonly DependencySource[] {
  return DEPENDENCY_SOURCES.filter((source) => source.entityKinds.includes(kind));
}
