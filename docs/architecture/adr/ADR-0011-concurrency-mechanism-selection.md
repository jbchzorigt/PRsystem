# ADR-0011 — Concurrency mechanism chosen by race class, not per feature

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §6

## Context

The requirements name more than twenty concrete races: two guests paying for the last room, hold
expiry against a paid callback, a boundary worker against an upgrade callback, two Cleaners claiming
one task, parallel refills against scarce stock, duplicate rollout confirms. Left to per-feature
judgement, these would be solved inconsistently.

## Decision

Classify every race into one of ten classes (`11-concurrency-strategy.md` §2) and assign a fixed
mechanism per class: row lock, revision CAS, idempotency key, conditional claim, exclusion constraint,
partial unique index, balance check constraint, provider event dedup. Lock ordering is fixed
globally — hotel → room → stay → folio → deposit → drawer shift. Every race in the register has a
`GATE-CONC` test using real connections and a barrier.

## Alternatives rejected

- **Serializable isolation everywhere.** High abort rates under the contention patterns here, and it
  would still not express "at most one non-terminal pending".
- **Optimistic concurrency only.** Fails for scarce-resource races where the loser must be told
  precisely why.
- **Application-level mutexes.** Not durable, not correct across instances, and Redis locks are
  excluded by ADR-0002.

## Consequences

- Choosing a mechanism is a lookup, not a debate.
- Deadlock risk is bounded by the fixed lock order.
- A race without a `GATE-CONC` test is treated as unmitigated regardless of the code.
