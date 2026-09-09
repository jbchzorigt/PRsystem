# Autonomous checkpoint — Phase 20 complete, Phase 21 authorized

**Written:** 2026-09-09, at the close of Phase 20 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 20 needed a correction.** Its governed battery failed three of 28 executions on the
implementation commit for one cause — the committed-secret scanner flagging AWS's documented example
key id in the SigV4 vector test, and a canary constant — and passed all 28 on the correction commit,
which is the measured tree, as Phases 08, 13 and 16 did. Implementation completion is not customer
acceptance and not release approval.

**No gate cleared.** Phase 20's honest output is that every one of the fourteen gates is still
`BLOCKED`, in three places now held to one another, and that a deployment cannot enable an adapter
behind a blocked gate at all. Requirement coverage stays complete (279 of 279) and release readiness
stays absent: eleven EXT gates and three internal controls are open, seventeen P1 items are open, two
dependency advisories are contained rather than closed, no phase since Phase 05 has been accepted,
and Phases 21 to 23 have not run.

---

## 1. Repository

| Field | Value |
| --- | --- |
| Path | `/Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb` |
| Branch | `claude/prsystem-phases-06-23-d506eb` |
| Base | fast-forwarded from `claude/mvp-implementation` at `818bd12db6fdc557bb6908b773ed359465c6ce71` (Phase 05 acceptance) |
| Phases 06–18 | as recorded in the Phase 19 checkpoint and in `phase-status.md`; unchanged |
| Phase 19 commits | implementation `e913a9aec886c224dacf24b25892f73bf8e3e115` (the measured tree), record `7711f40` |
| Phase 20 commits | implementation `ccbf60272d9f1c05fb298a9c25f2ad3270f96d07`, correction `361b116b9c1e6901dd6c9506ff1050ff267926a7` (the measured tree) |
| Phase 20 record commit | the commit that carries this checkpoint (see `git log -1`) |

**Where the work lives, and why.** Unchanged since the Phase 06 checkpoint: the work is on this
worktree's branch. The main checkout at `/Users/zorigtgantumur/Documents/Work/prsystem` still holds
`claude/mvp-implementation` at `818bd12` with the superseded uncommitted Phase 06 draft and the
untracked Phase 03 checkpoint; it was not modified. This worktree also carries an untracked copy of
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Reconciling the
two checkouts is the customer's call and was not performed. No push, merge, rebase, reset, stash,
clean or deploy has been performed anywhere.

## 2. Governed state

Declared in [`tools/programme-state.mjs`](../../tools/programme-state.mjs): Phases 03, 04 and 05
`DONE` and `ACCEPTED`; Phases 06 to 20 `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`, each an entry of
`PROGRESSED_PHASES` with its own evidence manifest; **Phase 21 — Responsive UI and accessibility —
`NOT STARTED`, authorized to begin.** The standing progression authorization of 2026-09-03 is
unchanged: implementation authorization for Phases 06–23, sequential; not acceptance, not release
approval, no gate weakened. Governance check 17 holds each manifest, governed entry and record to one
another; check 14 holds the runbook's `GATE-SEC` catalogue to its twenty sub-gates.

## 3. What Phase 20 delivered

