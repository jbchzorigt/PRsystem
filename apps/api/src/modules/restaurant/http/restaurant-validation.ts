import { ApiError } from '@prsystem/contracts';
import type { DaySchedule, FulfillmentState, HandoffMode } from '../domain/restaurant';
import { ETA_CHOICES, isEtaChoice } from '../domain/restaurant';

/**
 * What a restaurant request accepts — and what it refuses to be told.
 *
 * The list below is the point: an order's price, its hotel, its stay and its
 * paid state are all decided on the server (doc 08 §§8, 11). A client that
 * names one of them is refused rather than quietly ignored, because a field
 * silently dropped today is a field silently honoured after a careless edit.
 */

const REJECTED_FIELDS = [
  'hotelid',
  'stayid',
  'roomid',
  'guestsessionid',
  'totalamountmnt',
  'unitpricemnt',
  'pricemnt',
  'paymentstate',
  'orderstate',
  'refundstate',
];

export function rejectServerOwnedFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (REJECTED_FIELDS.includes(key.toLowerCase())) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `${key} is determined by the server and is not accepted from the client`,
      );
    }
  }
}

/** A basket: items and quantities, and never a price. */
export function requireBasket(
  value: unknown,
): readonly { readonly itemId: string; readonly quantity: number }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'lines must be a non-empty array');
  }
  if (value.length > 50) {
    throw new ApiError('VALIDATION_FAILED', 'an order carries at most 50 lines');
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiError('VALIDATION_FAILED', 'each line must be an object');
    }
    const line = entry as Record<string, unknown>;
    rejectServerOwnedFields(line);
    const itemId = line['itemId'];
    const quantity = line['quantity'];
    if (typeof itemId !== 'string' || !UUID.test(itemId)) {
      throw new ApiError('VALIDATION_FAILED', 'each line names an itemId');
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'each quantity is a positive whole number');
    }
    if (quantity > 99) {
      throw new ApiError('VALIDATION_FAILED', 'a line carries at most 99 of one item');
    }
    return { itemId: itemId.toLowerCase(), quantity };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** doc 08 §22: an ETA is one of four, not any number of minutes. */
export function requireEta(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !isEtaChoice(value)) {
    throw new ApiError('VALIDATION_FAILED', `etaMinutes must be one of ${ETA_CHOICES.join(', ')}`);
  }
  return value;
}

const ADVANCEABLE: readonly FulfillmentState[] = [
  'PREPARING',
  'READY',
  'OUT_FOR_DELIVERY',
  'DELIVERED_TO_ROOM',
  'HANDED_TO_RECEPTION',
  'PICKED_UP_BY_GUEST',
];

/**
 * The state a restaurant may move an order to.
 *
 * `ACCEPTED` is not here: acceptance is its own command, because it also
 * promises an ETA. Neither is `CANCELLED`, for the same reason.
 */
export function requireFulfillmentTarget(value: unknown): FulfillmentState {
  if (typeof value !== 'string' || !ADVANCEABLE.includes(value as FulfillmentState)) {
    throw new ApiError('VALIDATION_FAILED', `to must be one of ${ADVANCEABLE.join(', ')}`);
  }
  return value as FulfillmentState;
}

const HANDOFFS: readonly HandoffMode[] = ['ROOM', 'RECEPTION', 'GUEST_PICKUP'];

export function requireHandoff(value: unknown): HandoffMode {
  if (typeof value !== 'string' || !HANDOFFS.includes(value as HandoffMode)) {
    throw new ApiError('VALIDATION_FAILED', `mode must be one of ${HANDOFFS.join(', ')}`);
  }
  return value as HandoffMode;
}

export function requireDecision(value: unknown): 'APPROVE' | 'REJECT' {
  if (value !== 'APPROVE' && value !== 'REJECT') {
    throw new ApiError('VALIDATION_FAILED', 'decision must be APPROVE or REJECT');
  }
  return value;
}

const REJECT_REASONS = [
  'PREPARATION_STARTED',
  'FOOD_READY',
  'OUT_FOR_DELIVERY',
  'HANDED_OVER',
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

/** doc 08 §21: a rejection states which of the four stages it rests on. */
export function optionalRejectReason(value: unknown): RejectReason | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !REJECT_REASONS.includes(value as RejectReason)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `rejectReason must be one of ${REJECT_REASONS.join(', ')}`,
    );
  }
  return value as RejectReason;
}

export function requireLinkState(value: unknown): 'ACTIVE' | 'INACTIVE' {
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    throw new ApiError('VALIDATION_FAILED', 'linkState must be ACTIVE or INACTIVE');
  }
  return value;
}

const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function requireWallTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !WALL_TIME.test(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a wall-clock time, HH:MM`);
  }
  return value.length === 5 ? `${value}:00` : value;
}

export function requireLocalDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a date, YYYY-MM-DD`);
  }
  return value;
}

/** The week's hours. A day is closed and has no times, or open and has both. */
export function requireWeek(value: unknown): readonly DaySchedule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    throw new ApiError('VALIDATION_FAILED', 'days must hold between one and seven entries');
  }
  const seen = new Set<number>();
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiError('VALIDATION_FAILED', 'each day must be an object');
    }
    const day = entry as Record<string, unknown>;
    const weekday = day['weekday'];
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new ApiError('VALIDATION_FAILED', 'weekday is 0 (Sunday) to 6');
    }
    if (seen.has(weekday)) {
      throw new ApiError('VALIDATION_FAILED', 'a weekday appears twice');
    }
    seen.add(weekday);
    const closed = day['closed'];
    if (typeof closed !== 'boolean') {
      throw new ApiError('VALIDATION_FAILED', 'closed must be true or false');
    }
    if (closed) return { weekday, closed, opensAt: null, closesAt: null };
    return {
      weekday,
      closed,
      opensAt: requireWallTime(day['opensAt'], 'opensAt'),
      closesAt: requireWallTime(day['closesAt'], 'closesAt'),
    };
  });
}

/** A price in whole tögrög, carried as a string so no float ever touches it. */
export function requirePriceMnt(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'priceMnt must be a whole number of tögrög, sent as a string',
    );
  }
  return BigInt(value);
}

/** The shape the database enforces, refused here with a sentence instead. */
export function requireContactPhone(value: unknown): string {
  if (typeof value !== 'string' || !/^\+976[0-9]{8}$/.test(value.trim())) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'contactPhone must be a Mongolian number in +976######## form',
    );
  }
  return value.trim();
}

/** The one-time code. Digits only, and never echoed back to the caller. */
export function requireAccessCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4,6}$/.test(value)) {
    throw new ApiError('UNAUTHENTICATED', 'that code did not work');
  }
  return value;
}

export function requireRoomToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 200) {
    throw new ApiError('UNAUTHENTICATED', 'that code did not work');
  }
  return value;
}

export function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 500) {
    throw new ApiError('VALIDATION_FAILED', 'note must be a short string');
  }
  return value;
}

export function optionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 300) {
    throw new ApiError('VALIDATION_FAILED', 'reason must be a short string');
  }
  return value;
}

export function optionalSortOrder(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9999) {
    throw new ApiError('VALIDATION_FAILED', 'sortOrder must be a small whole number');
  }
  return value;
}

export function requireMicro(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be an integer in micro-degrees`);
  }
  const limit = field === 'latitudeMicro' ? 90_000_000 : 180_000_000;
  if (value < -limit || value > limit) {
    throw new ApiError('VALIDATION_FAILED', `${field} is outside the world`);
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError('VALIDATION_FAILED', `${field} must be true or false`);
  }
  return value;
}
