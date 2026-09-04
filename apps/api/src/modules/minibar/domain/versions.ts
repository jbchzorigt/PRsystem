/**
 * Template versions (`RML-DEC-015`…`021`, doc 26 §§24–32) and multi-room
 * batches (`RML-DEC-025`…`028`, doc 26 §36), as pure rules.
 */

export const VERSION_STATES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type VersionState = (typeof VERSION_STATES)[number];

const VERSION_EDGES: Readonly<Record<VersionState, readonly VersionState[]>> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionVersion(from: VersionState, to: VersionState): boolean {
  return VERSION_EDGES[from].includes(to);
}

export interface PublishCandidateItem {
  readonly productId: string;
  readonly targetQuantity: number;
  /** As read from the product row inside the transaction. */
  readonly productState: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly productHotelId: string;
  /** Whether the product's selling price has been stated. */
  readonly priced: boolean;
}

export interface PublishRefusal {
  readonly code:
    | 'PARENT_NOT_ACTIVE'
    | 'NO_ITEMS'
    | 'PRODUCT_NOT_ACTIVE'
    | 'PRODUCT_FOREIGN'
    | 'PRODUCT_DUPLICATE'
    | 'TARGET_NOT_POSITIVE'
    | 'PRODUCT_UNPRICED';
  readonly productId?: string;
}

/**
 * doc 26 §27.1 / `RML-DEC-018`: every rule is checked and every failure is
 * reported, so the Manager sees the whole list rather than the first refusal.
 * An unpriced product is added to the document's list because a published
 * version is what a check-in price book is built from (`PRICE-DEC-001`), and
 * a price that was never stated cannot be snapshotted.
 */
export function publishRefusals(input: {
  readonly parentState: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly hotelId: string;
  readonly items: readonly PublishCandidateItem[];
}): readonly PublishRefusal[] {
  const refusals: PublishRefusal[] = [];
  if (input.parentState !== 'ACTIVE') refusals.push({ code: 'PARENT_NOT_ACTIVE' });
  if (input.items.length === 0) refusals.push({ code: 'NO_ITEMS' });
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.productId)) {
      refusals.push({ code: 'PRODUCT_DUPLICATE', productId: item.productId });
    }
    seen.add(item.productId);
    if (item.productHotelId !== input.hotelId) {
      refusals.push({ code: 'PRODUCT_FOREIGN', productId: item.productId });
    }
    if (item.productState !== 'ACTIVE') {
      refusals.push({ code: 'PRODUCT_NOT_ACTIVE', productId: item.productId });
    }
    if (!Number.isInteger(item.targetQuantity) || item.targetQuantity < 1) {
      refusals.push({ code: 'TARGET_NOT_POSITIVE', productId: item.productId });
    }
    if (!item.priced) refusals.push({ code: 'PRODUCT_UNPRICED', productId: item.productId });
  }
  return refusals;
}

// ------------------------------------------------------------------ batches

