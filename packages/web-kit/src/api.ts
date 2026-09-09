import { API_PREFIX, IDEMPOTENCY_HEADER } from '@prsystem/contracts';
import type { ApiErrorEnvelope, ErrorCode } from '@prsystem/contracts';

/**
 * The one way a portal reaches the API (CLAUDE.md §3: a web application
 * contains no authoritative business rule — it asks, renders, and submits).
 *
 * Every call carries the session token as a bearer the *server side* of the
 * portal holds in an httpOnly cookie; the browser never sees it. Nothing here
 * decides an outcome: an error comes back typed, with the code and the
 * field-level detail the API's envelope carries, and the page renders it.
 */

export type ApiFailure = {
  readonly ok: false;
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK';
  readonly message: string;
  readonly details: readonly { readonly field: string; readonly issue: string }[];
};

export type ApiResult<T> =
  { readonly ok: true; readonly status: number; readonly body: T } | ApiFailure;

export interface ApiRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly token?: string | undefined;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function withQuery(url: URL, query: ApiRequest['query']): void {
  if (query === undefined) return;
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(name, String(value));
  }
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Every route is versioned under the API prefix; health is not a portal concern. */
  url(path: string, query?: ApiRequest['query']): string {
    const url = new URL(`${API_PREFIX}${path}`, this.options.baseUrl);
    withQuery(url, query);
    return url.toString();
  }

  async call<T>(path: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...request.headers,
    };
    if (request.token !== undefined) headers['authorization'] = `Bearer ${request.token}`;
    if (request.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = request.idempotencyKey;
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url(path, request.query), {
        method: request.method ?? 'GET',
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        cache: 'no-store',
      });
      const text = await response.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      if (response.ok) return { ok: true, status: response.status, body: parsed as T };
      const envelope = (parsed as Partial<ApiErrorEnvelope> | undefined)?.error;
      return {
        ok: false,
        status: response.status,
        code: envelope?.code ?? 'INTERNAL_ERROR',
        message: envelope?.message ?? 'the request failed',
        details: envelope?.details ?? [],
      };
    } catch {
      // The transport failed or timed out. No URL and no body in the message:
      // a portal error is shown to a person, and a person is not a log sink.
      return {
        ok: false,
        status: 0,
        code: 'NETWORK',
        message: 'the API could not be reached',
        details: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Throws a failure so a server component can bail to the error boundary. */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.body;
  throw new ApiCallError(result);
}

export class ApiCallError extends Error {
  override readonly name = 'ApiCallError';
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(`${failure.code}: ${failure.message}`);
    this.failure = failure;
  }
}
