# ADR-0018 — Append-only monthly-partitioned audit streams, with Police audit separated

**Status:** Accepted · **Date:** Phase 01 · **Closes:** DM-02
**Relates to:** ADR-0009 (append-only), ADR-0016 (policy as configuration), ADR-0017 (RLS and roles)

## Context

Audit is a legal and operational asset: doc 13 §13.1 enumerates mandatory Police audit events, and
`RBAC-DEC-006` requires protected actions — including denied attempts — to be recorded. Volume is
high and long-lived, retention differs by data class, and Police access audit must not be readable by
platform operators. `04-logical-data-model.md` left partitioning open as **DM-02**.

## Decision

1. **Two streams, not one.** `audit.platform_event` and `police_audit.security_event` are separate
   tables in separate schemas with separate grants. Platform operators cannot read Police audit;
   `prsystem_api` has no grant on `police_audit`.
2. **Append-only, and write-only for business runtimes.** Both carry the ADR-0009 rules rejecting
   `UPDATE` and `DELETE`. **Amended in Phase 03 by customer direction:** a business runtime role
   appends and cannot read. **Tightened again in the Phase 03 security review:** a runtime role holds *no*
   table privilege on an audit relation at all. Appending goes through the SECURITY DEFINER wrappers
   `audit.append_platform_audit_event` and `police_audit.append_police_security_event`, which derive
   server time, realm, actor and tenant scope from the trusted transaction context rather than
   accepting them from the caller, and which are owned by `prsystem_audit_writer` — a role holding
   `INSERT` and not `SELECT`.

   **One writer owns both functions, by design.** That is an *infrastructure*
   role, not a runtime one, and it is a different kind of separation from the
   realm boundary: it is NOLOGIN, no runtime can assume it, it can read neither
   stream, and it never chooses what it writes. Realm separation is enforced by
   the realm check inside each function and by realm-separated `EXECUTE` grants —
   `prsystem_api`/`prsystem_worker` on the platform function, `prsystem_police` on
   the Police one. Splitting the owner would add a role without adding a boundary. Reading is the privilege of the dedicated `prsystem_audit_reader`,
   which in turn cannot write. `police_audit.security_event` is the same shape with `prsystem_police` and
   `prsystem_police_audit_reader`, and neither reader can cross to the other stream. The earlier
   wording granted runtime roles `SELECT` as well, which would have let any API query read the whole
   platform audit trail.
3. **Monthly range partitions by server timestamp.** Partition key is the server-generated
   `occurred_at`, never a client-supplied or business-effective time, so a backdated business event
   still lands in the partition of the month it was actually recorded.
4. **Partitions are pre-created.** A maintenance job creates the next partitions ahead of time.
   `platform.ensure_month_partitions` is an allow-list over exactly the two audit streams, bounds the
   requested month count, fixes its `search_path`, fully qualifies every object, serialises with an
   advisory lock, and re-establishes ownership, grants and TRUNCATE protection on each new partition —
   so a partition created next month is no more permissive than one created by the migration. An
   alert fires when the horizon of pre-created partitions falls below the configured threshold — a
   missing partition is an operational incident detected *before* a write fails, not after.
5. **High-risk actions fail closed.** Where an action's audit record is written in the same
   transaction as its effect, a failure to record the audit rolls back the effect. This applies to
   every money-changing and lifecycle-changing command, every Police outcome decision, and every
   step-up-gated Operation action. An action that cannot be attributed does not happen.
6. **Retention is configuration, per data class.** Following ADR-0016, retention lives in versioned
   configuration keyed by data class, with legal hold suspending removal. **No Police retention
   duration is invented here.** Absent an approved ЦЕГ value (EXT-09), Police audit is retained and
   not purged, and the dependent historical-search feature stays disabled in production.
7. **Removal is privileged.** Partition detach and drop run through functions owned by `prsystem_partition_mgr` under a named,
   audited job that checks legal hold first. It is never an application delete.

## Alternatives rejected

- **One unpartitioned table.** Retention would require mass `DELETE` against an append-only table,
  and index bloat would degrade the queries investigators depend on.
- **One partitioned table with a realm column.** A single grant mistake would expose Police audit to
  platform operators; the requirement is separation, not filtering.
- **Partition by business-effective time.** A backdated arrival would land in a closed partition,
  which breaks both retention accounting and the meaning of "when was this recorded".
- **Audit written asynchronously.** Fast, but a crash between effect and audit produces an
  unattributable financial change — the exact repudiation risk `T-X-03` addresses.

## Consequences

- Retention becomes a partition operation rather than a row-by-row purge.
- Audit write availability is on the critical path for high-risk actions. That is intentional: the
  alternative is an unattributable effect.
- The partition-horizon alert is a required operational runbook item from Phase 03 onward.
- Investigator queries filter by month first, which suits both partition pruning and the 31-day Police
  search window.

## Verification

| Test | Gate | Asserts |
| --- | --- | --- |
| Append-only | `GATE-MIGR` | `UPDATE` and `DELETE` on both streams have no effect for runtime roles |
| Grant separation | `GATE-INTEG` | `prsystem_api` cannot read `police_audit`; Operation roles cannot either |
| Partition routing | `GATE-INTEG` | A backdated business event lands in the partition of its server-recorded month |
| Missing partition | `GATE-INTEG` | Absent a partition, the write fails and the enclosing high-risk action rolls back |
| Fail-closed | `GATE-INTEG` | Simulated audit-write failure rolls back the money-changing effect |
| Retention | `GATE-INTEG` | Purge honours legal hold; Police audit is not purged without an approved policy version |
