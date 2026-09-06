# Autonomous checkpoint — Phase 17 complete, Phase 18 authorized

**Written:** 2026-09-06, at the close of Phase 17 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 17 needed one commit.** Its governed battery passed on the implementation commit at the
first attempt, all 28 executions exiting 0 — as Phases 09 to 12, 14 and 15 did. Phases 08, 13 and 16
each needed a correction first. Implementation completion is not customer acceptance and not release
approval.

---

## 1. Repository

| Field | Value |
| --- | --- |
| Path | `/Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb` |
| Branch | `claude/prsystem-phases-06-23-d506eb` |
| Base | fast-forwarded from `claude/mvp-implementation` at `818bd12db6fdc557bb6908b773ed359465c6ce71` (Phase 05 acceptance) |
| Phase 06 commits | `a44fd58e59966ad293278cd3aace5f629141ea98`, `dcca709ded1be4bf33c25b4d1ca37b4da647dbd7`, then its record commit |
| Phase 07 commits | `1d2c764fab47adb49f9e2e6dd8346fca3a28e5ff`, `0b408205cd337aec26c70c7607a8e68b3aedbac2`, record `879b5e1` |
| Phase 08 commits | implementation `621e17db9d40523c545e35c0d72b2b814508a874`, correction `5b3603ab6bf5b2baa1099f4d239e5a0b397f5ec1` (the measured tree), record `d480bf4` |
| Phase 09 commits | implementation `4063ac530ee536bb2cda5c27a1cb2526d22a660a` (the measured tree), record `11ca271` |
| Phase 10 commits | implementation `1ac4656cfd47be97785a4a990604b73b0c4ff872` (the measured tree), record `c3fd42e` |
| Phase 11 commits | implementation `92bceaf8a25f74d82797ae207e61ad86ef6ce3c1` (the measured tree), record `dcd6395` |
| Phase 12 commits | implementation `713e101bee3c0f9e86139a523ed789ef4be044f5` (the measured tree), record `affb63c` |
| Phase 13 commits | implementation `4768ec189a28c702689226eaf42ff76e8cbdd41f`, correction `5d51fa9d0956e194c27614249829bd62c04581a8` (the measured tree), record `bd9e24c` |
| Phase 14 commits | implementation `e9f11ad325d5ea218150abbdfb64b070dc89b811` (the measured tree), record `44c2aff` |
| Phase 15 commits | implementation `ff121ef641ac36d5087ec9cd3823bbe8056e71c3` (the measured tree), record `ab1640c` |
| Phase 16 commits | implementation `d5cf786d4c52de1e1e076a840bf00bc08709d232`, correction `fbb498bd4e832e868fbeaa4ae8d39a9523612cfb` (the measured tree), record `65f6e75` |
| Phase 17 commits | implementation `e2b7bf8f4dc637d6c214ca9a59caf872a0927549` (the measured tree) |
| Phase 17 record commit | the commit that carries this checkpoint (see `git log -1`) |

**Where the work lives, and why.** Unchanged since the Phase 06 checkpoint: the work is on this
worktree's branch. The main checkout at `/Users/zorigtgantumur/Documents/Work/prsystem` still holds
`claude/mvp-implementation` at `818bd12` with the superseded uncommitted Phase 06 draft and the
untracked Phase 03 checkpoint; it was not modified. This worktree also carries an untracked copy of
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Reconciling the
two checkouts is the customer's call and was not performed. No push, merge, rebase, reset, stash,
clean or deploy has been performed anywhere.

## 2. Governed state

Declared in [`tools/programme-state.mjs`](../../tools/programme-state.mjs):

| Phase | State | Acceptance |
| --- | --- | --- |
| 03 — Platform kernel | `DONE` | `ACCEPTED` at `3ac74a6…` |
| 04 — IAM, tenancy, RBAC, staff lifecycle | `DONE` | `ACCEPTED` at `e5fcf19…` |
| 05 — Hotel onboarding and subscription | `DONE` | `ACCEPTED` at `35314ba…` |
| 06 — Hotel, room, category, and tariffs | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 07 — Minibar inventory and templates | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 08 — Availability, guest identity, reception, and stay | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 09 — Cleaner and checkout coordination | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 10 — Folio, deposit, payment, and correction | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 11 — Shift, cash drawer, expense, and hotel finance | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 12 — Public discovery and Guest authentication | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 13 — Online booking and inventory hold | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 14 — Online payment, refund, commission, and settlement | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 15 — Restaurant | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 16 — Verified reviews | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 17 — Guest registry, exports, and Hotel Admin reports | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 18 — Police monitoring | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 17
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 17 delivered

