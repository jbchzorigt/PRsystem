/**
 * API surface conventions shared by every route and every client.
 */

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

/** Routes excluded from the version prefix: operational surfaces, not API contract. */
export const UNVERSIONED_PATHS = ['/health/live', '/health/ready', '/docs-json'] as const;

/** Correlates a request across API, worker, outbox and audit (13-telemetry-and-redaction). */
export const CORRELATION_HEADER = 'x-request-id';

/**
 * Client-supplied idempotency key for money-changing and lifecycle-changing
 * commands (CLAUDE.md §6).
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Optimistic concurrency for revision/CAS resources (ADR-0011). The client
 * echoes the revision it read; a mismatch is `REVISION_MISMATCH`, never a
 * last-write-wins overwrite.
 */
export const REVISION_HEADER = 'if-match-revision';

/**
 * A stable identifier as it crosses the wire. Opaque to clients: nothing may be
 * inferred from its shape, and it never encodes tenancy or authority.
 */
export type StableId = string;

/** Money is a JSON **string**, never a number — see `@prsystem/money`. */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: 'MNT';
}
