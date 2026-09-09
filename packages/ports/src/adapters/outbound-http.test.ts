import { describe, expect, it } from 'vitest';
import { FetchOutboundHttp, TokenBucket, classifyStatus, expectStatus } from './outbound-http';
import { ok } from '../port';

const ctx = { correlationId: 'outbound-test' };

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

describe('FetchOutboundHttp', () => {
  it('answers a response as ok, with lower-cased headers and the body bytes', async () => {
    const http = new FetchOutboundHttp({
      timeoutMs: 1000,
      fetch: fakeFetch(
        async () => new Response('hello', { status: 200, headers: { ETag: '"x"' } }),
      ),
    });
    const result = await http.send(
      { method: 'GET', url: 'http://example.invalid/', headers: {} },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.headers['etag']).toBe('"x"');
      expect(Buffer.from(result.value.body).toString()).toBe('hello');
    }
  });

  it('answers TIMEOUT when the ceiling passes, and UNAVAILABLE on a transport failure', async () => {
    const slow = new FetchOutboundHttp({
      timeoutMs: 20,
      fetch: fakeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    });
    expect(
      await slow.send({ method: 'GET', url: 'http://example.invalid/', headers: {} }, ctx),
    ).toEqual({
      ok: false,
      error: { kind: 'TIMEOUT', retryable: true },
    });
    const down = new FetchOutboundHttp({
      timeoutMs: 1000,
      fetch: fakeFetch(() =>
        Promise.reject(new TypeError('fetch failed: http://secret.invalid/k')),
      ),
    });
    const failed = await down.send(
      { method: 'GET', url: 'http://example.invalid/', headers: {} },
      ctx,
    );
    expect(failed).toEqual({ ok: false, error: { kind: 'UNAVAILABLE', retryable: true } });
    // The transport error's text, which can carry a URL, is not forwarded.
    expect(JSON.stringify(failed)).not.toContain('secret.invalid');
  });

  it('refuses a non-positive timeout', () => {
    expect(() => new FetchOutboundHttp({ timeoutMs: 0 })).toThrow(/positive/);
  });
});

describe('status classification', () => {
  it('maps 2xx to success, 429 and 5xx to retryable, other 4xx to a rejection', () => {
    expect(classifyStatus(204)).toBeUndefined();
    expect(classifyStatus(429)).toEqual({ kind: 'UNAVAILABLE', retryable: true });
    expect(classifyStatus(503)).toEqual({ kind: 'UNAVAILABLE', retryable: true });
    expect(classifyStatus(403)).toEqual({ kind: 'REJECTED', providerCode: 'HTTP_403' });
  });

  it('expectStatus accepts the named statuses and reads the provider code from the body', () => {
    const response = {
      status: 403,
      headers: {},
      body: new TextEncoder().encode('<Code>AccessDenied</Code>'),
    };
    expect(expectStatus(ok(response), [200], () => 'AccessDenied')).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'AccessDenied' },
    });
    expect(expectStatus(ok({ ...response, status: 200 }), [200]).ok).toBe(true);
    // A 2xx the caller did not expect is still a rejection, never a silent success.
    expect(expectStatus(ok({ ...response, status: 206 }), [200])).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'HTTP_206' },
    });
  });
});

describe('TokenBucket', () => {
  it('admits the burst at once, then one per interval, under an injected clock', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      { perSecond: 2, burst: 3 },
      () => now,
      (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    );
    expect(bucket.available()).toBe(3);
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(bucket.available()).toBe(0);
    // The fourth waits half a second: one token at two per second.
    await bucket.take();
    expect(sleeps).toEqual([500]);
    now += 10_000;
    expect(bucket.available()).toBe(3);
  });

  it('refuses a rate or a burst that is not positive', () => {
    expect(() => new TokenBucket({ perSecond: 0, burst: 1 })).toThrow(/positive/);
    expect(() => new TokenBucket({ perSecond: 1, burst: 0 })).toThrow(/positive/);
  });
});
