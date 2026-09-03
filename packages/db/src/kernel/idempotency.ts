import { createHash } from 'node:crypto';
import type { UnitOfWork } from '../unit-of-work';

/**
 * Idempotency records (CLAUDE.md §6, 04-logical-data-model §10).
 *
 * A retry must never create a second business effect. The record is claimed in
 * the same transaction as the effect, so a crash between them is impossible.
 */

export type IdempotencyOutcome =
  | { readonly kind: 'claimed'; readonly idempotencyId: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'key_reused_with_different_payload' };

export interface IdempotencyRequest {
  readonly operation: string;
  readonly key: string;
  readonly clientRef: string;
  /** Canonical request body. Hashed, never stored. */
  readonly payload: unknown;
  readonly ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Stable JSON: object keys sorted at every depth, so a semantically identical
 * body serialised in a different key order still hashes the same and is treated
 * as a genuine retry rather than a conflicting reuse.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = walk(source[key]);
      return sorted;
    }
    if (typeof node === 'bigint') return node.toString();
    return node;
  };
  return JSON.stringify(walk(value));
}

export function requestHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Claims the key, or reports why it cannot be claimed.
 *
 * The unique index on `(realm, actor, operation, key)` is the arbiter: two
 * concurrent identical requests race for the same row and exactly one wins, so
 * the effect happens once even under perfect simultaneity.
 */
export async function claimIdempotencyKey(
  uow: UnitOfWork,
  request: IdempotencyRequest,
): Promise<IdempotencyOutcome> {
  const hash = requestHash(request.payload);
  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const inserted = await uow.query<{ idempotency_id: string }>(
    `INSERT INTO platform.idempotency_key
       (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key,
        request_hash, correlation_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
     ON CONFLICT (realm, actor_ref, operation, idempotency_key) DO NOTHING
     RETURNING idempotency_id`,
    [
      uow.context.hotelId,
      uow.context.realm,
      uow.context.actorRef,
      request.clientRef,
      request.operation,
      request.key,
      hash,
      uow.context.correlationId,
      ttl,
    ],
  );

  const claimed = inserted.rows[0];
  if (claimed !== undefined) {
    return { kind: 'claimed', idempotencyId: claimed.idempotency_id };
  }

  const existing = await uow.query<{
    request_hash: string;
    state: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT request_hash, state, response_status, response_body
       FROM platform.idempotency_key
      WHERE realm = $1 AND actor_ref = $2 AND operation = $3 AND idempotency_key = $4`,
    [uow.context.realm, uow.context.actorRef, request.operation, request.key],
  );

  const row = existing.rows[0];
  if (row === undefined) {
    // The row exists for a different tenant and RLS hides it. Reusing a key
    // across tenants is refused rather than silently reassigned.
    return { kind: 'key_reused_with_different_payload' };
  }

  // Same key, different body: a client bug or a replay attack. Never serve the
  // stored response for a request that did not produce it.
  if (row.request_hash !== hash) {
    return { kind: 'key_reused_with_different_payload' };
  }
  if (row.state === 'in_progress') {
    return { kind: 'in_progress' };
  }
  return {
    kind: 'replay',
    status: row.response_status ?? 500,
    body: row.response_body,
  };
}

/** Stores the canonical response. Runs in the same transaction as the effect. */
export async function completeIdempotencyKey(
  uow: UnitOfWork,
  idempotencyId: string,
  status: number,
  body: unknown,
): Promise<void> {
  await uow.query(
    `UPDATE platform.idempotency_key
        SET state = $1, response_status = $2, response_body = $3::jsonb, completed_at = now()
      WHERE idempotency_id = $4 AND state = 'in_progress'`,
    [
      status >= 200 && status < 400 ? 'succeeded' : 'failed',
      status,
      canonicalJson(body),
      idempotencyId,
    ],
  );
}

export type IdempotencyLock =
  | { readonly kind: 'in_progress'; readonly idempotencyId: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'absent' };

/**
 * Locks an already-claimed key for the transaction that will complete it.
 *
 * A command that has to call a provider *between* claiming its key and storing
 * its result — creating an invoice is the case — cannot hold the claim's
 * transaction open across the network. So it claims in one transaction, calls
 * the provider with a stable key, and then locks the record in the transaction
 * that persists the outcome. Two concurrent completions serialise here: the
 * second waits on the row lock and, once the first has committed, finds the
 * stored response and replays it rather than persisting a second effect.
 */
export async function lockIdempotencyClaim(
  uow: UnitOfWork,
  request: { readonly operation: string; readonly key: string },
): Promise<IdempotencyLock> {
  const locked = await uow.query<{
    idempotency_id: string;
    state: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT idempotency_id, state, response_status, response_body
       FROM platform.idempotency_key
      WHERE realm = $1 AND actor_ref = $2 AND operation = $3 AND idempotency_key = $4
        FOR UPDATE`,
    [uow.context.realm, uow.context.actorRef, request.operation, request.key],
  );
  const row = locked.rows[0];
  if (row === undefined) return { kind: 'absent' };
  if (row.state === 'in_progress')
    return { kind: 'in_progress', idempotencyId: row.idempotency_id };
  return { kind: 'replay', status: row.response_status ?? 500, body: row.response_body };
}