See the [Phase 20 record](phase-status.md#phase-20-record) and
[external-integration-gates.md](external-integration-gates.md) §6, which records per adapter slot
what exists, why it stays disabled and what would enable it.

- **The gate register is code** (`packages/ports/src/gates.ts`), held to the document by a unit
  test and to `platform.external_gate` by `SEC-SECRETS`; the type refuses `cleared: true` without an
  artefact. Clearing a gate is three reviewed changes, never one.
- **Adapter selection fails closed by configuration.** `ADAPTER_<SLOT>` per slot; `selectAdapters`
  refuses a simulator above test, a production adapter behind a `BLOCKED` gate and an adapter nobody
  wrote — at parse time, in the API before a port is bound, in the worker before Redis. The storage
  credential is required exactly when `ADAPTER_STORAGE=s3`, refused otherwise, and is a `Secret`.
- **Adapter infrastructure without a contract:** outbound HTTP with timeout and token bucket, the
  `Secret` wrapper, signature primitives, CIDR allowlisting as a guard on the four provider callback
  routes (`CALLBACK_ALLOWLIST_<PROVIDER>`; unconfigured means refused at and above staging).
- **The one standards-based adapter:** S3-compatible object storage over SigV4, verified against the
  three AWS-published vectors and against the compose stack's MinIO; disabled in production behind
  `INT-STORAGE-01`. Every contract-bound adapter refused rather than invented, each with its reason.
- **The Phase 14 provider jobs on the worker**, scheduled only when their adapters can run, and
  `DISABLED` treated as no decision by both the refund executor and the payout runner.
- **`SEC-ADAPTERS`**, the twentieth `GATE-SEC` sub-gate: production defaults answer `DISABLED` on
  every operation of every port with no network call; no simulator or uncleared adapter can be named
  in production; the credential escapes into nothing.
- **`DSR-01`'s mandatory Phase 20 review**: no dependency added, path unchanged, still contained.

Traceability v1.33 (no decision changes state; six Phase 20 obligation rows); assumptions
`A-P20-1`…`A-P20-9`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| `@prsystem/ports` unit / integration (MinIO) / `sec-adapters` | 102 / 3 / 6 |
| `@prsystem/config` unit | 49 |
| api `test:unit` / `test:integration` / `test:concurrency` / `src/security` | 346 / 562 / 81 / 43 |
| worker `test:unit` / `startup` (security) / `onboarding.e2e` | 26 / 9 / 2 |
| `@prsystem/db` `test:security` | 2,497 |
| `pnpm run lint` / `typecheck` / `format:check` / `openapi` | exit 0 |
| the eight governance validators on the final tree | all exit 0; governance 17/17, drift fixtures 325/325 |

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once. Every count above is from a serial run.

**The governed battery** ran twice. On the implementation commit `ccbf602`, three of 28 executions
exited 1 — the secret scanner, its fixture control and `test:security` at that same step, before
`GATE-SEC` ran — for the one cause the record describes. On the correction commit `361b116`, in a
clean detached checkout with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a
preparatory `pnpm run build`, **all 28 executions exited 0**: unit 1,671 across 11 projects;
migrations 148; integration 613 (ports 3, outbox 5, db 41, worker 2, api 562); concurrency 97 ×3;
regression 51; `GATE-SEC` 20/20 ×3; e2e 15; `audit:prod` clean; `audit:tree` three moderate
(`DSR-01`, `DSR-02`, unchanged). Exit codes and durations are in
[`phase-20-battery-log.md`](phase-20-battery-log.md), results in
[`phase-20-evidence.json`](phase-20-evidence.json), restated in the Phase 20 record.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 19 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- **Every Operation, Hotel, Guest, Restaurant and Police screen is Phase 21's**, and every API they
  need exists: the Phase 16 moderation queue, the Phase 19 dashboard, SMS tab and contact change, the
  Phase 18 account-provisioning surface (doc 13 §5.1), and the Restaurant Manager invitation
  (`A-P15-2`). Phase 21's own gates are Playwright per-portal flows at three viewports, an
  accessibility scan on every primary screen, and an architecture test that web packages import only
  `contracts` types.
- **Phase 22 inherits the unscheduled domain sweeps** — the Phase 13 hold expiry, the Phase 15 invoice
  expiry and refund SLA, the Phase 18 Police sweeps (`A-P20-9`) — and the decision whether the SMS
  delivery-status refresh may run on the worker at all, which means widening a runtime role
  (`A-P20-5`). Also `A-P14-11` (the overdue-conflict `CANCELLED_HOTEL` resolution), the `DSR-01` and
  `DSR-02` reviews, and the P1-10 non-functional measurements.
- **Two Operation surfaces still need a doc 18 §5 row** — the commission contract and the payable
  review (`A-P14-1`, `A-P19-11`). A requirement decision, not an implementation gap.
- **Clearing any gate** is now: the artefact recorded in `external-integration-gates.md`, the entry
  flipped in `gates.ts` with the artefact and date, a migration setting the seeded row, the adapter
  written and run through the conformance suite and a sandbox, and `ADAPTER_<SLOT>` set. Phase 23's
  gate review will find every one still `BLOCKED` unless the customer supplies what §6 names.

Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** Both Phase 20 battery checkouts were removed after their
  runs, and the Phase 14 one was removed with them; `git worktree list` shows the main checkout, this
  worktree and the earlier task-owned detached checkouts `battery-wt-08b` through `battery-wt-13`
  under the session scratchpad — all safe to remove with `git worktree remove --force`.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379, MinIO 59000, Mailpit 51025). `docker-compose.yml` fixes
  that project name; the migration suite's schema dump resolves its container through `docker
  compose ps -q postgres` from the checkout root; Turborepo passes only `DATABASE_URL` to a task. The
  ports integration suite reaches MinIO at `OBJECT_STORAGE_ENDPOINT_TEST` or `127.0.0.1:59000` with
  the compose file's local credentials and a bucket of its own. The disposable project `prsystem-p06`
  and its volumes are still present and unused. Local development credentials only, kept in the
  session scratchpad (`env.sh`) and deliberately not reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01` … `EXT-11`, `INT-OTP-01`, `INT-MAIL-01`, `INT-STORAGE-01`
  (BLOCKED; §6 of the register says per slot what would clear each), 17 P1 configuration items, and
  selecting `GATE-SEC` as a required GitHub status check.
- **`.env.example` now sets `ADAPTER_STORAGE=s3` for local development**, so a local export writes
  to the compose stack's MinIO for real; every other slot defaults to the simulator below production
  and to `disabled` at it. A production deployment must set nothing to hold nothing.
- **`DSR-01` reviewed and still contained; `DSR-02` unchanged**; both due in Phase 22.
- **Three Police items are still recorded for the customer's attention**: the full registration
  number in a Match SMS, the all-hotel check-in list, and the four-digit bootstrap exception.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 21 — Responsive UI and accessibility — is the current phase and is authorized to begin under
the standing authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md`
(current position, ledger, the Phase 19 and 20 records), `build-plan.md` §"Phase 21", and the portal
requirement documents the build plan assigns. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 21/,/^### Phase 22/p' docs/implementation/build-plan.md \
  && ls apps/
```

Begin from what exists: the five portal applications scaffolded in Phase 02 (`apps/`), the OpenAPI
document `pnpm run openapi` generates, and the `contracts` package — the only thing a web package
may import. Phase 21 owns no DEC ID either; its scope is the portals wired to real APIs with
server-enforced navigation, Mongolian copy taken from the requirement documents rather than written,
and accessibility measured by a scan rather than asserted. No business rule may move into web code
(CLAUDE.md §3), and UI hiding is never authorization (§4).
