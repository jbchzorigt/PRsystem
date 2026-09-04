# Autonomous checkpoint — Phase 09 complete, Phase 10 authorized and not started

**Written:** 2026-09-04, at the close of Phase 09 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 09 needed one commit.** The implementation landed at `4063ac5` and the governed battery ran
against it in full, every execution exiting 0 on its first attempt. Phase 08 before it took two
commits: its implementation `621e17d` failed the concurrency gate on a booking commitment read as an
instant rather than an interval, and `5b3603a` corrected it and was re-measured. Implementation
completion is not customer acceptance and not release approval.

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
| Phase 09 implementation commit | `4063ac530ee536bb2cda5c27a1cb2526d22a660a` (the measured tree) |
| Phase 09 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 09 — Cleaner and checkout coordination | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 10 — Folio, deposit, payment, and correction | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 09 are the entries of
`PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and record to one
another.

## 3. What Phases 08 and 09 delivered

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

Phase 09 (see the [Phase 09 record](phase-status.md#phase-09-record)): migration
`0010_cleaner_checkout` (nine tenant tables — the Cleaner's cleaning task, the minibar usage report
with its append-only versions, priced lines and counted movements, the guest's dispute, the payment
attempt's lock, the append-only post-settlement adjustment and the active-stay refill task — and the
stay guard replaced with one backward edge so a checkout can be called off); the checkout, report,
dispute, payment-lock, refill and cleaning-task services in the stay module; `PaymentAttemptsPort`
with its unprovisioned default and simulator; the minibar contract's four checkout methods and the
named non-guest stock-out action; four controllers and 22 paths; four test suites (10 unit, 12
integration, 3 concurrency, 3 HTTP); traceability rows for its 18 decisions (136 of 279 `COVERED`);
assumptions `A-P09-1`…`A-P09-13`; the governance entries for the Phase 09 manifest.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, disposable Compose project `prsystem-p06`).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 09 `domain/checkout` unit suite | 10 passed |
| `checkout.integration` / `checkout.concurrency` | 12 / 3 passed |
| `stay.integration` + `stay.authorization.http` | 23 + 10 passed |
| api `test:integration` / `test:concurrency` (every module) | 332 / 37 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,398 / 88 / 41 / 16 / 51 |
| api `test:unit` (163), `turbo run lint typecheck` forced (45 tasks), `openapi` (22 new paths), `prettier --check .` | exit 0 |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 189 of 189 |

**The governed battery** ran in a clean detached checkout of the Phase 09 implementation commit
`4063ac5` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true` (no cached task
replay), after a preparatory `pnpm run build`. All 28 executions exited 0, each on its first attempt
(07:53–08:02 UTC): unit 1,414; migrations 148; integration 380; concurrency 53 ×3; regression 51;
GATE-SEC 19 of 19 ×3; e2e 15. Exit codes and durations are in
[`phase-09-battery-log.md`](phase-09-battery-log.md), results in
[`phase-09-evidence.json`](phase-09-evidence.json), restated in the Phase 09 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03/04/05/06/07 batteries and the
Phase 05 CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- Phase 10: `platform.stay_folio` (`room_id`, `stay_id`, the unsettled predicate) and
  `platform.payment_attempt` with an implementation of `PaymentAttemptsPort`; the deposit amount
  (`A-P06-2`); the stay completes through `StayService.recordActualCheckout` once the folio is
  settled, beside the minibar report Phase 09 already settles.
- Phase 11: the cash count, handover and review on `reception_shift`, keeping the open-shift bound.
- Phase 13: `ConfirmedBookingsPort`, `platform.booking` (`assigned_room_id`, `category_id`),
  `ConflictService.detect`, the assignment application and the refund obligation on
  `stay.conflict.resolved` / `CANCELLED_HOTEL`; `captureRateSnapshot` for `ONLINE_BOOKING`; and the
  online side of `stay.minibar_report_settled`.
- Phase 17: guest identity corrections as new `stay_guest` revisions; the registry reads the latest
  effective actual start; the settled report and its adjustments feed the hotel's financial
  reporting.
- Phase 18: `stay.checked_in` (token, never the number) and `stay.actual_time_corrected`.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`;
  both registries are held to the live schema by tests.

## 7. Processes, containers and services

- **No task-owned process is running.** `git worktree list` shows the main checkout, this worktree
  and two task-owned detached checkouts the batteries ran in — `scratchpad/battery-wt-08b` at
  `5b3603a` and `scratchpad/battery-wt-09` at `4063ac5` — both safe to remove with
  `git worktree remove --force`. The failed first Phase 08 battery's worktree was removed after its
  account was transcribed; its summary, metadata and failing log are kept in
  `scratchpad/failed-battery-08/`.
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
  contract, field list and legal basis. Phase 09 adds no external gate: the payment provider whose
  answer may release a locked report is Phase 10's, and until that module exists the contract
  answers `UNKNOWN`, which holds the lock. No customer decision is pending on either phase's scope;
  `A-P08-1` (the shift's owner, Phase 11's to tighten), `A-P08-11` (self-approval of a
  higher-category remedy) and `A-P09-1` (the checkout start under the existing checkout action) are
  recorded for attention. Their acceptance, like Phases 06 and 07, is the customer's to give.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

Phase 10 — Folio, deposit, payment, and correction — is the current phase and is authorized to begin
under the standing authorization. Before editing: reread `CLAUDE.md`, this checkpoint,
`phase-status.md` (current position, ledger, the Phase 08 and 09 records), `build-plan.md`
§"Phase 10", and the requirement files that phase assigns (doc 20, doc 02 §§3.4–3.9, doc 11, doc 24
§§1–4, doc 18 §3); list its owned DEC IDs from `requirements-traceability.md` §2 ("Phase load") and
the family tables. Then verify `git status` matches §4 and begin with the schema, creating
`platform.stay_folio` and `platform.payment_attempt` in the shapes the registries and
`PaymentAttemptsPort` predict — the folio's `room_id`, `stay_id` and unsettled predicate are already
named by `CHECKOUT_OBLIGATION_SOURCES` and the minibar safe-point registry — and implementing
`PaymentAttemptsPort` against the real attempt so a locked minibar report is released, settled or
held by what the provider actually says.
