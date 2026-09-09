import type { PortContext, PortMode, PortResult } from '../../port';
import { fail, ok } from '../../port';
import type {
  ObjectStorageCommand,
  ObjectStoragePort,
  ObjectStorageResult,
  PutObjectInput,
  SignedUrl,
  SignedUrlInput,
  StoredObject,
} from '../../object-storage.port';
import type { OutboundHttp, OutboundResponse } from '../outbound-http';
import { expectStatus } from '../outbound-http';
import type { Secret } from '../secret';
import { sha256Hex } from '../signing';
import { EMPTY_PAYLOAD_HASH, presignUrl, signHeaders, uriEncode } from './sigv4';

/**
 * `INT-STORAGE-01` — the S3-compatible production adapter (CLAUDE.md §1; doc 12
 * §7, `GUEST-DEC-007`).
 *
 * It speaks the S3 REST API in path-style form, signed with SigV4, over the
 * `OutboundHttp` it is given. The bucket, endpoint, region and credential are
 * configuration; the credential is a `Secret` and is exposed only inside the
 * signer.
 *
 * It keeps the simulator's two promises so the caller cannot tell them apart:
 * a key that is gone cannot be signed, and removing what is already gone
 * answers `deleted: false` rather than a second delete. Both cost a `HEAD`
 * first, which is the honest price of not inventing a URL to nothing.
 *
 * Enabled only through `selectAdapters`, which refuses it in production while
 * the gate is uncleared. Nothing here checks the gate itself: an adapter that
 * could decide it was allowed to run would be the wrong place for that rule.
 */
export interface S3ObjectStorageConfig {
  /** `http://host:port` or `https://host`. No path, no trailing slash. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret;
  readonly http: OutboundHttp;
  /** Test seam: the signing clock. */
  readonly now?: () => Date;
}

const XML_CODE = /<Code>([A-Za-z0-9.]+)<\/Code>/;

/** The provider's error code, from the body it answered, never its message. */
function s3ErrorCode(response: OutboundResponse): string | undefined {
  const text = Buffer.from(response.body).toString('utf8', 0, Math.min(response.body.length, 4096));
  const match = XML_CODE.exec(text);
  return match?.[1];
}

export class S3ObjectStorage implements ObjectStoragePort {
  readonly id = 'object-storage';
  readonly mode: PortMode = 'adapter';

  private readonly scheme: 'http' | 'https';
  private readonly host: string;

  constructor(private readonly config: S3ObjectStorageConfig) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('the object storage endpoint must be an http or https origin');
    }
    if (endpoint.pathname !== '/' || endpoint.search !== '') {
      throw new Error('the object storage endpoint must be a bare origin');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
      throw new Error('the object storage bucket name is not a valid S3 bucket name');
    }
    this.scheme = endpoint.protocol === 'http:' ? 'http' : 'https';
    this.host = endpoint.host;
  }

  private path(key: string): string {
    return `/${this.config.bucket}/${key}`;
  }

  private url(key: string, query: Readonly<Record<string, string>> = {}): string {
    const encoded = Object.entries(query)
      .map(([name, value]) => `${uriEncode(name, false)}=${uriEncode(value, false)}`)
      .join('&');
    return `${this.scheme}://${this.host}${uriEncode(this.path(key), true)}${
      encoded.length === 0 ? '' : `?${encoded}`
    }`;
  }

  private now(): Date {
    return this.config.now === undefined ? new Date() : this.config.now();
  }

  private signed(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    payloadHash: string,
    headers: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, string>> {
    return signHeaders(
      { method, host: this.host, path: this.path(key), query: {}, headers, payloadHash },
      { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      this.config.region,
      this.now(),
    );
  }

  private async head(key: string, ctx: PortContext): Promise<PortResult<boolean>> {
    const answer = await this.config.http.send(
      { method: 'HEAD', url: this.url(key), headers: this.signed('HEAD', key, EMPTY_PAYLOAD_HASH) },
      ctx,
    );
    if (!answer.ok) return answer;
    if (answer.value.status === 200) return ok(true);
    if (answer.value.status === 404) return ok(false);
    const refused = expectStatus(answer, [200, 404]);
    return refused.ok ? ok(false) : refused;
  }

  async put(input: PutObjectInput, ctx?: PortContext): Promise<PortResult<StoredObject>> {
    const context = ctx ?? { correlationId: 'unattributed' };
    const contentHash = sha256Hex(input.body);
    const answer = expectStatus(
      await this.config.http.send(
        {
          method: 'PUT',
          url: this.url(input.key),
          headers: this.signed('PUT', input.key, contentHash, {
            'content-type': input.contentType,
            'content-length': String(input.body.byteLength),
          }),
          body: input.body,
        },
        context,
      ),
      [200],
      s3ErrorCode,
    );
    if (!answer.ok) return answer;
    return ok({ key: input.key, contentHash, byteLength: input.body.byteLength });
  }

  async signedUrl(input: SignedUrlInput, ctx?: PortContext): Promise<PortResult<SignedUrl>> {
    const context = ctx ?? { correlationId: 'unattributed' };
    if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
      return fail({ kind: 'REJECTED', providerCode: 'InvalidExpiry' });
    }
    // A key that is gone cannot be signed — the simulator's rule, kept here so
    // an expired export looks the same from the outside on either path.
    const present = await this.head(input.key, context);
    if (!present.ok) return present;
    if (!present.value) return fail({ kind: 'REJECTED', providerCode: 'NoSuchKey' });
    const url = presignUrl(
      {
        method: 'GET',
        scheme: this.scheme,
        host: this.host,
        path: this.path(input.key),
        expiresInSeconds: input.expiresInSeconds,
      },
      { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      this.config.region,
      this.now(),
    );
    return ok({ url, expiresInSeconds: input.expiresInSeconds });
  }

  async remove(key: string, ctx?: PortContext): Promise<PortResult<{ deleted: boolean }>> {
    const context = ctx ?? { correlationId: 'unattributed' };
    const present = await this.head(key, context);
    if (!present.ok) return present;
    if (!present.value) return ok({ deleted: false });
    const answer = expectStatus(
      await this.config.http.send(
        {
          method: 'DELETE',
          url: this.url(key),
          headers: this.signed('DELETE', key, EMPTY_PAYLOAD_HASH),
        },
        context,
      ),
      [200, 204],
      s3ErrorCode,
    );
    if (!answer.ok) return answer;
    return ok({ deleted: true });
  }

  execute(cmd: ObjectStorageCommand, ctx: PortContext): Promise<PortResult<ObjectStorageResult>> {
    switch (cmd.kind) {
      case 'put':
        return this.put(cmd.input, ctx);
      case 'sign':
        return this.signedUrl(cmd.input, ctx);
      case 'delete':
        return this.remove(cmd.input.key, ctx);
    }
  }
}
