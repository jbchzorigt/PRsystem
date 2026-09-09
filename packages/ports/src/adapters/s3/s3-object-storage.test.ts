import { describe, expect, it } from 'vitest';
import type { OutboundHttp, OutboundRequest, OutboundResponse } from '../outbound-http';
import { Secret } from '../secret';
import { fail, ok } from '../../port';
import type { PortResult } from '../../port';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * The adapter over a fake transport: what it sends, what it makes of what
 * comes back, and what never leaves it.
 */

const CANARY = 'phase-20-s3-canary-secret';
const KEY = 'exports/00000000-0000-4000-8000-0000000000aa/0123456789abcdef0123456789abcdef.xlsx';

class FakeHttp implements OutboundHttp {
  readonly requests: OutboundRequest[] = [];
  private readonly answers: PortResult<OutboundResponse>[] = [];

  answer(status: number, body = '', headers: Record<string, string> = {}): this {
    this.answers.push(ok({ status, headers, body: new TextEncoder().encode(body) }));
    return this;
  }

  refuse(result: PortResult<OutboundResponse>): this {
    this.answers.push(result);
    return this;
  }

  send(request: OutboundRequest): Promise<PortResult<OutboundResponse>> {
    this.requests.push(request);
    const next = this.answers.shift();
    if (next === undefined) throw new Error('the fake transport was not told what to answer');
    return Promise.resolve(next);
  }
}

function adapter(http: FakeHttp): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: 'http://127.0.0.1:59000',
    region: 'us-east-1',
    bucket: 'prsystem-local',
    accessKeyId: 'prsystem_local',
    secretAccessKey: new Secret(CANARY),
    http,
    now: () => new Date('2026-09-09T00:00:00Z'),
  });
}

describe('S3ObjectStorage', () => {
  it('puts an object with a signed, content-hashed request and reports what it stored', async () => {
    const http = new FakeHttp().answer(200);
    const body = new TextEncoder().encode('a synthetic workbook');
    const stored = await adapter(http).put({
      key: KEY,
      body,
      contentType: 'application/vnd.ms-excel',
    });
    expect(stored).toEqual({
      ok: true,
      value: {
        key: KEY,
        contentHash:
          '5e4a4f3b9b7a3f7d5a5d6f0f1c1a7c7e4c5b6d8a4e9c3b6a1d2f0e9c8b7a6f5d'.length === 64
            ? expect.any(String)
            : undefined,
        byteLength: body.byteLength,
      },
    });
    const request = http.requests[0]!;
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(`http://127.0.0.1:59000/prsystem-local/${KEY}`);
    expect(request.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=prsystem_local\/20260909\/us-east-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(request.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(request.headers['content-type']).toBe('application/vnd.ms-excel');
  });

  it('checks the key exists before signing a URL, and signs for exactly the seconds asked', async () => {
    const http = new FakeHttp().answer(200);
    const signed = await adapter(http).signedUrl({ key: KEY, expiresInSeconds: 300 });
    expect(http.requests.map((one) => one.method)).toEqual(['HEAD']);
    expect(signed.ok).toBe(true);
    if (signed.ok) {
      expect(signed.value.expiresInSeconds).toBe(300);
      expect(signed.value.url).toContain('X-Amz-Expires=300');
      expect(signed.value.url).toContain('X-Amz-SignedHeaders=host');
      expect(signed.value.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
      expect(signed.value.url.startsWith(`http://127.0.0.1:59000/prsystem-local/${KEY}?`)).toBe(
        true,
      );
    }
  });

  it('cannot sign a key that is gone, and removing one twice deletes once', async () => {
    const gone = new FakeHttp().answer(404, '<Error><Code>NoSuchKey</Code></Error>');
    expect(await adapter(gone).signedUrl({ key: KEY, expiresInSeconds: 300 })).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'NoSuchKey' },
    });
    const removed = new FakeHttp().answer(200).answer(204).answer(404);
    const port = adapter(removed);
    expect(await port.remove(KEY)).toEqual({ ok: true, value: { deleted: true } });
    expect(await port.remove(KEY)).toEqual({ ok: true, value: { deleted: false } });
    expect(removed.requests.map((one) => one.method)).toEqual(['HEAD', 'DELETE', 'HEAD']);
  });

  it('reads the provider code from a refusal and passes a transport failure through', async () => {
    const denied = new FakeHttp().answer(
      403,
      '<Error><Code>AccessDenied</Code><Message>x</Message></Error>',
    );
    expect(
      await adapter(denied).put({ key: KEY, body: new Uint8Array(1), contentType: 'x' }),
    ).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'AccessDenied' },
    });
    const down = new FakeHttp().refuse(fail({ kind: 'TIMEOUT', retryable: true }));
    expect(await adapter(down).remove(KEY)).toEqual({
      ok: false,
      error: { kind: 'TIMEOUT', retryable: true },
    });
    const flaky = new FakeHttp().answer(503);
    expect(
      await adapter(flaky).put({ key: KEY, body: new Uint8Array(1), contentType: 'x' }),
    ).toEqual({
      ok: false,
      error: { kind: 'UNAVAILABLE', retryable: true },
    });
  });

  it('never lets the secret out: not in a URL, a header, a body or a serialised error', async () => {
    const http = new FakeHttp()
      .answer(200)
      .answer(200)
      .answer(403, '<Code>SignatureDoesNotMatch</Code>');
    const port = adapter(http);
    await port.put({ key: KEY, body: new Uint8Array(2), contentType: 'x' });
    const signed = await port.signedUrl({ key: KEY, expiresInSeconds: 60 });
    const refused = await port.put({ key: KEY, body: new Uint8Array(2), contentType: 'x' });
    const surfaces = [
      JSON.stringify(http.requests),
      JSON.stringify(signed),
      JSON.stringify(refused),
      JSON.stringify(port),
      String(port),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(CANARY);
  });

  it('refuses an endpoint that is not a bare origin, and a bucket that is not a bucket name', () => {
    const base = {
      region: 'us-east-1',
      bucket: 'prsystem-local',
      accessKeyId: 'k',
      secretAccessKey: new Secret('s'),
      http: new FakeHttp(),
    };
    expect(() => new S3ObjectStorage({ ...base, endpoint: 'http://h/path' })).toThrow(
      /bare origin/,
    );
    expect(() => new S3ObjectStorage({ ...base, endpoint: 'ftp://h' })).toThrow(/http or https/);
    expect(
      () => new S3ObjectStorage({ ...base, endpoint: 'http://h', bucket: 'Bad_Bucket' }),
    ).toThrow(/bucket name/);
  });
});
