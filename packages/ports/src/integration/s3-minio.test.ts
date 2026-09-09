import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  FetchOutboundHttp,
  S3ObjectStorage,
  Secret,
  selectAdapters,
  defaultAdapterModes,
} from '../index';
import { EMPTY_PAYLOAD_HASH, signHeaders } from '../adapters/s3/sigv4';

/**
 * The S3 adapter against a real S3-compatible service: the compose stack's
 * MinIO (docs/architecture/02 §6). Local development credentials only, and
 * a bucket of this test's own, so nothing here touches an export.
 *
 * What this proves that the fake-transport test cannot: the signatures are
 * accepted by an independent implementation, a presigned URL fetched with a
 * plain client returns the bytes, and the two HEAD-first promises hold against
 * the real protocol.
 */

const ENDPOINT = process.env['OBJECT_STORAGE_ENDPOINT_TEST'] ?? 'http://127.0.0.1:59000';
const ACCESS_KEY = process.env['OBJECT_STORAGE_ACCESS_KEY_ID_TEST'] ?? 'prsystem_local';
const SECRET_KEY = process.env['OBJECT_STORAGE_SECRET_ACCESS_KEY_TEST'] ?? 'prsystem_local_dev';
const REGION = 'us-east-1';
const BUCKET = `prsystem-ports-${randomUUID().slice(0, 8)}`;
const ctx = { correlationId: 'minio-integration' };

const credentials = { accessKeyId: ACCESS_KEY, secretAccessKey: new Secret(SECRET_KEY) };
const origin = new URL(ENDPOINT);

/** A bucket call the adapter deliberately has no surface for. */
async function bucket(method: 'PUT' | 'DELETE'): Promise<number> {
  const headers = signHeaders(
    {
      method,
      host: origin.host,
      path: `/${BUCKET}`,
      query: {},
      headers: {},
      payloadHash: EMPTY_PAYLOAD_HASH,
    },
    credentials,
    REGION,
    new Date(),
  );
  const response = await fetch(`${ENDPOINT}/${BUCKET}`, { method, headers });
  await response.arrayBuffer();
  return response.status;
}

let storage: S3ObjectStorage;

beforeAll(async () => {
  const created = await bucket('PUT');
  expect([200, 409]).toContain(created);
  storage = new S3ObjectStorage({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    ...credentials,
    http: new FetchOutboundHttp({ timeoutMs: 10_000 }),
  });
}, 30_000);

afterAll(async () => {
  await bucket('DELETE');
});

describe('S3ObjectStorage against MinIO', () => {
  const key = `exports/${randomUUID()}/${randomUUID().replace(/-/g, '')}.xlsx`;
  const body = new TextEncoder().encode('a synthetic workbook, stored for real');

  it('stores, signs, serves through the signed URL, and removes', async () => {
    const stored = await storage.put({ key, body, contentType: 'application/vnd.ms-excel' }, ctx);
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.byteLength).toBe(body.byteLength);

    const signed = await storage.signedUrl({ key, expiresInSeconds: 300 }, ctx);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.url).not.toContain(SECRET_KEY);

    // A plain client, no credential: the URL is the whole authorisation.
    const fetched = await fetch(signed.value.url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(body);

    expect(await storage.remove(key, ctx)).toEqual({ ok: true, value: { deleted: true } });
    expect(await storage.remove(key, ctx)).toEqual({ ok: true, value: { deleted: false } });
    expect(await storage.signedUrl({ key, expiresInSeconds: 300 }, ctx)).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'NoSuchKey' },
    });
    // And the URL that was valid a moment ago now serves nothing.
    const gone = await fetch(signed.value.url);
    await gone.arrayBuffer();
    expect(gone.status).toBe(404);
  }, 30_000);

  it('is refused by the service with a typed rejection when the credential is wrong', async () => {
    const wrong = new S3ObjectStorage({
      endpoint: ENDPOINT,
      region: REGION,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: new Secret('not-the-credential'),
      http: new FetchOutboundHttp({ timeoutMs: 10_000 }),
    });
    const refused = await wrong.put({ key, body, contentType: 'x' }, ctx);
    expect(refused).toEqual({
      ok: false,
      error: { kind: 'REJECTED', providerCode: 'SignatureDoesNotMatch' },
    });
  }, 30_000);

  it('is what selectAdapters builds for storage=s3 below production', () => {
    const selected = selectAdapters({
      appEnv: 'ci',
      slots: { ...defaultAdapterModes('ci'), storage: 's3' },
      storage: { endpoint: ENDPOINT, region: REGION, bucket: BUCKET, ...credentials },
    });
    expect(selected.storage).toBeInstanceOf(S3ObjectStorage);
    expect(selected.storage.mode).toBe('adapter');
  });
});
