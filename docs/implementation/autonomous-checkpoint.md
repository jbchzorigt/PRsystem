# Autonomous checkpoint — Phase 21 complete, Phase 22 authorized

**Written:** 2026-09-09, at the close of Phase 21 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 21 passed its battery on the implementation commit.** All 28 executions of the governed
battery exited 0 on `357df68`, the measured tree, in a clean detached checkout. Implementation
completion is not customer acceptance and not release approval.

**No gate cleared.** Every one of the fourteen gates is still `BLOCKED`; the portals show the
e-Mongolia sign-in as not yet open, and every provider they reach answered as its simulator in the
measured runs. Requirement coverage stays complete (279 of 279) and release readiness stays absent:
eleven EXT gates and three internal controls are open, seventeen P1 items are open, two dependency
advisories are contained rather than closed, no phase since Phase 05 has been accepted, and Phases 22
and 23 have not run.

---

## 1. Repository

| Field | Value |
| --- | --- |
| Path | `/Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb` |
| Branch | `claude/prsystem-phases-06-23-d506eb` |
| Base | fast-forwarded from `claude/mvp-implementation` at `818bd12db6fdc557bb6908b773ed359465c6ce71` (Phase 05 acceptance) |
| Phases 06–19 | as recorded in the Phase 20 checkpoint and in `phase-status.md`; unchanged |
| Phase 20 commits | implementation `ccbf602`, correction `361b116` (the measured tree), record `8a6bb10` |
| Phase 21 commits | implementation `357df68be65a55126d135a46059a3f3eb9aebb43` (the measured tree) |
| Phase 21 record commit | the commit that carries this checkpoint (see `git log -1`) |

**Where the work lives, and why.** Unchanged since the Phase 06 checkpoint: the work is on this
worktree's branch. The main checkout at `/Users/zorigtgantumur/Documents/Work/prsystem` still holds
`claude/mvp-implementation` at `818bd12` with the superseded uncommitted Phase 06 draft and the
untracked Phase 03 checkpoint; it was not modified. This worktree also carries an untracked copy of
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Reconciling the
two checkouts is the customer's call and was not performed. No push, merge, rebase, reset, stash,
clean or deploy has been performed anywhere.

## 2. Governed state

Declared in [`tools/programme-state.mjs`](../../tools/programme-state.mjs): Phases 03, 04 and 05
`DONE` and `ACCEPTED`; Phases 06 to 21 `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`, each an entry of
`PROGRESSED_PHASES` with its own evidence manifest; **Phase 22 — Security, concurrency, recovery,
and full E2E — `NOT STARTED`, authorized to begin.** The standing progression authorization of
2026-09-03 is unchanged: implementation authorization for Phases 06–23, sequential; not acceptance,
not release approval, no gate weakened. Governance check 17 holds each manifest, governed entry and
record to one another; check 14 holds the runbook's `GATE-SEC` catalogue to its twenty sub-gates.

## 3. What Phase 21 delivered

