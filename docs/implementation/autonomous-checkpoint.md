# Autonomous checkpoint — Phase 22 complete, Phase 23 authorized

**Written:** 2026-09-10, at the close of Phase 22 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 22 passed its battery on the correction commit.** The first run, on the implementation
commit `4bf8629`, failed `pnpm run test:regression` (two tests asserting a 21-entry journal after
migration `0021`) and the three `pnpm run test:security` runs (a tenant-row seed writing a uuid
booking reference the new shape check refuses, so two db suites skipped); both fixtures were
corrected on `4575f8d`, no product code, and all 28 executions of the governed battery exited 0
there, the measured tree, in a clean detached checkout. Implementation
completion is not customer acceptance and not release approval.

**No gate cleared.** Every one of the fourteen gates is still `BLOCKED`; every provider the journeys
reach answered as its simulator in the measured runs. Requirement coverage stays complete (279 of
279) and release readiness stays absent: eleven EXT gates and three internal controls are open,
seventeen P1 items are open, two dependency advisories are contained rather than closed and were
reviewed this phase, no phase since Phase 05 has been accepted, two non-functional targets are
measured short and five are unmeasured, and Phase 23 has not run.

---

## 1. Repository

| Field | Value |
| --- | --- |
| Path | `/Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb` |
| Branch | `claude/prsystem-phases-06-23-d506eb` |
| Base | fast-forwarded from `claude/mvp-implementation` at `818bd12db6fdc557bb6908b773ed359465c6ce71` (Phase 05 acceptance) |
| Phases 06–20 | as recorded in the Phase 21 checkpoint and in `phase-status.md`; unchanged |
| Phase 21 commits | implementation `357df68` (the measured tree), record `4f17b4b` |
| Phase 22 commits | implementation `4bf8629`, correction `4575f8d37ec5cc5bbe6d93e29ef5828248688313` (the measured tree) |
| Phase 22 record commit | the commit that carries this checkpoint (see `git log -1`) |

**Where the work lives, and why.** Unchanged since the Phase 06 checkpoint: the work is on this
worktree's branch. The main checkout at `/Users/zorigtgantumur/Documents/Work/prsystem` still holds
`claude/mvp-implementation` at `818bd12` with the superseded uncommitted Phase 06 draft and the
untracked Phase 03 checkpoint; it was not modified. This worktree also carries an untracked copy of
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Reconciling the
two checkouts is the customer's call and was not performed. No push, merge, rebase, reset, stash,
clean or deploy has been performed anywhere.

## 2. Governed state

Declared in [`tools/programme-state.mjs`](../../tools/programme-state.mjs): Phases 03, 04 and 05
`DONE` and `ACCEPTED`; Phases 06 to 22 `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`, each an entry of
`PROGRESSED_PHASES` with its own evidence manifest; **Phase 23 — Release candidate audit —
`NOT STARTED`, authorized to begin.** It is the last phase of the approved programme; there is no
Phase 24. The standing progression authorization of 2026-09-03 is unchanged: implementation
authorization for Phases 06–23, sequential; not acceptance, not release approval, no gate weakened.
Governance check 17 holds each manifest, governed entry and record to one another; check 14 holds
the runbook's `GATE-SEC` catalogue to its twenty sub-gates.

## 3. What Phase 22 delivered

