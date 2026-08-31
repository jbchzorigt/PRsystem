import { createHash } from 'node:crypto';

/**
 * The one way an internal idempotency key is derived from a caller's.
 *
 * A client key may legally be 200 characters, which is also the column's limit.
 * Appending anything to it — `:discovery`, or `:${kind}:${ref}` — therefore
 * produced a key the database refused, and because that refusal surfaced inside
 * a best-effort retry it left the work permanently queued instead of failing
 * loudly. Concatenation cannot be made safe by trimming either: truncating the
 * caller's key makes two different requests collide, which is worse than an
 * error.
 *
 * So a derived key is a **digest**, not a concatenation. It is:
 *
 *  - fixed length, and always inside the 8–200 the column allows;
 *  - deterministic, so a retry of the same request derives the same key;
 *  - collision-resistant, so two different requests never share one;
 *  - unambiguously bound — every component is length-prefixed, so
 *    `("ab", "c")` and `("a", "bc")` are different keys.
 *
 * The operation name stays in the clear so an operator reading the table can
 * tell what a row belongs to; only the components are digested.
 */

/** Longest operation tag that still leaves the result inside the column limit. */
const MAX_OPERATION = 100;

export function derivedIdempotencyKey(operation: string, ...components: readonly string[]): string {
  if (operation.length === 0 || operation.length > MAX_OPERATION) {
    throw new Error(`the derived-key operation must be 1..${String(MAX_OPERATION)} characters`);
  }

  const digest = createHash('sha256');
  for (const component of [operation, ...components]) {
    const bytes = Buffer.from(component, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    // Length-prefixed, so no component can be read as part of the next one.
    digest.update(length);
    digest.update(bytes);
  }

  // `d1` is the derivation version: if the scheme ever changes, keys derived
  // under the old one stay recognisable rather than silently colliding.
  return `d1.${operation}.${digest.digest('hex')}`;
}
