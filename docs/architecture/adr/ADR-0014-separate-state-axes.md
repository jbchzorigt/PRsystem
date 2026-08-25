# ADR-0014 — Separate state axes; never a single status column

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §5; REST-DEC-001; PAY-DEC-005

## Context

The requirements are explicit and repeated: a restaurant order has seven independent axes; a booking
separates booking, hold, payment, attempt, refund and payout; a shift separates operational state from
financial review; a Match separates workflow from outcome; a template separates entity lifecycle from
version lifecycle. Collapsing these produces contradictions such as "refunded but never paid" or
"closed but awaiting review".

## Decision

Model each axis as its own column with its own state machine. A UI label is derived from axes; it is
never stored as a state. Transitions are validated per axis, and cross-axis rules are explicit
predicates.

## Alternatives rejected

- **One status enum per entity.** Cannot represent `payment = PAID` with `order = CANCELLED` and
  `refund = PENDING`, which the requirements demand.
- **Status plus flags.** Flags drift out of sync with the primary status.

## Consequences

- More columns and more explicit transitions, which is the point.
- Reporting reads the axis it means rather than inferring from a blended label.
- `GATE-UNIT` tests each axis's transition table independently, including forbidden transitions.
