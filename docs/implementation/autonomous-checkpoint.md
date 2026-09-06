# Autonomous checkpoint — Phase 14 complete, Phase 15 authorized

**Written:** 2026-09-06, at the close of Phase 14 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 14 needed one implementation commit.** Its governed battery passed on that commit with all
28 executions exiting 0 on their first attempt, including both dependency audits. Phases 09 to 12
each needed one commit too. Phase 13 took two — a committed test literal the secret scanner reads as
a credential — and Phase 08 took two for a concurrency defect. Implementation completion is not
customer acceptance and not release approval.

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
| Phase 14 commits | implementation `e9f11ad325d5ea218150abbdfb64b070dc89b811` (the measured tree) |
| Phase 14 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 15 — Restaurant | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 14
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 14 delivered

See the [Phase 14 record](phase-status.md#phase-14-record). Migration `0015_booking_settlement` adds
the money a booking makes and holds three rules in the database rather than in application code.

**There is no default commission** (`PAY-DEC-001`): `commission_rate_bps` has no DEFAULT, both
runtime logins hold `SELECT` on `hotel_commission_contract` and nothing else, and a hotel with no
active contract cannot take an online payment at all. doc 18 names no permission for administering a
rate, so none was invented (`A-P14-1`).

**The arithmetic is a CHECK** (`PAY-DEC-008`): retained is gross less refunded; commission is
`(retained × bps + 5000) / 10000`, which on non-negative bigints is exactly `ROUND_HALF_UP`; the
hotel's share is retained less commission. The gateway fee is a term of none of them, so it cannot be
deducted from a payout by mistake (`BK-DEC-011`, `A-P14-5`).

**A capture is server-verified end to end** (`PAY-DEC-005`): signature, then the hotel resolved from
the invoice by a definer function because a callback names no tenant, then the provider event
deduplicated, then the provider's own status re-queried, then provider, reference, amount and
currency matched against the stored attempt — and only then a transition.

Cancellation at the 24-hour boundary, a no-show after the arrival date's `23:59:59` hotel-local, the
first-night fee, `HELD` while a refund is open, `D+1 12:00 Asia/Ulaanbaatar` batching, a retry as a
new `attempt_no`, and `ADJUSTMENT_DUE` for a refund that lands after a payout are all implemented and
gated. Traceability v1.27 (eleven decisions; 191 of 279 `COVERED`); assumptions `A-P14-1`…`A-P14-11`.

Two defects the gates found and this phase fixed:

- `booking_confirmed_has_time` was an equivalence, which made a booking cancelled after confirmation
  unrepresentable — the first Phase 14 path to reach it (`A-P14-9`);
- a refund landing after a payout raised no adjustment, because the eligibility recompute skipped a
  payable that was already `PAID` — which is the one case the adjustment exists for.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 14 `settlement/domain/settlement` unit suite | 24 passed |
| `settlement.integration` / `settlement.concurrency` / `settlement.security` | 19 / 5 / 12 passed |
| `booking.integration` / `booking.http` after the Phase 14 changes | 10 / 12 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 237 / 84 / 423 / 55 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,893 / 88 / 41 / 16 / 51 |
| `@prsystem/ports` `test:unit` | 57 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 252 of 252 |

**The governed battery** ran in a clean detached checkout of the Phase 14 implementation commit
`e9f11ad` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. All 28 executions exited 0 on their first attempt. Exit codes and durations are in
[`phase-14-battery-log.md`](phase-14-battery-log.md), results in
[`phase-14-evidence.json`](phase-14-evidence.json), restated in the Phase 14 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**An earlier attempt at that battery was stopped, not recorded.** It was pointed at a second
PostgreSQL cluster while the migration suite's schema dump resolves its container from the checkout's
own Compose project, so `pnpm run test:migrations` failed for an environmental reason. Its output
directory was removed and the run was repeated in full on the corrected environment; no part of it is
evidence for anything.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 13 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 14 discharged everything the last checkpoint named of it.** Capture, refund execution,
commission, the gateway fee and the payout axis are implemented; `EXT-07` has its canonical port and
simulator with the production adapter disabled. The `SettlementPort` and `BookingRefundAxisPort`
defaults both refuse the moment their relations exist, and both are now implemented.

- **Phase 15**: Restaurant money stays out of the hotel drawer (doc 24 §1) and out of the online
  booking ledger (doc 11 §2).
- **Phase 16**: a verified-stay review reads the booking and the stay it became.
- **Phase 17**: the booking's money feeds the hotel's financial reporting — the payable, the ledger
  and the payout batch are the rows it reads, and doc 23 §11 keeps the gateway fee out of hotel
  expense.
- **Phase 18**: `stay.checked_in` and `stay.actual_time_corrected` are unchanged by this phase.
- **Phase 19 (Platform Operation)** carries two open items this phase deliberately did not invent:
  an Operation surface for administering a commission contract, and one for reviewing a payable that
  is `HELD` or `ADJUSTMENT_DUE`. Both need a permission doc 18 §5 does not yet name (`A-P14-1`).
- **Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
  `CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling the
  two settlement jobs and the Phase 13 expiry sweep on the worker's queues — all three are services
  with tests and no scheduler entry yet.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** `git worktree list` shows the main checkout, this worktree
  and the task-owned detached checkouts the batteries ran in — including `battery-wt-14` at
  `e9f11ad` — all safe to remove with `git worktree remove --force`.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379). `docker-compose.yml` fixes that project name, and the
  migration suite's schema dump resolves its container through `docker compose ps -q postgres` from
  the checkout root; Turborepo passes only `DATABASE_URL` to a task, so an override naming another
  container never reaches the test process. The cluster the suites create scratch databases in and
  the cluster the dump reads from must therefore be the same one — pointing them at different
  clusters is what stopped the first Phase 14 battery. The disposable project `prsystem-p06` and its
  volumes are still present and unused by this phase; they are safe to keep or remove. Local
  development credentials only, kept in the session scratchpad (`env.sh`) and deliberately not
  reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01`, `EXT-02`, `EXT-03`, `EXT-04`, `EXT-06`, `EXT-11` (BLOCKED,
  conformance-gated simulators), `INT-OTP-01`, `INT-MAIL-01`, the Phase 19 offline verification
  surface, 17 P1 configuration items, `DSR-01`, and selecting `GATE-SEC` as a required GitHub status
  check.
- **`EXT-07` is first touched by Phase 14 and stays BLOCKED.** doc 11 §12 makes the legal,
  contractual and payment-service basis for the platform holding a third party's money an external
  gate. `HotelPayoutPort` answers `DISABLED` in production and makes no network call; every payout
  measured here was against the deterministic simulator. **Phase 14 adds no new external gate.**
- **No customer decision is pending on this phase's scope**, but two items are recorded for
  attention because they are the customer's to settle, not this programme's: the commission rate of
  each hotel is contractual data with no MVP administration surface (`A-P14-1`), and doc 09 §12's
  `planned_checkin_at` is derived from the start of the arrival date because no document configures
  a standard check-in hour (`A-P14-2`). A configured hour would move the free-cancellation deadline
  later.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 15 — Restaurant — is the current phase and is authorized to begin under the standing
authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md` (current
position, ledger, the Phase 13 and 14 records), `build-plan.md` §"Phase 15", and the requirement
files that phase assigns; list its owned DEC IDs from `requirements-traceability.md` §2 and the
family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 15/,/^### Phase 16/p' docs/implementation/build-plan.md
```

Begin from the boundary Phase 14 was careful not to cross. doc 11 §2 keeps restaurant money out of
the online booking ledger and doc 24 §1 keeps it out of the hotel's cash drawer: the Restaurant's
payments go to the Restaurant's own merchant. So Phase 15 is not an extension of the settlement
module — it is a separate money path, and the first thing to establish is that the two ledgers cannot
reach each other.
