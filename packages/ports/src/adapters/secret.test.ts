import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET, Secret } from './secret';

describe('Secret', () => {
  const secret = new Secret('phase-20-canary-credential');

  it('exposes the value through expose() and nothing else', () => {
    expect(secret.expose()).toBe('phase-20-canary-credential');
    expect(secret.length).toBe(26);
    expect(String(secret)).toBe(REDACTED_SECRET);
    expect(`${secret}`).toBe(REDACTED_SECRET);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED_SECRET}"}`);
    expect(inspect(secret)).toBe('Secret([redacted])');
    expect(inspect({ nested: secret }, { depth: 4 })).not.toContain('canary');
    expect(Object.keys(secret)).toEqual([]);
  });

  it('refuses to be empty', () => {
    expect(() => new Secret('')).toThrow(/empty/);
  });
});