export const CHANGE_STATES = [
  'SCHEDULED_AFTER_STAY',
  'READY_FOR_RECONCILIATION',
  'IN_PROGRESS',
  'BLOCKED_STOCK',
  'BLOCKED_VARIANCE',
  'APPLIED',
  'CANCELLED',
  'ROLLBACK_REQUIRED',
  'ROLLED_BACK',
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export const TERMINAL_CHANGE_STATES: readonly ChangeState[] = [
  'APPLIED',
  'CANCELLED',
  'ROLLED_BACK',
];

export function isTerminalChange(state: ChangeState): boolean {
  return TERMINAL_CHANGE_STATES.includes(state);
}

export const BATCH_STATES = [
  'IN_PROGRESS',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'CANCELLED',
  'FAILED_VALIDATION',
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

export interface BatchChild {
  readonly result: 'ACCEPTED' | 'SKIPPED';
  /** The change's state; absent for a skipped room. */
  readonly changeState?: ChangeState;
  /** Whether a movement had been posted before the change went terminal. */
  readonly movementStarted?: boolean;
}

/**
 * doc 26 §36.3, as the mutually exclusive conditions the document requires
 * rather than a first-match walk down its table.
 *
 *  - `FAILED_VALIDATION`: no room was accepted;
 *  - `IN_PROGRESS`: an accepted child is not terminal;
 *  - `COMPLETED`: every room was accepted and every child is `APPLIED`;
 *  - `CANCELLED`: at least one accepted, every accepted child `CANCELLED`
 *    before any movement;
 *  - `PARTIALLY_COMPLETED`: every accepted child terminal, and none of the above.
 */
export function deriveBatchState(children: readonly BatchChild[]): BatchState {
  const accepted = children.filter((child) => child.result === 'ACCEPTED');
  if (accepted.length === 0) return 'FAILED_VALIDATION';
  if (
    accepted.some(
      (child) => child.changeState === undefined || !isTerminalChange(child.changeState),
    )
  ) {
    return 'IN_PROGRESS';
  }
  if (
    accepted.length === children.length &&
    accepted.every((child) => child.changeState === 'APPLIED')
  ) {
    return 'COMPLETED';
  }
  if (
    accepted.every((child) => child.changeState === 'CANCELLED' && child.movementStarted !== true)
  ) {
    return 'CANCELLED';
  }
  return 'PARTIALLY_COMPLETED';
}

/** The read-only classification of one room in a Rollout preview (doc 26 §36.1). */
export type EligibilityCode =
  | 'ROOM_NOT_ACTIVE'
  | 'MINIBAR_OFF'
  | 'DIFFERENT_TEMPLATE'
  | 'ALREADY_ON_TARGET'
  | 'PENDING_CHANGE'
  | 'TARGET_NOT_PUBLISHED'
  | 'TARGET_TEMPLATE_NOT_ACTIVE'
  | 'TARGET_PRODUCT_NOT_ACTIVE';

export interface RoomEligibilityFacts {
  readonly roomState: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly mode: 'ON' | 'OFF';
  readonly currentTemplateId: string | null;
  readonly currentVersionId: string | null;
  readonly hasPendingChange: boolean;
  /** Whether the room's safe point is met right now (no active stay, nothing unfinished). */
  readonly safePoint: boolean;
}

export interface TargetFacts {
  readonly templateId: string;
  readonly versionId: string;
  readonly versionState: VersionState;
  readonly templateState: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly everyProductActive: boolean;
}

export type Eligibility =
  | { readonly kind: 'READY_NOW' }
  | { readonly kind: 'SCHEDULE_AFTER_STAY' }
  | { readonly kind: 'INELIGIBLE'; readonly code: EligibilityCode };

/** doc 26 §33.1: all six conditions, in the order the document states them. */
export function rolloutEligibility(room: RoomEligibilityFacts, target: TargetFacts): Eligibility {
  if (target.versionState !== 'PUBLISHED')
    return { kind: 'INELIGIBLE', code: 'TARGET_NOT_PUBLISHED' };
  if (target.templateState !== 'ACTIVE') {
    return { kind: 'INELIGIBLE', code: 'TARGET_TEMPLATE_NOT_ACTIVE' };
  }
  if (!target.everyProductActive) return { kind: 'INELIGIBLE', code: 'TARGET_PRODUCT_NOT_ACTIVE' };
  if (room.roomState !== 'ACTIVE') return { kind: 'INELIGIBLE', code: 'ROOM_NOT_ACTIVE' };
  if (room.mode !== 'ON') return { kind: 'INELIGIBLE', code: 'MINIBAR_OFF' };
  if (room.currentTemplateId !== target.templateId) {
    return { kind: 'INELIGIBLE', code: 'DIFFERENT_TEMPLATE' };
  }
  if (room.currentVersionId === target.versionId) {
    return { kind: 'INELIGIBLE', code: 'ALREADY_ON_TARGET' };
  }
  if (room.hasPendingChange) return { kind: 'INELIGIBLE', code: 'PENDING_CHANGE' };
  return room.safePoint ? { kind: 'READY_NOW' } : { kind: 'SCHEDULE_AFTER_STAY' };
}
