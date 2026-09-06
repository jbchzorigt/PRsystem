# Autonomous checkpoint — Phase 15 complete, Phase 16 authorized

**Written:** 2026-09-06, at the close of Phase 15 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 15 needed one implementation commit.** Its governed battery passed on that commit. Phases 09
to 12 and Phase 14 each needed one commit too. Phase 13 took two — a committed test literal the
secret scanner reads as a credential — and Phase 08 took two for a concurrency defect. Implementation
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
| Phase 09 commits | implementation `4063ac530ee536bb2cda5c27a1cb2526d22a660a` (the measured tree), record `11ca271` |
| Phase 10 commits | implementation `1ac4656cfd47be97785a4a990604b73b0c4ff872` (the measured tree), record `c3fd42e` |
| Phase 11 commits | implementation `92bceaf8a25f74d82797ae207e61ad86ef6ce3c1` (the measured tree), record `dcd6395` |
| Phase 12 commits | implementation `713e101bee3c0f9e86139a523ed789ef4be044f5` (the measured tree), record `affb63c` |
| Phase 13 commits | implementation `4768ec189a28c702689226eaf42ff76e8cbdd41f`, correction `5d51fa9d0956e194c27614249829bd62c04581a8` (the measured tree), record `bd9e24c` |
| Phase 14 commits | implementation `e9f11ad325d5ea218150abbdfb64b070dc89b811` (the measured tree), record `44c2aff` |
| Phase 15 commits | implementation `ff121ef641ac36d5087ec9cd3823bbe8056e71c3` (the measured tree) |
| Phase 15 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 16 — Verified reviews | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 15
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 15 delivered

