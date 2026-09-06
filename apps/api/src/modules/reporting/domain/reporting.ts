import { hotelLocalDate, instant } from '@prsystem/time';

/**
 * What the guest registry and the financial dashboard actually compute
 * (doc 12 §§4–8, doc 23 §§2–7).
 *
 * Pure, and every function here is one sentence from those documents. Two
 * groups matter most.
 *
 * **The registry's rules are about time and shape.** A mandatory date range
 * that defaults to thirty days and may not exceed the retention period; three
 * page sizes and no others; an age taken from a date of birth on a hotel-local
 * date, and never guessed.
 *
 * **The dashboard's rules are about not mixing things up.** doc 23 §1 says the
 * whole purpose is to stop confirmed sales, money actually received, receivables
 * and deposits from being reported as one another. So they are computed here as
 * separate values from separate inputs, and the one derived figure — the
 * operating result — subtracts COGS rather than purchases, because
 * `FIN-DEC-004` says the same money must not be deducted twice.
 */

// --------------------------------------------------------------- the registry

/** `GUEST-DEC-005`: twenty by default, and only these three. */
export const PAGE_SIZES: readonly number[] = [20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;
/** doc 12 §8: the default window is the last thirty calendar days, inclusive. */
export const DEFAULT_RANGE_DAYS = 30;
/** `GUEST-DEC-008`: the MVP product default, and the longest range allowed. */
export const DEFAULT_RETENTION_DAYS = 365;
/** `GUEST-DEC-006`: one export, ten thousand rows, and never a partial file. */
export const EXPORT_ROW_CAP = 10_000;
/** `GUEST-DEC-007`: the file's life, and the URL's. */
export const EXPORT_FILE_TTL_MINUTES = 60;
export const EXPORT_URL_TTL_MINUTES = 5;

const DAY_MS = 86_400_000;

export function isPageSize(value: number): boolean {
  return PAGE_SIZES.includes(value);
}

/**
 * doc 12 §4: the row number a page starts at, in the *whole* filtered result.
 *
 * One-based, because the column is `Дэс дугаар` and a guest list starting at
 * zero would be a database index by another name.
 */
export function firstRowNumber(page: number, pageSize: number): number {
  return (page - 1) * pageSize + 1;
}

export function totalPages(totalRows: number, pageSize: number): number {
  if (totalRows <= 0) return 0;
  return Math.ceil(totalRows / pageSize);
}

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * doc 12 §8: the default range — today and the twenty-nine days before it, in
 * the hotel's own timezone, as a half-open `[from, to)` instant interval.
 *
 * Half-open because every other interval in this platform is: a stay that began
 * at the last instant of the range belongs to it, and one that began at the
 * first instant of the next day does not.
 */
export function defaultRange(now: Date, timeZone: string, days = DEFAULT_RANGE_DAYS): DateRange {
  const today = hotelLocalDate(instant(now), timeZone);
  const to = startOfLocalDay(addLocalDays(today, 1), timeZone);
  const from = startOfLocalDay(addLocalDays(today, -(days - 1)), timeZone);
  return { from, to };
}

/** A `YYYY-MM-DD` local date pair, read as the same half-open interval. */
export function rangeOfLocalDates(from: string, to: string, timeZone: string): DateRange {
  return {
    from: startOfLocalDay(from, timeZone),
    to: startOfLocalDay(addLocalDays(to, 1), timeZone),
  };
}

export type RangeRefusal = 'INVERTED' | 'TOO_LONG';

/**
 * doc 12 §8: the range is mandatory, ordered, and no longer than retention.
 *
 * A longer window is refused rather than truncated: doc 12 is explicit that a
 * report must not reach data the retention policy says is gone.
 */
export function refuseRange(
  range: DateRange,
  retentionDays = DEFAULT_RETENTION_DAYS,
): RangeRefusal | undefined {
  if (range.to.getTime() <= range.from.getTime()) return 'INVERTED';
  if (range.to.getTime() - range.from.getTime() > retentionDays * DAY_MS) return 'TOO_LONG';
  return undefined;
}

/**
 * `GUEST-DEC-003`: whole years completed, on the hotel-local date of the
 * effective check-in.
 *
 * Snapshotted at check-in and never recomputed: doc 12 §6 says a historical age
 * must not change because somebody opened the report later. `undefined` is
 * `Тодорхойгүй` — a missing or unusable date of birth is never guessed at.
 */
export function ageOn(dateOfBirth: string | null, localDate: string): number | undefined {
  if (dateOfBirth === null) return undefined;
  const born = parseLocalDate(dateOfBirth);
  const on = parseLocalDate(localDate);
  if (born === undefined || on === undefined) return undefined;
  let age = on.year - born.year;
  if (on.month < born.month || (on.month === born.month && on.day < born.day)) age -= 1;
  if (age < 0 || age > 150) return undefined;
  return age;
}

/** doc 12 §8: the search is trimmed, and a search of only spaces is no search. */
export function normalizeSearch(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// -------------------------------------------------------------- the dashboard

/** doc 23 §6.1: the three ranges the dashboard offers. */
export type QuickRange = 'LAST_7_DAYS' | 'THIS_MONTH' | 'CUSTOM';

/** doc 23 §6.1: today and the six days before it, hotel-local. */
export function lastSevenDays(now: Date, timeZone: string): DateRange {
  return defaultRange(now, timeZone, 7);
}

/** doc 23 §6.1: the first of this month to the end of today, hotel-local. */
export function thisMonth(now: Date, timeZone: string): DateRange {
  const today = hotelLocalDate(instant(now), timeZone);
  const first = `${today.slice(0, 7)}-01`;
  return {
    from: startOfLocalDay(first, timeZone),
    to: startOfLocalDay(addLocalDays(today, 1), timeZone),
  };
}

export interface SalesFigures {
  /** doc 23 §2.1: finalized charges, whether or not they were paid. */
  readonly grossSalesMnt: bigint;
  readonly discountMnt: bigint;
  readonly reversalMnt: bigint;
}

/** doc 23 §2.1: gross less discounts, waivers and sales reversals. */
export function netSalesMnt(sales: SalesFigures): bigint {
  return sales.grossSalesMnt - sales.discountMnt - sales.reversalMnt;
}

export interface ReceivedFigures {
  /** Successful service payments only. Pending and failed are not money. */
  readonly successfulPaymentsMnt: bigint;
  readonly successfulRefundsMnt: bigint;
}

/** doc 23 §2.2: what actually arrived, less what actually went back. */
export function receivedMnt(received: ReceivedFigures): bigint {
  return received.successfulPaymentsMnt - received.successfulRefundsMnt;
}

/**
 * doc 23 §2.3: what is still owed, and never a negative.
 *
 * An overpayment or a refundable deposit is a liability, not a negative
 * receivable, so the floor is zero and the excess is reported on its own.
 */
export function receivableMnt(input: {
  readonly netSalesMnt: bigint;
  readonly paymentAllocationMnt: bigint;
  readonly depositAllocationMnt: bigint;
}): bigint {
  const owed = input.netSalesMnt - input.paymentAllocationMnt - input.depositAllocationMnt;
  return owed > 0n ? owed : 0n;
}

/** doc 23 §3.1: quantity sold times the weighted-average cost snapshot. */
export function cogsMnt(lines: readonly { quantity: number; unitCostMnt: bigint }[]): bigint {
  return lines.reduce((total, line) => total + BigInt(line.quantity) * line.unitCostMnt, 0n);
}

/**
 * doc 23 §3.2: the operating result, and the name it is not allowed to have.
 *
 * `FIN-DEC-004`: minibar cost enters as COGS, not as the purchase — deducting
 * both would take the same money out twice. The inventory purchase is a cash
 * outflow and is reported as one, on its own card.
 */
export function operatingResultMnt(input: {
  readonly netSalesMnt: bigint;
  readonly minibarCogsMnt: bigint;
  readonly paidOperatingExpenseMnt: bigint;
}): bigint {
  return input.netSalesMnt - input.minibarCogsMnt - input.paidOperatingExpenseMnt;
}

/**
 * A margin in integer basis points, or `undefined` for doc 23's `N/A`.
 *
 * Basis points rather than a float, and `undefined` rather than zero: a hotel
 * with no sales has no margin, and reporting `0%` would be a claim it did not
 * make. Rounded half-up on a possibly negative numerator, which is why the sign
 * is handled before the rounding rather than after.
 */
export function marginBps(numerator: bigint, denominator: bigint): number | undefined {
  if (denominator <= 0n) return undefined;
  const scaled = numerator * 10_000n;
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return Number(negative ? -rounded : rounded);
}

/** A margin as a percentage string, from the integer the server computed. */
export function formatMargin(bps: number | undefined): string {
  if (bps === undefined) return 'N/A';
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}

export interface RoomDemandRow {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly completedStays: number;
  readonly roomNetSalesMnt: bigint;
}

/**
 * `FIN-DEC-007`: the top five rooms by demand.
 *
 * Completed, non-cancelled stays whose actual checkout fell in the range. Ties
 * break on room net sales and then on the room number, so the list is stable
 * between two calls that see the same data — a report whose order wobbled would
 * be unusable for the comparison it exists to support.
 */
export function topByDemand<T extends RoomDemandRow>(rows: readonly T[], limit = 5): readonly T[] {
  return [...rows]
    .sort(
      (left, right) =>
        right.completedStays - left.completedStays ||
        compareBigint(right.roomNetSalesMnt, left.roomNetSalesMnt) ||
        left.roomNumber.localeCompare(right.roomNumber),
    )
    .slice(0, limit);
}

/** `FIN-DEC-007`: the same five rooms, ordered by what they earned. */
export function topByRevenue<T extends RoomDemandRow>(rows: readonly T[], limit = 5): readonly T[] {
  return [...rows]
    .sort(
      (left, right) =>
        compareBigint(right.roomNetSalesMnt, left.roomNetSalesMnt) ||
        right.completedStays - left.completedStays ||
        left.roomNumber.localeCompare(right.roomNumber),
    )
    .slice(0, limit);
}

function compareBigint(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** `GUEST-DEC-008`: the deadline a checkout snapshots. */
export function retentionExpiry(checkoutAt: Date, retentionDays: number): Date {
  return new Date(checkoutAt.getTime() + retentionDays * DAY_MS);
}

/** `GUEST-DEC-007`: the file's hour, and the URL's five minutes. */
export function fileExpiry(readyAt: Date): Date {
  return new Date(readyAt.getTime() + EXPORT_FILE_TTL_MINUTES * 60_000);
}

export function urlExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + EXPORT_URL_TTL_MINUTES * 60_000);
}

// ------------------------------------------------------------- local calendar

/** The hotel-local calendar day a report groups by. */
export function localDateOf(at: Date, timeZone: string): string {
  return hotelLocalDate(instant(at), timeZone);
}

/** Every local date in `[from, to)`, so a day with no activity still appears. */
export function localDatesOf(range: DateRange, timeZone: string): readonly string[] {
  const dates: string[] = [];
  let cursor = localDateOf(range.from, timeZone);
  const last = localDateOf(new Date(range.to.getTime() - 1), timeZone);
  // Bounded: a range longer than the retention period is refused before this.
  for (let guard = 0; guard <= DEFAULT_RETENTION_DAYS + 1; guard += 1) {
    dates.push(cursor);
    if (cursor >= last) break;
    cursor = addLocalDays(cursor, 1);
  }
  return dates;
}

function parseLocalDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

/** Calendar arithmetic on a `YYYY-MM-DD`, without a timezone in sight. */
export function addLocalDays(date: string, days: number): string {
  const parsed = parseLocalDate(date);
  if (parsed === undefined) throw new Error(`not a local date: ${date}`);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant a hotel-local day begins.
 *
 * Found by search rather than by an offset table: the offset at midnight is
 * what decides, and a fixed guess would be wrong on the two days a year a zone
 * changes. Two candidate instants are enough for every real zone.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const parsed = parseLocalDate(date);
  if (parsed === undefined) throw new Error(`not a local date: ${date}`);
  const naive = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  for (const offsetHours of [-14, 14]) {
    const guess = new Date(naive - offsetHours * 3_600_000);
    const offset = zoneOffsetMs(guess, timeZone);
    const candidate = new Date(naive - offset);
    if (localDateOf(candidate, timeZone) === date && zoneOffsetMs(candidate, timeZone) === offset) {
      return candidate;
    }
  }
  // A zone in which the day has no midnight (a forward transition at 00:00)
  // starts at the first instant that is in it.
  return new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return asUtc - at.getTime();
}
