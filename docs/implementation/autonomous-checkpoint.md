# Autonomous checkpoint — Phase 12 complete, Phase 13 in progress

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
| Phase 12 implementation commit | `713e101bee3c0f9e86139a523ed789ef4be044f5` (the measured tree) |
| Phase 12 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 13 — Online booking and inventory hold | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 12
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 12 delivered

See the [Phase 12 record](phase-status.md#phase-12-record). Migration
`0013_guest_identity_discovery` admits the Guest realm to the Phase 04 account kernel rather than
building a parallel identity beside it, adds the four account-global `guest_*` tables, the
tenant-scoped `hotel_photo`, and the public listing projection — two `SECURITY DEFINER` functions
owned by the existing login-less resolver role, reaching tenant rows only through policies whose
`USING` clause is the visibility rule itself. The public module serves unauthenticated search and
detail with distance and ordering computed by the platform; the guest module serves phone
registration, sign-in, recovery, e-Mongolia and doc 09 §6.3's dual-channel linking. Two ports ship
fail-closed with the conformance suite: `EXT-02` entirely, and `EXT-06`'s geocoding half.
Traceability v1.25 (`BK-DEC-001`, `BK-DEC-002`; 173 of 279 `COVERED`); assumptions
`A-P12-1`…`A-P12-10`.

Two defects the gates found and this phase fixed:

- an attempt budget that never decreased, because a wrong one-time code was recorded inside the
  transaction its own refusal rolled back — a six-digit code could be guessed without limit
  (`A-P12-3`);
- `PublicController` resolved no service at runtime, because it relied on inferred constructor
  metadata; every search answered 500 until an explicit `@Inject` was added.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, disposable Compose project `prsystem-p06`).** All exit 0:

| Command | Result |
| --- | --- |
| `@prsystem/ports` `test:unit` (both new port conformance suites) | 54 passed |
| Phase 12 `guest/domain/guest` and `public/domain/listing` unit suites | 16 passed |
| `guest.integration` / `guest.concurrency` / `guest.security` | 11 / 3 / 8 passed |
| `public.integration` / `public.security` / `public.http` | 9 / 5 / 8 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 199 / 64 / 382 / 45 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 1,681 / 88 / 41 / 16 / 51 |
| `turbo run lint typecheck` forced (45 tasks), `openapi`, `prettier --check .` | exit 0 |
| `node tools/validate-governance.mjs` / `validate-governance.fixtures.mjs` on the final tree | 17 of 17 / 228 of 228 |

