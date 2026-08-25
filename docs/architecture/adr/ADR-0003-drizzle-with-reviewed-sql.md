# ADR-0003 — Drizzle ORM with reviewed SQL for locks and advanced constraints

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §1

## Context

Type safety across ~19 modules is valuable, but the correctness of this system rests on PostgreSQL
features most ORMs abstract away: `SELECT … FOR UPDATE`, exclusion constraints, partial unique
indexes, `CREATE INDEX CONCURRENTLY`, `NOT VALID` constraint validation, and append-only rules.

## Decision

Use Drizzle for schema definition, typed queries and migration generation. Write explicit reviewed
SQL wherever a lock, an advanced constraint or a concurrency-sensitive statement is involved. Every
generated migration is reviewed as SQL before it is committed.

## Alternatives rejected

- **Heavier ORM with lazy loading and identity map.** Hides query shape and lock acquisition, which
  are exactly what must be explicit here.
- **Raw SQL only.** Loses type safety across a large module count and increases drift between schema
  and code.

## Consequences

- Migration files are readable SQL that a reviewer can reason about.
- Lock acquisition is visible at the call site rather than implied by an abstraction.
- Some queries are hand-written; they are covered by `GATE-INTEG` against real PostgreSQL.
