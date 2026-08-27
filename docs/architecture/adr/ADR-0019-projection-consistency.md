# ADR-0019 — Same-transaction read models within a module; eventual consistency across modules

**Status:** Accepted · **Date:** Phase 01 · **Closes:** DM-03
**Relates to:** ADR-0010 (outbox), ADR-0013 (module boundaries)

## Context

Several read models exist: the guest registry list, Operation KPI cards, the public search index,
rating aggregates, rollout batch progress. `04-logical-data-model.md` left their consistency model
open as **DM-03**. Getting this wrong in either direction is costly — synchronous cross-module
updates would violate ADR-0013, while making a *critical* decision from a lagging projection would
permit double-selling a room or refunding twice.

## Decision

1. **Within a module: same transaction.** A module may maintain its own critical read model inside
   the transaction that changes the source data — for example category availability counters, deposit
   balance aggregates and rollout batch progress. The module owns both sides, so there is no boundary
   violation and no lag.
2. **Across modules: outbox plus idempotent inbox.** Any read model owned by a different module than
   its source is updated asynchronously through the transactional outbox, with an inbox consumer that
   is idempotent on a natural key. This preserves ADR-0013.
3. **Observable freshness.** Every asynchronous projection exposes, where operationally relevant, an
   `as_of` timestamp, a processing status and a measurable lag. The Operation KPI view states its
   `as_of` moment; the guest registry exposes its lag; export jobs record the `as_of` of the data
   they captured. A stale projection must be visibly stale rather than silently wrong.
4. **Critical commands never read a projection.** The following classes always read authoritative
   rows under the appropriate lock, never a read model:
   - authorization and entitlement decisions;
   - payment and refund eligibility;
   - inventory and availability allocation, including category holds and stock transfers;
   - deposit balance and allocation;
   - readiness and check-in admission;
   - any transition guarded by a uniqueness or non-negativity invariant.
5. **Rebuildable.** Every projection is fully rebuildable from authoritative records or the event log,
   with a documented rebuild job. Losing or corrupting a projection is an availability incident, never
   a correctness incident.

## Alternatives rejected

- **All projections synchronous.** Would require cross-module writes in one transaction, breaking
  module ownership and coupling unrelated failure domains.
- **All projections asynchronous, including within a module.** Adds lag and a rebuild dependency to
  data a module could simply maintain correctly and cheaply in its own transaction.
- **Read-your-writes via cache pinning.** Papers over the model rather than deciding it, and would
  still leave critical commands reading a derived value.

## Consequences

- Reviewers have a simple test: if a command's correctness depends on the value, it must read the
  authoritative row.
- Dashboards may lag; they must say so. "Silently stale" is treated as a defect.
- Rebuild jobs are first-class deliverables of the phases that introduce projections, not afterthoughts.
- Outbox lag becomes a monitored SLI for every consumer-owned projection, alongside its existing role
  in Police alert delivery.

## Verification

| Test | Gate | Asserts |
| --- | --- | --- |
| Critical-path isolation | `GATE-INTEG` | With a deliberately stale projection, availability, payment eligibility, refund eligibility and authorization still decide correctly |
| Idempotent inbox | `GATE-CONC` | A redelivered event updates the projection once |
| Rebuild | `GATE-INTEG` | Truncate and rebuild reproduces the projection exactly |
| Freshness surface | `GATE-INTEG` | Each async projection exposes `as_of` or lag where declared |
