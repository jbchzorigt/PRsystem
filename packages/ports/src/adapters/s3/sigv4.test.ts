import { describe, expect, it } from 'vitest';
import { Secret } from '../secret';
import { sha256Hex } from '../signing';
import {
  EMPTY_PAYLOAD_HASH,
  UNSIGNED_PAYLOAD,
  canonicalRequest,
  presignUrl,
  signHeaders,
  uriEncode,
} from './sigv4';

/**
 * The published AWS examples, verbatim. The example credential is AWS's own
 * documentation fixture (`AKIAIOSFODNN7EXAMPLE`), not a real key, and every
 * expected value below is one the S3 API Reference prints.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: new Secret('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
};
const AT = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';

describe('SigV4 — the AWS S3 API Reference examples', () => {
  it('signs the GET Object example with the documented signature', () => {
    const headers = signHeaders(
      {
        method: 'GET',
        host: HOST,
        path: '/test.txt',
        query: {},
        headers: { Range: 'bytes=0-9' },
        payloadHash: EMPTY_PAYLOAD_HASH,
      },
      CREDENTIALS,
      'us-east-1',
      AT,
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs the PUT Object example with the documented signature', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = sha256Hex(body);
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const headers = signHeaders(
      {
        method: 'PUT',
        host: HOST,
        path: '/test$file.text',
        query: {},
        headers: {
          Date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        },
        payloadHash,
      },
      CREDENTIALS,
      'us-east-1',
      AT,
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('presigns the GET example URL with the documented signature', () => {
    const url = presignUrl(
      { method: 'GET', scheme: 'https', host: HOST, path: '/test.txt', expiresInSeconds: 86400 },
      CREDENTIALS,
      'us-east-1',
      AT,
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('builds the documented canonical request for the presigned example', () => {
    const { text } = canonicalRequest({
      method: 'GET',
      host: HOST,
      path: '/test.txt',
      query: {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
        'X-Amz-Date': '20130524T000000Z',
        'X-Amz-Expires': '86400',
        'X-Amz-SignedHeaders': 'host',
      },
      headers: { host: HOST },
      payloadHash: UNSIGNED_PAYLOAD,
    });
    expect(text).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com\n',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
  });

  it('encodes the way S3 canonicalises: unreserved kept, everything else percent-encoded', () => {
    expect(uriEncode('/exports/a b/c~d', true)).toBe('/exports/a%20b/c~d');
    expect(uriEncode("it's(*)!", false)).toBe('it%27s%28%2A%29%21');
    expect(uriEncode('a/b', false)).toBe('a%2Fb');
    expect(uriEncode('Сүхбаатар', false)).toBe(
      '%D0%A1%D2%AF%D1%85%D0%B1%D0%B0%D0%B0%D1%82%D0%B0%D1%80',
    );
  });

  it('never places the secret in a header, and refuses a non-positive expiry', () => {
    const headers = signHeaders(
      {
        method: 'HEAD',
        host: HOST,
        path: '/k',
        query: {},
        headers: {},
        payloadHash: EMPTY_PAYLOAD_HASH,
      },
      CREDENTIALS,
      'us-east-1',
      AT,
    );
    expect(JSON.stringify(headers)).not.toContain('wJalrXUtnFEMI');
    expect(() =>
      presignUrl(
        { method: 'GET', scheme: 'https', host: HOST, path: '/k', expiresInSeconds: 0 },
        CREDENTIALS,
        'us-east-1',
        AT,
      ),
    ).toThrow(/positive/);
  });
});
