# Autonomous checkpoint — Phase 11 complete, Phase 12 authorized and not started

**Written:** 2026-09-04, at the close of Phase 11 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 11 needed one implementation commit.** Its governed battery passed on that commit; two of
the 25 executions were earlier attempts of `pnpm run audit:tree` that the npm registry refused
before any audit ran, and the third answered. Phases 09 and 10 before it each needed one commit
too. Phase 08 took two: its implementation `621e17d` failed the concurrency gate on a booking
commitment read as an instant rather than an interval, and `5b3603a` corrected it and was
re-measured. Implementation completion is not customer acceptance and not release approval.

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
| Phase 11 implementation commit | `92bceaf8a25f74d82797ae207e61ad86ef6ce3c1` (the measured tree) |
| Phase 11 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 10 — Folio, deposit, payment, and correction | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 11 — Shift, cash drawer, expense, and hotel finance | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 12 — Public discovery and Guest authentication | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 11
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 11 delivered

See the [Phase 11 record](phase-status.md#phase-11-record). Migration `0012_shift_cash_expense`
extends `cash_location` (Phase 05) and `reception_shift` (Phase 08) rather than building beside
them, and adds the typed append-only `cash_movement`, `cash_transfer`, `cash_request` and `expense`.
The shift grows from open/close into doc 03's lifecycle — count, handover, recount, acceptance,
close, self-close, and the Manager's and Hotel Admin's separately permissioned reviews. The new
finance module owns the locations, the ledger, the transfers, the bank-deposit and withdrawal
approvals and the expense lifecycle. Three contracts keep the modules one-way: `CashLedgerPort`
(stay → finance), `ShiftLookupPort` (finance → stay) and `CashPostingsPort` (billing → finance), the
last mirroring every cash-channel transaction into the drawer in the transaction that writes the
payment. 22 new HTTP paths; five test suites (10 unit, 8 integration, 2 concurrency, 3 HTTP);
traceability rows for the 20 owned decisions (171 of 279 `COVERED`); assumptions `A-P11-1`…`A-P11-13`.

Two defects the gates found and this phase fixed, both in accepted phases:

- a pre-existing lock-order inversion between a check-in and a minibar configuration apply, which
  deadlocked intermittently under the added Phase 11 concurrency load (`A-P11-13`);
- `ONB-DEC-001`'s grant probe treating `platform.cash_location` as provisioning-only, which doc 24
  §2.1 contradicts; the API now holds `INSERT`/`UPDATE` there and the security suite proves what the
  missing grant used to (`A-P11-12`).

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, disposable Compose project `prsystem-p06`).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 11 `finance/domain/cash` and `stay/domain/shift` unit suites | 10 passed |
| `finance.integration` / `finance.concurrency` (×3) / `finance.authorization.http` | 8 / 2 each / 3 passed |
| api `test:integration` / `test:concurrency` (every module, concurrency ×3) | 354 / 40 |
| api `test:unit` / `test:security` | 183 / 51 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,662 / 88 / 41 / 16 / 51 |
| `turbo run lint typecheck` forced (45 tasks), `openapi` (160 paths), `prettier --check .` | exit 0 |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 215 of 215 |

**The governed battery** ran in a clean detached checkout of the Phase 11 implementation commit
`92bceaf` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true` (no cached task
replay), after a preparatory `pnpm run build`. 24 of the 26 executions exited 0 on their first
attempt: unit 1,434; migrations 148; integration 402; concurrency 58 ×3; regression 51; GATE-SEC 19
of 19 ×3; e2e 15. The two that did not were the first two attempts of `pnpm run audit:tree`, each
refused by the npm registry's audit endpoint before any audit ran (a socket timeout, then a 503);
the third, executed in the same tree against the same lockfile, reported one moderate advisory and
nothing at high or critical. Exit codes and durations are in
[`phase-11-battery-log.md`](phase-11-battery-log.md), results in
[`phase-11-evidence.json`](phase-11-evidence.json), restated in the Phase 11 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03/04/05/06/07/08/09/10 batteries
and the Phase 05 CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- Phase 12: public discovery and Guest authentication — the first phase of the online side; it owns
  only `BK-DEC-001` and `BK-DEC-002` and depends on nothing Phase 11 built.
- Phase 13: `ConfirmedBookingsPort`, `platform.booking` (`assigned_room_id`, `category_id`),
  `ConflictService.detect`, the assignment application and the refund obligation on
  `stay.conflict.resolved` / `CANCELLED_HOTEL`; `captureRateSnapshot` for `ONLINE_BOOKING`; the
  online side of `stay.minibar_report_settled`; and an online booking's prepayment as a folio
  payment rather than a deposit.
- Phase 14: the provider callback that detects a late refund success unprompted — the contract it
  calls, freeze and open one case, is already in `RefundService`. An online payment faces a provider,
  not a drawer, so it adds no cash movement.
- Phase 15: Restaurant money stays out of the hotel drawer (doc 24 §1); no movement type can carry it.
- Phase 17: guest identity corrections as new `stay_guest` revisions; the registry reads the latest
  effective actual start; the folio, the money ledger, the cash ledger, the shift counts, the
  expenses and the finance events feed the hotel's financial reporting.
- Phase 18: `stay.checked_in` (token, never the number) and `stay.actual_time_corrected`.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`;
  both registries are held to the live schema by tests.

## 7. Processes, containers and services

- **No task-owned process is running.** `git worktree list` shows the main checkout, this worktree
  and four task-owned detached checkouts the batteries ran in — `scratchpad/battery-wt-08b` at
  `5b3603a`, `battery-wt-09` at `4063ac5`, `battery-wt-10` at `1ac4656` and `battery-wt-11` at
  `92bceaf` — all safe to remove with `git worktree remove --force`. The failed first Phase 08
  battery's worktree was removed after its account was transcribed; its summary, metadata and
  failing log are kept in `scratchpad/failed-battery-08/`.
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
  `EXT-01` (BLOCKED for its contract), `INT-OTP-01`, `INT-MAIL-01`, the Phase 19 offline
  verification surface, 17 P1 configuration items, `DSR-01`, and selecting `GATE-SEC` as a required
  GitHub status check.
- **Phase 11 adds no new external gate.** Cash is counted, not confirmed; the card and bank expense
  methods reference the payment ports Phase 10 already gated. No customer decision is pending on
  this phase's scope. `A-P11-12` (the `cash_location` grant) and `A-P11-13` (the lock order) touch
  accepted phases and are recorded for attention; `A-P08-1` is now partly answered by `A-P11-5`.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

Phase 12 — Public discovery and Guest authentication — is the current phase and is authorized to
begin under the standing authorization. Before editing: reread `CLAUDE.md`, this checkpoint,
`phase-status.md` (current position, ledger, the Phase 10 and 11 records), `build-plan.md`
§"Phase 12", and the requirement files that phase assigns (doc 09 for the public and booking side,
doc 18 §3, doc 13 where the Guest realm touches it); list its owned DEC IDs — `BK-DEC-001` and
`BK-DEC-002` — from `requirements-traceability.md` §2 and the family tables. Then verify
`git status` matches §4 and begin with the Guest realm and the public search surface: the listing
visibility conditions, the server-computed distance and ordering, and the e-Mongolia and phone-OTP
ports, both simulator-only and fail-closed outside local, CI and test.
