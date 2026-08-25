# ADR-0004 — Versioned migrations only; no schema push; no down-migrations

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §10

## Context

Schema push diverges environments silently and cannot express `CONCURRENTLY`, `NOT VALID` or
append-only rules. Down-migrations imply a schema can be reversed while data has moved forward, which
is usually false for a financial ledger.

## Decision

Every schema change is a numbered, immutable, reviewed SQL migration. Local development builds its
database by running migrations. Both fresh and upgrade paths are tested every phase (`GATE-MIGR`).
Destructive change uses expand → backfill → dual-write → contract. There are no down-migrations;
recovery is a forward migration, and catastrophic recovery is point-in-time restore.

## Alternatives rejected

- **Schema push in development only.** Development would stop exercising the migration path, which is
  where production risk lives.
- **Reversible migration pairs.** A tested-forward, untested-backward path is a false sense of safety.

## Consequences

- The migration path is exercised daily.
- Destructive changes span two migrations and often two phases, which is slower and safer.
- Rolling back an application version does not require a schema rollback, because expand/contract
  keeps N-1 working.
