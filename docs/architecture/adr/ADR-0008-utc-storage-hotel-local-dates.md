# ADR-0008 — UTC storage with hotel-local business dates

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §5

## Context

Business rules are hotel-local: the fixed checkout time, the nightly calendar rule, the no-show
`23:59:59` cutoff, the hotel-local day bound on backdating, and report date bases. Event ordering,
audit and provider reconciliation are global.

## Decision

Store every instant as UTC `timestamptz`. Derive hotel-local dates from the hotel's IANA timezone at
the point of use. Never store a local date as an instant, and never compare a local date to an
instant without an explicit conversion. Server time is captured once per transaction.

## Alternatives rejected

- **Store local time with an offset column.** Breaks across DST boundaries and complicates ordering.
- **Assume one platform-wide timezone.** Correct today, but it would bake an assumption into every
  query rather than into one column.

## Consequences

- `packages/time` owns the conversions; modules never format dates ad hoc.
- Each report metric declares its date basis explicitly (`FIN-DEC-006`).
- The three stay timestamps stay distinct: a backdated arrival never moves a financial effective time
  or a Police alert time.
