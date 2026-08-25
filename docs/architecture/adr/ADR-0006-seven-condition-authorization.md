# ADR-0006 — A single seven-condition authorization pipeline

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §4

## Context

`docs/18` defines a large action matrix with role, package, subscription state and scope dimensions,
plus recurring rules: Hotel Admin never inherits operational roles; package entitlement gates above
role; a role name grants nothing; UI hiding is not authorization.

## Decision

Implement one pipeline evaluated by every backend action, in fixed order: realm → active account and
membership → named permission → tenant and resource scope → package entitlement → account/hotel/
subscription state → step-up MFA. Stages 2–4 return one indistinguishable denial; stages 5–7 return
actionable codes. The permission catalog is generated from the matrix and tested against it row by
row.

## Alternatives rejected

- **Per-endpoint guards.** Guarantees drift across ~19 modules and hundreds of actions.
- **Role checks at the call site.** Cannot express the package gate or the no-inheritance rule
  consistently.
- **Policy engine as a separate service.** Adds a network hop to every request for no benefit inside
  a monolith.

## Consequences

- Authorization is one auditable code path with one test surface.
- The matrix is executable: a doc 18 row without a test is a visible gap.
- Cross-tenant probing yields no existence signal.
- Every action must declare its permission; there is no implicit allow.
