import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request correlation — docs/architecture/13-telemetry-and-redaction.md §2.
 *
 * Every request and job carries a correlation context. Only identifiers are carried;
 * no name, email or other content ever enters this object.
 */
export interface CorrelationContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly realm?: string;
  readonly actorId?: string;
  /**
   * The message that caused this one. Correlation groups a unit of work;
   * causation orders it, so an outbox event can be traced back to the command
   * that produced it without either carrying business data.
   */
  readonly causationId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_HEADER = 'x-request-id';

/** A new opaque request identifier. */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * Accept an inbound correlation id only when it is a plausible opaque token.
 * An arbitrary client string is never echoed into logs.
 */
export function sanitiseRequestId(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  if (trimmed.length < 8 || trimmed.length > 64) return undefined;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}

/** Run `fn` with the given correlation context bound to the async scope. */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The correlation context of the current async scope, if any. */
export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/** The correlation id of the current unit of work, if one is established. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.requestId;
}
