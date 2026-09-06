import { hotelLocalDate, instant, instantFromHotelLocal, localDate } from '@prsystem/time';

/**
 * The Restaurant's decisions, with nothing around them (doc 08 §§5, 8, 10, 20–22).
 *
 * Everything here is a pure function of values the caller has already read and
 * locked, so the rules that decide whether an order may be placed at all, what a
 * refund request is entitled to, and which SLA thresholds have passed cannot
 * drift between the command, the sweep and the callback that apply them.
 */

/** doc 08 §10: seven axes, and nothing collapsed into one status. */
export type OrderState = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export type FulfillmentState =
  | 'NOT_STARTED'
  | 'AWAITING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED_TO_ROOM'
  | 'HANDED_TO_RECEPTION'
  | 'PICKED_UP_BY_GUEST'
  | 'CANCELLED';

export type RestaurantPaymentState = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
export type RefundPolicy = 'NONE' | 'MANDATORY' | 'DISCRETIONARY';
export type RefundRequestState = 'NONE' | 'OPEN' | 'APPROVED' | 'REJECTED' | 'RESOLVED';
export type RestaurantRefundState = 'NONE' | 'PENDING' | 'REFUNDED' | 'FAILED';
export type HandoffMode = 'ROOM' | 'RECEPTION' | 'GUEST_PICKUP' | 'REFUND_REQUEST';

export const FULFILLMENT_TERMINAL: readonly FulfillmentState[] = [
  'DELIVERED_TO_ROOM',
  'HANDED_TO_RECEPTION',
  'PICKED_UP_BY_GUEST',
  'CANCELLED',
];

export function isFulfillmentTerminal(state: FulfillmentState): boolean {
  return FULFILLMENT_TERMINAL.includes(state);
}

/** doc 08 §22: the only four an acceptance may promise. */
export const ETA_CHOICES: readonly number[] = [15, 30, 45, 60];

export function isEtaChoice(minutes: number): boolean {
  return ETA_CHOICES.includes(minutes);
}

/** `RC-DEC-030`: acceptance warnings at five minutes and ten. */
export const ACCEPT_WARN_MINUTES = 5;
export const ACCEPT_ESCALATE_MINUTES = 10;

/** `RC-DEC-031`: request escalations at five, ten and thirty. */
export const REQUEST_WARN_MINUTES = 5;
export const REQUEST_ESCALATE_MINUTES = 10;
export const REQUEST_PAUSE_MINUTES = 30;

/** doc 08 §22: a promise that is fifteen minutes late opens a refund request. */
export const ETA_GRACE_MINUTES = 15;

/** The payment window an invoice gets, before the ordering close caps it. */
export const INVOICE_WINDOW_MINUTES = 15;

const MINUTE = 60_000;

// ---------------------------------------------------------------- the schedule

