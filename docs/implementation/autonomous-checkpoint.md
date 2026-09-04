# Autonomous checkpoint — Phase 08 complete, Phase 09 authorized and not started

**Written:** 2026-09-04, at the close of Phase 08 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 08 needed two commits.** The implementation landed at `621e17d`, and the governed battery
against it **failed**: its second `test:concurrency` execution let a walk-in and an overdue-conflict
assignment both take one room, because a booking commitment was read as a point in time (its start)
rather than as an interval, so a booking that had already started and was still awaited was
invisible. That battery is not evidence and none of its counts are used. `5b3603a` reads a
commitment as the interval `[planned_checkin_at, planned_checkout_at)` — stored on the conflict row,
immutable with the facts it was opened on — and the battery was run again, in full, on that commit.
Implementation completion is not customer acceptance and not release approval.

---

## 1. Repository

| Field | Value |
| --- | --- |
| Path | `/Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb` |
| Branch | `claude/prsystem-phases-06-23-d506eb` |
| Base | fast-forwarded from `claude/mvp-implementation` at `818bd12db6fdc557bb6908b773ed359465c6ce71` (Phase 05 acceptance) |
| Phase 06 commits | `a44fd58e59966ad293278cd3aace5f629141ea98`, `dcca709ded1be4bf33c25b4d1ca37b4da647dbd7`, then its record commit |
| Phase 07 commits | `1d2c764fab47adb49f9e2e6dd8346fca3a28e5ff`, `0b408205cd337aec26c70c7607a8e68b3aedbac2`, record `879b5e1` |
| Phase 08 commits | implementation `621e17db9d40523c545e35c0d72b2b814508a874`, correction `5b3603ab6bf5b2baa1099f4d239e5a0b397f5ec1` (the measured tree) |
| Phase 08 record commit | the commit that carries this checkpoint (see `git log -1`) |

**Where the work lives, and why.** Unchanged from the Phase 06 checkpoint: the work is on this
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
| 09 — Cleaner and checkout coordination | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06, 07 and
08 are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry
and record to one another.

## 3. What Phase 08 delivered

See the [Phase 08 record](phase-status.md#phase-08-record). In short: migration
`0009_stay_reception` (ten tenant tables: the minimal Reception shift, the cleaning axis and its
append-only history, the stay with write-once times and a forward-only state held by trigger, the
guest's append-only revisions with the encrypted identifier and keyed token, the price book, the
actual-time correction, the overdue conflict, the stay history); the stay module under
`apps/api/src/modules/stay/` (shift, cleaning state, quote and check-in with the server-bounded
backdate and historical readiness proof, XYP through the EXT-01 port with `MANUAL` fallback,
tariff snapshot, price book and override consumption, the Police-minimal outbox event; room board
and stay view; actual checkout with the needs-cleaning, scheduled-change and lifecycle hand-offs;
correction request and decision with `self_approved`; conflict detection contract and its four
remedies; five controllers, 30 paths); `XypIdentityPort` in `@prsystem/ports`; six test suites
(23 unit, 23 integration, 7 HTTP, 4 concurrency); traceability rows for the 19 owned decisions
(118 of 279 `COVERED`); assumptions `A-P08-1`…`A-P08-13`; the EXT-01 status note; the governance
changes for the Phase 08 manifest.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

**What the correction commit changed:** `packages/db/migrations/0009_stay_reception.sql`
(`planned_checkout_at` and `booking_fulfillment_conflict_interval` on the conflict, immutable in the
guard), `packages/db/src/schema.ts`, `packages/db/src/schema-snapshot.ts` (that table's entries
regenerated from a live migrated database; the comparator and the shipped-snapshot gate hold them),
`packages/db/src/test-support/tenant-rows.ts`, and in the stay module
`contracts/confirmed-bookings.ts` (`nextForRoom` → `commitmentsForRoom`),
`repositories/conflict.repository.ts`, `services/check-in.service.ts`, `services/conflict.service.ts`,
`services/correction.service.ts`, with two integration cases proving both sides of the boundary.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, disposable Compose project `prsystem-p06`).** All exit 0:

| Command | Result |
| --- | --- |
| stay domain unit suites | 23 passed |
| `stay.integration` + `stay.authorization.http` | 30 passed (23 + 7) |
| `stay.concurrency` | 4 passed, three consecutive runs on the correction |
| api `test:integration` / `test:concurrency` (every module, after the catalog and minibar suites learned the stay relation exists) | 317 / 34 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,231 / 88 / 41 / 16 / 51 |
| `@prsystem/ports` `test:unit` | 51 |
| api `test:unit` (153), `turbo run lint typecheck` forced (45 tasks), `openapi` (30 new paths), `prettier --check .` | exit 0 |
| `validate-governance` 17/17, `validate-regression-coverage` 724/724, `validate-pool-error-fixture` 12/12, `scan-secrets` 0 findings, `validate-workspace` 15/15 | on the implementation tree |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 176 of 176 |

Every row above was measured again on the correction tree, except `@prsystem/ports` `test:unit` and
api `test:unit`, which the correction does not touch and which the battery's own `test:unit` (1,404
across 11 projects) covers.

