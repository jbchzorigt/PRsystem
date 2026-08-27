import { describe, expect, it } from 'vitest';
import { isSyntheticRegistrationNumber, syntheticIdentities, syntheticIdentity } from './synthetic';

describe('syntheticIdentity', () => {
  it('is deterministic for a given seed', () => {
    expect(syntheticIdentity(42)).toEqual(syntheticIdentity(42));
  });

  it('produces a structurally valid ten-digit registration number', () => {
    const identity = syntheticIdentity(7);
    expect(identity.registrationNumber).toMatch(/^\d{10}$/);
  });

  it('always uses the reserved synthetic prefix', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      expect(syntheticIdentity(seed).registrationNumber.startsWith('99')).toBe(true);
    }
  });

  it('marks every identity as synthetic', () => {
    expect(syntheticIdentity(1).synthetic).toBe(true);
  });

  it('encodes a plausible month and day', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const rd = syntheticIdentity(seed).registrationNumber;
      const month = Number(rd.slice(2, 4));
      const day = Number(rd.slice(4, 6));
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(28);
    }
  });
});

describe('isSyntheticRegistrationNumber', () => {
  it('recognises every generated identity', () => {
    for (const identity of syntheticIdentities(50)) {
      expect(isSyntheticRegistrationNumber(identity.registrationNumber)).toBe(true);
    }
  });

  it('rejects a number outside the reserved range', () => {
    expect(isSyntheticRegistrationNumber('8801154321')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isSyntheticRegistrationNumber('99')).toBe(false);
    expect(isSyntheticRegistrationNumber('991301999')).toBe(false);
    expect(isSyntheticRegistrationNumber('not-a-number')).toBe(false);
  });
});

describe('syntheticIdentities', () => {
  it('returns the requested count', () => {
    expect(syntheticIdentities(10)).toHaveLength(10);
  });

  it('returns distinct registration numbers', () => {
    const numbers = new Set(syntheticIdentities(200).map((i) => i.registrationNumber));
    expect(numbers.size).toBeGreaterThan(190);
  });
});
