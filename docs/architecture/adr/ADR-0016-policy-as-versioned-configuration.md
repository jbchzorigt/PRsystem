# ADR-0016 — Policy values are versioned configuration and fail closed when absent

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §9; POL-DEC-010; POL-DEC-011; GUEST-DEC-008

## Context

Several values cannot be chosen by the engineering team. Police alert escalation minutes and Police
check-in retention require written ЦЕГ approval. Guest retention may be overridden by law. SMS caps
depend on a provider contract. The requirements state plainly that these must not be hard-coded, and
that without an approved value the dependent feature is not enabled in production.

## Decision

Model each such value as a row in a versioned configuration table carrying value, owner, legal basis,
effective date, retroactivity and an audit trail. Code reads the current version. When no approved
version exists, the dependent feature is **disabled** in production — never defaulted. Development and
staging may use documented interim defaults, recorded in the P1 register.

## Alternatives rejected

- **Constants in code.** Directly contradicts the requirements and makes a legal change a deploy.
- **Environment variables.** No owner, no legal basis, no audit, no history.
- **Sensible defaults in production.** Would silently substitute engineering judgement for a legal
  approval — the specific failure the requirements guard against.

## Consequences

- Police escalation timers and Police historical search stay disabled in production until EXT-09
  clears; the Police module is complete but partly inert, which is the intended behaviour.
- A policy change is an audited data change, not a release.
- Interim development defaults must never leak into production, which `GATE-INTEG` asserts by
  checking that a production-mode read of an unapproved policy disables the feature.
