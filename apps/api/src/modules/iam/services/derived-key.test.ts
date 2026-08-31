import { describe, expect, it } from 'vitest';
import { derivedIdempotencyKey } from './derived-key';

/** The column the derived key is written to accepts 8..200 characters. */
const MIN = 8;
const MAX = 200;

describe('derived idempotency keys', () => {
  it('stays inside the column limit for a client key at the maximum', () => {
    const clientKey = 'k'.repeat(MAX);
    for (const key of [
      derivedIdempotencyKey('handoff.discovery', clientKey),
      derivedIdempotencyKey('handoff.open', clientKey, 'reception_shift', 'x'.repeat(MAX)),
    ]) {
      expect(key.length).toBeGreaterThanOrEqual(MIN);
      expect(key.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('is deterministic', () => {
    expect(derivedIdempotencyKey('handoff.open', 'seed', 'cleaner_task', 'ref')).toBe(
      derivedIdempotencyKey('handoff.open', 'seed', 'cleaner_task', 'ref'),
    );
  });

  it('binds each component unambiguously', () => {
    // Concatenation would make these three the same key.
    const keys = new Set([
      derivedIdempotencyKey('op', 'ab', 'c'),
      derivedIdempotencyKey('op', 'a', 'bc'),
      derivedIdempotencyKey('op', 'abc'),
    ]);
    expect(keys.size).toBe(3);
  });

  it('separates operations that share their components', () => {
    expect(derivedIdempotencyKey('one', 'seed')).not.toBe(derivedIdempotencyKey('two', 'seed'));
  });

  it('never truncates the caller’s key into a collision', () => {
    const long = 'k'.repeat(MAX);
    expect(derivedIdempotencyKey('op', long)).not.toBe(derivedIdempotencyKey('op', `${long}x`));
  });

  it('refuses an operation tag that could overflow the column', () => {
    expect(() => derivedIdempotencyKey('o'.repeat(101), 'seed')).toThrow();
    expect(() => derivedIdempotencyKey('', 'seed')).toThrow();
  });
});
