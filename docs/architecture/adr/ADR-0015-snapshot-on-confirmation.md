# ADR-0015 — Snapshot on confirmation; never re-resolve from current configuration

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §5

## Context

Tariffs, cleaning buffers, deposit amounts, minibar selling prices, template versions and retention
policy all change over time. The requirements insist that a confirmed booking, an active stay and a
historical report never change because configuration changed later.

## Decision

At confirmation, copy every value a later charge or report depends on into an immutable snapshot:
unit price, tariff source level and entity id, configuration version, fixed checkout time, cleaning
buffer, the full minibar price book, retention policy version. Downstream logic reads the snapshot,
never the live catalog. Where possible the dependency is a foreign key to a snapshot row rather than a
copied value, so re-resolving is not merely discouraged but impossible.

## Alternatives rejected

- **Temporal tables with as-of queries.** Correct in principle but fragile: a single query that forgets
  the as-of clause silently reprices history.
- **Effective-dated configuration read at report time.** Same fragility, and it cannot express
  "this stay used exactly this version".

## Consequences

- Snapshots are the largest single source of write amplification, accepted deliberately.
- A product absent from a stay's price book cannot be charged — a referential impossibility rather
  than a validation rule.
- Restating history requires a new correction record, never a configuration edit.
