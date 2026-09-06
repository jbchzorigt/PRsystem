import { describe, expect, it } from 'vitest';
import {
  HOLD_SECONDS,
  attemptExpiry,
  captureOutcome,
  chooseRemedy,
  formatReference,
  hasLapsed,
  holdExpiryFrom,
  isTerminal,
  nightCount,
  nightsOf,
  refundOnHotelCancellation,
  releasesInventory,
  windowProblem,
} from './booking';

/** The booking's decisions, tested without a database (doc 09 §§7–10). */

const at = (iso: string): Date => new Date(iso);
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('the nightly window (BK-DEC-012)', () => {
  it('takes exactly the nights of a half-open range', () => {
    expect(nightsOf(day('2026-10-05'), day('2026-10-08')).map((d) => d.toISOString())).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-06T00:00:00.000Z',
      '2026-10-07T00:00:00.000Z',
    ]);
    // The checkout night is not slept in, so it is not taken.
    expect(nightCount(day('2026-10-05'), day('2026-10-06'))).toBe(1);
  });

  it('refuses a window that is not whole nights, is past, or is absurd', () => {
    const today = day('2026-10-05');
    expect(windowProblem(day('2026-10-05'), day('2026-10-06'), today)).toBeUndefined();
    expect(windowProblem(day('2026-10-06'), day('2026-10-06'), today)).toBe('NOT_NIGHTLY');
    expect(windowProblem(day('2026-10-04'), day('2026-10-06'), today)).toBe('IN_THE_PAST');
    expect(windowProblem(day('2026-10-05'), day('2027-10-05'), today)).toBe('TOO_LONG');
    expect(windowProblem(at('2026-10-05T14:00:00Z'), day('2026-10-06'), today)).toBe('MISALIGNED');
  });
});

describe('the ten minutes (BK-DEC-009, PAY-DEC-002)', () => {
  it('is ten minutes from the server, and no session outlives it', () => {
    const now = at('2026-10-05T10:00:00.000Z');
    const hold = holdExpiryFrom(now);
    expect(hold.getTime() - now.getTime()).toBe(HOLD_SECONDS * 1000);
    // An attempt opened nine minutes in expires with the hold, not ten minutes
    // later (doc 09 §10).
    const late = at('2026-10-05T10:09:00.000Z');
    expect(attemptExpiry(hold, late)).toEqual(hold);
    expect(attemptExpiry(hold, now)).toEqual(hold);
  });

  it('has lapsed only while it is still a live hold', () => {
    const base = {
      state: 'HOLDING' as const,
      holdState: 'ACTIVE' as const,
      paymentState: 'PENDING' as const,
      holdExpiresAt: at('2026-10-05T10:10:00.000Z'),
    };
    expect(hasLapsed(base, at('2026-10-05T10:09:59.999Z'))).toBe(false);
    expect(hasLapsed(base, at('2026-10-05T10:10:00.000Z'))).toBe(true);
    expect(hasLapsed({ ...base, state: 'CONFIRMED' }, at('2026-10-05T11:00:00Z'))).toBe(false);
    expect(hasLapsed({ ...base, holdState: 'CONSUMED' }, at('2026-10-05T11:00:00Z'))).toBe(false);
  });
});

