import type { PortContext, PortError, PortResult } from '../port';
import { fail, ok } from '../port';

/**
 * The one way a production adapter reaches a provider.
 *
 * A request carries a hard timeout, is counted against a token bucket when the
 * adapter has a throughput limit to respect, and comes back as a typed
 * `PortResult` — never as a thrown transport error. What it refuses to do is as
 * important: nothing here logs a URL, a header or a body, and the error it
 * answers carries a status code, never the provider's response text.
 *
 * Retrying is the caller's decision, because only the caller knows whether the
 * request was idempotent. A `TIMEOUT` on a create is "unknown outcome", and the
 * domain's own idempotency key — not a blind retry here — is what makes asking
 * again safe (CLAUDE.md §6).
 */

export interface OutboundRequest {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface OutboundResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface OutboundHttp {
  send(request: OutboundRequest, ctx: PortContext): Promise<PortResult<OutboundResponse>>;
}

export interface RateLimit {
  /** Sustained requests per second. */
  readonly perSecond: number;
  /** How many may go at once after a quiet period. */
  readonly burst: number;
}

/**
 * A token bucket. Deterministic under an injected clock, so a test can prove
 * the limit without waiting for it.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (limit.perSecond <= 0 || limit.burst <= 0) {
      throw new Error('a rate limit needs a positive rate and a positive burst');
    }
    this.tokens = limit.burst;
    this.last = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, current - this.last) / 1000;
    this.tokens = Math.min(this.limit.burst, this.tokens + elapsedSeconds * this.limit.perSecond);
    this.last = current;
  }

  /** How many requests may go right now without waiting. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Resolves when one token has been taken, sleeping for it if necessary. */
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await this.sleep(Math.ceil((deficit / this.limit.perSecond) * 1000));
    }
  }
}

export interface FetchOutboundHttpOptions {
  /** Hard ceiling on one exchange, connect to last byte. */
  readonly timeoutMs: number;
  readonly rateLimit?: RateLimit;
  /** Test seam. Defaults to the runtime's `fetch`. */
  readonly fetch?: typeof fetch;
}

type FetchLike = typeof fetch;

/** Maps a status the provider answered to the port vocabulary. */
export function classifyStatus(status: number): PortError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 429 || status >= 500) return { kind: 'UNAVAILABLE', retryable: true };
  return { kind: 'REJECTED', providerCode: `HTTP_${String(status)}` };
}

export class FetchOutboundHttp implements OutboundHttp {
  private readonly bucket: TokenBucket | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: FetchOutboundHttpOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('an outbound timeout must be a positive number of milliseconds');
    }
    this.bucket = options.rateLimit === undefined ? undefined : new TokenBucket(options.rateLimit);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async send(request: OutboundRequest, _ctx: PortContext): Promise<PortResult<OutboundResponse>> {
    if (this.bucket !== undefined) await this.bucket.take();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
        redirect: 'manual',
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return ok({ status: response.status, headers, body });
    } catch (error) {
      // The error object is not forwarded: a transport error's message can
      // carry the URL, and the URL can carry a key or a bucket name.
      if (controller.signal.aborted) return fail({ kind: 'TIMEOUT', retryable: true });
      void error;
      return fail({ kind: 'UNAVAILABLE', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The `PortResult` an adapter answers for a non-2xx status, or the response. */
export function expectStatus(
  result: PortResult<OutboundResponse>,
  accepted: readonly number[],
  providerCodeOf?: (response: OutboundResponse) => string | undefined,
): PortResult<OutboundResponse> {
  if (!result.ok) return result;
  if (accepted.includes(result.value.status)) return result;
  const classified = classifyStatus(result.value.status);
  if (classified === undefined) {
    return fail({ kind: 'REJECTED', providerCode: `HTTP_${String(result.value.status)}` });
  }
  if (classified.kind === 'REJECTED') {
    const code = providerCodeOf?.(result.value);
    return fail(code === undefined ? classified : { kind: 'REJECTED', providerCode: code });
  }
  return fail(classified);
}
