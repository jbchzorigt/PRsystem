# PRsystem — Recovery Runbook

**Version:** 1.0 (Phase 22 — the rehearsal measured; docs/architecture/02 §7, 15 §5)
**Status:** implementation-owned. The targets it measures against are `PROVISIONAL_ARCHITECTURE_DEFAULT`
until an approved decision adopts them (P1-10); a measurement that falls short is a gap against a
provisional target, never a reason to lower it.

PostgreSQL is the single recovery unit (docs/architecture/02 §7). The API and the worker are
stateless; Redis holds only queues that re-drive from the outbox; object storage holds only
regenerable export artefacts under a one-hour TTL. Recovering the platform is recovering the
database, then telling the worker what not to send twice.

---

## 1. Posture

| Element | Requirement | Where it is decided |
| --- | --- | --- |
| Base backup | `pg_basebackup` (tar format, fast checkpoint), at least daily, retained 30 days | Deployment; rehearsed by `tools/recovery-rehearsal.mjs` |
| WAL archiving | `wal_level = replica`, `archive_mode = on`, an `archive_command` that never overwrites, `archive_timeout` ≤ 60 s | The RPO exposure is bounded by `archive_timeout` plus the archive copy; the rehearsal uses 30 s |
| Archive location | Separate from the primary's storage; encrypted at rest and in transit (CLAUDE.md §8) | Deployment |
| Retention | 30 days of point-in-time recovery, monthly archives per the P1-09 retention matrix once approved | P1-09, P1-10 |
| Restore rehearsal | Every release cycle; the Phase 22 rehearsal is the first measured one | `tools/recovery-rehearsal.mjs` |

The rehearsal tool is the executable form of this runbook: it starts a dedicated PostgreSQL 17 with
the archiving above, provisions the schema through the platform's own bootstrap and migration
journal, writes real business rows through the API's harness, takes the base backup, destroys the
primary without warning, restores twice — to the end of the archive and to a chosen point in time —
and verifies rows, schema and the outbox delivery markers. It touches nothing but containers and
volumes it names `prsystem-rehearsal-*`.

```bash
node tools/recovery-rehearsal.mjs --out docs/implementation/phase-22-recovery-rehearsal.json
```

## 2. Measured (Phase 22)

From [phase-22-recovery-rehearsal.json](phase-22-recovery-rehearsal.json), measured on
2026-09-10 on one machine from a local archive, `postgres:17.6-alpine`, `archive_timeout = 30`:

| Measure | Result | Provisional target | Within |
| --- | ---: | ---: | --- |
| RPO exposure — the newest commit's wait until its WAL segment was archived, with nothing switched by hand | 25.2 s (bounded by the 30 s cadence) | ≤ 300 s | yes |
| RTO — from the primary's destruction to a restored, verified database (restore A) | 1.6 s | ≤ 14 400 s | yes, locally |
| Restore A — base backup + every archived segment | 40 of 40 rooms, audit and outbox counts equal, schema dump identical | complete | yes |
| Restore B — point in time between two commits | 30 rooms present, the 31st absent, schema dump identical | exact | yes |
| Base backup of the provisioned database | 1.5 s, 51 MB | — | — |

**What the RTO measures and what it does not.** The 1.6 s is the restore itself — unpack, replay,
promote, verify — on one machine from a local archive of a small database. A hosted restore adds
provisioning a server, transferring the base backup and the archive, and re-pointing the API and
worker; the runbook budgets those in §3 and the four-hour target is what the whole procedure must
meet, not what the replay did. The RPO exposure is the archiver's cadence: a segment is archived
when it fills or when `archive_timeout` elapses, so a commit can wait up to that timeout, and the
rehearsal saw 25 s of it.

## 3. Procedure

1. **Declare.** Record the failure time `T_fail` (server clock) and stop the API and the worker so
   nothing writes to a primary that may be half alive.
2. **Decide the target.** Latest possible (`recovery_target` unset) for a crash; a point in time
   `T_target` before a destructive change for a logical error. Record the decision and who made it.
3. **Provision.** A PostgreSQL 17 instance with the same major version, the cluster roles bootstrap
   (`packages/db/bootstrap/cluster-roles.sql`, [database-bootstrap-runbook.md](database-bootstrap-runbook.md))
   is *not* re-run — the roles are inside the base backup.
4. **Restore the base backup** into the empty data directory; `touch recovery.signal`; set
   `restore_command` to fetch from the archive, `recovery_target_time = 'T_target'` and
   `recovery_target_inclusive = true` for a point in time, and `recovery_target_action = 'promote'`.
5. **Start and wait** for `pg_is_in_recovery()` to answer `false`.
6. **Verify** before anyone connects: `SELECT count(*) FROM platform.stay` and the audit and outbox
   counts against the last known figures; `pg_dump --schema-only` against the release's schema
   dump; the newest `audit.platform_event` row's time against `T_target`.
7. **Cut off the side effects** (§4), then start the worker, then the API.
8. **Record** the incident: `T_fail`, `T_target`, the data window lost (`T_fail − T_target`, or the
   RPO exposure for a crash), the restore's start and finish, who verified what.

Budget for the four hours: provisioning and transfer ≤ 2 h; restore and replay ≤ 30 min for a
database within the year-one volume of docs/architecture/15 §1; verification and cut-off ≤ 30 min;
the rest is margin.

## 4. Side effects after a restore

A restored database is the truth as of its recovery target. Two things it cannot know:

- **What was delivered after the target.** An outbox event the worker relayed, an email or an SMS it
  sent between `T_target` and `T_fail`, is marked delivered only in the database that was lost. On
  the restored one those rows are pending again, and a worker started blindly would send them a
  second time. Before the worker starts, mark every outbox delivery and notification row whose
  event occurred before `T_fail` as delivered with a reason naming this incident:

  ```sql
  UPDATE platform.outbox_delivery d
     SET state = 'PUBLISHED', published_at = now(), last_error = 'recovery cut-off <incident id>'
    FROM platform.outbox_event e
   WHERE e.event_id = d.event_id AND d.published_at IS NULL AND e.occurred_at < '<T_fail>';
  ```

  The rehearsal shows the markers survive a restore untouched (restore A: published count equal
  before and after), so only the window between the target and the failure needs this.
- **What a provider did after the target.** A payment confirmed, or a callback applied, after
  `T_target` is gone from the database but not from the provider. The worker's reconciliation
  sweeps (`billing.refund_late_check`, the Phase 15 invoice-expiry and refund-SLA sweeps, the Phase
  20 settlement sweeps) and the Operation reconciliation queue (doc 14 §4.2) are how those come back:
  run a provider status re-query for every payment attempt open at `T_target` before reopening the
  portals. Nothing re-credits an entitlement or reopens a hold automatically (CLAUDE.md §7).

Late provider callbacks arriving after the restore are handled by the callback rules: verified,
deduplicated by `(provider, provider_event_id)`, matched, re-queried, and applied idempotently.

## 5. What this runbook does not cover yet

- A hosted environment: the measured numbers are one machine's. The first production-shaped
  rehearsal must repeat §2 against the real archive location and record its own figures.
- Backup encryption and archive access control: mandated (CLAUDE.md §8), decided by the deployment,
  not exercised by the rehearsal.
- Object storage and Redis: regenerable and re-driven respectively; no restore step.