describe('a capture arriving (PAY-DEC-006)', () => {
  const now = at('2026-10-05T10:05:00.000Z');
  const live = {
    state: 'HOLDING' as const,
    holdState: 'ACTIVE' as const,
    paymentState: 'PENDING' as const,
    holdExpiresAt: at('2026-10-05T10:10:00.000Z'),
  };
  const active = { state: 'ACTIVE' as const };

  it('confirms while the hold is alive', () => {
    expect(captureOutcome(live, active, now)).toEqual({ kind: 'confirm' });
  });

  it('never reopens an expired booking; it owes the money back', () => {
    const expired = { ...live, state: 'EXPIRED' as const, holdState: 'EXPIRED' as const };
    expect(captureOutcome(expired, active, at('2026-10-05T10:20:00Z'))).toEqual({
      kind: 'refund_obligation',
      reason: 'expired',
    });
    // Even before the sweep has run: the clock, not the row, decides.
    expect(captureOutcome(live, active, at('2026-10-05T10:10:00.000Z'))).toEqual({
      kind: 'refund_obligation',
      reason: 'expired',
    });
  });

  it('treats a second capture of a paid booking as money twice', () => {
    const paid = { ...live, state: 'CONFIRMED' as const, paymentState: 'PAID' as const };
    expect(captureOutcome(paid, { state: 'ACTIVE' }, now)).toEqual({
      kind: 'refund_obligation',
      reason: 'duplicate',
    });
    // The same attempt repeating itself is a replay and changes nothing.
    expect(captureOutcome(paid, { state: 'PAID' }, now)).toEqual({ kind: 'already_confirmed' });
  });

  it('ignores an attempt that is no longer the live one', () => {
    expect(captureOutcome(live, { state: 'SUPERSEDED' }, now)).toEqual({ kind: 'stale' });
    expect(captureOutcome(live, { state: 'FAILED' }, now)).toEqual({ kind: 'stale' });
  });

  it('owes the money back when a hotel cancellation is paid for', () => {
    const cancelled = { ...live, state: 'CANCELLED_HOTEL' as const };
    expect(captureOutcome(cancelled, active, now)).toEqual({
      kind: 'refund_obligation',
      reason: 'terminal',
    });
    expect(refundOnHotelCancellation('PAID')).toBe('REQUIRED');
    expect(refundOnHotelCancellation('PENDING')).toBe('NONE');
  });
});

describe('what a terminal transition releases', () => {
  it('gives the units back on every ending except a completed stay', () => {
    expect(releasesInventory('HOLDING', 'EXPIRED')).toBe(true);
    expect(releasesInventory('CONFIRMED', 'CANCELLED_GUEST')).toBe(true);
    expect(releasesInventory('CONFIRMED', 'CANCELLED_HOTEL')).toBe(true);
    expect(releasesInventory('CHECKED_IN', 'NO_SHOW')).toBe(true);
    // A completed booking consumed its unit; it did not hand it back.
    expect(releasesInventory('CHECKED_IN', 'COMPLETED')).toBe(false);
    // And an ending twice releases nothing twice.
    expect(releasesInventory('EXPIRED', 'EXPIRED')).toBe(false);
    expect(TERMINALS.every(isTerminal)).toBe(true);
  });
});

const TERMINALS = [
  'EXPIRED',
  'CANCELLED_GUEST',
  'CANCELLED_HOTEL',
  'NO_SHOW',
  'COMPLETED',
] as const;

describe('the remedy ladder (BK-DEC-014)', () => {
  const booked = 'cat-standard';
  it('offers the booked category first', () => {
    expect(
      chooseRemedy(booked, 100_000n, [
        { roomId: 'r-lux', categoryId: 'cat-lux', rankMnt: 200_000n },
        { roomId: 'r-std', categoryId: booked, rankMnt: 100_000n },
      ]),
    ).toEqual({ kind: 'same_category', roomId: 'r-std' });
  });

  it('then the cheapest higher category, never a lower one', () => {
    expect(
      chooseRemedy(booked, 100_000n, [
        { roomId: 'r-suite', categoryId: 'cat-suite', rankMnt: 300_000n },
        { roomId: 'r-lux', categoryId: 'cat-lux', rankMnt: 200_000n },
      ]),
    ).toEqual({ kind: 'upgrade', roomId: 'r-lux', categoryId: 'cat-lux' });
    // A cheaper room is a downgrade sold as a remedy, so it is not offered.
    expect(
      chooseRemedy(booked, 100_000n, [
        { roomId: 'r-small', categoryId: 'cat-small', rankMnt: 60_000n },
      ]),
    ).toEqual({ kind: 'cancel_hotel' });
  });

  it('cancels when nothing is left', () => {
    expect(chooseRemedy(booked, 100_000n, [])).toEqual({ kind: 'cancel_hotel' });
  });
});

describe('the booking reference', () => {
  it('is quotable: no letters a person would confuse', () => {
    const ref = formatReference(Uint8Array.from(Array.from({ length: 16 }, (_, i) => i * 7)));
    expect(ref).toMatch(/^[A-Z0-9]{10}$/);
    expect(ref).not.toMatch(/[IO01]/);
  });
});
