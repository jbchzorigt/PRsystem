/**
 * The stock ledger vocabulary and the two arithmetic rules of doc 22
 * (`INV-DEC-002`…`005`), written once so the service and the tests agree.
 *
 * The database is the authority — the ledger trigger applies every movement
 * and recomputes the average — and these functions restate the same rules so
 * a test can hold the trigger to them.
 */

export const MOVEMENT_TYPES = [
  'OPENING',
  'PURCHASE',
  'TRANSFER_TO_ROOM',
  'RETURN_TO_WAREHOUSE',
  'GUEST_CONSUMPTION',
  'WASTE',
  'ADJUST_PLUS',
  'ADJUST_MINUS',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const LOCATIONS = ['WAREHOUSE', 'ROOM', 'TRANSFER'] as const;
export type Location = (typeof LOCATIONS)[number];

/** The correction kinds a Manager records with a reason (doc 22 §4). */
export const CORRECTION_TYPES = ['WASTE', 'ADJUST_PLUS', 'ADJUST_MINUS'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export function isCorrectionType(value: string): value is CorrectionType {
  return (CORRECTION_TYPES as readonly string[]).includes(value);
}

/** The location a movement of a given type names (doc 22 §4 table). */
export function locationOf(type: MovementType, roomId: string | undefined): Location {
  if (type === 'TRANSFER_TO_ROOM' || type === 'RETURN_TO_WAREHOUSE') return 'TRANSFER';
  if (type === 'OPENING' || type === 'PURCHASE') return 'WAREHOUSE';
  if (type === 'GUEST_CONSUMPTION') return 'ROOM';
  return roomId === undefined ? 'WAREHOUSE' : 'ROOM';
}

/** How a movement changes each location's balance: warehouse, room, hotel total. */
export function balanceEffect(
  type: MovementType,
  location: Location,
  quantity: number,
): { readonly warehouse: number; readonly room: number; readonly total: number } {
  switch (type) {
    case 'OPENING':
    case 'PURCHASE':
      return { warehouse: quantity, room: 0, total: quantity };
    case 'TRANSFER_TO_ROOM':
      return { warehouse: -quantity, room: quantity, total: 0 };
    case 'RETURN_TO_WAREHOUSE':
      return { warehouse: quantity, room: -quantity, total: 0 };
    case 'GUEST_CONSUMPTION':
      return { warehouse: 0, room: -quantity, total: -quantity };
    case 'WASTE':
    case 'ADJUST_MINUS':
      return location === 'WAREHOUSE'
        ? { warehouse: -quantity, room: 0, total: -quantity }
        : { warehouse: 0, room: -quantity, total: -quantity };
    case 'ADJUST_PLUS':
      return location === 'WAREHOUSE'
        ? { warehouse: quantity, room: 0, total: quantity }
        : { warehouse: 0, room: quantity, total: quantity };
  }
}

/**
 * The continuous weighted average (doc 22 §5), in integer MNT, rounded half up
 * once.
 *
 * `totalBefore` is the hotel's whole physical quantity — warehouse plus every
 * room — because the average is hotel-level: a transfer moves quantity between
 * locations and does not touch it. When nothing was held, or no cost had been
 * established, the incoming cost is the average.
 */
export function weightedAverageCost(input: {
  readonly totalBefore: number;
  readonly averageBefore: bigint | null;
  readonly quantity: number;
  readonly unitCost: bigint;
}): bigint {
  if (input.totalBefore <= 0 || input.averageBefore === null) return input.unitCost;
  const divisor = BigInt(input.totalBefore + input.quantity);
  const numerator =
    BigInt(input.totalBefore) * input.averageBefore + BigInt(input.quantity) * input.unitCost;
  return (numerator + divisor / 2n) / divisor;
}

/** One line of a target: what a version says a room should hold. */
export interface TargetLine {
  readonly productId: string;
  readonly targetQuantity: number;
}

/** One line of what a room holds, or what a Cleaner counted. */
export interface StockLine {
  readonly productId: string;
  readonly quantity: number;
}

/** One bounded instruction a reconciliation task carries (doc 26 §21). */
export interface TaskBound {
  readonly productId: string;
  readonly direction: 'TO_ROOM' | 'TO_WAREHOUSE';
  readonly maxQuantity: number;
  /** What the room should hold afterwards; `0` for a removal. */
  readonly targetQuantity: number;
}

/**
 * The delta between what a room holds and what the pinned target says
 * (doc 26 §§16–18): removed or excess stock goes back to the warehouse, added
 * or short stock comes from it, and a product already at target needs nothing.
 *
 * An empty target is the ON → OFF case: everything goes back.
 */
export function reconciliationBounds(
  held: readonly StockLine[],
  target: readonly TargetLine[],
): readonly TaskBound[] {
  const targets = new Map(target.map((line) => [line.productId, line.targetQuantity]));
  const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
  const bounds: TaskBound[] = [];
  for (const [productId, quantity] of holdings) {
    const wanted = targets.get(productId) ?? 0;
    if (quantity > wanted) {
      bounds.push({
        productId,
        direction: 'TO_WAREHOUSE',
        maxQuantity: quantity - wanted,
        targetQuantity: wanted,
      });
    }
  }
  for (const [productId, wanted] of targets) {
    const quantity = holdings.get(productId) ?? 0;
    if (quantity < wanted) {
      bounds.push({
        productId,
        direction: 'TO_ROOM',
        maxQuantity: wanted - quantity,
        targetQuantity: wanted,
      });
    }
  }
  return bounds.sort((a, b) => a.productId.localeCompare(b.productId));
}

/**
 * The Cleaner's count against what the ledger says the room holds
 * (doc 26 §18, §20): a difference is a variance the Manager resolves with a
 * reasoned waste or adjustment, never something the Cleaner settles.
 */
export function countVariances(
  held: readonly StockLine[],
  counted: readonly StockLine[],
): readonly { readonly productId: string; readonly held: number; readonly counted: number }[] {
  const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
  const counts = new Map(counted.map((line) => [line.productId, line.quantity]));
  const ids = new Set([...holdings.keys(), ...counts.keys()]);
  const variances = [];
  for (const productId of [...ids].sort()) {
    const h = holdings.get(productId) ?? 0;
    const c = counts.get(productId) ?? 0;
    if (h !== c) variances.push({ productId, held: h, counted: c });
  }
  return variances;
}

/**
 * Whether a room meets its target after reconciliation (doc 22 §6.2): every
 * target met is `FULL`; anything short is `SHORT`. Excess is not shortness, but
 * it is not "at target" either — an ON → OFF or a version switch removes it
 * before this is asked.
 */
export function statusAgainstTarget(
  held: readonly StockLine[],
  target: readonly TargetLine[],
): 'FULL' | 'SHORT' {
  const holdings = new Map(held.map((line) => [line.productId, line.quantity]));
  for (const line of target) {
    if ((holdings.get(line.productId) ?? 0) < line.targetQuantity) return 'SHORT';
  }
  return 'FULL';
}