See the [Phase 15 record](phase-status.md#phase-15-record). Migration `0016_restaurant_ordering`
adds fifteen tables and holds the phase's hard rules in the database rather than in application code.

**The food money never reaches a hotel total.** doc 08 §13 sends a restaurant payment to the
restaurant's own merchant, so there is no payable, no batch, no commission and no platform payout
for it. Nothing in this module writes a folio line, a deposit, a cash movement or a shift total; the
separation is structural, and the integration gate asserts it against each of those relations by
name.

**Seven axes, seven columns** (`REST-DEC-001`). A late capture on a cancelled order moves
`payment_state` and leaves the other six where they were.

**The acceptance race is the order's row lock** (`REST-DEC-002`). Pre-accept and past ten minutes the
refund is `MANDATORY`/`APPROVED` and the order cancels; accepted first, the later request is
`DISCRETIONARY`/`OPEN` and fulfilment continues. Neither outcome moves money — only a verified
provider refund does. The concurrency gate runs that race ten times and asserts no mixed state.

**Three rules are constraints, not conventions.** `expires_at <= ordering_closes_at` on every
invoice (`RC-DEC-023`); `active_sessions + pending_codes <= 5` on every stay (`RC-DEC-027`);
`promised_ready_at = accepted_at + eta_minutes` on every acceptance (`REST-DEC-003`).

**The guest is confined by the database.** `app.guest_stay_id` and a `RESTRICTIVE` policy on each of
the five stay-scoped relations. The room session is its own credential on its own header and can
never be mistaken for a Guest-realm account bearer (`A-P15-3`); the hotel behind a session token is
resolved by a narrow `SECURITY DEFINER` function and then re-read inside that hotel's own scope
(`A-P15-5`). No secret — QR token, one-time code or session token — is stored in plaintext, reaches
an audit payload, or comes back on an idempotency replay.

**Checkout** (`RC-DEC-028`, `-029`, `A-P15-9`). An unfinished order does not hard-block the final
checkout; an unacknowledged one does, re-read under the stay's own lock at the moment the checkout is
confirmed. The checkout cancels no order and starts no refund, and closes the stay's guest access in
the same transaction. It crosses the module boundary as `RestaurantOrdersPort`, whose
`Unprovisioned` default fails closed once `platform.restaurant_order` exists (`A-P15-11`).

Traceability v1.28 (nineteen decisions; 210 of 279 `COVERED`); assumptions `A-P15-1`…`A-P15-11`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 15 `restaurant/domain/restaurant` unit suite | 27 passed |
| `restaurant.integration` / `restaurant.concurrency` / `restaurant.security` / `restaurant.http` | 13 / 4 / 11 / 9 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 264 / 95 / 445 / 59 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 2,181 / 88 / 41 / 16 / 51 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| `node tools/validate-governance.mjs` and the seven other validators on the final tree | all exit 0 |

**The governed battery** ran in a clean detached checkout of the Phase 15 implementation commit
`ff121ef` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. Exit codes and durations are in
[`phase-15-battery-log.md`](phase-15-battery-log.md), results in
[`phase-15-evidence.json`](phase-15-evidence.json), restated in the Phase 15 record. The two
governance rows there are from the final tree, which is the only tree that carries the record.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 14 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 15 discharged the boundary the last checkpoint named of it.** Restaurant money is out of the
hotel drawer (doc 24 §1) and out of the online booking ledger (doc 11 §2), and the integration gate
asserts it rather than asserting that nobody wrote the code.

- **Phase 16**: a verified-stay review reads the booking and the stay it became. Nothing in Phase 15
  changes that surface.
- **Phase 17**: the booking's money feeds the hotel's financial reporting. Restaurant money must
  stay out of it too — doc 08 §13 and doc 23 §11 agree, and Phase 15 wrote no row that Phase 17
  would read.
- **Phase 18**: `stay.checked_in` and `stay.actual_time_corrected` are unchanged by this phase.
- **Phase 19 (Platform Operation)** carries three open items deliberately not invented: an Operation
  surface for administering a commission contract, one for reviewing a `HELD` or `ADJUSTMENT_DUE`
  payable (both `A-P14-1`), and the Restaurant Manager *invitation* flow, which is Phase 04's
  existing `hotel.restaurant.manager_invite` and was not re-implemented here (`A-P15-2`).
- **Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
  `CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling on
  the worker's queues the two settlement jobs, the Phase 13 expiry sweep and now Phase 15's
  invoice-expiry and refund-SLA sweeps — all five are services with tests and no scheduler entry yet.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 15 battery checkout was removed after its run, so
  `git worktree list` shows the main checkout, this worktree and the earlier task-owned detached
  checkouts (`battery-wt-08b` through `battery-wt-14`) — all safe to remove with
  `git worktree remove --force`.
- **Shared services that must not be touched:** the unrelated `piston`,
  `hotel-platform-postgres` and `hotel-platform-redis` containers.
- **Environment for the measured runs:** the repository's own Compose stack, project `prsystem`
  (Postgres 127.0.0.1:55442, Redis 56379). `docker-compose.yml` fixes that project name, and the
  migration suite's schema dump resolves its container through `docker compose ps -q postgres` from
  the checkout root; Turborepo passes only `DATABASE_URL` to a task, so an override naming another
  container never reaches the test process. The cluster the suites create scratch databases in and
  the cluster the dump reads from must therefore be the same one. The disposable project
  `prsystem-p06` and its volumes are still present and unused; they are safe to keep or remove.
  Local development credentials only, kept in the session scratchpad (`env.sh`) and deliberately not
  reproduced here.

## 8. Blockers and pending customer choices

- Unchanged and still open: `EXT-01`, `EXT-02`, `EXT-03`, `EXT-04`, `EXT-06`, `EXT-07`, `EXT-11`
  (BLOCKED, conformance-gated simulators), `INT-OTP-01`, `INT-MAIL-01`, the Phase 19 offline
  verification surface, 17 P1 configuration items, `DSR-01`, and selecting `GATE-SEC` as a required
  GitHub status check.
- **`EXT-03` is the gate Phase 15 exercises and it stays BLOCKED.** The restaurant's own merchant is
  reached through the same typed payment port and the same deterministic simulator every gate here
  was measured against; the production adapter makes no network call. **Phase 15 adds no new
  external gate.**
- **No customer decision is pending on this phase's scope.** Two items are recorded for attention
  because they are the customer's to settle: the Restaurant Manager reaches the platform by
  invitation, not by an account this phase creates (`A-P15-2`), and a restaurant's ordering schedule
  is hotel-local wall time with no configured business-day cutoff, so an overnight window is
  recognised by a closing earlier than its opening (`A-P15-6`).
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 16 — Verified reviews — is the current phase and is authorized to begin under the standing
authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md` (current
position, ledger, the Phase 14 and 15 records), `build-plan.md` §"Phase 16", and the requirement
files that phase assigns; list its owned DEC IDs from `requirements-traceability.md` §2 and the
family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 16/,/^### Phase 17/p' docs/implementation/build-plan.md
```

Begin from what a review is allowed to be. doc 10 makes a review something only a *verified stay* can
leave, which means the eligibility question is answered by Phase 08's stay and Phase 13's booking
rather than by anything the reviewer sends. So the first thing to establish is the eligibility
predicate and where it is evaluated — not the review text, and not the rating arithmetic.
