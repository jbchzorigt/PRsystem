/**
 * Drizzle schema root.
 *
 * Phase 02 owns the migration mechanism, not the data model: this schema is
 * deliberately empty. Platform, IAM, audit, outbox, idempotency and every
 * business table are introduced in Phase 03 and later, each behind its own
 * versioned migration (ADR-0004).
 *
 * `packages/db/src/migrate.test.ts` asserts that applying every migration to a
 * fresh database still leaves zero base tables in `public`, so this emptiness is
 * enforced by a gate rather than by convention.
 */
export {};
