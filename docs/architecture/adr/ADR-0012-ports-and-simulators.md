# ADR-0012 — Typed provider ports with deterministic simulators; adapters in Phase 20

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §9

## Context

All eleven external gates are blocked: no contract, credential or signature rule is confirmed. The
requirements forbid inventing them, but the domain logic that depends on them — payment-gated
provisioning, hold expiry, refund obligations, Match alerts — is exactly where the hardest correctness
requirements live.

## Decision

Define a typed port per external system with a uniform result type. Ship a deterministic simulator
that passes an eight-scenario conformance suite: duplicate, out-of-order, delayed-past-expiry, unknown
reference, amount mismatch, currency mismatch, invalid signature, timeout-then-late-success. Build
production adapters in Phase 20 only, against the same suite. An adapter whose gate is uncleared
returns `DISABLED` and makes no network call.

## Alternatives rejected

- **Wait for contracts.** Would block eighteen phases on external parties.
- **Best-guess adapters now.** Invents signature schemes and endpoints — explicitly forbidden.
- **Ad-hoc mocks per test.** Every module would re-derive callback semantics, and the hard scenarios
  would go untested.

## Consequences

- Domain logic is fully testable before any contract is signed.
- The simulator conformance suite is the acceptance criterion for each real adapter.
- Ports may be defined earlier than Phase 20 only where a phase cannot otherwise be built or gated;
  the permitted set is enumerated in `build-plan.md` §2.