See the [Phase 21 record](phase-status.md#phase-21-record) and `A-P21-1`…`A-P21-11` in
[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.25.

- **`packages/web-kit`** — the portals' shell (skip link, landmarks, server-decided navigation),
  fields with `aria-describedby`, tables that stack into cards below 768px, the Mongolian error
  vocabulary, the typed HTTP client over the API's envelope, and the httpOnly session cookie.
  Depends on `@prsystem/contracts` only; approved in `validate-workspace`, the build plan's tree and
  the architecture document's package table.
- **Five portals on the real API** — Hotel (board, quote and check-in, stay and folio, Cleaner
  dashboard, shifts, housekeeping, catalog, registry, finance, staff, restaurant codes,
  subscription with grace banners and the lock screen), Public and Guest (search, listing, detail,
  registration by phone, hold, pay, cancel, own bookings, review), Restaurant (QR and code, menu,
  order, invoice, refund), Police (dashboard and charts, exact match search, acknowledge, Found,
  False Match, check-in list, wanted registration and case lifecycle, identity decision, export),
  Operation (TOTP sign-in and step-up, KPI cards, filtered list, suspension, reset initiation,
  onboarding queue, reconciliation queue, recovery, accounts, SMS preview → confirm → history).
  Every page is a server component; every command a Server Action with a render-time idempotency
  key; no identifier in a URL; no business rule in web code.
- **Two API additions:** the Operation and Police navigation projection on `GET /auth/session`
  (`realmRole`, `effectivePermissions`, `stepUpRequired`, by the same pure pipeline, consulted by no
  command) and `revision` on the Police `CaseView`.
- **The gates:** `e2e/api-server.mjs` (real API on a scratch database, synthetic seeds, loopback
  console for the simulators' codes), 33 Playwright flows per profile at Pixel 7, Galaxy Tab S4 and
  Desktop Chrome, axe-core WCAG 2.0/2.1 A + AA over every primary screen with no horizontal scroll,
  and the web boundary as `webBoundaryRule` plus `packages/testing/src/web-boundary.test.ts`.

Traceability v1.34 (no decision changes state; four Phase 21 obligation rows).

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `.next/`, `openapi.json`, `.turbo/`, `test-results/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| `playwright test` (all three projects, real API) | 99 passed |
| `@prsystem/web-kit` unit / `@prsystem/testing` unit (incl. web boundary) | 16 / 18 |
| api `iam.integration`, `iam.repair`, `police.integration`, `police.http`, `operation.http` | 85 |
| `pnpm run lint` / `typecheck` / `format:check` / `test:unit` / `openapi` / `build` | exit 0 (18 / 30 / — / 20 / — / 18 projects) |
| the eight governance validators on the final tree | all exit 0 |

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once. `playwright test` binds 53100–53104 for the portals and 53200/53201 for
the API and its console, refuses a server already on those ports, and needs `apps/api/dist` and the
portal builds (`pnpm run test:e2e` builds them first).

**The governed battery** ran once, on the implementation commit `357df68`, in a clean detached
checkout with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`: **all 28 executions exited 0**. Exit codes and durations are in
[`phase-21-battery-log.md`](phase-21-battery-log.md), results in
[`phase-21-evidence.json`](phase-21-evidence.json), restated in the Phase 21 record.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 20 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- **Phase 22 inherits the full end-to-end pass** — a provider invoice followed to its pay page
  (which needs a page the simulator does not serve, or a gate cleared), a restaurant order paid, a
  checkout driven to settlement, onboarding through activation (`A-P21-8`) — on the harness Phase 21
  stood up. WebKit and Firefox profiles are not installed and not claimed.
- **API reads the portals still lack** (`A-P21-4`): a wanted-person list (doc 13 §12.1), a
  hotel-side restaurant order list and staff list, a Cleaner-readable count sheet, the Police
  account-management routes (doc 13 §5), the reconciliation terminal outcome (doc 14 §4.2). Each is
  an API addition for the phase that owns it; none is a rule to write in web code.
- **Unchanged from Phase 20:** the unscheduled domain sweeps (`A-P20-9`), the SMS delivery-status
  refresh's worker question (`A-P20-5`), `A-P14-11`, the `DSR-01` and `DSR-02` reviews, the P1-10
  non-functional measurements, and the two Operation surfaces that need a doc 18 §5 row (`A-P14-1`,
  `A-P19-11`).
- **Clearing any gate** is unchanged: the artefact in `external-integration-gates.md`, the entry in
  `gates.ts`, a migration, the adapter and its conformance run, and `ADAPTER_<SLOT>`.

Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 21 battery checkout is removed after its run; `git
  worktree list` shows the main checkout, this worktree and the earlier task-owned detached checkouts
  `battery-wt-08b` through `battery-wt-13` under the session scratchpad — all safe to remove with
  `git worktree remove --force`. The scratch database `prsystem_test_e2e` is dropped by the e2e
  server on shutdown and recreated with `FORCE` by the next run.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379, MinIO 59000, Mailpit 51025), with the Playwright Chromium
  build in the user's Playwright cache. The disposable project `prsystem-p06` and its volumes are
  still present and unused. Local development credentials only, kept in the session scratchpad
  (`env.sh`) and deliberately not reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01` … `EXT-11`, `INT-OTP-01`, `INT-MAIL-01`, `INT-STORAGE-01`
  (BLOCKED), 17 P1 configuration items, `DSR-01` and `DSR-02` (due in Phase 22), and selecting
  `GATE-SEC` as a required GitHub status check.
- **Three Police items are still recorded for the customer's attention**: the full registration
  number in a Match SMS, the all-hotel check-in list, and the four-digit bootstrap exception.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 22 — Security, concurrency, recovery, and full E2E — is the current phase and is authorized
to begin under the standing authorization.** Before editing: reread `CLAUDE.md`, this checkpoint,
`phase-status.md` (current position, ledger, the Phase 20 and 21 records), `build-plan.md`
§"Phase 22", `docs/architecture/15-non-functional-targets.md` and the Phase 01 threat model the
build plan names. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 22/,/^### Phase 23/p' docs/implementation/build-plan.md \
  && ls e2e/ packages/testing/src/
```

Begin from what exists: the e2e harness and its seeded API server, the twenty `GATE-SEC` sub-gates,
the per-module concurrency suites, the migration suite's fresh and upgrade paths, and the
non-functional targets that are all still `PROVISIONAL_ARCHITECTURE_DEFAULT`. Phase 22 measures; a
shortfall is reported as a gap, never resolved by lowering a number, and no gate is weakened to
pass (CLAUDE.md §11).
