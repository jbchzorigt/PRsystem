# Autonomous checkpoint — Phase 13 complete, Phase 14 authorized

**Written:** 2026-09-05, at the close of Phase 12 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 12 needed one implementation commit.** Its governed battery passed on that commit with all
26 executions exiting 0 on their first attempt — including both dependency audits, which earlier
phases had to re-execute when the npm registry refused them. Phases 09, 10 and 11 each needed one
commit too. Phase 08 took two: its implementation `621e17d` failed the concurrency gate on a booking
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
| Phase 11 commits | implementation `92bceaf8a25f74d82797ae207e61ad86ef6ce3c1` (the measured tree), record `dcd6395` |
| Phase 12 commits | implementation `713e101bee3c0f9e86139a523ed789ef4be044f5` (the measured tree), record `affb63c` |
| Phase 13 commits | implementation `4768ec189a28c702689226eaf42ff76e8cbdd41f`, correction `5d51fa9d0956e194c27614249829bd62c04581a8` (the measured tree) |
| Phase 13 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 14 — Online payment, refund, commission, and settlement | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 13
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 13 delivered

See the [Phase 13 record](phase-status.md#phase-13-record). Migration
`0014_online_booking_inventory` makes overbooking a constraint violation rather than a race:
occupancy is a row per category per night carrying the capacity and the units taken, with
`CHECK (units_held <= units_capacity)`, and every path that changes it locks those rows in night
order. A booking is `BK-DEC-012`'s MVP shape with its identity, window and booker written once and
its price a snapshot; the hold is ten minutes from the server's clock and is never extended; exactly
one payment attempt is `ACTIVE`. Expiry and the callback compete on one row, and a capture arriving
after the hold has gone raises a full refund obligation without reopening anything. Both contracts
Phase 12 was owed are implemented, together with the write half that consumes a booking inside the
check-in's own transaction. Traceability v1.26 (seven decisions; 180 of 279 `COVERED`); assumptions
`A-P13-1`…`A-P13-11`.

Three defects the gates found and this phase fixed:

- every calendar date was bound as a `Date` and shifted across the session timezone, so the night a
  booking took was not the night availability asked about (`A-P13-8`);
- `booking_confirmed_has_snapshot` made an expired booking unrepresentable (`A-P13-10`);
- the dependency registry named `booking.assigned_room_id`, a column `BK-DEC-013` does not create
  (`A-P13-9`).

A fourth was found by the battery itself: a committed test literal that the secret scanner reads as
a credential. The battery was stopped rather than allowed to record a run against a tree with a
known failure, `5d51fa9` composed the value the way every other synthetic passphrase is, and the
battery was re-measured on that commit.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, disposable Compose project `prsystem-p06`).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 13 `booking/domain/booking` unit suite | 14 passed |
| `booking.integration` / `booking.concurrency` (×3) / `booking.security` / `booking.http` | 10 / 5 each / 8 / 6 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 213 / 72 / 398 / 50 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,778 / 88 / 41 / 16 / 51 |
| `@prsystem/ports` `test:unit`, `@prsystem/worker` `test:unit` | 54 / 14 |
| `turbo run lint typecheck` forced (45 tasks), `openapi`, `prettier --check .` | exit 0 |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 241 of 241 |

**The governed battery** ran in a clean detached checkout of the Phase 13 correction commit
`5d51fa9` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a
preparatory `pnpm run build`. Exit codes and durations are in
[`phase-13-battery-log.md`](phase-13-battery-log.md), results in
[`phase-13-evidence.json`](phase-13-evidence.json), restated in the Phase 13 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**An earlier battery on the implementation commit `4768ec1` was stopped, not recorded.** It had
reached `validate-secret-scan.fixtures.mjs`, which exited 1 on the committed test literal described
in §3. Its output directory was removed and the run was repeated in full on `5d51fa9`; no part of it
is evidence for anything.

**Historical evidence (unchanged, not re-measured):** the Phase 03/04/05/06/07/08/09/10/11/12
batteries and the Phase 05 CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 13 discharged the two the last checkpoint named.** `ConfirmedBookingsPort` and
`CategoryHoldsPort` are both implemented, so neither default refuses any more; `BookingFulfilmentPort`
was added for the write half and its own default refuses until it is implemented, which it now is.

- **Phase 14** owes the settlement half of what Phase 13 records: capture and refund execution,
  commission, the gateway fee, `EXT-07`'s central account, and the payout axis. The obligations are
  already on the row — `payment_state = 'PAID'` with `refund_state = 'REQUIRED'` — and
  `booking.refund_required` is on the outbox. `BK-DEC-014`'s "commission 0, gateway fee the
  platform's cost" is a settlement rule with nothing yet to settle.
- Phase 14 also owes the provider callback that detects a late refund success unprompted; the
  contract it calls is already in `RefundService`.
- **Phase 15**: Restaurant money stays out of the hotel drawer (doc 24 §1).
- **Phase 16**: a verified-stay review reads the booking and the stay it became.
- **Phase 17**: the booking's money feeds the hotel's financial reporting.
- **Phase 18**: `stay.checked_in` and `stay.actual_time_corrected` are unchanged by this phase.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** `git worktree list` shows the main checkout, this worktree
  and six task-owned detached checkouts the batteries ran in — `scratchpad/battery-wt-08b` at
  `5b3603a`, `battery-wt-09` at `4063ac5`, `battery-wt-10` at `1ac4656`, `battery-wt-11` at
  `92bceaf` and `battery-wt-12` at `713e101` — all safe to remove with `git worktree remove
  --force`. The failed first Phase 08 battery's worktree was removed after its account was
  transcribed; its summary, metadata and failing log are kept in `scratchpad/failed-battery-08/`.
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
- **Phase 13 adds no new external gate.** It records payment *attempts* against the ports Phase 05
  already gated and settles no money; `EXT-07` is Phase 14's and is untouched.
- **Phase 12 added no new external gate either.** It ships the ports for two that were already registered.
  `EXT-02` and `EXT-06` remain **BLOCKED** and now carry a canonical port and a conformance-gated
  simulator; `EXT-06`'s geocoding half is gated while its distance half is provider-free, recorded
  as `A-P12-6`. **P1-01** — the nearby radius and the sort order — is now live on its interim
  values (5 km, availability then distance) and is the one P1 item this phase actually exercises.
- No customer decision is pending on this phase's scope. `A-P12-1` (a nullable
  `user_account.email_normalized`) and `A-P12-7` (the Guest realm in the platform scope) change
  Phase 04 artefacts and are recorded for attention.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 14 — Online payment, refund, commission, and settlement — is the current phase and is
authorized to begin under the standing authorization.** Before editing: reread `CLAUDE.md`, this
checkpoint, `phase-status.md` (current position, ledger, the Phase 12 and 13 records),
`build-plan.md` §"Phase 14", and the requirement files that phase assigns; list its owned DEC IDs
from `requirements-traceability.md` §2 and the family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 14/,/^### Phase 15/p' docs/implementation/build-plan.md
```

Begin where Phase 13 stopped deliberately: the refund obligations it raises. A booking already
carries `payment_state = 'PAID'` with `refund_state = 'REQUIRED'` and emits `booking.refund_required`
on the outbox, so Phase 14's first job is the axis that settles them — not a new way to record that
they exist.
