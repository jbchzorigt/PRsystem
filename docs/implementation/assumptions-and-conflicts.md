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
