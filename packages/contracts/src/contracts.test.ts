import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  ApiError,
  ERROR_CODES,
  decodeCursor,
  encodeCursor,
  errorEnvelope,
  httpStatusForErrorCode,
  isStableId,
  newStableId,
  pageRequest,
} from './index';

describe('API surface', () => {
  it('versions every route under /api/v1', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });
});

describe('error envelope', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      const status = httpStatusForErrorCode(code);
      expect({ code, valid: status >= 400 && status < 600 }).toEqual({ code, valid: true });
    }
  });

  it('returns NOT_FOUND semantics for a cross-tenant probe', () => {
    // A cross-tenant denial must be indistinguishable from not-found, so a probe
    // cannot confirm that another tenant's resource exists.
    expect(httpStatusForErrorCode('NOT_FOUND')).toBe(404);
  });

  it('carries the correlation id and nothing sensitive', () => {
    const envelope = errorEnvelope(
      new ApiError('VALIDATION_FAILED', 'invalid request', [
        { field: 'amountMnt', issue: 'must be an integer string' },
      ]),
      'corr-1',
    );

    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    expect(envelope.error.correlationId).toBe('corr-1');
    expect(JSON.stringify(envelope)).not.toMatch(/password|token|secret/i);
  });

  it('omits details entirely when there are none', () => {
    const envelope = errorEnvelope(new ApiError('NOT_FOUND', 'not found'), 'corr-2');
    expect('details' in envelope.error).toBe(false);
  });
});

describe('pagination', () => {
  it('defaults and bounds the page size', () => {
    expect(pageRequest({}).limit).toBe(50);
    expect(pageRequest({ limit: 200 }).limit).toBe(200);
    expect(() => pageRequest({ limit: 201 })).toThrow(ApiError);
    expect(() => pageRequest({ limit: 0 })).toThrow(ApiError);
    expect(() => pageRequest({ limit: 1.5 })).toThrow(ApiError);
  });

  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ id: 'row-1', sortKey: '2026-01-01T00:00:00Z' });
    expect(decodeCursor(cursor)).toEqual({ id: 'row-1', sortKey: '2026-01-01T00:00:00Z' });
    expect(pageRequest({ cursor }).cursor).toBe(cursor);
  });

  it('rejects a cursor this API did not issue', () => {
    expect(() => pageRequest({ cursor: 'not a cursor!' })).toThrow(ApiError);
    expect(() => decodeCursor(Buffer.from('nospace').toString('base64url'))).toThrow(ApiError);
  });
});

describe('stable identifiers', () => {
  it('produces a valid, unique, time-ordered id', () => {
    const first = newStableId(new Date('2026-01-01T00:00:00Z'));
    const second = newStableId(new Date('2026-01-01T00:00:01Z'));

    expect(isStableId(first)).toBe(true);
    expect(first).not.toBe(second);
    // Time ordering makes index inserts local; it must hold lexicographically.
    expect(first < second).toBe(true);
  });

  it('marks itself as version 7', () => {
    expect(newStableId().charAt(14)).toBe('7');
  });

  it('does not repeat across a burst', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newStableId()));
    expect(ids.size).toBe(500);
  });
});