**The governed battery** ran twice. The first, on the implementation commit `621e17d`, **failed** —
`pnpm run test:concurrency` run 2 reported `expected [ true, true ] to have length 1`; its summary,
metadata and failing log are kept outside the repository in the session scratchpad
(`failed-battery-08/`), and nothing was generated from it. The second ran in a clean detached
checkout of the correction commit `5b3603a` with a fresh install, a fresh `TURBO_CACHE_DIR` and
`TURBO_FORCE=true` (no cached task replay), after a preparatory `pnpm run build`. All 28 executions
exited 0 (06:46–06:58 UTC, plus one `audit:prod` re-execution after the npm registry's audit
endpoint timed out before any audit ran): unit 1,404; migrations 148; integration 365; concurrency
50 ×3; regression 51; GATE-SEC 19 of 19 ×3; e2e 15. Exit codes and durations are in
[`phase-08-battery-log.md`](phase-08-battery-log.md), results in
[`phase-08-evidence.json`](phase-08-evidence.json), restated in the Phase 08 record. The two
governance rows there — 17 of 17 and 176 of 176 — are from the final tree, which is the only tree
that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03/04/05/06/07 batteries and the
Phase 05 CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- Phase 09: `platform.cleaning_task` (`room_id`), `platform.minibar_usage_report` (`room_id`,
  `stay_id`) and `platform.minibar_refill_task` (`room_id`, `product_id`) in the shapes the
  registries and `CHECKOUT_OBLIGATION_SOURCES` name; the Cleaner's tasks drive
  `HousekeepingService`; the checkout start moves a stay to `CHECKOUT_IN_PROGRESS`;
  `GUEST_CONSUMPTION` posts through `InventoryRepository.appendMovement`.
- Phase 10: `platform.stay_folio` (`room_id`, `stay_id`); the deposit amount (`A-P06-2`); the stay
  completes through `StayService.recordActualCheckout` once the folio is settled.
- Phase 11: the cash count, handover and review on `reception_shift`, keeping the open-shift bound.
- Phase 13: `ConfirmedBookingsPort`, `platform.booking` (`assigned_room_id`, `category_id`),
  `ConflictService.detect`, the assignment application and the refund obligation on
  `stay.conflict.resolved` / `CANCELLED_HOTEL`; `captureRateSnapshot` for `ONLINE_BOOKING`.
- Phase 17: guest identity corrections as new `stay_guest` revisions; the registry reads the
  latest effective actual start.
- Phase 18: `stay.checked_in` (token, never the number) and `stay.actual_time_corrected`.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`;
  both registries are held to the live schema by tests.

## 7. Processes, containers and services

- **No task-owned process is running.** The first battery's worktree was removed through
  `git worktree remove --force` after its failure account was transcribed into §5 and its summary,
  metadata and failing log were copied aside; `git worktree list` shows the main checkout, this
  worktree and `scratchpad/battery-wt-08b`, the detached checkout of `5b3603a` the passing battery
  ran in, which is task-owned and safe to remove.
- **Task-owned containers — disposable, safe to keep or remove:** Compose project `prsystem-p06`
  (Postgres 127.0.0.1:55742, Redis 56679, MinIO 59300/59301, Mailpit 51325/58325) and its volumes.
  Every database test above ran there; scratch databases are named `prsystem_test_*` and dropped by
  their suites.
- **Shared services that must not be touched:** the Compose project `prsystem` (Postgres 55442 and
  the rest) and its volumes; the unrelated `piston`, `hotel-platform-postgres`,
  `hotel-platform-redis` containers.
- **Environment for the disposable runs:** `DATABASE_URL`, `REDIS_URL_TEST`, `COMPOSE_PROJECT_NAME`
  and `PRSYSTEM_POSTGRES_CONTAINER` pointing at the `prsystem-p06` project; local development
  credentials only, kept in the session scratchpad (`env.sh`) and deliberately not reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-03`, `EXT-04`, `EXT-11` (BLOCKED, conformance-gated simulators),
  `INT-OTP-01`, `INT-MAIL-01`, the Phase 19 offline verification surface, 17 P1 configuration items,
  `DSR-01`, and selecting `GATE-SEC` as a required GitHub status check.
- Phase 08 introduced the EXT-01 port and simulator; the gate itself stays BLOCKED for its
  contract, field list and legal basis. No customer decision is pending on this phase's scope;
  `A-P08-1` (the shift's owner, Phase 11's to tighten) and `A-P08-11` (self-approval of a
  higher-category remedy) are recorded for attention. Its acceptance, like Phases 06 and 07, is
  the customer's to give.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

Phase 09 — Cleaner and checkout coordination — is the current phase and is authorized to begin
under the standing authorization. Before editing: reread `CLAUDE.md`, this checkpoint,
`phase-status.md` (current position, ledger, the Phase 07 and 08 records), `build-plan.md`
§"Phase 09", and the requirement files that phase assigns (doc 04, doc 21, doc 22 §6, doc 25
§§5–8, doc 02 §§3.2–3.3, doc 18 §3); list its 18 owned DEC IDs from `requirements-traceability.md`
§2 ("Phase load") and the family tables. Then verify `git status` matches §4 and begin with the
schema, creating the relations the registries and `CHECKOUT_OBLIGATION_SOURCES` predict
(`platform.cleaning_task`, `platform.minibar_usage_report`, `platform.minibar_refill_task`) in the
named shapes or updating the entries in the same change, driving `HousekeepingService` from the
Cleaner's tasks, and moving a stay to `CHECKOUT_IN_PROGRESS` where §6 says.
