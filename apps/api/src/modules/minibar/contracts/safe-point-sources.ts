import type { DependencySource } from '../../catalog/contracts/dependency-sources';

/**
 * What has to be terminal before a room's configuration may be reconciled
 * (doc 26 §15, `RML-DEC-008`): the stay, its checkout and final payment, the
 * required minibar report, and every active-stay refill task.
 *
 * All four are owned by later phases, so each is named here the way the
 * catalog names its consumers, and probed the same way: a relation that does
 * not exist yet cannot hold a row, and that is evidence — the room has no
 * stay because there are no stays. When the owning phase creates its relation
 * it uses the column and predicate named here or updates the entry in the
 * same change; `minibar.dependency.test.ts` refuses a relation that exists
 * without its column.
 *
 * Phase 08 additionally calls `ConfigurationService.advanceScheduled` from the
 * transaction that records a checkout, so a change scheduled behind a stay is
 * re-evaluated the moment the stay ends rather than by polling.
 */
export const SAFE_POINT_SOURCES: readonly DependencySource[] = [
  {
    id: 'room.active_stay',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '08',
    relation: 'platform.stay',
    column: 'room_id',
    predicate: "state <> 'COMPLETED'",
    detail: 'a stay is in progress in this room',
  },
  {
    id: 'room.open_checkout',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '10',
    relation: 'platform.stay_folio',
    column: 'room_id',
    predicate: "state <> ALL (ARRAY['SETTLED', 'VOID'])",
    detail: 'a checkout or its final payment for this room is not settled',
  },
  {
    id: 'room.open_minibar_report',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '09',
    relation: 'platform.minibar_usage_report',
    column: 'room_id',
    predicate: "state <> ALL (ARRAY['SETTLED', 'CANCELLED'])",
    detail: 'a minibar usage report for this room is not terminal',
  },
  {
    id: 'room.open_refill_task',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '09',
    relation: 'platform.minibar_refill_task',
    column: 'room_id',
    predicate: "state <> ALL (ARRAY['COMPLETED', 'CANCELLED', 'IMPOSSIBLE'])",
    detail: 'an active-stay refill task for this room is not terminal',
  },
];

/**
 * The one reference an archive must respect beyond the rooms and changes it
 * can see itself: an active stay whose check-in pinned this exact version
 * (doc 26 §30.1). Phase 08 owns the relation.
 */
export const VERSION_STAY_SOURCE: DependencySource = {
  id: 'version.active_stay',
  entityKinds: ['MINIBAR_TEMPLATE'],
  kind: 'operational',
  owningPhase: '08',
  relation: 'platform.stay_minibar_snapshot',
  column: 'version_id',
  predicate:
    "EXISTS (SELECT 1 FROM platform.stay s WHERE s.stay_id = platform.stay_minibar_snapshot.stay_id AND s.state <> 'COMPLETED')",
  detail: 'an active stay pinned this version at check-in',
};
