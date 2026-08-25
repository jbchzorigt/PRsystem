# ADR-0010 — Transactional outbox with at-least-once delivery and idempotent consumers

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §6

## Context

Committing a business change and then sending an email, SMS or cross-module event is a dual-write
problem. Police alerts, activation links and notifications must not be lost when a change commits, and
must not fire when it rolls back.

## Decision

Write the domain change and its events in one transaction. A relay in `worker` delivers events
at-least-once after commit. Every consumer is idempotent on a natural key. Provider calls never happen
inside a transaction.

## Alternatives rejected

- **Send inside the transaction.** A slow provider holds locks; a rollback cannot unsend.
- **Send after commit without an outbox.** A crash between commit and send loses the event silently.
- **Exactly-once delivery.** Not achievable across a network boundary; consumer idempotency is the
  honest formulation.

## Consequences

- Consumers must declare an idempotency key: `stay_id + wanted_person_id` for Police matching,
  `(event_id, channel)` for notifications.
- Outbox lag is a monitored SLI because Police alerts ride it.
- A restore must not re-deliver already-sent events; the delivery marker and cut-off procedure handle
  this.