See the [Phase 17 record](phase-status.md#phase-17-record). Migration `0018_registry_reporting` adds
six tables and four columns on `platform.expense`, and holds most of the phase's rules in the
database rather than in application code.

**A file lives an hour; a link lives five minutes.** Both are CHECK-derived on different tables, and
issuing a link writes only to the grant table — so re-issuing one cannot extend the file, which is
the gate the build plan names (`GUEST-DEC-007`).

**An export cannot be partial.** The row count and the job creation are one transaction under a
ten-thousand-row cap the database also carries, and the refusal names the cap so a caller narrows
the filter rather than retrying (`GUEST-DEC-006`).

**The registry reads the effective check-in.** The latest approved time correction is coalesced over
the recorded check-in inside the read, so a correction changes the next read and never rewrites an
export already taken (`FIN-DEC-009`, `A-P17-1`).

**An anonymised guest row says what it is.** Clearing the identifiers moves the identity type to
`NO_DOCUMENT`, the assurance to `LOW_ASSURANCE` and the Police eligibility to
`NOT_ELIGIBLE_EXACT_RD`, because doc 05 §3 ties an identity type to the ciphertext that proves it.
Phase 08's append-only guard was extended to permit exactly that one shape (`A-P17-7`).

**Each export kind carries its own permission.** doc 18 §3 gives the registry export, the room Excel
and the minibar Excel separate rows with different packages, so the download resolves the job's kind
before authorizing and the job list returns only the kinds the caller could have asked for
(`A-P17-10`).

Unlike Phase 16, this phase **does** run in the worker: three queues build the queued exports,
expire the lapsed files and purge the due stays, each calling the very service method the API
exposes, on a login that can run an export job and cannot create one (`A-P17-8`). Traceability v1.30
(nineteen decisions; 240 of 279 `COVERED`); assumptions `A-P17-1`…`A-P17-12`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 17 `reporting/domain/reporting` unit suite | 26 passed |
| `reporting.integration` / `reporting.concurrency` / `reporting.security` / `reporting.http` | 22 / 6 / 8 / 11 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 309 / 121 / 510 / 70 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 2,416 / 88 / 41 / 16 / 51 |
| worker `test:unit` / `test:integration` / `test:security` | 18 / 2 / 8 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| the eight governance validators on the final tree | all exit 0; governance 17/17, drift fixtures 289/289 |

**One regression was found by a development-time run and fixed before the battery.** Migration 0018
makes `expense_type` NOT NULL on `platform.expense`, and Phase 11's expense command did not write
it, so two finance suites failed. The fix is the classification contract described in `A-P17-11`:
the finance module asks the reporting module for a category's kind rather than reading its table,
writes the resulting `expense_type`, and a trigger refuses any row whose type disagrees with its
category.

**The governed battery** ran in a clean detached checkout of the Phase 17 implementation commit
`e2b7bf8` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. **All 28 executions exited 0 on the first attempt.** Exit codes and durations are
in [`phase-17-battery-log.md`](phase-17-battery-log.md), results in
[`phase-17-evidence.json`](phase-17-evidence.json), restated in the Phase 17 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once: the db security suite creates and drops databases and roles the api
suites are using, which produces `permission denied for schema platform` in unrelated suites. Every
count above is from a serial run.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 16 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 17 discharged what the last checkpoint named of it.** The hotel's financial reporting keeps
restaurant money out (doc 08 §13) and reviews carry no money at all, and `RC-DEC-032` — the guest
registry columns — is closed.

- **Phase 18**: `stay.checked_in` and `stay.actual_time_corrected` are unchanged by this phase. What
  is new for it is the retention purge: an anonymised stay is marked `NOT_ELIGIBLE_EXACT_RD`, so
  Police matching over a purged stay finds no registration number to match, which is intended and
  should be asserted rather than assumed when Phase 18 lands (`A-P17-7`).
- **Phase 19 (Platform Operation)** carries the same four open items, unchanged: an Operation
  surface for administering a commission contract and one for reviewing a `HELD` or
  `ADJUSTMENT_DUE` payable (both `A-P14-1`); the Restaurant Manager invitation flow, which is Phase
  04's existing `hotel.restaurant.manager_invite` (`A-P15-2`); and the Operation screens for the
  Phase 16 moderation queue, whose API exists and whose portal does not.
- **Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
  `CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling on
  the worker's queues the two settlement jobs, the Phase 13 expiry sweep and Phase 15's
  invoice-expiry and refund-SLA sweeps — five services with tests and no scheduler entry yet. Phase
  17 **removes nothing from that list and adds nothing to it**: it wired its own three sweeps
  (`reporting.export.run`, `reporting.export.expiry`, `reporting.retention.purge`) into the worker
  deployment, which is the pattern the five outstanding ones still need.
- **A production gate now has a port label.** S3-compatible object storage is `INT-STORAGE-01`,
  owned by Phase 20: the typed port and its simulator exist, and the production adapter answers
  `DISABLED`, so an export in production fails closed until that gate is discharged.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 17 battery checkout was removed after its run, so
  `git worktree list` shows the main checkout, this worktree and the earlier task-owned detached
  checkouts (`battery-wt-08b` through `battery-wt-14`) — all safe to remove with `git worktree
  remove --force`.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379). `docker-compose.yml` fixes that project name, and the
  migration suite's schema dump resolves its container through `docker compose ps -q postgres` from
  the checkout root; Turborepo passes only `DATABASE_URL` to a task, so an override naming another
  container never reaches the test process. The cluster the suites create scratch databases in and
  the cluster the dump reads from must therefore be the same one — and, as §5 records, two suites
  must not be run against it at once. The disposable project `prsystem-p06` and its volumes are
  still present and unused; they are safe to keep or remove. Local development credentials only,
  kept in the session scratchpad (`env.sh`) and deliberately not reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01`, `EXT-02`, `EXT-03`, `EXT-04`, `EXT-06`, `EXT-07`, `EXT-11`
  (BLOCKED, conformance-gated simulators), `INT-OTP-01`, `INT-MAIL-01`, the Phase 19 offline
  verification surface, 17 P1 configuration items, `DSR-01`, and selecting `GATE-SEC` as a required
  GitHub status check.
- **`EXT-08` (personal data) is first touched by this phase and stays BLOCKED.** Retention is
  implemented as versioned configuration with a per-stay snapshot and legal hold, and the MVP
  default is 365 days from the recorded checkout. The privacy notice, the consent, the controller
  and processor roles, the transfer conditions and the breach procedure remain absent; a written
  legal or ЦЕГ policy overrides the default through a new configuration version, not a code change.
- **`INT-STORAGE-01` is registered as a non-EXT production gate owned by Phase 20.** No bucket,
  credential or bucket policy is approved, so the production object-storage adapter is disabled and
  an export outside local, CI and test fails closed with a recorded reason.
- **One item is recorded for the customer's attention.** An anonymised guest row keeps its stay and
  its dates and loses its identity — names become `Устгасан`, the date of birth becomes
  `1900-01-01`, and every identifier column is cleared. That is irreversible by design, and the only
  thing standing between a stay and it is the legal hold (`A-P17-7`, `GUEST-DEC-008`).
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 18 — Police monitoring — is the current phase and is authorized to begin under the standing
authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md` (current
position, ledger, the Phase 16 and 17 records), `build-plan.md` §"Phase 18", and the requirement
files that phase assigns; list its owned DEC IDs from `requirements-traceability.md` §2 and the
family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 18/,/^### Phase 19/p' docs/implementation/build-plan.md
```

Begin from the isolation gate, not from the matching. doc 13's hardest requirement is that no
hotel-facing response, error text or timing may differ according to whether a Match exists — a
property of the whole check-in path, not of the Police module — and the two-person approval,
requester ≠ approver, is a backend rule that cannot be added afterwards. Establish those two before
any Wanted table is written.
