import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CORRELATION_HEADER, currentCorrelation } from '@prsystem/telemetry';
import { registerCorrelation } from './correlation.plugin';

const app = Fastify();
registerCorrelation(app);
app.get('/probe', async () => ({ requestId: currentCorrelation()?.requestId ?? null }));

afterEach(async () => {
  // keep the instance for all cases; closed once at the end of the file
});

describe('registerCorrelation', () => {
  it('generates a request id and echoes it in the response header', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe' });

    const header = response.headers[CORRELATION_HEADER];
    expect(header).toBeDefined();
    expect(response.json<{ requestId: string }>().requestId).toBe(header);
  });

  it('binds the correlation context for the handler', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.json<{ requestId: string | null }>().requestId).not.toBeNull();
  });

  it('accepts a well-formed inbound correlation id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { [CORRELATION_HEADER]: 'inbound-request-1234' },
    });

    expect(response.headers[CORRELATION_HEADER]).toBe('inbound-request-1234');
  });

  it('replaces a malformed inbound id rather than echoing client text', async () => {
    const injected = '<script>alert(1)</script>';
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { [CORRELATION_HEADER]: injected },
    });

    expect(response.headers[CORRELATION_HEADER]).not.toBe(injected);
    expect(String(response.headers[CORRELATION_HEADER])).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('issues a distinct id per request', async () => {
    const first = await app.inject({ method: 'GET', url: '/probe' });
    const second = await app.inject({ method: 'GET', url: '/probe' });

    expect(first.headers[CORRELATION_HEADER]).not.toBe(second.headers[CORRELATION_HEADER]);
  });
});
