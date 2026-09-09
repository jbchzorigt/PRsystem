import { API_PREFIX, IDEMPOTENCY_HEADER } from '@prsystem/contracts';
import { describe, expect, it } from 'vitest';
import { ApiCallError, ApiClient, unwrap } from './api';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ApiClient', () => {
  it('addresses the versioned prefix and drops empty query values', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { ok: 1 }));
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl });
    const answer = await client.call<{ ok: number }>('/hotels', {
      query: { name: 'x', page: 2, empty: '', gone: undefined },
    });
    expect(answer).toEqual({ ok: true, status: 200, body: { ok: 1 } });
    expect(calls[0]!.url).toBe(`http://api.test${API_PREFIX}/hotels?name=x&page=2`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.cache).toBe('no-store');
  });

  it('carries the bearer, the idempotency key and a JSON body, and nothing of the browser', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { id: 'a' }));
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl });
    await client.call('/guest/bookings', {
      method: 'POST',
      token: 'tok',
      idempotencyKey: 'portal-1',
      body: { a: 1 },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers[IDEMPOTENCY_HEADER]).toBe('portal-1');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(Object.keys(headers)).not.toContain('cookie');
  });

  it('returns the error envelope typed, with its field details', async () => {
    const { impl } = fakeFetch(() =>
      json(409, {
        error: {
          code: 'CONFLICT',
          message: 'no',
          details: [{ field: 'x', issue: 'taken' }],
          correlationId: 'c',
        },
      }),
    );
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl });
    const answer = await client.call('/x');
    expect(answer).toEqual({
      ok: false,
      status: 409,
      code: 'CONFLICT',
      message: 'no',
      details: [{ field: 'x', issue: 'taken' }],
    });
  });

  it('treats a non-JSON failure as an internal error and an empty success as no body', async () => {
    const { impl } = fakeFetch(({ url }) =>
      url.endsWith('/gone')
        ? new Response('<html>', { status: 502 })
        : new Response(null, { status: 204 }),
    );
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl });
    expect(await client.call('/gone')).toMatchObject({
      ok: false,
      status: 502,
      code: 'INTERNAL_ERROR',
    });
    expect(await client.call('/empty')).toEqual({ ok: true, status: 204, body: undefined });
  });

  it('reports a transport failure as NETWORK without naming the URL', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed: http://api.test/secret');
    });
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl });
    const answer = await client.call('/secret');
    expect(answer).toEqual({
      ok: false,
      status: 0,
      code: 'NETWORK',
      message: 'the API could not be reached',
      details: [],
    });
  });

  it('aborts a call that outlives its timeout', async () => {
    const { impl } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: impl, timeoutMs: 20 });
    const answer = await client.call('/slow');
    expect(answer).toMatchObject({ ok: false, code: 'NETWORK' });
  });

  it('unwrap throws the failure for the error boundary', () => {
    expect(unwrap({ ok: true, status: 200, body: 'v' })).toBe('v');
    expect(() =>
      unwrap({ ok: false, status: 404, code: 'NOT_FOUND', message: 'none', details: [] }),
    ).toThrow(ApiCallError);
  });
});