See the [Phase 22 record](phase-status.md#phase-22-record) and `A-P22-1`…`A-P22-13` in
[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.26.

- **Recovery rehearsal** — `tools/recovery-rehearsal.mjs` and `recovery-runbook.md`: a disposable
  PostgreSQL 17 primary with continuous archiving, a base backup, the platform's own workload, the
  primary destroyed, restore to the end of the archive and to a point in time, both verified row for
  row and schema for schema. Measured RPO exposure 25.2 s (≤ 5 min), RTO 1.6 s for the restore
  (≤ 4 h for the procedure). Report `phase-22-recovery-rehearsal.json`. P1-10 stays open.
- **Full journeys** — `e2e/journeys/{booking,police,subscription,onboarding}.spec.ts` at three
  Chromium profiles on the real API with the worker's consumers in-process: hold → invoice →
  callback → check-in → minibar lock and reconciliation → charges → cash on a shift → settlement →
  review → payable; wanted case → check-in → matcher alert with its latency recorded; the three
  subscription lanes with renewal after the lock; onboarding from the application to the shift
  count.
- **Defects the journeys found, fixed at the source** — the folio's transactions as the minibar
  report's payment attempts (`BillingPaymentAttempts`); migration `0021_stay_booking_ref_text`
  (booking reference as text with a shape check, snapshot subject = booking id); the live minibar
  report on the stay view and the revision on the Cleaner queue; the cash shift in the portal; the
  Police sweep default at 5 s; request and unexpected-error logging; the table wrapper's
  focusable region.
- **Secret-leakage scan at runtime** — `e2e/leakage.spec.ts`: 81 canaries across every platform,
  police and audit table, the API log and every Redis key of the run; zero findings. The tree scan
  stays at zero.
- **Concurrency coverage** — `tools/concurrency-manifest.mjs` (147 commands, each raced by a named
  suite or excused for a recorded reason), `tools/validate-concurrency-coverage.mjs` and the unit
  gate `packages/testing/src/concurrency-coverage.test.ts`.
- **Fault injection** — `apps/api/src/resilience/degraded-modes.http.test.ts` in `GATE-INTEG`:
  Redis, payment provider, ХУР, SMS and object storage down, each observed as doc 15 §4 documents.
- **Security** — API security headers and a deny-all CSP on every answer; portal headers through
  `packages/web-kit/next-headers.mjs`; `phase-22-security-review.md` (threat model re-verified realm
  by realm); `dependency-security-register.md` v1.2 (DSR-01 and DSR-02 reviewed, still contained).
- **Measurements** — `phase-22-measurements.md`, `phase-22-load-measurement.json`, doc 15 §10:
  every target beside its measurement; the room board p50 (77.6 ms vs 50) and single-instance
  throughput (145.5 rps vs 200) short; availability, outbox relay lag, the 10 000-row export, the
  service-month boundary timing and the paint metrics not measured.

Traceability v1.35 (no decision changes state; six Phase 22 obligation rows).

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `.next/`, `openapi.json`, `.turbo/`, `test-results/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| `playwright test` (mobile, tablet, desktop and leakage projects, real API) | 130 passed |
| `node tools/recovery-rehearsal.mjs` | PASS — RPO 25.233 s, RTO 1.567 s, 40/40 and 30/30 rows, schema equal |
| `node tools/load-test.mjs --requests 200 --concurrency 8` | report written; two classes short of target |
| api `degraded-modes.http` / `billing.integration` / `checkout.integration` / `stay.*` / `review.*` | exit 0 |
| `pnpm run lint` / `typecheck` / `format:check` / `test:unit` / `test:migrations` / `openapi` / `build` | exit 0 (18 / 30 / — / 20 / 148 / — / 18 projects) |
| the eight governance validators on the final tree | all exit 0 |

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once. `playwright test` binds 53100–53104 for the portals and 53200/53201 for
the API and its console, refuses a server already on those ports, and needs `apps/api/dist`,
`apps/worker/dist` and the portal builds (`pnpm run test:e2e` builds them first). The recovery
rehearsal needs Docker and binds 55497–55499; the load tool binds 53230/53231.

**The governed battery** ran twice — on `4bf8629`, where the regression suite exited 1, and in full
on the correction commit `4575f8d` — each in a clean detached
checkout with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`: **all 28 executions exited 0 on `4575f8d`**. Exit codes and durations are in
[`phase-22-battery-log.md`](phase-22-battery-log.md), results in
[`phase-22-evidence.json`](phase-22-evidence.json), restated in the Phase 22 record.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 21 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. What Phase 23 receives

- **The release decision is the customer's.** Phase 23 reports, per target in doc 15, whether the
  Phase 22 measurement achieved the provisional value — including RPO ≤ 5 min and RTO ≤ 4 h — and
  P1-10 closes only by a DEC adopting the values, never by measurement.
- **Measured gaps and unmeasured targets** (`A-P22-8`, `phase-22-measurements.md` §9): the room
  board p50, single-instance throughput, availability, outbox relay lag (`A-P22-7`: the relay has no
  consumer), the 10 000-row export, the service-month boundary timing, the paint metrics.
- **Structural findings:** no general request rate limiter (`A-P22-6`); the portals' CSP admits
  inline script (`A-P22-9`); WebKit and Firefox not claimed; `EXT-10` penetration test not performed.
- **API reads the portals still lack** (`A-P21-4`) and the unscheduled domain sweeps (`A-P20-9`),
  the SMS delivery-status refresh's worker question (`A-P20-5`), `A-P14-11`, and the two Operation
  surfaces that need a doc 18 §5 row (`A-P14-1`, `A-P19-11`) — each to be reported as covered,
  deferred with a reason, or a release blocker.
- **Clearing any gate** is unchanged: the artefact in `external-integration-gates.md`, the entry in
  `gates.ts`, a migration, the adapter and its conformance run, and `ADAPTER_<SLOT>`.

Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 22 battery checkout is removed after its run; `git
  worktree list` shows the main checkout, this worktree and the earlier task-owned detached checkouts
  under the session scratchpad — all safe to remove with `git worktree remove --force`. The scratch
  databases `prsystem_test_e2e` and `prsystem_test_load` are dropped by the e2e server on shutdown
  and recreated with `FORCE` by the next run. The rehearsal's `prsystem-rehearsal-*` containers and
  volumes are removed by the tool on exit.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379, MinIO 59000, Mailpit 51025), with the Playwright Chromium
  build in the user's Playwright cache. The disposable project `prsystem-p06` and its volumes are
  still present and unused. Local development credentials only, kept in the session scratchpad
  (`env.sh`) and deliberately not reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01` … `EXT-11`, `INT-OTP-01`, `INT-MAIL-01`, `INT-STORAGE-01`
  (BLOCKED), 17 P1 configuration items, `DSR-01` and `DSR-02` (reviewed in Phase 22, next due at the
  release candidate audit), and selecting `GATE-SEC` as a required GitHub status check.
- **Three Police items are still recorded for the customer's attention**: the full registration
  number in a Match SMS, the all-hotel check-in list, and the four-digit bootstrap exception.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 23 — Release candidate audit — is the current phase, the last of the approved programme,
and is authorized to begin under the standing authorization.** Before editing: reread `CLAUDE.md`,
this checkpoint, `phase-status.md` (current position, ledger, the Phase 21 and 22 records),
`build-plan.md` §"Phase 23", `requirements-traceability.md`, `external-integration-gates.md`,
`phase-22-measurements.md` §9 and `phase-22-security-review.md` §5. Then verify `git status`
matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 23/,/^## 5/p' docs/implementation/build-plan.md \
  && grep -c PENDING docs/implementation/requirements-traceability.md
```

Phase 23 reconciles and reports; it takes no release decision, clears no gate by assertion, adopts
no non-functional value by measurement alone, and weakens nothing to pass (CLAUDE.md §11).
