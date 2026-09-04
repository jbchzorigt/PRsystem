/**
 * Room readiness for a new check-in (doc 05 §17.1, doc 22 §9, doc 26 §3.1;
 * `STAY-DEC-008`, `RC-DEC-017`).
 *
 * ```text
 * room_reusable =
 *   server_time >= actual_ready_not_before
 *   AND cleaning_state = CLEAN
 *   AND applicable_minibar_readiness = READY
 * ```
 *
 * Evaluated at an instant: the server's now for an ordinary check-in, the
 * chosen arrival for a backdated one — in which case every fact must be one
 * the history proves was already true then (doc 05 §19.2).
 */

export type CleaningState = 'CLEAN' | 'NEEDS_CLEANING' | 'CLEANING';
export type EntityState = 'ACTIVE' | 'RETIRING' | 'INACTIVE';

export interface ReadinessFacts {
  /** The instant the room is asked about. */
  readonly at: Date;
  readonly roomState: EntityState;
  readonly categoryState: EntityState;
  /** The cleaning state in force at `at`, or `null` when the room was never marked. */
  readonly cleaningStateAt: CleaningState | null;
  /** Whether a live stay occupies the room. */
  readonly occupied: boolean;
  /** `actual_checkout_at + snapshotted buffer` of the previous stay, if any. */
  readonly readyNotBefore: Date | null;
  /** The minibar module's own blockers for this room (doc 26 §3.1, doc 22 §9). */
  readonly minibarBlockers: readonly string[];
}

export type ReadinessBlocker =
  | 'ROOM_NOT_ACTIVE'
  | 'CATEGORY_NOT_ACTIVE'
  | 'ROOM_OCCUPIED'
  | 'CLEANING_BUFFER_PENDING'
  | 'NOT_CLEAN'
  | string;

export function readinessBlockers(facts: ReadinessFacts): readonly ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];
  if (facts.roomState !== 'ACTIVE') blockers.push('ROOM_NOT_ACTIVE');
  if (facts.categoryState !== 'ACTIVE') blockers.push('CATEGORY_NOT_ACTIVE');
  if (facts.occupied) blockers.push('ROOM_OCCUPIED');
  if (facts.readyNotBefore !== null && facts.at.getTime() < facts.readyNotBefore.getTime()) {
    blockers.push('CLEANING_BUFFER_PENDING');
  }
  if (facts.cleaningStateAt !== 'CLEAN') blockers.push('NOT_CLEAN');
  blockers.push(...facts.minibarBlockers);
  return blockers;
}

/**
 * doc 06 §4: `Цэвэрлэгээ шаардлагатай → Цэвэрлэж байгаа → Цэвэр` for a Cleaner
 * (25,000₮ / 30,000₮); `Цэвэрлэгээ шаардлагатай → Цэвэр` for the Manager of a
 * 20,000₮ hotel with no Cleaner. A completed checkout puts the room back to
 * `Цэвэрлэгээ шаардлагатай`.
 */
export function canTransitionCleaning(
  from: CleaningState | null,
  to: CleaningState,
  by: 'CLEANER' | 'MANAGER_P20' | 'SYSTEM',
): boolean {
  if (by === 'SYSTEM') return to === 'NEEDS_CLEANING';
  if (to === 'NEEDS_CLEANING') return false;
  if (by === 'MANAGER_P20') return to === 'CLEAN' && from !== 'CLEAN';
  // CLEANER
  if (to === 'CLEANING') return from === null || from === 'NEEDS_CLEANING';
  return from === null || from === 'NEEDS_CLEANING' || from === 'CLEANING';
}
