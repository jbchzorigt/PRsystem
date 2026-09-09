# Autonomous checkpoint — Phase 19 complete, Phase 20 authorized

**Written:** 2026-09-09, at the close of Phase 19 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 19 needed one commit.** Its governed battery passed on the implementation commit at the
first attempt, all 28 executions exiting 0 — as Phases 09 to 12, 14, 15, 17 and 18 did. Phases 08,
13 and 16 each needed a correction first. Implementation completion is not customer acceptance and
not release approval.

**Requirement coverage is now complete; release readiness is not.** All 279 canonical decisions are
`COVERED`. Eleven EXT gates and two internal controls are open, seventeen P1 configuration items are
open, two dependency advisories are contained rather than closed, no phase since Phase 05 has been
accepted, and Phases 20 to 23 have not run.

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
| Phase 17 commits | implementation `e2b7bf8f4dc637d6c214ca9a59caf872a0927549` (the measured tree), record `15187e9` |
| Phase 18 commits | implementation `3758aeb345a84242222657496ea290736de6ad98` (the measured tree), record `9d13d7d` |
| Phase 19 commits | implementation `e913a9aec886c224dacf24b25892f73bf8e3e115` (the measured tree) |
| Phase 19 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 18 — Police monitoring | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 19 — Platform Operation | `DONE` | `AWAITING_CUSTOMER_ACCEPTANCE` |
| 20 — External adapters | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 19
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 19 delivered

