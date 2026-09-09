/**
 * Display formatting only. Money arrives as a whole-MNT string and leaves as
 * text; no arithmetic happens in a portal (CLAUDE.md §5).
 */

export const HOTEL_TIME_ZONE = 'Asia/Ulaanbaatar';

const mnt = new Intl.NumberFormat('mn-MN', { maximumFractionDigits: 0 });

/** `240000` → `240,000₮`; a non-numeric string is shown as it came. */
export function formatMnt(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  if (!/^-?\d+$/.test(text)) return text;
  const sign = text.startsWith('-') ? '−' : '';
  return `${sign}${mnt.format(Number(text.replace('-', '')))}₮`;
}

const dateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: HOTEL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateOnly = new Intl.DateTimeFormat('sv-SE', {
  timeZone: HOTEL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('sv-SE', {
  timeZone: HOTEL_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parse(value: string | Date | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** `2026-09-09 14:30` in hotel-local time. */
export function formatDateTime(value: string | Date | null | undefined): string {
  const parsed = parse(value);
  return parsed === undefined ? '—' : dateTime.format(parsed);
}

export function formatDate(value: string | Date | null | undefined): string {
  const parsed = parse(value);
  return parsed === undefined ? '—' : dateOnly.format(parsed);
}

/** `HH:mm` in hotel-local time — the form the room card uses (doc 06 §3). */
export function formatTime(value: string | Date | null | undefined): string {
  const parsed = parse(value);
  return parsed === undefined ? '—' : timeOnly.format(parsed);
}

/** Whole minutes as `2 ц 15 мин`, the way a remaining time reads. */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${String(rest)} мин`;
  return rest === 0 ? `${String(hours)} ц` : `${String(hours)} ц ${String(rest)} мин`;
}

/** Today's calendar date in hotel-local time, as an `<input type="date">` value. */
export function todayHotelLocal(now = new Date()): string {
  return dateOnly.format(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return at.toISOString().slice(0, 10);
}