export interface DaySchedule {
  /** 0 = Sunday, as PostgreSQL's `EXTRACT(dow)` counts. */
  readonly weekday: number;
  readonly closed: boolean;
  /** `HH:MM` or `HH:MM:SS`, hotel-local wall clock. */
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

export interface DayOverride {
  /** `YYYY-MM-DD`, hotel-local. */
  readonly localDate: string;
  readonly closed: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

export interface OrderingWindow {
  readonly open: boolean;
  /** When the window this instant falls in closes. Present only when open. */
  readonly closesAt?: Date;
  /** The next opening, for the message doc 08 §5 requires when it is shut. */
  readonly nextOpensAt?: Date;
}

function parseWall(value: string): { hour: number; minute: number; second: number } {
  const [h, m, s] = value.split(':');
  return { hour: Number(h ?? '0'), minute: Number(m ?? '0'), second: Number(s ?? '0') };
}

function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

interface ResolvedDay {
  readonly closed: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

/** doc 08 §5: an override for a date outranks the weekly row for its weekday. */
export function dayFor(
  date: string,
  weekly: readonly DaySchedule[],
  overrides: readonly DayOverride[],
): ResolvedDay {
  const override = overrides.find((entry) => entry.localDate === date);
  if (override !== undefined) {
    return { closed: override.closed, opensAt: override.opensAt, closesAt: override.closesAt };
  }
  const row = weekly.find((entry) => entry.weekday === weekdayOf(date));
  if (row === undefined) return { closed: true, opensAt: null, closesAt: null };
  return { closed: row.closed, opensAt: row.opensAt, closesAt: row.closesAt };
}

/**
 * The instants a day's ordering window spans.
 *
 * `18:00–02:00` closes on the *next* calendar day, which is what makes an
 * overnight schedule work: the window is not "the times are out of order", it is
 * a window that crosses midnight, and it is resolved by adding a day to the
 * closing side rather than by comparing two wall clocks.
 */
export function windowOf(
  date: string,
  timeZone: string,
  day: ResolvedDay,
): { opens: Date; closes: Date } | undefined {
  if (day.closed || day.opensAt === null || day.closesAt === null) return undefined;
  const opens = parseWall(day.opensAt);
  const closes = parseWall(day.closesAt);
  const opensAt = instantFromHotelLocal(localDate(date), timeZone, opens);
  const overnight =
    closes.hour * 3600 + closes.minute * 60 + closes.second <=
    opens.hour * 3600 + opens.minute * 60 + opens.second;
  const closingDate = overnight ? shiftLocalDate(date, 1) : date;
  const closesAt = instantFromHotelLocal(localDate(closingDate), timeZone, closes);
  return { opens: new Date(opensAt.getTime()), closes: new Date(closesAt.getTime()) };
}

/**
 * Whether the restaurant is taking orders at this instant, and when it next is.
 *
 * Yesterday's window is considered as well as today's, because an overnight one
 * that opened at `18:00` is still open at `01:00` — and a guest ordering at one
 * in the morning is exactly the case the requirement calls out.
 */
export function orderingWindowAt(
  now: Date,
  timeZone: string,
  weekly: readonly DaySchedule[],
  overrides: readonly DayOverride[],
): OrderingWindow {
  const today = hotelLocalDate(instant(now), timeZone);
  for (const offset of [-1, 0]) {
    const date = shiftLocalDate(today, offset);
    const window = windowOf(date, timeZone, dayFor(date, weekly, overrides));
    if (window === undefined) continue;
    if (now.getTime() >= window.opens.getTime() && now.getTime() < window.closes.getTime()) {
      return { open: true, closesAt: window.closes };
    }
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = shiftLocalDate(today, offset);
    const window = windowOf(date, timeZone, dayFor(date, weekly, overrides));
    if (window === undefined) continue;
    if (window.opens.getTime() > now.getTime()) return { open: false, nextOpensAt: window.opens };
  }
  return { open: false };
}

/**
 * `RC-DEC-023`: an invoice never outlives the day's ordering close.
 *
 * The payment window is the shorter of the two, always — which is why a guest
 * who starts paying five minutes before closing gets five minutes, not fifteen.
 */
export function invoiceExpiry(now: Date, closesAt: Date): Date {
  const requested = new Date(now.getTime() + INVOICE_WINDOW_MINUTES * MINUTE);
  return requested.getTime() < closesAt.getTime() ? requested : closesAt;
}

// ------------------------------------------------------------------ the basket

export interface BasketLine {
  readonly itemId: string;
  readonly name: string;
  readonly unitPriceMnt: bigint;
  readonly quantity: number;
}

/** doc 08 §6: the total is the server's, recomputed from the menu rows. */
export function basketTotalMnt(lines: readonly BasketLine[]): bigint {
  return lines.reduce((total, line) => total + line.unitPriceMnt * BigInt(line.quantity), 0n);
}

// ------------------------------------------------------------------- the SLAs

export interface OrderFacts {
  readonly orderState: OrderState;
  readonly fulfillmentState: FulfillmentState;
  readonly paymentState: RestaurantPaymentState;
  readonly refundPolicy: RefundPolicy;
  readonly refundRequestState: RefundRequestState;
  readonly paymentConfirmedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly promisedReadyAt: Date | null;
  readonly refundRequestedAt: Date | null;
}

/**
 * `RC-DEC-030`: which acceptance thresholds have passed.
 *
 * Crossing one warns and opens an action. It cancels nothing and refunds
 * nothing — doc 08 §20 says so four times, and this function returning a flag
 * rather than a transition is that sentence in code.
 */
export interface AcceptanceSla {
  readonly warned: boolean;
  readonly escalated: boolean;
}

export function acceptanceSla(order: OrderFacts, now: Date): AcceptanceSla {
  if (order.paymentConfirmedAt === null || order.acceptedAt !== null) {
    return { warned: false, escalated: false };
  }
  const elapsed = now.getTime() - order.paymentConfirmedAt.getTime();
  return {
    warned: elapsed >= ACCEPT_WARN_MINUTES * MINUTE,
    escalated: elapsed >= ACCEPT_ESCALATE_MINUTES * MINUTE,
  };
}

export type RequestSource = 'GUEST' | 'RECEPTION' | 'CHECKOUT' | 'RESTAURANT_CANCEL';

export type RequestOutcome =
  | { readonly kind: 'mandatory'; readonly reason: 'PRE_ACCEPT_SLA' | 'RESTAURANT_CANCELLED' }
  | {
      readonly kind: 'discretionary';
      readonly reason: 'GUEST_REQUEST' | 'CHECKOUT_REFUND_REQUEST' | 'ETA_OVERDUE';
    }
  | { readonly kind: 'refused'; readonly reason: 'TOO_EARLY' | 'ALREADY_OPEN' | 'TERMINAL' };

/**
 * `REST-DEC-002`, decided at the instant the request commits.
 *
 * The rule is about *this moment*, not about the moment the button appeared: an
 * order accepted between the guest tapping and the transaction committing is an
 * accepted order, and the request it produces is discretionary. That is what
 * makes the row lock the whole of the race resolution — the loser re-reads and
 * gets a different, still-correct answer.
 */
export function requestOutcome(
  order: OrderFacts,
  source: RequestSource,
  now: Date,
): RequestOutcome {
  if (order.refundRequestState !== 'NONE') return { kind: 'refused', reason: 'ALREADY_OPEN' };
  if (order.paymentState !== 'PAID') return { kind: 'refused', reason: 'TERMINAL' };
  if (isFulfillmentTerminal(order.fulfillmentState)) {
    return { kind: 'refused', reason: 'TERMINAL' };
  }
  // doc 08 §22: the restaurant admitting it cannot fulfil the order owes the
  // whole amount back, whenever it says so.
  if (source === 'RESTAURANT_CANCEL') {
    return { kind: 'mandatory', reason: 'RESTAURANT_CANCELLED' };
  }
  if (order.acceptedAt === null) {
    if (order.paymentConfirmedAt === null) return { kind: 'refused', reason: 'TOO_EARLY' };
    const elapsed = now.getTime() - order.paymentConfirmedAt.getTime();
    // Before ten minutes the action does not exist yet — for the guest, for
    // Reception, and at checkout alike (doc 08 §20).
    if (elapsed < ACCEPT_ESCALATE_MINUTES * MINUTE) return { kind: 'refused', reason: 'TOO_EARLY' };
    return { kind: 'mandatory', reason: 'PRE_ACCEPT_SLA' };
  }
  // Accepted, so the restaurant may still refuse with a stated reason.
  if (source === 'CHECKOUT') return { kind: 'discretionary', reason: 'CHECKOUT_REFUND_REQUEST' };
  // doc 08 §22: fifteen minutes past the promise, the guest may ask.
  if (
    order.promisedReadyAt !== null &&
    now.getTime() >= order.promisedReadyAt.getTime() + ETA_GRACE_MINUTES * MINUTE
  ) {
    return { kind: 'discretionary', reason: 'ETA_OVERDUE' };
  }
  return { kind: 'refused', reason: 'TOO_EARLY' };
}

/**
 * `RC-DEC-023` / `REST-DEC-005`: a payment that lands after the order is over.
 *
 * The order is not reopened and never enters the production queue. What the
 * money creates is an obligation to give it back, whole.
 */
export type LateCaptureReason =
  | 'PAID_AFTER_INVOICE_EXPIRY'
  | 'RESTAURANT_INACTIVE_AT_PAYMENT'
  | 'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT';

export type CaptureOutcome =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'mandatory_refund'; readonly reason: LateCaptureReason }
  | { readonly kind: 'already_confirmed' };

export function captureOutcome(
  order: OrderFacts,
  context: {
    readonly linkActive: boolean;
    readonly itemsActive: boolean;
    readonly expired: boolean;
  },
): CaptureOutcome {
  if (order.paymentState === 'PAID') return { kind: 'already_confirmed' };
  if (context.expired || isFulfillmentTerminal(order.fulfillmentState)) {
    return { kind: 'mandatory_refund', reason: 'PAID_AFTER_INVOICE_EXPIRY' };
  }
  if (!context.linkActive) {
    return { kind: 'mandatory_refund', reason: 'RESTAURANT_INACTIVE_AT_PAYMENT' };
  }
  if (!context.itemsActive) {
    return { kind: 'mandatory_refund', reason: 'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT' };
  }
  return { kind: 'confirm' };
}

export interface RequestSla {
  readonly remindRestaurant: boolean;
  readonly escalateToHotel: boolean;
  readonly pauseLink: boolean;
}

/** `RC-DEC-031`: five, ten and thirty minutes from the committed request. */
export function requestSla(requestedAt: Date, now: Date): RequestSla {
  const elapsed = now.getTime() - requestedAt.getTime();
  return {
    remindRestaurant: elapsed >= REQUEST_WARN_MINUTES * MINUTE,
    escalateToHotel: elapsed >= REQUEST_ESCALATE_MINUTES * MINUTE,
    pauseLink: elapsed >= REQUEST_PAUSE_MINUTES * MINUTE,
  };
}

/**
 * `RC-DEC-031`: when the pause lifts.
 *
 * A refund that has actually reached the guest, or a discretionary request the
 * restaurant refused with a reason. A refund still `PENDING` or `FAILED` is not
 * a resolution, however long it has been either.
 */
export function requestResolved(order: OrderFacts): boolean {
  return order.refundRequestState === 'RESOLVED' || order.refundRequestState === 'REJECTED';
}

/** doc 08 §19: which real handover a recorded choice can become. */
export function terminalFor(mode: HandoffMode): FulfillmentState | undefined {
  switch (mode) {
    case 'ROOM':
      return 'DELIVERED_TO_ROOM';
    case 'RECEPTION':
      return 'HANDED_TO_RECEPTION';
    case 'GUEST_PICKUP':
      return 'PICKED_UP_BY_GUEST';
    case 'REFUND_REQUEST':
      // Not a handover at all: doc 08 §19 is explicit that the third option is
      // a request, and that Reception's choice is never itself terminal.
      return undefined;
  }
}

/** The fulfilment steps a restaurant may take, in the order doc 08 §10 fixes. */
const FULFILLMENT_ORDER: readonly FulfillmentState[] = [
  'AWAITING_ACCEPTANCE',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'OUT_FOR_DELIVERY',
];

/**
 * Whether a fulfilment step is forward.
 *
 * A terminal handover may be reached from any live state — a restaurant that
 * hands an order over at the counter never marked it `OUT_FOR_DELIVERY` — but
 * the live states themselves only ever advance.
 */
export function advancesFulfillment(from: FulfillmentState, to: FulfillmentState): boolean {
  if (isFulfillmentTerminal(from)) return false;
  if (isFulfillmentTerminal(to)) return true;
  const before = FULFILLMENT_ORDER.indexOf(from);
  const after = FULFILLMENT_ORDER.indexOf(to);
  return before >= 0 && after > before;
}

/** doc 08 §10: the order axis, derived from the two that move it. */
export function orderStateFor(
  fulfillment: FulfillmentState,
  payment: RestaurantPaymentState,
): OrderState {
  if (fulfillment === 'CANCELLED') return 'CANCELLED';
  if (
    fulfillment === 'DELIVERED_TO_ROOM' ||
    fulfillment === 'HANDED_TO_RECEPTION' ||
    fulfillment === 'PICKED_UP_BY_GUEST'
  ) {
    return 'COMPLETED';
  }
  return payment === 'PAID' ? 'CONFIRMED' : 'PENDING_PAYMENT';
}

/** A short, human-quotable order number. Unambiguous letters and digits only. */
const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function formatOrderNo(bytes: Uint8Array, length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ORDER_ALPHABET[(bytes[i] ?? 0) % ORDER_ALPHABET.length];
  }
  return out;
}

/** `RC-DEC-027`: five, and the two halves that share the allowance. */
export const MAX_GUEST_SESSIONS = 5;

export function accessAllowance(activeSessions: number, pendingCodes: number): number {
  return MAX_GUEST_SESSIONS - activeSessions - pendingCodes;
}
