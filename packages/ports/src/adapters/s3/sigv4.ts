import { hmacSha256, sha256Hex } from '../signing';
import type { Secret } from '../secret';

/**
 * AWS Signature Version 4 for S3, as published in the AWS General Reference
 * ("Signature Version 4 signing process") and the S3 API Reference
 * ("Authenticating Requests: Using Query Parameters"). A public standard,
 * not a vendor's private rule, which is why this adapter may exist while every
 * contract-bound one may not (CLAUDE.md §9).
 *
 * The secret is exposed inside `signingKey` for the length of four HMACs and
 * nowhere else. Nothing here logs, throws with, or returns a header value.
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret;
}

export interface SigV4Request {
  readonly method: string;
  readonly host: string;
  /** Already-decoded path; encoded here, segment by segment. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the payload, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_HASH = sha256Hex('');
const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

/** RFC 3986 unreserved characters only; `/` is kept when `keepSlash`. */
export function uriEncode(value: string, keepSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

export function amzDate(at: Date): { amzDate: string; dateStamp: string } {
  const iso = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([name, value]) => [uriEncode(name, false), uriEncode(value, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

function scope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`;
}

function signingKey(secret: Secret, dateStamp: string, region: string): Buffer {
  const kDate = hmacSha256(`AWS4${secret.expose()}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, SERVICE);
  return hmacSha256(kService, 'aws4_request');
}

export function canonicalRequest(request: SigV4Request): { text: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(request.headers);
  const text = [
    request.method.toUpperCase(),
    uriEncode(request.path, true),
    canonicalQuery(request.query),
    canonical,
    signed,
    request.payloadHash,
  ].join('\n');
  return { text, signedHeaders: signed };
}

function stringToSign(amz: string, credentialScope: string, canonical: string): string {
  return [ALGORITHM, amz, credentialScope, sha256Hex(canonical)].join('\n');
}

/**
 * Signs a request with the `Authorization` header. The `host`, `x-amz-date` and
 * `x-amz-content-sha256` headers are added if absent, so the caller cannot
 * forget to sign them.
 */
export function signHeaders(
  request: Omit<SigV4Request, 'headers'> & { readonly headers: Readonly<Record<string, string>> },
  credentials: SigV4Credentials,
  region: string,
  at: Date,
): Readonly<Record<string, string>> {
  const { amzDate: amz, dateStamp } = amzDate(at);
  const headers: Record<string, string> = {
    host: request.host,
    'x-amz-date': amz,
    'x-amz-content-sha256': request.payloadHash,
    ...Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const { text, signedHeaders } = canonicalRequest({ ...request, headers });
  const credentialScope = scope(dateStamp, region);
  const signature = hmacSha256(
    signingKey(credentials.secretAccessKey, dateStamp, region),
    stringToSign(amz, credentialScope, text),
  ).toString('hex');
  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * A presigned URL: the signature travels in the query and only `host` is
 * signed, so the URL is usable by a browser that adds headers of its own.
 */
export function presignUrl(
  input: {
    readonly method: 'GET';
    readonly scheme: 'http' | 'https';
    readonly host: string;
    readonly path: string;
    readonly expiresInSeconds: number;
  },
  credentials: SigV4Credentials,
  region: string,
  at: Date,
): string {
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
    throw new Error('a presigned URL needs a positive whole number of seconds');
  }
  const { amzDate: amz, dateStamp } = amzDate(at);
  const credentialScope = scope(dateStamp, region);
  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const { text } = canonicalRequest({
    method: input.method,
    host: input.host,
    path: input.path,
    query,
    headers: { host: input.host },
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const signature = hmacSha256(
    signingKey(credentials.secretAccessKey, dateStamp, region),
    stringToSign(amz, credentialScope, text),
  ).toString('hex');
  const encodedQuery = `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  return `${input.scheme}://${input.host}${uriEncode(input.path, true)}?${encodedQuery}`;
}
