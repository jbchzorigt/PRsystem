# ADR-0013 — Module boundaries enforced by contracts plus lint

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §3

## Context

In one process with one database, nothing physically prevents a module from importing another's
repository or joining to its tables. The requirements forbid it, and the Police isolation rule depends
on the boundary being mechanically enforced rather than merely intended.

## Decision

Each module owns its tables exclusively and exposes a `contracts` surface. Cross-module access is
limited to contract calls, permission-checked query services, projections and outbox events. An ESLint
boundary rule denies importing another module's repository, entity or schema path, with a deliberate
violation fixture that must fail lint. A dependency-graph test asserts that `police` is imported by no
module and that web packages import only `contracts` types.

## Alternatives rejected

- **Convention and review.** Erodes silently over nineteen modules.
- **Separate databases per module.** Contradicts ADR-0001 and would break cross-module transactions
  the requirements demand.
- **Runtime checks.** Too late; boundaries should fail at build time.

## Consequences

- Adding a dependency edge is a visible, ADR-worthy act.
- Consumers depend on rebuildable projections, so a projection defect is availability, not
  correctness.
- Later extraction of a module to a service remains feasible.
