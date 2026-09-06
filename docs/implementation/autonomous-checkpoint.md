# Autonomous checkpoint — Phase 16 complete, Phase 17 authorized

**Written:** 2026-09-06, at the close of Phase 16 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 16 needed two commits.** The implementation, and a correction its own governed battery
found: two `SECURITY DEFINER` read policies that migration 0017 creates and the declaration did not
carry, added after the canonical snapshot was generated. Phase 13 took two for a committed test
literal the secret scanner reads as a credential, and Phase 08 two for a concurrency defect; Phases
09 to 12, 14 and 15 each needed one. Implementation completion is not customer acceptance and
not release approval.

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
| Phase 16 commits | implementation `d5cf786d4c52de1e1e076a840bf00bc08709d232`, correction `fbb498bd4e832e868fbeaa4ae8d39a9523612cfb` (the measured tree) |
| Phase 16 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 17 — Guest registry, exports, and Hotel Admin reports | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 16
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 16 delivered

See the [Phase 16 record](phase-status.md#phase-16-record). Migration `0017_verified_reviews` adds
seven tables and holds four of the phase's rules in the database rather than in application code.

**A review is earned, and earned once.** `booking_id` is UNIQUE, so a completed booking yields one
review forever — including when the owner soft-deleted it, because that row still occupies its
booking. Eligibility itself is three conditions read from the booking module's own contract inside
the transaction that writes the row, never from a status the client sent (`RV-DEC-002`).

**Nothing is ever deleted.** The owner withdraws to `DELETED`, a moderator hides to `HIDDEN`, every
table refuses `DELETE`, and a trigger refuses any transition *out* of `DELETED` — which is how doc
10 §7.3's "a moderator does not undo an owner's delete" became a property of the schema.

**The average is a CHECK.** `(sum × 200 + count) / (max(count,1) × 2)` on integers is exactly half-up
in hundredths, so the published average cannot disagree with the count and sum it summarises, and no
client computes it (`A-P16-4`).

**Moderation is a granted permission, never a role name.** `OPERATION_ADMIN` and
`PLATFORM_SUPER_ADMIN` grant nothing on their own; `REVIEW_MODERATE` plus a step-up does, re-read
inside each command's transaction, so a revocation that commits first wins.

The aggregate moves in the same transaction as the review it summarises, on its own row lock — so
this phase has no job, no sweep and **no worker grant on any of its seven tables**. Traceability
v1.29 (eleven decisions; 221 of 279 `COVERED`); assumptions `A-P16-1`…`A-P16-11`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 16 `review/domain/review` unit suite | 19 passed |
| `review.integration` / `review.concurrency` / `review.security` / `review.http` | 23 / 5 / 18 / 9 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 283 / 113 / 477 / 64 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 2,304 / 88 / 41 / 16 / 51 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| the eight governance validators on the final tree | all exit 0; governance 17/17, drift fixtures 277/277 |

**A first battery was stopped, not recorded.** On `d5cf786` it failed `pnpm run test:migrations`
because migration 0017 creates `moderation_resolution_read` and `queue_resolution_read` and neither
was declared in `schema.ts` or the canonical snapshot — both were added to the migration after the
snapshot had been generated, which is why the earlier local run passed. The comparator caught
exactly what it exists to catch. That run's output was removed and the battery repeated in full on
the corrected commit; no part of it is evidence for anything.

**One thing worth recording about how the development-time runs were made.** An early attempt ran the api and db suites
*concurrently* against the same PostgreSQL cluster and produced `permission denied for schema
platform` in seven of them: the db security suite creates and drops databases and roles, and the api
suites were using them at the time. Re-run serially, every suite passed. The counts above and the
governed battery below are the serial runs; the concurrent attempt is evidence for nothing and is
not recorded as a result.

**The governed battery** ran in a clean detached checkout of the Phase 16 correction commit
`fbb498b` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. Exit codes and durations are in
[`phase-16-battery-log.md`](phase-16-battery-log.md), results in
[`phase-16-evidence.json`](phase-16-evidence.json), restated in the Phase 16 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 15 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 16 discharged what the last checkpoint named of it.** A verified-stay review reads the
booking and the stay it became, through a contract rather than another module's tables.

- **Phase 17**: the hotel's financial reporting. Restaurant money stays out of it (doc 08 §13) and
  reviews carry no money at all, so neither of the last two phases wrote a row Phase 17 reads.
  Phase 17 also owns `RC-DEC-032`, the guest registry columns.
- **Phase 18**: `stay.checked_in` and `stay.actual_time_corrected` are unchanged by this phase.
- **Phase 19 (Platform Operation)** now carries four open items deliberately not invented: an
  Operation surface for administering a commission contract and one for reviewing a `HELD` or
  `ADJUSTMENT_DUE` payable (both `A-P14-1`); the Restaurant Manager invitation flow, which is Phase
  04's existing `hotel.restaurant.manager_invite` (`A-P15-2`); and the Operation *screens* for the
  moderation queue this phase implemented as an API — the permission and the commands exist, the
  Operation portal does not yet.
- **Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
  `CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling on
  the worker's queues the two settlement jobs, the Phase 13 expiry sweep and Phase 15's
  invoice-expiry and refund-SLA sweeps — five services with tests and no scheduler entry yet. Phase
  16 adds nothing to that list: its aggregate moves inside the transaction that moved the review.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 15 and Phase 16 battery checkouts were removed
  after their runs, so `git worktree list` shows the main checkout, this worktree and the earlier
  task-owned detached checkouts (`battery-wt-08b` through `battery-wt-14`) — all safe to remove with
  `git worktree remove --force`.
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
- **Phase 16 touches no external gate at all.** A review is written, moderated and published
  entirely inside the platform: no provider, no gateway, no external identity.
- **Two items are recorded for the customer's attention.** The public display-name mask is one
  character plus `***`, which doc 10 §11 already lists as a P1 UX refinement (`A-P16-3`). And the
  review window is measured from the booking's `terminal_at`, which equals the stay's
  `actual_checkout_at` by construction today — if a later phase lets a recorded checkout time be
  corrected, that correction has to reach the booking too or the window will measure from the wrong
  instant (`A-P16-1`).
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 17 — Guest registry, exports, and Hotel Admin reports — is the current phase and is
authorized to begin under the standing authorization.** Before editing: reread `CLAUDE.md`, this
checkpoint, `phase-status.md` (current position, ledger, the Phase 15 and 16 records),
`build-plan.md` §"Phase 17", and the requirement files that phase assigns; list its owned DEC IDs
from `requirements-traceability.md` §2 and the family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 17/,/^### Phase 18/p' docs/implementation/build-plan.md
```

Begin from what a registry export is allowed to contain. doc 12 governs a list of *identified
guests*, which is the most sensitive data this platform holds — CLAUDE.md §8 forbids full
registration numbers and passports in logs, exports, fixtures and payloads alike. So the first thing
to establish is which columns an export may carry and who may generate one, not the export
machinery.
