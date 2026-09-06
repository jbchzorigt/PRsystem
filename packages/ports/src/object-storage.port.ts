import { createHash } from 'node:crypto';
import type { Port, PortContext, PortError, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `ObjectStoragePort` — the private temporary store an export file lives in.
 *
 * doc 12 §7 and `GUEST-DEC-007`: a completed export is written to *private*
 * storage, lives one hour from the moment it was ready, and is reached through
 * a signed URL good for five minutes. The bucket, its region, its credentials
 * and its retention configuration are an S3-compatible object-storage contract
 * that nobody has signed — it is a registered production gate — so the
 * production adapter is `UnavailableObjectStorage`, which answers `DISABLED`
 * and writes nothing, and the deterministic simulator is what local, CI and
 * test run against.
 *
 * Two properties belong to the *caller*, not to this port, and are stated here
 * so nobody looks for them in an adapter: the file's one hour is a derived
 * column on the export job, and the URL's five minutes is a row on a separate
 * table. A storage provider that offered a longer-lived URL could therefore not
 * lengthen either of them.
 */

export interface StoredObject {
  /** The generated key. Never a guest's name, number or any personal value. */
  readonly key: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface SignedUrlInput {
  readonly key: string;
  /** doc 12 §7: five minutes. The caller states it; the port does not invent one. */
  readonly expiresInSeconds: number;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresInSeconds: number;
}

export type ObjectStorageCommand =
  | { readonly kind: 'put'; readonly input: PutObjectInput }
  | { readonly kind: 'sign'; readonly input: SignedUrlInput }
  | { readonly kind: 'delete'; readonly input: { readonly key: string } };

export type ObjectStorageResult = StoredObject | SignedUrl | { readonly deleted: boolean };

export interface ObjectStoragePort extends Port<ObjectStorageCommand, ObjectStorageResult> {
  put(input: PutObjectInput, ctx?: PortContext): Promise<PortResult<StoredObject>>;
  signedUrl(input: SignedUrlInput, ctx?: PortContext): Promise<PortResult<SignedUrl>>;
  remove(key: string, ctx?: PortContext): Promise<PortResult<{ deleted: boolean }>>;
}

abstract class ObjectStorageBase implements ObjectStoragePort {
  abstract readonly id: string;
  abstract readonly mode: PortMode;

  abstract put(input: PutObjectInput, ctx?: PortContext): Promise<PortResult<StoredObject>>;
  abstract signedUrl(input: SignedUrlInput, ctx?: PortContext): Promise<PortResult<SignedUrl>>;
  abstract remove(key: string, ctx?: PortContext): Promise<PortResult<{ deleted: boolean }>>;

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

const DISABLED: PortError = { kind: 'DISABLED', gate: 'INT-STORAGE-01' };

/** The production path until the storage contract clears: refuse, typed. */
export class UnavailableObjectStorage extends ObjectStorageBase {
  readonly id = 'object-storage';
  readonly mode: PortMode = 'adapter';

  // The inputs are named and ignored rather than omitted: the signature is the
  // port's, and a disabled adapter must be substitutable for a working one.
  put(_input: PutObjectInput): Promise<PortResult<StoredObject>> {
    return Promise.resolve(fail(DISABLED));
  }

  signedUrl(_input: SignedUrlInput): Promise<PortResult<SignedUrl>> {
    return Promise.resolve(fail(DISABLED));
  }

  remove(_key: string): Promise<PortResult<{ deleted: boolean }>> {
    return Promise.resolve(fail(DISABLED));
  }
}

/**
 * The deterministic simulator for local, CI and test.
 *
 * It keeps the bytes in memory under their key, so a test can assert what a
 * file contains, that deleting it really removes it, and that a URL issued for
 * a key that is gone cannot be signed — which is what an expired export must
 * look like from the outside.
 */
export class SimulatedObjectStorage extends ObjectStorageBase {
  readonly id = 'object-storage';
  readonly mode: PortMode = 'simulator';

  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  private armedFailures: PortError[] = [];
  private sequence = 0;

  /** The next call answers with this transport error and stores nothing. */
  failNext(error: PortError): void {
    this.armedFailures.push(error);
  }

  /** What a test needs to assert about a file without a network. */
  bodyOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.body;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  get size(): number {
    return this.objects.size;
  }

  put(input: PutObjectInput): Promise<PortResult<StoredObject>> {
    const armed = this.armedFailures.shift();
    if (armed !== undefined) return Promise.resolve(fail(armed));
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return Promise.resolve(
      ok({
        key: input.key,
        contentHash: createHash('sha256').update(input.body).digest('hex'),
        byteLength: input.body.byteLength,
      }),
    );
  }

  signedUrl(input: SignedUrlInput): Promise<PortResult<SignedUrl>> {
    const armed = this.armedFailures.shift();
    if (armed !== undefined) return Promise.resolve(fail(armed));
    // A key that is gone cannot be signed. An expired export therefore fails
    // here rather than handing out a URL to nothing.
    if (!this.objects.has(input.key)) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'NoSuchKey' }));
    }
    this.sequence += 1;
    return Promise.resolve(
      ok({
        url:
          `https://storage.invalid/${input.key}` +
          `?sig=sim-${String(this.sequence).padStart(6, '0')}` +
          `&expires=${String(input.expiresInSeconds)}`,
        expiresInSeconds: input.expiresInSeconds,
      }),
    );
  }

  remove(key: string): Promise<PortResult<{ deleted: boolean }>> {
    const armed = this.armedFailures.shift();
    if (armed !== undefined) return Promise.resolve(fail(armed));
    return Promise.resolve(ok({ deleted: this.objects.delete(key) }));
  }
}

/** Chooses the adapter for an environment, and refuses to degrade. */
export function selectObjectStorage(appEnv: string): ObjectStoragePort {
  return isNonProductionEnv(appEnv) ? new SimulatedObjectStorage() : new UnavailableObjectStorage();
}