See the [Phase 19 record](phase-status.md#phase-19-record). Migration `0020_platform_operation` adds
eleven tables and seven `SECURITY DEFINER` resolvers, and the shape of the module is the security
model.

**A role name grants nothing, and a name is not an account** (`OPS-DEC-015`). Every action names an
explicitly granted permission from doc 18 §5, evaluated by the Phase 04 pipeline against the realm,
the role column, the grant and a step-up no older than ten minutes, inside the transaction that
applies the effect. The second factor is real — RFC 6238 TOTP with the accepted counter step written
under a compare-and-set — and a password re-proves nothing.

**The operator never holds the secret.** A reset names a hotel; a resolver reads the registered
address, queues the link and returns it masked, so the address never reaches this process. The
subscription list masks it the same way and compares an exact search inside the function. There is
no route that changes an address at all (`OPS-DEC-009`), and naming one in a body is refused rather
than ignored.

**The KPI partition is one expression at one instant** (`OPS-DEC-014`), so the five status cards and
the three package cards each sum to the total by construction, and every card's filter returns
exactly what it counted. `Идэвхжээгүй` is outside the total by design (`OPS-DEC-013`).

**Suspension never pauses the calendar** (`OPS-DEC-016`). The append-only event snapshots
`starts_at` and `expires_at` on both sides, so the rule is checked by comparing two rows; the hotel's
staff scope grants are revoked and no other hotel's are; nothing auto-reactivates.

**Nothing sends an SMS but a person confirming a preview** (`OPS-DEC-010`).
`confirmed_by_account_id` is `NOT NULL`, the preview stores the hash of the body and of the resolved
recipients, and one message per phone per job is a unique index. Delivery is one-way, with no inbound
route and no callback route of any kind.

Traceability v1.32 (sixteen decisions; **279 of 279 `COVERED`**); assumptions `A-P19-1`…`A-P19-11`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 19 `operation/domain/operation` unit suite | 23 passed |
| `operation.integration` / `operation.concurrency` / `operation.security` / `operation.http` | 21 / 6 / 15 / 7 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 346 / 146 / 559 / 81 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 2,496 / 88 / 41 / 16 / 51 |
| `@prsystem/ports` / `@prsystem/authz` unit | 65 / 943 |
| worker `test:unit` | 21 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| the eight governance validators on the final tree | all exit 0; governance 17/17, drift fixtures 313/313 |

**One kernel assertion was re-stated, and one Phase 05 guard sharpened.**

- `sec-rls`'s tenant-bearing rule asserted that every `platform` table carrying `hotel_id` is
  `TENANT_RLS`, with one named exemption. Phase 19's `sms_recipient_message` carries `hotel_id`
  because a platform reminder names the hotel it was sent to, and the row belongs to the Operation
  realm. The assertion now names each exemption per table with the class that protects it, and
  `validateClassification` — which the same suite runs — checks that class: RLS enabled and forced,
  every policy comparing `platform.current_realm()`, and no runtime role but the API's holding
  anything on it.
- `platform.hotel_subscription_guard` required `billing_revision` to increase on every update, which
  was right while every update was a billing one. A suspension is not, and bumping the revision would
  stale an outstanding renewal quote that names the current one. The guard now requires the increase
  when a billing-bearing column moves and refuses a decrease otherwise (`A-P19-4`).

**Four new tenant-row fixtures** were added for the Phase 19 `TENANT_RLS` tables, each producing a
row the database would otherwise accept, so the RLS and ACL suites test the policy rather than a
NOT NULL constraint.

**The governed battery** ran in a clean detached checkout of the Phase 19 implementation commit
`e913a9a` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. **All 28 executions exited 0 on the first attempt.** Exit codes and durations are
in [`phase-19-battery-log.md`](phase-19-battery-log.md), results in
[`phase-19-evidence.json`](phase-19-evidence.json), restated in the Phase 19 record.

**`pnpm run audit:tree` is unchanged from Phase 18**: three moderate advisories, `DSR-01` and
`DSR-02`, both contained and both due for review in Phase 22. `pnpm run audit:prod` is clean and the
gate's threshold is unchanged.

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once. Every count above is from a serial run.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 18 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 19 discharged three of the five items the last checkpoint named of it** and left two open
for a reason that has not changed:

- The **Police account provisioning surface** is *not* one of them and stays open in a narrower
  form: doc 13 §5.1's Admin-creates-account screen is a portal, and portals are Phase 21. The
  service and the four-digit bootstrap exist and are tested.
- **Administering a commission contract** and **reviewing a `HELD` or `ADJUSTMENT_DUE` payable**
  (both `A-P14-1`) need a permission doc 18 §5 does not name. Phase 19 did not invent one
  (`A-P19-11`). Closing either needs an approved decision, not an implementation.
- The **Restaurant Manager invitation flow** (`A-P15-2`) is Phase 04's existing
  `hotel.restaurant.manager_invite` and needs only a screen — Phase 21.
- The **Operation screens** for the Phase 16 moderation queue, the Phase 19 dashboard, the SMS tab
  and the contact change are all Phase 21's: every one of their APIs now exists.

**Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
`CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling on
the worker's queues the two settlement jobs, the Phase 13 expiry sweep, Phase 15's invoice-expiry and
refund-SLA sweeps, and Phase 18's two Police sweeps — nine service methods with tests and no
scheduler entry yet. Phase 19 adds a tenth: **the SMS delivery-status refresh**, which is an
Operation-realm command with a route rather than a queue, because doc 14 §5.4 forbids a scheduler
from *sending* and says nothing about one asking a provider what happened. Wiring it is Phase 20's
or Phase 22's, alongside the other nine.

**`EXT-05` bounds what the SMS tab can be.** The tariff table is empty, so no cost estimate is
shown; the segment count follows the two capacities doc 14 §5.3 publishes and is labelled an
estimate; there is no callback route because no signature scheme is approved; and with the production
adapter disabled a confirmed send records every recipient message `FAILED` with the gate as its
reason. `INT-MAIL-01` bounds the enrolment link, the reset delivery and the contact notice the same
way.

Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 19 battery checkout was removed after its run, so
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

- Unchanged and still open: `EXT-01`, `EXT-02`, `EXT-03`, `EXT-04`, `EXT-06`, `EXT-07`, `EXT-08`,
  `EXT-09`, `EXT-10`, `EXT-11` (BLOCKED, conformance-gated simulators), `INT-OTP-01`,
  `INT-MAIL-01`, `INT-STORAGE-01`, 17 P1 configuration items, and selecting `GATE-SEC` as a required
  GitHub status check.
- **`EXT-05` (CallPro) is now consumed by two phases and stays BLOCKED.** The endpoint, the
  authentication scheme, the callback signature, the segment algorithm and the tariff are all
  unapproved. What that costs is written into the behaviour rather than around it: no cost estimate,
  no callback route, and a confirmed send that records every message as undelivered.
- **The Phase 19 offline verification surface is no longer a pending item — it is a recorded
  boundary.** doc 14 §2.2 keeps email-ownership recovery outside the MVP, so what exists is a
  two-person handoff that records a decision and changes no address. The procedure the decision
  follows is a production support and security document the customer still owes.
- **Two Operation surfaces need a doc 18 §5 row before they can exist**: the commission contract and
  the payable review (`A-P14-1`, `A-P19-11`). This is a requirement decision, not an implementation gap.
- **`DSR-01` and `DSR-02` are unchanged** and both due for review in Phase 22.
- **Three Police items are still recorded for the customer's attention**: the full registration
  number in a Match SMS, the all-hotel check-in list, and the four-digit bootstrap exception.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 20 — External adapters — is the current phase and is authorized to begin under the standing
authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md` (current
position, ledger, the Phase 18 and 19 records), `build-plan.md` §"Phase 20", and
`external-integration-gates.md` in full — that register, not the build plan, is what decides which
adapters may be enabled at all. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 20/,/^### Phase 21/p' docs/implementation/build-plan.md
```

Begin from the gate register, not from the adapters. Phase 20 owns no DEC ID: its scope is eleven
external systems whose contracts, credentials and signature rules are mostly still missing, and the
phase's honest output is a set of adapters that are *either* enabled with their gate cleared *or*
explicitly recorded as still blocked. An adapter written against an invented endpoint would be worse
than no adapter, and CLAUDE.md §9 says so directly. Expect most of the eleven to stay disabled, and
expect the phase's real work to be the conformance suite that proves a disabled adapter fails closed.
