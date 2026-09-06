# PRsystem — Assumptions, Drift Resolutions and Conflicts

**Version:** 1.3 (Phase 03 — kernel scope clarifications in §3.3 and drift resolution D-05)

Precedence used throughout (CLAUDE.md §0):

1. [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md)
2. the relevant module document
3. [docs/18-action-level-permission-matrix.md](../18-action-level-permission-matrix.md)

Nothing in this file edits a requirement document. Where two documents describe the same rule with
different wording, the resolution below records which text is canonical and why.

Phase numbers refer to the approved namespace 01–23 fixed in [build-plan.md](build-plan.md) §3.

---

## 1. Open P0 conflicts

**None.** [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §2 records
`Нээлттэй P0: байхгүй` — every P0 product, schema and API decision is closed. No item in this file
blocks Phase 01.

---

## 2. Documentation drift resolutions

These are wording differences between an earlier general document and a later canonical module
document. Each is resolved by precedence, not by choice.

### D-01 — Deposit configuration authority

- **Earlier text.** Doc 02 §3.4 and `RC-DEC-002`: "Manager эсвэл Hotel Admin … барьцааны дүнг …
  тохируулна", which reads as Hotel Admin holding the right directly.
- **Canonical text.** `DEP-DEC-008` (doc 20 §2.5) and `RBAC-DEC-013` (doc 18): deposit hotel and
  category configuration is a Manager or Manager Plus operational action; **Hotel Admin must hold the
  package-permitted Manager or Manager Plus role separately**.
- **Resolution.** Follow `DEP-DEC-008` and `RBAC-DEC-013`. Doc 02 §9.5 already states the same
  constraint, so doc 02 is internally consistent with the canonical rule; only the summary sentence in
  `RC-DEC-002` is loose. This matches the global rule `RBAC-DEC-001` — Hotel Admin never inherits
  operational roles.
- **Phases affected.** Phase 04 (permission catalog), Phase 10 (deposit configuration and folio).

### D-02 — Exceptional deposit source and exemption correction authority

- **Earlier text.** Doc 02 §3.4: "Онцгой тохиолдлын өөрчлөлтийг Manager/Hotel Admin баталж".
- **Canonical text.** Doc 02 §9.5 and `DEP-DEC-008`: pre-confirmation source and exemption correction
  is performed by Manager, or by Manager Plus on the 30 000₮ package, with a mandatory reason; Hotel
  Admin needs the separate operational role.
- **Resolution.** Follow doc 02 §9.5 and `DEP-DEC-008`.
- **Phases affected.** Phase 10.

### D-03 — Hourly duration granularity and price formula

- **Earlier text.** `STAY-DEC-002` and doc 18 §8: the hourly charge is "effective hourly price × the
  number of hours Reception selected".
- **Later canonical text.** `STAY-DEC-014` (doc 05 §24) and doc 00 §2 P0-39D: walk-in hourly stays use
  fixed 30-minute steps stored as integer `duration_minutes` and `half_hour_units`, with
  `hourly_total_mnt = ROUND_HALF_UP(effective_hourly_rate_mnt × half_hour_units / 2)`.
- **Resolution.** `STAY-DEC-014` is the canonical precision rule and is confirmed by doc 00, which has
  the highest precedence. `STAY-DEC-002` remains valid as the shape of the formula, and `STAY-DEC-006`
  confirms that no Manager-configurable minimum, maximum or increment is added. Implement
  `STAY-DEC-014`.
- **Phases affected.** Phase 06 owns the rate configuration (`STAY-DEC-002`, `STAY-DEC-006`); Phase 08
  owns the duration model and the rounding (`STAY-DEC-014`).

### D-04 — Shift approval authority phrasing

- **Earlier text.** Doc 02 §3.5 and doc 03 §2 mention "Manager/Hotel Admin" as shift reviewers in
  general prose.
- **Canonical text.** `SHIFT-DEC-001`–`SHIFT-DEC-007` and `RBAC-DEC-011`: routine financial review is
  performed by Manager or Manager Plus; Hotel Admin is the **exception** reviewer — Manager
  unavailable, Manager worked the shift as Reception, or a self-close with a variance. A zero-variance
  self-close needs no review at all.
- **Resolution.** Follow `SHIFT-DEC-001`–`SHIFT-DEC-007` and `RBAC-DEC-011`.
- **Phases affected.** Phase 11.

---

### D-08 — Which role runs a cross-tenant system job (ADR-0017, internal)

- **Earlier text.** ADR-0017 §7 role table: a cross-tenant system job "Runs as `prsystem_maintenance`
  under a named job identity".
- **Canonical text.** ADR-0017 §4 role table, same document: `prsystem_maintenance` is break-glass,
  **owns nothing, grants nothing**, and is "reachable by nobody, including the migration principal";
  §5 adds that normal cross-tenant maintenance does not use `BYPASSRLS`.
- **Resolution.** The §4/§5 reading is canonical; §7 was stale wording from before the Phase 03
  review removed the maintenance grants. §7 now names the `SECURITY DEFINER` function owned by
  `prsystem_maintenance_fn`, which holds no `BYPASSRLS` and establishes tenant scope one tenant at a
  time. This is a wording correction inside one implementation-owned ADR, not a design change: the
  code, the grants and `database-bootstrap-runbook.md` already implement the §4 reading. Enforced by
  `sec-ownership.test.ts` ("the break-glass role holds no schema privilege at all") and by the
  bootstrap final invariants.

### D-09 — Dedicated maintenance-job scheduler principal (customer-approved)

- **Approved decision.** Introduce a dedicated scheduling principal: group role
  `prsystem_job_scheduler`, login `prsystem_job_scheduler_login`, and one narrow
  `SECURITY DEFINER` function for issuing privileged maintenance jobs. The role model becomes
  **11 group roles and 7 canonical login principals**.
- **Problem it resolves.** The worker previously held unrestricted `INSERT` on `platform.job_run`,
  and the maintenance function authorises on `job_name`, `job_identity` and `state` — columns in that
  same table. A worker could therefore mint its own maintenance authorisation, so "only an authorised
  job may run privileged maintenance" was a statement about a row the executor itself could write.
- **Boundary.** The scheduler may issue a privileged job through the narrow function and can do
  nothing else: no `INSERT`, no `UPDATE`, no ownership on `job_run`, and it cannot execute the
  maintenance function it authorises. The worker may execute an issued job whose executor identity
  matches its authenticated `session_user` — never `app.actor_ref`, which the connection holding it
  can rewrite — and cannot create one: it holds no `INSERT`, and its separate
  `platform.begin_worker_job` path rejects the `platform.maintenance.%` namespace categorically.
  Credentials, sessions and deployment responsibilities are separate.
- **Enforcement.** `platform.schedule_maintenance_job` (fixed `search_path`, owned by
  `prsystem_maintenance_fn`, no `PUBLIC` execute, `prsystem_job_scheduler` only, allow-listed job
  types, server-side authorisation columns, immutable scheduling audit in the same transaction);
  the `job_run_privileged_has_issuer` check constraint; `platform.job_run_transition_guard`
  (identity and `issuer_ref` immutable, terminal states terminal). The worker holds **`SELECT` only**
  on `platform.job_run` — no `UPDATE` of any kind, column-scoped or otherwise. Ordinary transitions go
  through `platform.finish_worker_job`, which requires `job_identity = session_user` and refuses the
  `platform.maintenance.%` namespace. Covered by `GATE-SEC` / `SEC-SCHEDULER`.
- **Status.** Approved by the customer as a design decision, not a discovered conflict. Recorded here
  because it changes the canonical role model that [[D-08]] and the runbook describe.

## 3. Recorded implementation assumptions

Assumptions made where the requirements specify behaviour but not a mechanism. Each is reversible and
none reopens a closed P0 decision.

| ID | Assumption | Basis | Established in | Risk if wrong |
| --- | --- | --- | --- | --- |
| A-01 | `Asia/Ulaanbaatar` is the seed hotel timezone, stored per hotel; all timestamps persist as UTC `timestamptz` and resolve to hotel-local for business dates | doc 05 §6, doc 23 §6.1 | Phase 03 | Low — timezone is already per-hotel data |
| A-02 | Money columns are `bigint` MNT integers (₮ has no subunit in these documents); rates are `integer` basis points | `PAY-DEC-008`, doc 09 §9.2 | Phase 03 | Low |
| A-03 | Occupancy overlap is enforced by a PostgreSQL exclusion constraint over `(room_id, tstzrange(start_at, end_at, '[)'))` in addition to application checks | `STAY-DEC-008` | Phase 03 | Low — belt and braces |
| A-04 | "One non-terminal pending X" invariants are enforced by partial unique indexes, not only by application logic | `RML-DEC-007`, `DEP-DEC-007`, `STAFF-DEC-009`, `STAY-DEC-010` | Phase 04 | Low |
| A-05 | Append-only tables are protected by database rules or triggers rejecting `UPDATE` and `DELETE`, not only by repository discipline | `CASH-DEC-004`, `INV-DEC-003`, `DEP-DEC-006` | Phase 03 | Low |
| A-06 | Permission names in code use the exact identifiers from doc 18 where the document names them (`OPERATION_READ`, `SUBSCRIPTION_REMINDER_SEND`, `REVIEW_MODERATE`, `WANTED_CASE_EXPORT`, and so on); hotel-side actions receive generated stable identifiers derived from the matrix rows | doc 18 §§3, 5, 6 | Phase 04 | Low |
| A-07 | The `Үндсэн касс` default drawer is created inside the onboarding provisioning transaction | `CASH-DEC-001`, doc 24 §2.1 | Phase 05 | Low |
| A-08 | Guest access codes, OTPs, invitation tokens and reset tokens are stored only as keyed HMAC digests bound to a purpose and a subject | `POL-DEC-022`, `RC-DEC-026`, `STAFF-DEC-001` | Phase 04 | Low |
| A-09 | Outbox delivery is at-least-once with consumer-side idempotency keys; Police matching consumes a minimal check-in event containing no financial or commercial fields | CLAUDE.md §3, doc 13 §3 | Phase 03 | Low |
| A-10 | Multi-role permission evaluation is a union of granted action permissions, intersected with the package entitlement gate | `RBAC-DEC-001`, `RBAC-DEC-003` | Phase 04 | Low |
| A-11 | Cleaner task claiming uses a single-statement conditional update on `assignment_version`, satisfying the one-atomic-claim rule while P1-19's automatic SLA escalation stays deferred | doc 04 §8, `STAFF-DEC-007`, P1-19 | Phase 09 | Low |
| A-12 | Provider events are deduplicated on `(provider, provider_event_id)` with a unique constraint, and payments on `(provider, merchant, provider_payment_id)` | `PAY-DEC-005`, `ONB-DEC-008` | Phase 03 | Low |

Assumptions A-03, A-04, A-05 and A-08 were **superseded in substance** by the Phase 01 design
decisions in §3.1: they described the intended mechanism, and the ADRs now specify it normatively.
They remain listed because the reasoning is unchanged.

### 3.1 Phase 01 design decisions

The four architecture design questions raised in Phase 01 are **closed**. None remains open.

| ID | Decision | ADR | Implemented in |
| --- | --- | --- | --- |
| DM-01 | PostgreSQL Row Level Security as defence in depth: `FORCE ROW LEVEL SECURITY` on hotel- and restaurant-scoped tables, transaction-scoped `SET LOCAL` server-derived context, five database roles with no `BYPASSRLS` for API or worker *(as decided in Phase 01; the role model is now 11 group roles and 7 login principals — see D-09)*, migrations under a separate owner role, Police in a separate schema and role, explicit rules for public projections and cross-tenant jobs | [ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md) | Phase 03, extended per table in 04–19 |
| DM-02 | Append-only audit partitioned monthly by server timestamp, in two separately granted streams; partitions pre-created with a horizon alert; high-risk actions fail closed when audit cannot be recorded; retention configurable by data class with legal hold; no invented Police retention duration | [ADR-0018](../architecture/adr/ADR-0018-audit-partitioning.md) | Phase 03 |
| DM-03 | Own read model in the same transaction; cross-module projections eventually consistent via outbox and idempotent inbox, with observable `as_of`/lag; critical commands never read a projection; all projections rebuildable | [ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md) | Phase 03, applied in 13, 17, 19 |
| DM-04 | Envelope encryption with versioned DEKs behind a provider-neutral `KeyManagementPort`; separate Hotel/Guest and Police key scopes; versioned keyed-HMAC lookup, never an unkeyed hash; key version stored with ciphertext; rotation and rewrapping; deterministic development simulator; production fails closed | [ADR-0020](../architecture/adr/ADR-0020-key-management.md) | Phase 03, adapter in Phase 20 |

### 3.2 Phase 02 scope clarification — migrations and E2E harness

**This is a scope clarification, not a deferral and not a deviation.** Nothing is postponed out of
Phase 02, and [build-plan.md](build-plan.md) §3 Phase 02 is unchanged in substance: it already names
"Drizzle plus a versioned migration runner" and "Playwright harness". The clarification fixes what
those two deliverables mean while the data model does not yet exist.

| Question | Approved answer | Evidence in the scaffold |
| --- | --- | --- |
| What does the migration runner apply in Phase 02, given that no table may exist yet? | A **business-table-free baseline migration**. It installs `btree_gist` and `pgcrypto` — the database prerequisites the data model depends on — and creates no table. | `packages/db/migrations/0000_baseline.sql` |
| How is the runner proved without a schema? | Against **real PostgreSQL**: a fresh database accepts the whole journal, and a **second application is a safe no-op** that mutates no ledger row. | `packages/db/src/migrate.test.ts`, `pnpm run test:migrations` |
| What stops a Phase 03 table from arriving early? | The same gate asserts that after applying every migration, **zero base tables** exist outside the migration ledger, and a journal test rejects any `CREATE TABLE` in a migration file. | `packages/db/src/migrations.test.ts` |
| What does the Playwright harness exercise in Phase 02? | **Non-business portal-shell smoke tests only**: each of the five portals starts, returns 200, and renders its own identity rather than another portal's. | `e2e/portal-shells.spec.ts`, `pnpm run test:e2e` |

Boundaries this clarification preserves:

- **No platform, IAM, audit, outbox, idempotency or business table exists before Phase 03.** Those
  tables, and the `GATE-MIGR` Upgrade, constraint-presence, append-only and determinism assertions,
  belong to Phase 03 and later, per [ADR-0004](../architecture/adr/ADR-0004-versioned-migrations-only.md).
- **Full workflow end-to-end coverage belongs to Phases 21–22.** Phase 02 owns the harness, not the
  journeys.

Phase 02 owns **zero DEC IDs**, so this clarification changes no requirement coverage.

### D-05 — Outbox: append-only versus delivery marker

- **One text.** [12-migration-strategy.md](../architecture/12-migration-strategy.md) §5 lists the
  outbox among append-only tables, whose `UPDATE` and `DELETE` are rejected in the migration that
  creates them.
- **The other text.** [04-logical-data-model.md](../architecture/04-logical-data-model.md) §10 gives
  `outbox_event` a mutable **delivery marker**.
- **Why they conflict.** A single table cannot both reject every `UPDATE` and carry a column the
  relay updates on each attempt.
- **Resolution (customer-approved, Phase 03).** Split the row. `platform.outbox_event` is strictly
  append-only and holds what happened; `platform.outbox_delivery` holds claim, lease, attempt count,
  backoff and published state. A database trigger creates the delivery row with the event, so the
  pairing is an invariant rather than a caller obligation. Both documents are satisfied, and the
  stronger property — a permanently failing consumer can never destroy the record of what happened —
  is gained rather than traded away.
- **Phases affected.** Phase 03 (mechanism); every later phase that emits an event.

### 3.3 Phase 03 scope clarifications

Three decisions were put to the customer before any Phase 03 edit and approved. Each is recorded as a
clarification, not a silent resolution.

| # | Question | Approved answer |
| --- | --- | --- |
| 1 | [build-plan.md](build-plan.md) Phase 03 also listed the four realms, sessions and auth-epoch revocation, the authorization engine, the permission-catalog structure, the package-entitlement gate, the subscription-state gate and the step-up MFA marker — which the Phase 03 brief placed out of scope. | **Move that half to Phase 04.** Phase 03 is the transaction kernel; Phase 04 absorbs realms, sessions, the authorization engine and the entitlement gates. Build-plan §3 updated to match, so the document describes what was built. |
| 2 | [ADR-0018](../architecture/adr/ADR-0018-audit-partitioning.md) §2 gives runtime application roles `INSERT` **and** `SELECT` on both audit streams; the Phase 03 security requirement is stricter. | **The stricter rule governs, and was tightened further in the sixth repair.** `prsystem_api` and `prsystem_worker` hold **no direct grant on either audit stream at all**: they append only by executing the `SECURITY DEFINER` wrapper, whose owner (`prsystem_audit_writer`) is the sole holder of `INSERT`. They cannot read audit either. Two new roles — `prsystem_audit_reader` and `prsystem_police_audit_reader` — hold scoped `SELECT` and no write. ADR-0018 §2 amended to record the tightening. |
| 3 | The outbox conflict above. | **Split into an immutable event and a mutable delivery row.** Recorded as D-05. |

Phase 03 owns **zero DEC IDs**, so none of these changes requirement coverage.

### 3.4 Phase 04 scope clarifications

Three decisions were taken while implementing Phase 04. None resolves a P0 conflict; each records a
place where two approved documents point in different directions, or where a Phase 03 rule had to be
widened for a capability Phase 03 explicitly deferred.

| # | Question | Resolution |
| --- | --- | --- |
| 1 | [03-module-ownership-and-dependencies.md](../architecture/03-module-ownership-and-dependencies.md) §1 gives the Phase 04 `tenancy` module a **package entitlement projection**, while [ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md) §4 forbids authorization and entitlement from reading a projection at all. | **The ADR governs; the projection is deferred to Phase 05.** Entitlement is read through a typed, fail-closed subscription contract instead. Its authoritative source is the Phase 05 subscription aggregate, which does not exist yet — so building the projection now would mean an entitlement gate reading eventually-consistent data derived from nothing. Phase 04 owns the port and the rule that a port which cannot answer denies. |
| 2 | Phase 03 fixed the platform scope sentinel as valid **only** in the Operation realm. Phase 04 introduces account-scoped Hotel-realm work — signing in, changing a password, logging out of every device — which belongs to an account rather than to one hotel and therefore has no `hotel_id`. | **The sentinel is now valid in the Hotel realm too, and refused in Guest and Police.** It widens nothing: no hotel carries the sentinel as its id, so every tenant policy matches zero rows under it, and `SEC-RLS` asserts exactly that against real rows in every tenant table. The only rows reachable are the account-scoped tables, which carry no tenant column, and the principal's own membership and session-scope rows. |
| 3 | doc 19 §14 leaves the authentication numbers open as P1 configuration — token TTLs, resend intervals, attempt and rate limits, password cost — while the lifecycle they govern had to be built. | **The shape is owned, the numbers are not.** Every value lives in one versioned record marked `p1-provisional`, is injected rather than imported, and is stamped onto each artefact derived under it, so a stored credential verifies against the parameters it was made with. P1-06 stays open; nothing in Phase 04 claims otherwise. |

Phase 04 owns **26 DEC IDs** — `RBAC-DEC-001`–`017` and `STAFF-DEC-001`–`009` — and all 26 move to
`COVERED` in [requirements-traceability.md](requirements-traceability.md) §16 and §17.

### 3.5 Phase 04 remediation 1 — decisions taken while repairing

Five decisions were taken during the bounded security remediation recorded in
[phase-status.md](phase-status.md#phase-04-remediation-1). None resolves a P0 conflict.

| # | Question | Resolution |
| --- | --- | --- |
| 1 | [ADR-0004](../architecture/adr/ADR-0004-versioned-migrations-only.md) says a mistake is corrected by a new migration, never by rewriting an applied one. `0002_iam_rbac_staff` needed structural corrections. | **Corrected in place, not by a forward migration.** The immutability ADR-0004 asserts attaches to an *accepted, applied* migration; `0002` had never been customer-accepted and had never reached a deployed cluster. Correcting it keeps the Phase 04 delta at exactly one migration, which is what a deployment applies and what the upgrade gate now tests. `0000_baseline` and `0001_kernel` are untouched and are pinned by checksum in `packages/db/src/test-support/frozen-phase-03/`, so an in-place edit to either fails the gate. |
| 2 | doc 19 §3 has a hotel-scoped Manager Plus invite the *first* Restaurant Manager, but doc 06 §4.1 scopes a Restaurant action by `restaurant_id`. Read together the inviter would need a membership in a restaurant that has no staff yet. | **A membership covers a request if its scope contains the target.** A hotel-scoped membership covers a row that *names* a restaurant, because there the restaurant is the subject of the action; a restaurant-scoped membership covers only its own. Candidates are evaluated narrowest-first and each on its own, so this is "does any single membership authorise this?", never a union of two — which doc 06 §6 forbids. |
| 3 | doc 19 §3 requires the restaurant to be one the hotel registered, and Phase 15 owns the `restaurant` aggregate. | **A typed, fail-closed contract**, the same shape as the subscription port: the production implementation answers nothing and the invitation is refused, rather than assuming the restaurant belongs to the hotel. `RestaurantDirectoryPort`; Phase 15 supplies the adapter. |
| 4 | doc 19 §8.1 requires a suspension to hand over the suspended member's open work, and Phases 09, 11 and 15 own that work. Phase 04 had taken it from the request body. | **An injected `OpenWorkPort` owned by the domain modules.** With none registered the answer is a determinate empty list — there is no such work in the system yet — and a registered provider that cannot answer refuses rather than reporting nothing. A caller can neither fabricate open work nor omit it. |
| 5 | The governance validator reserves the words *repair* and *customer review* in headings for the canonical Phase 03 repair-record form, and Phase 04 now has a security repair of its own to record. | **Phase 04's record is titled a *remediation*.** Borrowing the Phase 03 vocabulary would make two different kinds of record indistinguishable to every check that reads them. The prose says plainly that it was a security repair; only the heading vocabulary is reserved. |

### 3.6 Phase 04 remediation 2 — decisions taken while repairing

| # | Question | Resolution |
| --- | --- | --- |
| 1 | doc 19 §8.1 requires a suspension to hand over the suspended member's open work, and the modules that own that work can be unreachable. Enumerating it inside the security transaction made a provider outage roll the suspension back. | **The question is persisted, not the answer.** The transition commits with a durable `work_handoff_discovery` marker beside it, atomically; enumeration is a separate retryable step that runs immediately and again on demand. An unanswerable provider leaves the marker open with its attempts counted — it is never rendered as "no open work", which is the one outcome that would silently drop a blocker. |
| 2 | The reset-intake drain and the discovery reconciliation are durable processors with no scheduled invoker in Phase 04. | **Recorded rather than improvised.** Scheduling the drain belongs with the email provider it would deliver through (`INT-MAIL-01`, no adapter exists), and scheduling the reconciliation belongs with Phases 09, 11 and 15, which own the work it enumerates. Both are reachable now as explicit commands, and both are listed as carried forward in [phase-status.md](phase-status.md#phase-04-remediation-2). |
| 3 | doc 19 §6 makes the reset endpoint unauthenticated and indistinguishable, but the account-specific work behind it — a lookup, a keyed derivation, a provider call — is unbounded in time and only happens for addresses that exist. | **Indistinguishable means the work, not just the answer.** The public path performs one bounded insert and returns; everything account-specific moves behind a durable queue. Normalising the status and body alone left a timing oracle that a slow or unreachable provider widened from microseconds to seconds. |

### 3.7 Phase 04 remediation 3 — decisions taken while repairing

| # | Question | Resolution |
| --- | --- | --- |
| 1 | A client idempotency key may be 200 characters, which is also the column's limit, so any suffix produced an illegal key. Truncating the caller's key would fit but would make two different requests collide. | **Digest, never concatenate.** One helper derives every internal key: length-prefixed components under SHA-256, behind a versioned readable operation tag. Fixed length, always legal, deterministic, collision-resistant, and unambiguous about where one component ends and the next begins. |
| 2 | A discovery marker described a suspension, but nothing tied it to the transition that raised it, so it survived a reactivation and could later hand an active employee's work away. | **A marker is bound to one revision of one membership.** It stores the state and revision it expects, paired by a CHECK to its reason; reconciliation locks the membership and compares both before enumerating anything. A reactivation supersedes its own marker in the same transaction, and the open-marker index is partial on `PENDING` so a later transition raises its own rather than reusing the old one. |
| 3 | The reset delivery has to survive a provider that is slow, unreachable, or that accepts a message whose acknowledgement is then lost — and the secret it delivers may not be stored in plaintext. | **A leased queue plus a durable, sealed delivery intent.** Ownership is a claim token with an expiry, checked by compare-and-set on every settlement; an outage is retryable with capped backoff and eventually an operator-visible dead letter, while `ignored` and `throttled` stay terminal because they are decisions. The reset and its intent commit before the provider is contacted, the one-time secret is held under envelope encryption with its own key scope, key version and row-bound AAD, and a stable `delivery_id` makes a retry after a lost acknowledgement produce no second visible message. |
| 4 | Moving the Hotel-Admin-initiated reset onto the same queue would have reattributed its resets to `self`. | **The attribution travels with the entry.** One delivery mechanism, because two would be two ways to hold a live link; `initiated_by` and `initiated_by_account_id` are carried on the intake so the reset it produces still records who asked for it. |

The lease duration, retry backoff, dead-letter threshold and their ceiling are
**provisional**, carried in the same versioned record as the rest of P1-06. None
of them is a customer-approved value.

### 3.8 Phase 04 remediation 4 — decisions taken while repairing

| # | Question | Resolution |
| --- | --- | --- |
| 1 | Two operations touched a membership and its discovery marker in opposite orders, and PostgreSQL resolved the resulting cycle by killing one of them. | **One lock order, everywhere: membership first, marker second.** The candidate markers are read without any lock, and each is re-read under its own lock once the membership is held, then revalidated. Deadlock-victim selection and generic transaction retry are both refused as answers — a correct order is not something to be recovered from. |
| 2 | A settled queue entry could be returned to the queue by the restricted runtime, including one the provider had already refused its full retry budget. | **Both settled states are terminal, and neither is deletable.** A dead letter is a decision an operator must be able to rely on; a runtime that could resurrect one could do it without leaving a trace. |
| 3 | Two queue entries can exist for one address — a self-service request and a Hotel Admin sending the link — and an account-wide lookup let the second adopt the first's delivery identity and attribution. | **A reset belongs to the intake that created it**, by a `NOT NULL` foreign key with one live intent per intake. Every retry and reclaim resolves by intake, and the guard refuses to rebind an intent to another one. |
| 4 | "The provider failed" and "the provider sent it and the acknowledgement was lost" are indistinguishable to a sender, and only the second must not produce a second message. | **They are the same retry, made safe by identity rather than by detection.** The sender recovers the same intent and the same delivery id, and the provider recognises the repeat. The simulator gained a mode that records and then throws, so the case is exercised rather than assumed. |
| 5 | A recorded intent can outlive its own TTL before a provider ever accepts it. | **Expiry is checked on the database clock before the secret is decrypted.** An expired intent is terminalised with its sealed secret destroyed and replaced for the same intake while retry budget remains, and dead-lettered when it does not. Four database rules keep the secret complete, destroy-only, and absent from every delivered or terminal row. |

### 3.9 Phase 05 scope alignments — approved requirements, implemented

Three alignments of already-approved requirements. None is a new business
decision, and none reopens an approved DEC.

| # | Alignment | Reading, and what was implemented |
| --- | --- | --- |
| 1 | **Phone OTP.** doc 15 §2.1 makes an OTP-verified phone a precondition of the invoice; the early-port table places phone OTP in Phase 12. | Only the **reusable typed port and its deterministic simulator** moved forward. Guest registration and Guest authentication stay Phase 12 and nothing here touches either. CallPro is **not** assumed to carry it: EXT-05 is an SMS *send* contract, not an OTP service, so the capability has its own blocked production control, `INT-OTP-01`, and the adapter fails closed outside local, CI and test. The code itself is a purpose- and subject-bound keyed digest with an attempt budget on the row — never plaintext. |
| 2 | **Hotel location.** doc 15 §2.1 requires the district, khoroo, address and map coordinate to be captured and stored server-side. | Persisted and validated, as **integer micro-degrees** rather than floating point (CLAUDE.md §5), with range constraints in the database. No `GeoPort`, no Google Maps geocoding, no distance calculation and no public discovery: those stay Phase 12 behind EXT-06. The duplicate-review flag of doc 15 §5.1 asks the narrower question integer coordinates can answer — same name within a very short distance, or the same district and address — and never approximates a geocoder. |
| 3 | **Default drawer.** doc 24 §2.1 requires exactly one `Үндсэн касс` when a hotel's subscription activates. | Created inside the provisioning transaction, so it commits with the tenant or not at all. Only the **cash-location root** was introduced: kind, name, code, state and the single-default index. No shifts, movements, balances, expenses, safes or cash APIs — those are Phase 11 — and the table carries no column for any of them. The early introduction is recorded in the implementation architecture documents. |
| 4 | **Offline ownership verification** (doc 15 §3.1 (3), Phase 05 remediation 1). doc 18 names no permission for the offline proof; the nearest catalogued Operation action is the subscription contact offline exception. | Mapped to `operation.subscription_contact_change_approve` (`SUBSCRIPTION_CONTACT_CHANGE_APPROVE`, Platform-only, step-up) through the Phase 04 pipeline: realm, explicit grant, recent step-up and audit, evaluated inside the transaction. The decision records the deciding account and can only *pass* a proof — never attach an owner or skip it. **No HTTP route exists for it in Phase 05**: the Platform Operation surface is Phase 19, so the production action is not reachable and is not claimed to be. |
| 5 | **`PROVISIONING_FAILED → PAID_OWNER_VERIFICATION_REQUIRED`** (Phase 05 remediation 1). doc 15 §3.1 describes the existing-owner race at resolution time, not after a failed provisioning attempt. | The §3.1 race can be discovered at claim time — an owner with this identifier appeared between resolution and provisioning — and the boundary refuses with its own SQLSTATE rather than building a second owner. The application returns to the proof state through the one added edge; the payment stays confirmed, nothing is re-priced, and the operator retry path is unchanged. |
| 6 | **An account holding the admin email after payment** (doc 15 §3.1, Phase 05 remediation 1). doc 15 requires the existing-account path to be proved by that account's sign-in or a completed password recovery. | The invoice already refuses an address another Hotel account holds unless the application is bound to that account by a signed-in proof (`existing_account_id`, `existing_account_proof_method`). An account that appears **after** payment is treated as a provisioning failure: the boundary refuses to create a second account and the row waits, with its payment, for the existing-account proof or the permissioned retry. It is never resolved by guessing which account the applicant meant. |
| 7 | **Prepared and abandoned quotes and invoices** (Phase 05 remediation 2, finding 1). doc 17 §4.4 names one live unpaid intent and a stale quote that is never applied; it does not say where a quote lives between pricing and the provider's answer. | A quote or invoice is a row from the moment it is priced: `PREPARING`, with its complete snapshot and no provider invoice, is the state between the claim and the provider's reply; `ABANDONED` is the state of one the provider refused, one whose snapshot moved, or one whose principal lost the hotel while the provider was being called — with the provider's invoice recorded on it. Neither is live, neither is payable, and a late capture on an abandoned quote is the reconciliation case of `LIFE-DEC-006`. A retry under the same key recovers the prepared row and never re-prices the provider's invoice. |
| 8 | **A fee the provider did not state** (`SUB-DEC-007`, Phase 05 remediation 2, finding 6). doc 16 requires the provider fee to be recorded beside the gross; it does not say what to record when the provider's status carries none. | NULL: the fee is unknown and no net amount is derived from it. A provider that states zero is recorded as zero with a net equal to the gross. The ledger never fabricates a confirmed net amount from an absent fact. |
| 9 | **Operation decisions on tenant rows commit with their authorization** (doc 18 §5, Phase 05 remediation 2, finding 5). The two Operation actions that touch a hotel's rows — closing a payment reconciliation case and reopening a receipt issuance — used to authorize in the Operation realm and mutate in a second, hotel-scoped transaction. | `subscription_billing_intent` and `ebarimt_issuance` carry the same realm-gated `operation_review` policy the onboarding tables have carried since Phase 05, so the decision that was permitted is the decision that commits, in one transaction, and a decision that cannot be applied leaves no audit of having been requested. Operation dashboards still consume projections; this policy admits the two catalogued actions and nothing broader. |
| 10 | **A provider that refuses to create the invoice** (Phase 05 remediation 3, finding 1). Row 7's `ABANDONED` state carries the provider's invoice; a `REJECTED` or `MISMATCH` answer to `createInvoice` leaves a legitimate terminal row that never had one. | `REFUSED`: terminal, reached only from `PREPARING`, the one state besides `PREPARING` permitted no invoice and required to have none. Nothing can pay it, so it has no further edge. The refusal is stored against the idempotency key in the same transaction, replayed by the same key without a provider call, and a fresh key opens a live invoice. |

Two further notes, recorded here rather than left implied:

- **`prsystem_maintenance_fn` is reused as the provisioning definer.** It is the
  established narrow, NOLOGIN owner of the D-09 wrappers, and the alternative was
  a new cluster role rippling into bootstrap, the principal guards, the role
  closure assertion and the runbook. What the boundary actually guarantees is
  unchanged: no runtime holds INSERT on the tenant root, the wrapper re-derives
  the payment, the state and the owner from the rows it locks, and it is not
  exempt from row level security — it binds the new tenant's scope and every row
  it writes has to satisfy the ordinary policy.
- **The scheduled invokers.** Recorded as open at the end of Phase 05 and closed
  by Phase 05 remediation 1: the worker deployment registers a BullMQ consumer
  per Phase 05 queue (`apps/worker/src/jobs/onboarding.ts`) and a repeatable
  sweep for each, and PostgreSQL is the job record — a paid application carries
  its claim token, lease, availability instant and attempt count on its own
  row; the Redis message is a best-effort latency signal and never the job.
  The Phase 04 password-reset drain is still where it was.

---

### 3.10 Phase 06 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P06-1 — `config_version` is hotel-wide.** doc 05 §13.2 requires a snapshot to carry the
  "pricing config version". Any tariff write at hotel, category or room level advances one monotonic
  number on `platform.hotel_stay_configuration`, and that number is what a snapshot stores beside the
  source level and source entity. The configuration row is therefore the per-hotel serialisation
  point for tariff writers (`FOR UPDATE`) and for rate resolutions (`FOR SHARE`), which is what makes
  a stored version attributable to exactly one configuration state.
- **A-P06-2 — no deposit column.** doc 07 §2 lists a category-level deposit amount. `hotel.deposit.*`
  and the `DEP-DEC` family are assigned to Phase 10, so Phase 06 adds no deposit field; Phase 10 adds
  it to the category and the hotel configuration.
- **A-P06-3 — a package refusal is the opaque denial.** doc 07 §1 says the minibar is refused on
  20,000₮ whatever role the caller holds. The accepted Phase 04 pipeline evaluates the named
  permission with the *effective* package at stage 3, so a role the package does not carry is refused
  as `NOT_AUTHORIZED` and rendered as the same `NOT_FOUND` as a missing role (doc 06 §5), not as
  `PACKAGE_NOT_ENTITLED`. Phase 06 documents and tests this; it does not change the pipeline.
- **A-P06-4 — dependency sources of later phases are named now.** The lifecycle cannot answer "what
  still depends on this entity" without naming the stays, bookings, tasks, stock, versions and
  configuration that Phases 07, 08, 09 and 13 own. The registry names each relation and column and
  the probe reports `not_yet_provisioned` while it does not exist — evidence, never "no blockers". The
  names are predictions; each owning phase must use them or update the entry in the same change, and
  `catalog.dependency.test.ts` refuses a relation that exists without its column.
- **A-P06-5 — the server completes a retirement only for blockers Phase 06 can resolve.** doc 26 §2
  says the server moves `RETIRING → INACTIVE` when the last blocker is resolved. Today the only
  resolutions Phase 06 itself performs are a child room becoming `INACTIVE` or leaving a retiring
  category, and those complete the category's retirement with the requester and the system actor
  both recorded. An operator may also ask for finalization and is told what remains. Later phases
  call `LifecycleService.finalizeIfClear` in the transaction that resolves their own blocker.
- **A-P06-6 — snapshot capture has no route.** `captureRateSnapshot` is a transaction-bound contract
  for the confirmation transactions of Phases 08 and 13. Nothing in Phase 06 confirms a stay or a
  booking, so exposing a capture route would let a client decide when a price is fixed.
- **A-P06-7 — room-number uniqueness on reactivation is structural.** doc 26 §9 lists the
  hotel-scoped room number among the checks a reactivation performs. The unique constraint applies
  in every state, the inactive row keeps its number, and no other room can have taken it, so the
  check is satisfied by the schema rather than re-derived by the service.
- **A-P06-8 — minibar entities carry identity and lifecycle only.** Product and template rows are
  created in the tables Phase 07 extends with selling price, purchase cost, stock and template
  versions, so the lifecycle the four entities share is one model, not two.
- **A-P06-9 — the hourly minimum, maximum and increment are absent by construction.** `STAY-DEC-006`
  refused that configuration; the command types, the validation and the schema have no field for it
  and a payload carrying one is not read.

### 3.11 Phase 07 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P07-1 — the ledger read is gated by `hotel.minibar.cost_stock_manage`.** doc 18 §3 names the
  stock and cost actions but has no row for reading a product's movement ledger. The ledger shows
  purchase costs and the average in force, which is the data that action protects, so the read
  requires it; Reception and the Cleaner cannot read a ledger. A dedicated `.read` row is the
  customer's to add.
- **A-P07-2 — no refill task in Phase 07.** doc 22 §6.3 raises a refill against an *active stay*,
  and doc 26 §22 completes it at the stay's safe point; there is no stay before Phase 08. The
  relation the registries name for it — `platform.minibar_refill_task` — is Phase 09's, recorded as
  such in both registries, and reports `not_yet_provisioned` until then. Guest consumption is a
  movement type the ledger accepts today and Phase 09 posts.
- **A-P07-3 — the safe-point relations are predictions.** A room is at a safe point when no active
  stay, no open checkout, no open minibar report and no open refill task references it (doc 26 §14,
  §23). Those live in `platform.stay` (08), `platform.stay_folio` (10),
  `platform.minibar_usage_report` (09) and `platform.minibar_refill_task` (09). Until each exists the
  probe answers `not_yet_provisioned` and a change is `READY_FOR_RECONCILIATION` at once — evidence
  that nothing can occupy the room, not an assumption. Each owning phase uses the named column and
  predicate or updates the entry in the same change; `minibar.integration.test.ts` refuses a
  relation that exists without its column. `SCHEDULED_AFTER_STAY` and `advanceScheduled` exist now
  so Phase 08's checkout calls them rather than inventing the transition.
- **A-P07-4 — a balance is written only by the ledger.** doc 22 §3 says the balance is derived from
  the ledger. `minibar_warehouse_stock` and `room_minibar_stock` are updated by one `AFTER INSERT`
  trigger on `inventory_movement`, owned by `prsystem_maintenance_fn`; no runtime role holds `INSERT`
  or `UPDATE` on either. A minus movement is costed at the average in force by a `BEFORE INSERT`
  trigger of the same owner, and the weighted average is integer arithmetic rounded half up once.
  A negative balance is a check constraint, refused inside the transaction that would cause it.
- **A-P07-5 — a product without a selling price cannot be published.** doc 25 fixes the selling
  price into the stay snapshot at check-in; a published version binding a product with no price
  would make that capture impossible. `PRODUCT_UNPRICED` is therefore among the publish refusals of
  doc 26 §18, beside the rules the document lists. A purchase cost is not required to publish.
- **A-P07-6 — the Cleaner's count precedes every transfer, and an omitted product is a count of
  zero.** doc 26 §17.2 blocks a change on a variance between the counted and the recorded room
  stock. The completion command carries the count and the transfers together; a variance is recorded
  as `BLOCKED_VARIANCE` and nothing is posted, so the Manager's correction (a waste or adjustment
  linked to the change) is made against the same holdings the Cleaner counted. A rollback task
  reverses exact postings and carries no count.
- **A-P07-7 — the Manager's resolution re-opens the Cleaner's task.** After a correction or a
  receipt, `resolve` re-evaluates the room against the pinned target: nothing outstanding applies;
  excess to return, or a shortage the warehouse can now supply, returns the change to `IN_PROGRESS`
  with the task's bounds recomputed from what the room holds now; a shortage the warehouse cannot
  supply is refused as `STOCK_SHORT` unless applied under an audited override (doc 22 §8). Excess is
  never overridden.
- **A-P07-8 — the initial ON setup is an `OFF_TO_ON` change.** doc 26 §15 makes ON → OFF, OFF → ON
  and A → B the three reconciliation shapes; a room that has never had a minibar is `OFF` with no
  template, so its first setup is the same bounded refill as any later OFF → ON rather than a fourth
  path with no task.
- **A-P07-9 — excess after a partial completion is a variance block, and a partial posting shrinks
  the bounds.** A completion that moved less than the target leaves the change `BLOCKED_STOCK` or
  `BLOCKED_VARIANCE` with what was moved recorded, and the task's remaining bounds are reduced by
  the posted quantities, so a second completion under a fresh key cannot move the same quantity
  again (doc 22 §11).
- **A-P07-10 — a batch's state is derived, never stored.** doc 26 §35 lists the five batch states;
  they are computed from the children on every read (`deriveBatchState`), so no job and no second
  write can leave a batch saying something its children do not.
- **A-P07-11 — a POST that creates nothing answers `200`.** Publish, Set default, archive, delete,
  claim, complete, cancel, rollback, resolve, cancel remaining and preview answer `200` with the
  resulting view, as the Phase 04 and 05 command routes do; creations answer `201`.

### 3.12 Phase 08 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P08-1 — the Reception shift exists now, minimally.** doc 05 §19.1 refuses a check-in with no
  current open shift, and the shift is doc 03's, assigned to Phase 11. `platform.reception_shift`
  is created here with what the bound needs — who opened it, when, whether it is open, one open
  shift per hotel — under `hotel.shift.open_close_handover`. The cash count, handover states and
  financial review of doc 03 (`SHIFT-DEC-001`…`007`) are Phase 11's and extend this row; Phase 11
  may also tighten "the hotel's open shift" to "the caller's own", which doc 05 does not require.
- **A-P08-2 — the cleaning axis is built now; its queue is Phase 09's.** Readiness needs the actual
  cleaning state and its history (`STAY-DEC-008`, `RC-DEC-014`), so `room_cleaning_state` and the
  append-only `room_cleaning_event` land here with the two doc 18 rows (`cleaning_status_p20` for
  the Manager of a 20,000₮ hotel, `cleaning_status_p2530` for the Cleaner). The Cleaner's
  dashboard, tasks and `RC-DEC-008` remain Phase 09's. A room with no cleaning row has never been
  marked `Цэвэр` and is not ready: the first readiness of every room is an explicit act.
- **A-P08-3 — historical minibar readiness is proven conservatively.** doc 05 §19.2 requires a
  backdated check-in to prove readiness at the chosen instant from immutable events. The cleaning
  proof is exact (the last cleaning event at or before the instant). The minibar proof is
  "the current status is ready and the configuration row has not changed since the chosen instant"
  (`updated_at`); a configuration that changed in between refuses the backdate rather than
  reconstructing a status from the minibar history. `ROOM_OCCUPIED`, the buffer anchor and the
  lifecycle states are evaluated at the instant from the stay and event tables directly.
- **A-P08-4 — the backdate is whole minutes, to the nearest minute.** The Reception chooses a
  minute; the seconds between the form's minute and the server's confirmation are not a backdate,
  so `backdate_minutes` rounds rather than ceils, and a reason is required exactly when it is
  positive (`STAY-DEC-009`).
- **A-P08-5 — an online check-in waits for the booking module.** `source = ONLINE` is modelled
  (booking reference, no deposit, the booking's planned start as a backdate bound, the booking's
  own rate snapshot) but a check-in that names a booking is refused `BOOKING_NOT_FOUND` until Phase
  13 registers a `ConfirmedBookingsPort`. The default implementation answers from the absence of
  `platform.booking` — evidence, as the registries do — and refuses once the relation exists with
  no implementation behind it, so nothing ever reads "no bookings" from a table it does not own.
- **A-P08-6 — overdue conflicts: detection is a contract, an assignment is a commitment, a
  cancellation is a decision.** `ConflictService.detect` is transaction-bound for the booking
  module and a future scheduler; `refresh` lets Reception run it on demand. Until Phase 13 applies
  a same- or higher-category assignment to the booking, the resolved conflict's `assigned_room_id`
  is the room's commitment as this module knows it: a walk-in that would not fit before the
  booking's start is refused `ASSIGNED_BOOKING_CONFLICT`, and the room is not eligible for another
  booking. A commitment is an **interval**, `[planned_checkin_at, planned_checkout_at)`, not the
  start instant: a booking that has already started and is still awaited holds the room exactly as
  a later one does, so the conflict row stores the planned checkout beside the planned start (it is
  immutable with the rest of the facts the conflict was opened on), `ConfirmedBookingsPort`
  answers with every commitment whose interval has not ended, and eligibility compares intervals
  for overlap. Reading a commitment as its start alone let a walk-in and an assignment both take a
  room once the assigned booking's start had passed — a concurrency gate caught it, and the
  interval reading is what closed it. `CANCELLED_HOTEL` records the decision and emits `stay.conflict.resolved`; the full
  refund obligation of `BK-DEC-014` / `PAY-DEC-007` is the booking module's to open on that event.
- **A-P08-7 — guest identity revisions exist; the correction command is the registry's.**
  `stay_guest` is append-only with a `revision_no` and a current flag the guard admits flipping
  once, as `RC-DEC-044` requires. The command that records a corrected identity, and the re-run of
  exact matching on a newly valid registration number, land with the guest registry (Phase 17) and
  Police matching (Phase 18); Phase 08 writes revision 1.
- **A-P08-8 — what Police receives at check-in.** doc 13 §8.3 runs exact matching at
  `check_in_recorded_at`. The `stay.checked_in` outbox event carries the stay, the room, the times,
  the identity type, the eligibility and the keyed, namespaced lookup token with its key version —
  never a name, a date of birth or the number — so Phase 18 can match a token to a token.
- **A-P08-9 — the override is consumed on the configuration, not on its row.** The runtime holds
  no `UPDATE` on `minibar_shortage_override`, so "consumed by the next stay" is recorded by clearing
  the configuration's pointer and appending a minibar `CONSUMED` event naming the stay; the
  override row stays as the audited exception it was (doc 22 §8).
- **A-P08-10 — checkout obligations are evidence from later phases.** The actual checkout is
  Reception's (`hotel.stay.checkout_record`) and is refused while an obligation a later phase owns
  is open: the folio (`platform.stay_folio`, Phase 10) and the minibar usage report
  (`platform.minibar_usage_report`, Phase 09), probed the way the registries probe — absent is
  evidence, present-and-open refuses, unreadable refuses. Those phases use the named relation,
  column and predicate or update the entry in the same change.
- **A-P08-11 — self-approval of a higher-category remedy.** doc 05 §23.2 audits the case where a
  Reception + Manager multi-role account decides itself; `self_approved` is set when the deciding
  account holds the Reception role beside the Manager or Manager Plus role.
- **A-P08-12 — XYP is a port with a simulator; EXT-01 stays blocked.** `XypIdentityPort` answers
  found, not found, unavailable, timeout and disabled deterministically; outside local, CI and test
  the adapter is `DISABLED`, the record is `MANUAL`, and nothing is presented as verified
  (`RC-DEC-007`). The contract, field list and legal basis of EXT-01 remain open.
- **A-P08-13 — the guest access code is Phase 15's.** doc 02 §3.1's 4–6 digit one-time code on
  30,000₮ is the Restaurant's entry point; it is generated with the Restaurant module.

---

### 3.13 Phase 09 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P09-1 — starting a checkout has no action of its own.** doc 18 §3 carries one checkout row,
  `Early/on-time/late actual checkout бүртгэх, room/minibar тооцоо`
  (`hotel.stay.checkout_record`), and no separate row for `Check-out эхлүүлэх`, which doc 21 §9
  gives to Reception with the same "additional Reception role" rule for everyone else. Starting a
  checkout, calling it off and locking a payment attempt therefore all check that one action; the
  matrix is not widened and no new permission was invented.
- **A-P09-2 — the stay gained exactly one backward edge.** doc 04 §8 requires a started checkout to
  be callable off, leaving the report and the tasks as cancelled history. Phase 08's stay guard was
  forward-only because nothing could yet call one off; migration `0010` replaces the guard with the
  same rules plus `CHECKOUT_IN_PROGRESS → ACTIVE`. Write-once times, the increasing revision, the
  actual checkout recorded only with the completing transition and the immutability of a completed
  stay are unchanged.
- **A-P09-3 — the payment is a contract, the lock is Phase 09's.** doc 21 §5 requires the exact
  version to be locked and released only on a provider status that proves no money moved. The lock,
  its uniqueness and the reconciliation are implemented here; the money is Phase 10's.
  `PaymentAttemptsPort` asks the provider's own status, `UnprovisionedPaymentAttempts` answers
  `UNKNOWN` while `platform.payment_attempt` does not exist — which holds the lock, as the
  requirement wants — and refuses outright once that relation appears without an implementation.
  No client field, screen or Reception statement can set a provider status (CLAUDE.md §7).
- **A-P09-4 — the billable formula is a database constraint.** doc 22 §8 states
  `max(0, opening + refill − non-guest stock-out − counted)`. The service computes it and
  `minibar_usage_report_line_billable_formula` holds every stored line to it, so a line that does
  not follow the documented arithmetic cannot exist even if a future service is wrong. The line
  total is held the same way, and the unit price is a foreign key into the stay's own price book, so
  `PRICE-DEC-006`'s "a product absent from the snapshot cannot be charged" is structural rather
  than a check in code.
- **A-P09-5 — a waiver is an amount, not an edit.** `CHK-DEC-006` says a waived line reduces what
  is payable without changing the report. The waived amount is the disputed quantity at the
  version's own snapshot unit price, stored on the dispute; the version's total is untouched, and
  the payable amount is the total less the waivers decided on that version.
- **A-P09-6 — the report exists only where the minibar does.** `CHK-DEC-001` binds the report to a
  minibar-enabled room. The checkout opens one when the stay's `minibar_applicable` snapshot says
  so; a 20,000₮ hotel and a room whose minibar is off close their checkouts with no report, and
  therefore with no obligation to settle.
- **A-P09-7 — the non-guest stock-out stays in the minibar module, behind its own action.** doc 22
  §6.2's return, waste and negative adjustment are inventory movements, so they remain
  `ProductService.recordCorrection`; naming a stay now requires
  `hotel.minibar.non_guest_stock_out` beside the waste action, exactly as doc 18 §3 lists them as
  two rows. The room-to-warehouse return joined the correction kinds because doc 22 §6.2 names it,
  and it must name the room it leaves.
- **A-P09-8 — the routine refill belongs to no stay.** doc 04 §5.2 (12) refills the room for the
  *next* guest, so its transfers carry no `stay_id`: they are not billable to anyone. They are
  bounded by the room's current version target, refused entirely while a configuration change is
  pending, and refused for a product the room does not stock.
- **A-P09-9 — the guest's consumption posts at settlement.** A submitted version is a priced
  statement, not a movement; doc 04 §8 makes the charge and the stock leave together. The
  `GUEST_CONSUMPTION` movements are written in the transaction that settles the payment, so a
  returned or released version never takes stock out of the room.
- **A-P09-10 — a Cleaner's task holds a retirement open.** doc 04 §4 keeps a retiring room's
  existing tasks alive, and the catalog registry already named `room.cleaning_task` as an
  operational blocker. A room whose retirement is requested while a checkout is in progress
  therefore stays `RETIRING` until the Cleaner finishes; completing the task hands the lifecycle
  back (`RML-DEC-002`), as does closing a refill task for a retiring product.
- **A-P09-11 — the exception version records which role wrote it.** doc 21 §9 gives the exception
  report to Manager and Manager Plus. The version stores the actor's own role rather than a fixed
  `MANAGER`, so the audit says which of the two inspected the room.
- **A-P09-12 — the folio is Phase 10's.** doc 21 §2 settles `room + minibar + other charges −
  deposit`. Phase 09 owns the minibar side of that arithmetic and the lock the attempt puts on it;
  the folio, the deposit and the cash are Phase 10's and Phase 11's, and the stay still completes
  through `StayService.recordActualCheckout` once every obligation the registry names is settled.
- **A-P09-13 — one open cleaning task per room, one live report per stay.** Both are partial unique
  indexes rather than service checks, so a repeated checkout of the same room queues no second task
  and a stay cannot carry two live reports; the claim of either is a single conditional statement, so
  two Cleaners racing produce one winner and one `CONFLICT`.

### 3.14 Phase 10 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P10-1 — the folio is opened by the confirmation, through a contract.** doc 02 §3.4 makes the
  deposit requirement a fact of the check-in, so the check-in is where it is snapshotted. Phase 08's
  check-in calls `DepositsPort.openForStay`, which Phase 10 implements: it needs nothing from the
  billing module's own dependencies, so the two modules stay one-way (CLAUDE.md §3). A hotel that
  has configured no deposit cannot confirm a walk-in at all — the refusal is
  `DEPOSIT_NOT_CONFIGURED` and no stay row survives it.
- **A-P10-2 — the ledger records movements, not attempts.** doc 20 §2 refuses to call an unconfirmed
  QPay or card payment a payment. `payment_transaction` therefore holds only what actually happened,
  append-only; an attempt still in flight lives on `refund_request` for a refund, and for a payment
  it does not exist until the provider's own status says `PAID`. A movement's provider reference is
  unique per hotel and channel, so a duplicate callback or a repeated submit writes nothing new.
- **A-P10-3 — a reversal names the movement it reverses, not a provider.** The channel shape rules
  (`DEP-DEC-005`) apply to money that faced a provider; a reversal is an internal entry pointing at
  the original row, so the reference and approval-code constraints exempt the two reversal kinds and
  the reference stays where it was recorded.
- **A-P10-4 — the balance invariant is a CHECK.** `DEP-DEC-007`'s
  `received − reversed − allocated − reserved − refunded >= 0` is enforced by the database as well as
  by the service, and the aggregate row is locked `FOR UPDATE` by every money command, so an
  allocation racing a refund reservation serializes and one of them is refused rather than both
  succeeding.
- **A-P10-5 — a reservation exists from the request, not from the provider call.** doc 20 §3.1 keeps
  a pending, unknown or retryable-failed refund out of the available balance. The amount is reserved
  when the request is raised; a failed attempt leaves it reserved for the retry, and only an
  authoritative release frees it.
- **A-P10-6 — a retry that succeeds settles directly.** doc 20 §7 draws `FAILED → PENDING → SUCCEEDED`;
  the service retries in one command, so the guard admits `FAILED → SUCCEEDED` as well as
  `FAILED → PENDING`. The reservation stood throughout either way, which is what the decision
  protects.
- **A-P10-7 — the late success is detected by asking, not by a callback.** `DEP-DEC-009` requires a
  released refund the provider later paid to freeze the aggregate and open one case. The trigger
  here is an explicit re-query of the provider (`provider-check`), authorized like the release
  itself; the provider **callback** route that would do this unprompted belongs with the online
  payment surface of Phase 14, and this contract is what it will call. No client-supplied status is
  ever believed (CLAUDE.md §7).
- **A-P10-8 — the reconciliation runs in the hotel's tenant scope under an Operation action.**
  `DEP-DEC-010` gives the case to a Platform Operation account with
  `operation.deposit_refund_reconcile` and a recent step-up. The authorization is evaluated in the
  `operation` realm — no hotel role reaches it — while the transaction runs in the tenant scope of
  the hotel whose deposit it resolves, because the rows it locks are that hotel's.
- **A-P10-9 — the corrected record carries its own channel's references.** `DEP-DEC-006` re-records
  the movement rather than editing it, so the corrected row is held to the same channel rules as an
  original one; a correction that names a gateway or POS channel states its reference.
- **A-P10-10 — the deposit is a liability, never revenue.** An allocation writes no
  `payment_transaction` at all: it moves the aggregate's allocated total and the folio's applied
  total, so doc 20 §9's "a deduction adds no cash to the drawer" is structural rather than a
  reporting convention.
- **A-P10-11 — one line, one allocation.** doc 20 §3 allocates against the bill's lines. A unique
  index on the folio line keeps a line from being covered twice, which is also what makes three
  simultaneous allocations of the same line leave exactly one.
- **A-P10-12 — the folio must be settled before the stay completes.** Phase 08's checkout already
  probed `stay.open_folio`; now that the relation exists, the actual checkout of a stay whose bill
  is unpaid is refused `CHECKOUT_OBLIGATION_OPEN`. That is the intended reading of doc 02 §3.3 and
  it changes the Phase 08 and 09 flows in exactly one place: the bill is settled first.
- **A-P10-13 — the cash drawer itself is Phase 11's.** doc 20 §9 states the effect of a cash deposit
  on the expected drawer balance; the drawer, the count and the handover are doc 24's and Phase 11's.
  Phase 10 records the shift a cash movement belongs to, which is what Phase 11 will aggregate.

### 3.15 Phase 11 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P11-1 — a shift opens over a drawer, on a count.** doc 24 §§2.2, 3 make the drawer the unit of
  accountability and the first actual count its `INITIAL_FLOAT`, so `ShiftService.open` now requires
  the amount counted and resolves the drawer through `CashLedgerPort` — the named one, or the
  hotel's default. A hotel with no active drawer cannot open a shift (`NO_CASH_DRAWER`). Phase 05's
  activation provisions the default drawer with every hotel, so this holds for every activated
  hotel; the Phase 08 test harnesses seed the same row, because a hotel that skipped activation
  would otherwise be a fixture gap rather than the behaviour under test.
- **A-P11-2 — the drawer's float is seeded after the shift row exists.** The one-off `INITIAL_FLOAT`
  is written once per drawer, from the opening count of its first shift, *after* the shift insert.
  Two Receptions racing therefore collide on the shift's own partial unique index and report
  `SHIFT_ALREADY_OPEN`, rather than one of them losing on the movement index with a message about a
  float. An opening count of zero writes no movement: a drawer that starts empty starts at zero.
- **A-P11-3 — the financial review is two commands, not one.** doc 18 §3 gives
  `hotel.shift.financial_review` to the Manager and `hotel.shift.variance_self_close_review` to the
  Hotel Admin alone. A single "any-of" gate would let a Manager take the Hotel Admin's variance
  review, so the service exposes `review` (Manager, only while `PENDING_MANAGER`, refused to an
  account that worked the shift) and `adminReview` (Hotel Admin, for the self-close variance, the
  dispute and `SHIFT-DEC-004`'s self-review fallback, recorded as `self_reviewed`).
- **A-P11-4 — a rejection after the close is always a dispute.** `SHIFT-DEC-005` forbids reopening a
  closed shift. Since a review state exists only from the close onwards, every rejection a reviewer
  can reach is post-close and resolves to `DISPUTED`; the pre-close disagreement is the incoming
  Reception's `requestRecount`, which is a different command with a different actor.
- **A-P11-5 — Phase 08's direct close is now doc 03's self-close.** The Phase 08 shift closed
  straight from `OPEN` to `CLOSED` because the cash lifecycle did not exist yet. That path is now
  `selfClose` (`SHIFT-DEC-003`), and the Phase 08 expectation moved from `CLOSED` to `SELF_CLOSED`.
  `A-P08-1` — the shift's owner, left for this phase to tighten — is now answered for the count, the
  handover and the acceptance: each is bound to the opening account or the named recipient.
- **A-P11-6 — the ledger is read before the pending transfers, in that order.** A close asks
  `CashLedgerPort.summarizeShift` for both the outstanding transfers and the shift's movements. The
  transfers are read first: a confirmation committing between the two reads is then either still
  pending when the first read runs — and the close is refused — or already committed, so its
  movements are inside the second read. The reverse order would let a confirmation escape both
  (`CASH-DEC-006`).
- **A-P11-7 — a guest's cash reaches the drawer in the payment's own transaction.** doc 24 §4 puts
  cash payments, deposit receipts and their refunds in the drawer ledger, but the billing module
  owns the payment and not the drawer. Every cash-channel transaction it writes is mirrored through
  `CashPostingsPort` in the same transaction, so cash reaches both the folio and the drawer or
  neither. A `LATE_REFUND_COVERED` entry is deliberately not mirrored: the provider paid the guest
  and the deposit absorbed it, so no drawer moved.
- **A-P11-8 — a billing reversal is the cash refund of its kind, not a ledger correction.** A
  reversed cash deposit receipt is money physically handed back, so it posts `DEPOSIT_CASH_REFUND`
  (and a reversed folio payment `SERVICE_CASH_REFUND`). `CashService.correct` — which writes
  `CASH_CORRECTION_IN`/`OUT` against the movement it corrects — is for a ledger entry that never
  matched reality, which is a different fact (`CASH-DEC-004`, `-009`).
- **A-P11-9 — a correction belongs to the shift it is effective in.** `SHIFT-DEC-006` forbids
  rewriting a closed shift, so a correction is posted into the drawer's *current* shift with the
  original movement's id, and the closed shift's movement count is unchanged. The original row is
  refused any update by the append-only trigger, not by the service.
- **A-P11-10 — a drawer never goes negative, and an idle drawer takes nothing.** Every outflow
  re-derives the location's balance from its own movements and refuses `INSUFFICIENT_CASH`; every
  drawer movement resolves the drawer's active shift and refuses `NO_ACTIVE_SHIFT` when there is
  none. A safe has no shift and takes movements without one (`CASH-DEC-002`).
- **A-P11-11 — the Manager reads the locations it may move cash between.** doc 18 §3 gives the
  Manager `hotel.cash.transfer_initiate` but neither `hotel.cash.report_full` nor
  `hotel.cash.location_manage`. Reading the drawer list and the ledger therefore also admits the
  transfer permission: a Manager cannot move cash between drawers it is not allowed to see.
- **A-P11-12 — `ONB-DEC-001`'s grant probe narrows to what it protects.** Phase 05 proved
  "the runtime holds no `INSERT` on anything provisioning creates" by the absent grant, and included
  `platform.cash_location`. doc 24 §2.1 explicitly puts drawer and safe creation in the Hotel
  Admin's hands, so the API role now holds `INSERT`/`UPDATE` on that one table. What `ONB-DEC-001`
  protects — that a runtime session cannot fabricate a hotel, its subscription, its owner link or
  its profile — is unchanged, and the security test now proves the two things the missing grant used
  to: the insert is confined to the caller's own tenant, and the default drawer stays the one
  activation created. This is a narrowing of a test's scope to match a requirement, not a weakened
  gate; it is recorded here because it touches an accepted phase's invariant.
- **A-P11-13 — one lock order for a room and its minibar configuration.** A pre-existing inversion
  surfaced under the Phase 11 concurrency load: the minibar apply shared the room, locked the
  configuration and then upgraded the room to an exclusive lock to finalize its retirement, while a
  check-in locked the room and waited for the configuration — an intermittent deadlock. Both paths
  now take the room outright first. The fix is in Phase 07's module and is recorded here because it
  changes an accepted phase's locking, not its behaviour.

### 3.16 Phase 12 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P12-1 — a Guest is an account in the Phase 04 kernel, holding no email.** doc 09 §6.4 keeps
  account, booker and staying guest apart, and doc 09 §6.2 registers a guest by phone. Rather than a
  parallel identity table, the Guest realm joins `platform.user_account` and
  `platform.server_session`: realms never merge (ADR-0005), but they do share the kernel that issues
  and revokes sessions. `user_account.email_normalized` therefore drops `NOT NULL` behind
  `CHECK (email_normalized IS NOT NULL OR realm = 'guest')`, which keeps every other realm exactly
  as strict. A synthesised placeholder address was rejected: it would occupy
  `UNIQUE (realm, email_normalized)` and would be indistinguishable from a real address to every
  query that reads it. `AccountRow.emailNormalized` becomes `string | null`, and the two Phase 04
  sites that need an address assert the realm's guarantee rather than casting past it.
- **A-P12-2 — a guest may register through the provider and hold no number at all.** doc 09 §6.1 is
  a door of its own, not a decoration on §6.2. `guest_account.registered_via` is therefore
  `PHONE_OTP` or `PROVIDER`, the phone columns are all-or-nothing
  (`num_nulls(...) IN (0, 6)`), and `PHONE_OTP` without a proven number is unrepresentable. The
  uniqueness of a verified number is a *partial* index, so many provider accounts holding none do
  not collide. A provider account may gain a number later by proving it, exactly once: the guard
  refuses to replace or withdraw one already proven.
- **A-P12-3 — a one-time code is redeemed in its own committed transaction.** A wrong guess recorded
  inside the caller's transaction is rolled back by the very refusal it causes, and the attempt
  budget never decreases — an unbounded number of guesses against six digits. `redeem` therefore
  commits the attempt and settles the challenge before the caller's work begins, and the refusal is
  raised afterwards. The cost is that a code is spent even when the command that follows fails; the
  remedy is a fresh code, and that is the right trade. The integration and concurrency suites hold
  both halves: five wrong guesses lock the challenge, and two racing guesses cannot both spend the
  same attempt.
- **A-P12-4 — the public surface reads across tenants through `SECURITY DEFINER` functions.** Every
  table a listing needs is `FORCE ROW LEVEL SECURITY`, and a public search legitimately crosses
  every tenant. Migration `0013` adds `platform.public_hotel_listings()` and
  `platform.public_category_offers(...)`, owned by `prsystem_maintenance_fn` — the same narrow,
  login-less resolver role Phase 05 uses for its pre-tenant probes — reaching those rows only
  through `public_listing_read` / `public_availability_read` policies whose `USING` clause *is* the
  visibility rule rather than `true`. The API may execute the functions and still cannot select the
  tables across tenants; `public.security.test.ts` proves both halves.
- **A-P12-5 — two of doc 09 §5's five conditions are carried by the profile row.**
  `platform.hotel_profile` declares its coordinates, its address and its public phone `NOT NULL` and
  is append-only, so "location complete" and "public phone registered" cannot be withdrawn
  individually: a hotel has a profile carrying both, or has neither. The projection enforces them by
  joining that table, and a null test would have been dead SQL that read like a guarantee. The other
  three — account active, subscription valid, listing published — are separate terms, because
  doc 09 §3.2 refuses to collapse them into one word.
- **A-P12-6 — distance is computed by the platform, and geocoding alone is gated.** doc 09 §4
  requires distance and ordering to be computed server-side and a client-supplied distance never to
  be trusted. `GeoPort.geocode` and `.reverseGeocode` need Google Maps and answer `DISABLED` until
  `EXT-06` clears; `.distance` is a great-circle calculation over coordinates the platform already
  holds, reaches no provider, and is available on both paths. Answering `DISABLED` for arithmetic
  would push the calculation to the only other place it could go — the client — which is the outcome
  the gate exists to prevent. Coordinates cross the boundary as integer micro-degrees and the result
  is whole metres, so two callers agree exactly and an ordering never turns on a float's last bit.
- **A-P12-7 — the platform scope now admits the Guest realm.** `assertTenantContext` allowed the
  platform sentinel only in the Operation realm and for account-scoped Hotel work. A guest belongs
  to no hotel, so registering, signing in and recovering a password are that same account-scoped
  work, and the four `guest_*` tables carry no `hotel_id`. The rule is extended to `guest` on
  exactly those terms and nothing else: the Police realm still has no platform-wide work and is
  still refused, and `sec-rls.test.ts` holds that line.
- **A-P12-8 — the nearby radius and the sort order are the interim P1-01 values.** 5 km, availability
  first and then distance, named once in the domain rather than inlined. The ordering is total, so a
  page is stable. `external-integration-gates.md` §4 still carries the open decision.
- **A-P12-9 — the public module's category holds are a second, distinct booking contract.** The stay
  module already has a `ConfirmedBookingsPort` asking about one physical room, because a check-in is
  assigned a room. A public search never sees a room — `BK-DEC-013` offers a category and a count —
  so `CategoryHoldsPort` aggregates by category. Both defaults refuse rather than answer once
  `platform.booking` exists, so Phase 13 cannot implement one and silently leave the other
  over-reporting availability.
- **A-P12-10 — the second channel's code goes to the number the account holds.** doc 09 §6.3 asks
  for a dual-channel confirmation before an e-Mongolia identity joins a phone account. A caller who
  could name the number the code is sent to would prove nothing by answering it, so
  `requestLinkCode` takes only the link request, reads the account's own encrypted number, decrypts
  it for the length of the delivery call, and never returns it. `requirePurpose` refuses
  `ACCOUNT_LINK` from a request body for the same reason.

### 3.17 Phase 13 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P13-1 — overbooking is refused by a constraint, not by a count.** `BK-DEC-013` derives
  availability from eligible `ACTIVE` rooms minus overlapping holds, confirmed bookings and active
  stays. A count computed in one statement and acted on in another is a race with a name, so the
  occupancy is a row per category per night — `category_night_inventory` — carrying the capacity
  that night and the units taken, with `CHECK (units_held <= units_capacity)`. Every path that
  changes occupancy locks those rows **in night order**, which is what turns two guests racing the
  last unit into one waiting for the other rather than a deadlock, and the loser is refused by
  `23514` from the constraint itself.
- **A-P13-2 — a stay and a booking each subtract the same unit exactly once.** `units_capacity` is
  refreshed on every write from the rooms as they are at that instant, and it excludes rooms an
  active stay occupies — but only stays that carry no `fulfilled_booking_id`. A walk-in therefore
  reduces capacity; a booking holds `units_held`; and at check-in the booking's unit becomes the
  stay's occupancy with neither number moving. That is doc 09 §5's "transferred atomically, not
  double-counted", and it is why the check-in consumes the booking inside its own transaction
  through `BookingFulfilmentPort` rather than afterwards.
- **A-P13-3 — a completed booking releases nothing, because it consumed its unit.**
  `releasesInventory` is true for every terminal state except `COMPLETED`. An expired or cancelled
  booking gives its nights back at once, which is what the gate asks for; a booking that was slept
  in used them. The nights are in the past by then and nothing books them again.
- **A-P13-4 — the price is quoted at the hold and snapshotted at confirmation.**
  `captureRateSnapshot` is keyed by the booking id and is idempotent, so the hold's quote and the
  confirmation's snapshot are the same row: doc 09 §7 step 8 and doc 09 §10 together mean a paid
  booking is never repriced, and the guard refuses any later change to the snapshot columns.
- **A-P13-5 — Phase 13 records the refund obligation and settles nothing.** `PAY-DEC-006` makes a
  late or duplicate capture a full refund obligation. The booking's `payment_state` becomes `PAID`
  and its `refund_state` `REQUIRED`, an event and an outbox message are written, and that is all.
  Capture, refund execution, commission and the gateway fee are Phase 14's and are deliberately
  absent — as is `BK-DEC-014`'s "commission 0, gateway fee the platform's cost", which is a
  settlement rule with nothing to settle yet.
- **A-P13-6 — three reads cross the tenant boundary through resolver functions.** A booking command
  must know which hotel a category belongs to *before* it has a tenant; a public search must
  subtract what bookings hold with no tenant at all; and the expiry sweep must see lapsed holds
  across every hotel. All three are `SECURITY DEFINER` functions owned by the login-less resolver
  role Phase 05 introduced and Phase 12 reused — `hotel_of_category`, `public_category_holds` and
  `lapsed_booking_holds` — each answering identifiers or counts and nothing else. The alternative,
  letting a request name its own hotel, is exactly what the Guest boundary forbids.
- **A-P13-7 — a Guest reads their own booking through an account policy, and writes through the
  hotel's scope.** `own_booking_read` matches only under the platform sentinel and only where
  `booker_account_id` is the authenticated account, confined the same way Phase 04 confines a member
  reading their own membership. Commands run in the hotel's own scope with the Guest travelling as
  the account, so a Guest never holds a scope over hotel tables. Another guest's booking answers
  `NOT_FOUND`, identically to one that does not exist.
- **A-P13-8 — every calendar date is bound as `YYYY-MM-DD`.** A `Date` bound to a `date` column is
  converted through the session's timezone, so UTC midnight on the 4th is stored as the 3rd wherever
  the server is east of Greenwich — and the night a booking took would not be the night the
  availability query asked about. `toDateString` and `fromPgDate` are the only crossings, and the
  defect they fix was found by the integration suite rather than reasoned about.
- **A-P13-9 — `room.future_booking` was removed from the dependency registry.** It named
  `platform.booking.assigned_room_id`, a column `BK-DEC-013` does not create: a booking holds a
  category unit and reaches a room only by becoming a stay, which `room.active_stay` already blocks
  on. The expectation was corrected rather than a column invented to satisfy it. The catalog probe
  test that used it to prove "a relation present but unreadable is `unavailable`" now breaks and
  restores a real relation's shape instead, because every registered relation exists once Phase 13
  has landed.
- **A-P13-10 — a booking that never confirmed carries no price.** The first draft of
  `booking_confirmed_has_snapshot` required the snapshot of every state except `HOLDING`, which made
  an expired booking unrepresentable. It now requires it of `CONFIRMED`, `CHECKED_IN` and
  `COMPLETED` — the states that were actually confirmed — and `booking_confirmed_has_time` follows
  the same three. Found by the integration suite.
- **A-P13-11 — night granularity for units, buffers at assignment.** The category unit is counted
  per night. The snapshotted cleaning buffer that separates one occupancy from the next is a
  property of a *room*, and it is applied where a room is chosen: the Phase 08 availability rules at
  check-in and the Phase 12 projection's own arithmetic. Counting a buffer against a category unit
  would subtract a fraction of a night from a whole-night inventory.

### 3.18 Phase 14 scope alignments — approved requirements, implemented

Implementation decisions taken inside the approved requirements. None changes a requirement; each is
recorded so a reviewer can see where a judgement was made.

- **A-P14-1 — the commission contract has no application writer.** `PAY-DEC-001` requires an
  explicit, negotiated rate per hotel and refuses any default. doc 18 §5 names no Operation
  permission for setting one, and a role the requirements do not grant is a role this phase will not
  invent — so `hotel_commission_contract` grants `SELECT` to both runtime logins and nothing else,
  and a contract reaches the platform through the restricted configuration principal, the way the
  signed agreement it records does. What *is* implemented and gated is the operative rule: a hotel
  with no `ACTIVE` contract cannot take an online booking payment at all. An Operation surface for
  administering rates needs a permission doc 18 does not yet name.
- **A-P14-2 — `planned_checkin_at` is the start of the arrival date, hotel-local.** doc 09 §12
  refers to a confirmed booking's `planned_checkin_at`, and no approved document configures a
  standard check-in hour. The only instant the platform actually knows is the beginning of the
  booked arrival date in the hotel's own timezone, which is also the correct lower bound for doc 05
  §19's backdate guard. `PAY-DEC-007`'s free-cancellation deadline is 24 hours before it, and the
  no-show cutoff is that same date's `23:59:59`. A configured check-in hour would move the
  cancellation deadline later and is a P1 configuration item, not an assumption to invent here.
- **A-P14-3 — the commission base moves only when money moves.** doc 11 §3 makes the base the room
  charge *actually retained*, and doc 11 §5 keeps the refund on its own axis until a verified
  provider result completes it. A cancellation therefore raises the obligation and puts the payable
  `HELD`; it does not reduce the base against money the guest has not yet received. The base shrinks
  in exactly one place — the transaction that records the provider's confirmed refund — and the
  differences are posted as their own ledger events rather than edited into the earlier ones.
- **A-P14-4 — `ROUND_HALF_UP` is a database CHECK, not only a convention.**
  `commission_mnt = (retained_mnt * commission_rate_bps + 5000) / 10000` on non-negative bigints is
  exactly half-up, so the constraint recomputes what the application wrote. A unit test asserts the
  two agree across the tie cases, which is what keeps them from drifting.
- **A-P14-5 — the gateway fee cannot be deducted, because the formula has no term for it.**
  `BK-DEC-011` and `PAY-DEC-004` make the provider fee the platform's cost. `hotel_payable_mnt =
  retained_mnt - commission_mnt` is a CHECK with no fee term, so no application mistake can subtract
  it from a payout; the fee appears on its own `PROVIDER_FEE` ledger line and in the platform's own
  net result.
- **A-P14-6 — a payout batch is opened only when it pays something.** `PAY-DEC-009` deducts a
  negative adjustment from *the next payout*, and where there is no next payout it becomes a
  separate receivable. A batch whose lines net to zero or less would be a transfer that never
  happened, so none is opened: the `ADJUSTMENT_DUE` payables stand as the receivable on their own
  rows until a later batch has something to deduct them from.
- **A-P14-7 — the worker may read the hotel row.** The `D+1 12:00` batch is derived in the hotel's
  own timezone and eligibility is filed under its own calendar day, neither of which the job can
  compute without `platform.hotel`. `prsystem_worker` therefore holds `SELECT` on it, confined by
  RLS to the tenant it is already settling.
- **A-P14-8 — a callback names an invoice and never a tenant.** A provider holds no session and no
  hotel, so `booking_attempt_of_invoice` resolves the hotel on the server through the same narrow
  `SECURITY DEFINER` idiom Phase 13 uses for a category. It deliberately finds an attempt in *any*
  state, because `PAY-DEC-006` is precisely about the callbacks that arrive after one has expired or
  been superseded.
- **A-P14-9 — `booking_confirmed_has_time` was an equivalence and is now an implication.** Phase 13
  wrote it as "the state is one of `CONFIRMED`/`CHECKED_IN`/`COMPLETED` **iff** `confirmed_at` is
  set", which no Phase 13 path could violate. The first Phase 14 path to reach it — a guest
  cancelling a *paid* booking — did: the moment the state left the set, the constraint demanded that
  the confirmation had never happened. Migration 0015 restates it as the implication the
  requirements actually make, so a terminal booking keeps the instant it was confirmed at.
- **A-P14-10 — the platform's central-account settlement stays gated.** doc 11 §12 makes the legal
  and contractual basis for holding a third party's money an external gate. `HotelPayoutPort`
  (EXT-07) has a disabled production adapter and a deterministic simulator, so every payout in this
  phase is measured against the simulator and no real transfer is possible.
- **A-P14-11 — a hotel cancellation of a real booking is now reachable.** Phase 09's overdue-conflict
  resolution records `CANCELLED_HOTEL` on `booking_fulfillment_conflict` and, as its own comment
  says, leaves applying it to the booking module. Phase 14 adds the `booking.cancelled_hotel`
  command so `PAY-DEC-008`'s "commission base zero on hotel-caused cancellation" is reachable and
  gated. Wiring the conflict resolution itself to that command is not in this phase's scope and
  remains open.

---

## 4. P1 configuration register

[docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §3 lists **17** P1 items. All **17 remain
open**; none has been closed by any phase to date. None reopens schema or API design; each is
implemented as versioned configuration with the interim default below, surfaced in the admin or
configuration layer, and confirmed before MVP handover in Phase 23.

**P1 accounting:** 17 total · 17 pending · 0 closed.

An interim default, an architecture proposal or a passing measurement does **not** close a P1 item.
Only an approved customer decision does. This applies specifically to **P1-10**: Phase 01 proposed
measurable non-functional values, every one carrying the status `PROVISIONAL_ARCHITECTURE_DEFAULT`
— including RPO ≤ 5 minutes and RTO ≤ 4 hours. Phase 22 measures them and Phase 23 reports whether
they were achieved, but P1-10 stays `OPEN` until an approved DEC adopts the values.

| P1 | Item | Interim default used | Owning phase |
| --- | --- | --- | --- |
| P1-01 | Nearby radius and default sort | 5 km; availability first, then distance | 12 |
| P1-02 | Guest OTP TTL, resend and lockout | 5-minute TTL; 60-second resend; 5 attempts; IP and phone rate limit | 12 |
| P1-03 | Booking notification channels | In-app plus SMS to the verified phone, with SMS behind EXT-05 | 13 |
| P1-04 | Public listing minimum completeness | Required-field checklist, preview and an explicit publish action | 12 |
| P1-05 | Platform support access to guest data | **No** automatic access in MVP; the incident-approval flow is deferred | 17 |
| P1-06 | Restaurant menu detail | Item active or sold-out, quantity and note; add-ons deferred | 15 |
| P1-07 | SMS job cap, retry, retention and masking | Cap and retry configurable with a conservative default; body never logged | 19 |
| P1-08 | Police alert escalation minutes, routing and metrics | **Disabled in production without approved ЦЕГ configuration** (EXT-09) | 18 |
| P1-09 | Retention for non-guest data classes | Guest PII at 365 days confirmed; the audit, review, order, payment and SMS retention matrix is pending | 17 |
| P1-10 | Non-functional targets | `PROVISIONAL_ARCHITECTURE_DEFAULT` values proposed in [15-non-functional-targets.md](../architecture/15-non-functional-targets.md); **status `OPEN`** — measured in Phase 22, reported in Phase 23, closed only by an approved DEC | 01 |
| P1-11 | Receipt and tax beyond the subscription eBarimt | The ledger carries tax fields; room, minibar, booking receipts and VAT numbering are deferred | 17 |
| P1-12 | Audit viewer, filters, retention and alerts | The per-module audit taxonomy is built as each module lands; the central viewer is deferred | 22 |
| P1-13 | Restaurant invitation, OTP and guest access TTLs | A unified security configuration table | 15 |
| P1-14 | Review UX and display-name masking | The review is opened from the completed-stay detail; first letter plus mask | 16 |
| P1-15 | Operation reset token TTL and email provider | 30-minute single-use link; previous tokens invalidated | 19 |
| P1-17 | Guest access code length, TTL and lockout | Six digits, valid until checkout, rate-limited, hashed storage | 15 |
| P1-19 | Cleaner queue atomic claim and SLA | Atomic claim implemented per A-11; automatic timeout and escalation deferred | 09 |

---

## 5. Explicitly deferred scope

Recorded so that no phase implements it by accident (doc 00 §5, plus module-level deferrals).

- Restaurant menu add-ons, minimum order and quantity limits beyond the P1-06 minimum.
- Automatic and scheduled SMS campaigns, and a two-way SMS inbox.
- Hotel account recovery when the registered email is inaccessible — a Platform Super Admin offline
  procedure, not an Operation Dashboard feature.
- Police Admin bulk export of the all-hotel check-in list, which is closed to every role in MVP.
- Registration of additional co-occupants beyond the single primary guest per stay.
- Merging restaurant payments into hotel checkout, deposit, cash drawer or shift revenue.
- The nightly early-morning or business-day cutoff configuration (`STAY-DEC-007` deferred boundary).
- Retroactive Police matching against already-checked-out stays (`POL-DEC-017`).
- Any change to a confirmed booking's or an active stay's `planned_checkout_at` — no extension,
  shortening, amendment or hourly-to-nightly conversion exists in MVP (`STAY-DEC-012`).
  `STAY-DEC-011` is a post-MVP invariant only; no amendment instance may be created.
- Package downgrade in any form (`LIFE-DEC-001`).
- Subscription refunds (`SUB-DEC-009`); duplicate charges and chargebacks are finance exceptions, not
  product refunds.
- Relocation to a different hotel, or compensation, for hotel-caused overbooking (`BK-DEC-014`).

---

## 6. Conflict escalation protocol

If a phase discovers a genuine contradiction — not wording drift — between two documents at the same
precedence level, or between doc 00 and a module document:

1. Stop implementation of the affected area.
2. Record the exact quoted text from both sources here, with document and line references.
3. Record the design decision that each reading would force.
4. Report the conflict in the phase report and **do not** pick a reading unilaterally.

Wording drift that precedence resolves cleanly is recorded in §2 and does not stop work.
