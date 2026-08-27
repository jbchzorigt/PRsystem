import { describe, expect, it } from 'vitest';
import {
  currentCorrelation,
  newRequestId,
  runWithCorrelation,
  sanitiseRequestId,
} from './correlation';

describe('newRequestId', () => {
  it('produces distinct opaque identifiers', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    expect(ids.size).toBe(100);
  });
});

describe('sanitiseRequestId', () => {
  it('accepts a plausible opaque token', () => {
    expect(sanitiseRequestId('a1b2c3d4-e5f6')).toBe('a1b2c3d4-e5f6');
  });

  it.each([
    ['', 'empty'],
    ['short', 'too short'],
    ['x'.repeat(65), 'too long'],
    ['has space here', 'contains whitespace'],
    ['<script>alert(1)</script>', 'contains markup'],
    ['drop table users;--', 'contains punctuation'],
  ])('rejects %s (%s)', (candidate) => {
    expect(sanitiseRequestId(candidate)).toBeUndefined();
  });

  it('rejects non-string input', () => {
    expect(sanitiseRequestId(undefined)).toBeUndefined();
    expect(sanitiseRequestId(42)).toBeUndefined();
    expect(sanitiseRequestId({ id: 'x' })).toBeUndefined();
  });
});

describe('runWithCorrelation', () => {
  it('binds the context for the synchronous scope', () => {
    runWithCorrelation({ requestId: 'req-1' }, () => {
      expect(currentCorrelation()?.requestId).toBe('req-1');
    });
  });

  it('propagates across await boundaries', async () => {
    await runWithCorrelation({ requestId: 'req-2' }, async () => {
      await Promise.resolve();
      expect(currentCorrelation()?.requestId).toBe('req-2');
    });
  });

  it('does not leak outside the scope', () => {
    runWithCorrelation({ requestId: 'req-3' }, () => undefined);
    expect(currentCorrelation()).toBeUndefined();
  });

  it('isolates concurrent scopes', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithCorrelation({ requestId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentCorrelation()!.requestId);
      }),
      runWithCorrelation({ requestId: 'b' }, async () => {
        seen.push(currentCorrelation()!.requestId);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