**The governed battery** ran in a clean detached checkout of the Phase 12 implementation commit
`713e101` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true` (no cached task
replay), after a preparatory `pnpm run build`. **All 26 executions exited 0 on their first
attempt**: unit 1,453; migrations 148; integration 430; concurrency 61 ×3; regression 51; GATE-SEC
19 of 19 ×3; e2e 15; both dependency audits clean on the first request. Exit codes and durations are
in [`phase-12-battery-log.md`](phase-12-battery-log.md), results in
[`phase-12-evidence.json`](phase-12-evidence.json), restated in the Phase 12 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03/04/05/06/07/08/09/10/11 batteries
and the Phase 05 CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

- **Phase 13 owes two implementations, not one.** `platform.booking` arriving makes both
  `ConfirmedBookingsPort` (stay: commitments on one physical room) and `CategoryHoldsPort` (public:
  units of a category held in a window) refuse rather than answer. Implementing one and forgetting
  the other leaves public availability over-reporting, and the default is written to fail loudly at
  exactly that moment.
- Phase 13 also owes: `assigned_room_id` / `category_id` on the booking, `ConflictService.detect`,
  the assignment application and the refund obligation on `stay.conflict.resolved` /
  `CANCELLED_HOTEL`; `captureRateSnapshot` for `ONLINE_BOOKING`; the online side of
  `stay.minibar_report_settled`; and an online booking's prepayment as a folio payment rather than a
  deposit. The Guest session Phase 12 issues is the identity a booking is made under, and
  `booking.cancel_own` is already declared in `GUEST_ACTIONS`.
- Phase 14: the provider callback that detects a late refund success unprompted — the contract it
  calls, freeze and open one case, is already in `RefundService`.
- Phase 15: Restaurant money stays out of the hotel drawer (doc 24 §1).
- Phase 16: `review.report_published` is already declared in `GUEST_ACTIONS`; a verified-stay review
  reads the Guest account Phase 12 created.
- Phase 17: guest identity corrections as new `stay_guest` revisions; the folio, the money ledger,
  the cash ledger, the shift counts, the expenses and the finance events feed the hotel's financial
  reporting.
- Phase 18: `stay.checked_in` (token, never the number) and `stay.actual_time_corrected`.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** `git worktree list` shows the main checkout, this worktree
  and five task-owned detached checkouts the batteries ran in — `scratchpad/battery-wt-08b` at
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
- **Phase 12 adds no new external gate.** It ships the ports for two that were already registered.
  `EXT-02` and `EXT-06` remain **BLOCKED** and now carry a canonical port and a conformance-gated
  simulator; `EXT-06`'s geocoding half is gated while its distance half is provider-free, recorded
  as `A-P12-6`. **P1-01** — the nearby radius and the sort order — is now live on its interim
  values (5 km, availability then distance) and is the one P1 item this phase actually exercises.
- No customer decision is pending on this phase's scope. `A-P12-1` (a nullable
  `user_account.email_normalized`) and `A-P12-7` (the Guest realm in the platform scope) change
  Phase 04 artefacts and are recorded for attention.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 8a. Phase 13 in progress — what exists in the working tree

**HEAD is still the Phase 12 record `affb63c`.** Everything below is uncommitted.

**The schema layer is complete and every `@prsystem/db` gate passes on it**: migrations 148, unit
88, security 1,778, regression 51, integration 41, concurrency 16.

- `packages/db/migrations/0014_online_booking_inventory.sql` (untracked) — `booking` (the MVP shape,
  identity/window/booker written once, price a snapshot, terminal never reopened), `booking_night`,
  `category_night_inventory` whose `CHECK (units_held <= units_capacity)` **is** the anti-overbooking
  rule, `booking_payment_attempt` (one `ACTIVE` per booking by partial unique index),
  `booking_event`, `stay.fulfilled_booking_id` with a partial unique index, the `own_booking_read`
  policy that lets a Guest read their own booking and nothing else, the two
  `public_availability_read` policies the Phase 12 projection needs, and
  `platform.hotel_of_category(uuid)` — a `SECURITY DEFINER` resolver so a request never chooses the
  tenant its command runs in.
- Journal entry 14; migration counts 14 → 15 in the three suites; snapshot and Drizzle declarations
  regenerated; `classification.ts`, `test-support/tenant-rows.ts` (five fixtures) and
  `ownership-manifest.ts` updated; `migrations.test.ts` records Phase 13's table ownership.

**The API module is written and typechecks**, not yet exercised: `booking/domain/booking.ts`,
`repositories/booking.repository.ts`, `services/{booking-context,booking.service,expiry.service}.ts`,
`contracts/booking-reads.ts` (both ports Phase 13 owed, plus the fulfilment write),
`stay/contracts/booking-fulfilment.ts`, and the check-in now consumes the booking inside its own
transaction.

**One registry correction, made deliberately.** `room.future_booking` named
`platform.booking.assigned_room_id`, a column `BK-DEC-013` does not create: a booking holds a
category unit and reaches a room only by becoming a stay. The source was removed rather than a
column invented to satisfy it, and the three tests that named it were retargeted — including the
catalog probe test, which now breaks and restores a real relation's shape instead of creating a
fake one, since every registered relation exists once Phase 13 lands.

**Still to do:** the guest-facing HTTP layer, the module and its wiring into `app.module`, the
worker's expiry job, the test suites (unit, integration, concurrency ×3, security, HTTP), then
traceability v1.26, assumptions §3.17, the Phase 13 record, governance, the governed battery on the
implementation commit, evidence, and the two commits.

## 9. Exact next action

**Phase 13 — Online booking and inventory hold — is the current phase, authorized and under way.**
Resume from §8a: write `booking/http/`, `booking.module.ts` and the `app.module` wiring, then the
suites. Nothing already built needs redoing. Before editing: reread `CLAUDE.md`, this checkpoint,
`phase-status.md` (current position, ledger, the Phase 11 and 12 records), `build-plan.md`
§"Phase 13", and the requirement files that phase assigns; list its owned DEC IDs from
`requirements-traceability.md` §2 and the family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 13/,/^### Phase 14/p' docs/implementation/build-plan.md
```

Begin with the two contracts §6 names: `platform.booking` cannot be created without implementing
`ConfirmedBookingsPort` *and* `CategoryHoldsPort` in the same phase, because both defaults are
written to refuse the moment that table exists. Everything else in Phase 13 — the hold, the
category inventory of `BK-DEC-013`, the conflict detection and the assignment — hangs off that
table.
