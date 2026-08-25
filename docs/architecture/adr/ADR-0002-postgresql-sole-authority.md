# ADR-0002 — PostgreSQL is the sole authoritative store; Redis is never authoritative

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §1

## Context

The system holds money: folios, deposits, cash drawers, booking settlement, inventory valuation. The
requirements repeatedly demand database-level guarantees — non-negative balances, one active shift
per drawer, one pending request per scope, exclusive occupancy intervals. Redis and BullMQ are needed
for jobs and retries.

## Decision

All business, financial, audit, session, idempotency and outbox state lives in PostgreSQL. Redis
holds queues, retry backoff, rate-limit counters and non-authoritative caches only. No business
decision is ever made from a Redis read.

## Alternatives rejected

- **Redis-backed distributed locks.** Lock correctness would depend on clock assumptions and
  liveness; PostgreSQL row locks are already transactional with the write.
- **Idempotency keys in Redis.** A flush or eviction could permit a duplicate business effect,
  contradicting "a retry must never create a second business effect".
- **Read-through cache for entitlement or balance.** A stale entitlement is an authorization defect.

## Consequences

- Losing Redis degrades throughput, never correctness. Rate limits fail closed; queues re-drive from
  the outbox.
- PostgreSQL is the single recovery unit, which simplifies the RPO/RTO story.
- Some read amplification is accepted in exchange for correctness. Reporting pressure is relieved
  with projections and, later, read replicas.
