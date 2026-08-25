# Architecture Decision Records

Each ADR records one decision, its context, the alternatives rejected, and its consequences.

**Status values:** `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`

An ADR is amended only by a new ADR. Adding a module, an inter-module dependency edge, an external
interface, or a cross-realm data path requires a new ADR before implementation.

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-0001](ADR-0001-modular-monolith.md) | Modular monolith with one API and one worker deployment | Accepted |
| [ADR-0002](ADR-0002-postgresql-sole-authority.md) | PostgreSQL is the sole authoritative store; Redis is never authoritative | Accepted |
| [ADR-0003](ADR-0003-drizzle-with-reviewed-sql.md) | Drizzle ORM with reviewed SQL for locks and advanced constraints | Accepted |
| [ADR-0004](ADR-0004-versioned-migrations-only.md) | Versioned migrations only; no schema push; no down-migrations | Accepted |
| [ADR-0005](ADR-0005-four-isolated-realms.md) | Four isolated authentication realms in one deployment | Accepted |
| [ADR-0006](ADR-0006-seven-condition-authorization.md) | A single seven-condition authorization pipeline | Accepted |
| [ADR-0007](ADR-0007-integer-money-basis-points.md) | Integer MNT and integer basis points | Accepted |
| [ADR-0008](ADR-0008-utc-storage-hotel-local-dates.md) | UTC storage with hotel-local business dates | Accepted |
| [ADR-0009](ADR-0009-append-only-ledgers.md) | Append-only ledgers with reversal and correction records | Accepted |
| [ADR-0010](ADR-0010-transactional-outbox.md) | Transactional outbox with at-least-once delivery and idempotent consumers | Accepted |
| [ADR-0011](ADR-0011-concurrency-mechanism-selection.md) | Concurrency mechanism chosen by race class, not per feature | Accepted |
| [ADR-0012](ADR-0012-ports-and-simulators.md) | Typed provider ports with deterministic simulators; adapters in Phase 20 | Accepted |
| [ADR-0013](ADR-0013-module-boundary-enforcement.md) | Module boundaries enforced by contracts plus lint | Accepted |
| [ADR-0014](ADR-0014-separate-state-axes.md) | Separate state axes; never a single status column | Accepted |
| [ADR-0015](ADR-0015-snapshot-on-confirmation.md) | Snapshot on confirmation; never re-resolve from current configuration | Accepted |
| [ADR-0016](ADR-0016-policy-as-versioned-configuration.md) | Policy values are versioned configuration and fail closed when absent | Accepted |
