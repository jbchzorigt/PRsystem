# Autonomous checkpoint — Phase 18 complete, Phase 19 authorized

**Written:** 2026-09-09, at the close of Phase 18 under the standing progression authorization.
**Status of this document:** a handoff. It records what is true in the checkout, not what was
intended. Nothing below claims a gate that was not run.

**Phase 18 needed one commit.** Its governed battery passed on the implementation commit at the
first attempt, all 28 executions exiting 0 — as Phases 09 to 12, 14, 15 and 17 did. Phases 08, 13 and
16 each needed a correction first. Implementation completion is not customer acceptance and not
release approval.

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
| Phase 18 commits | implementation `3758aeb345a84242222657496ea290736de6ad98` (the measured tree) |
| Phase 18 record commit | the commit that carries this checkpoint (see `git log -1`) |

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
| 19 — Platform Operation | `NOT STARTED` | — (authorized to begin) |

The standing progression authorization of 2026-09-03 is unchanged: implementation authorization for
Phases 06–23, sequential; not acceptance, not release approval, no gate weakened. Phases 06 to 18
are the entries of `PROGRESSED_PHASES`; governance check 17 holds each manifest, governed entry and
record to one another.

## 3. What Phase 18 delivered

See the [Phase 18 record](phase-status.md#phase-18-record). Migration `0019_police_monitoring` puts
the first rows in the `police` schema, which had been empty since the kernel so that the separation
would be a database fact before it was a feature.

**A person, a case and a match are three things** (`POL-DEC-017`). A Wanted Person is an identity
and holds no `FOUND` or `CLOSED` state; a Wanted Case is one legal basis with its own lifecycle; a
Match is unique on `(stay_id, wanted_person_id)`, which is what makes a replayed event, a second
worker or a retried job produce one alert.

**Matching is exact, or it does not happen.** Two keyed tokens of one registration number, of the
same namespace and the same key version. There is no fuzzy path in the schema for a name, a birth
date or an address to travel down, and a passport, another government id or no document has no
exact-match path at all.

**Nobody owns a match** (`POL-DEC-016`, `POL-DEC-020`). No `responsible_user_id`, no assignee, no
transfer — not as a nullable column and not as a state. The first acknowledgement is an audit fact
that confers nothing.

**Two people, compared on account ids.** A manual identity, a Found correction and a False Match each
need a second account, checked by the pipeline, by the service and by a CHECK on the row. A False
Match cannot be approved over a Found.

**Three functions cross between the hotel world and the Police one, and nothing else does**
(`A-P18-3`). The worker may call two of them and holds no privilege on any Police table; the Police
role may name the platform schema and holds only the account, idempotency and outbox tables it signs
in and issues commands with — no stay, no folio, no booking, no guest.

Traceability v1.31 (twenty-three decisions; 263 of 279 `COVERED`); assumptions `A-P18-1`…`A-P18-13`.

## 4. Working tree at this checkpoint

Everything is committed except the untracked
`docs/implementation/phase-03-eighth-repair-checkpoint.md`, preserved as untracked. Build artefacts
(`dist/`, `openapi.json`, `.turbo/`) are ignored.

## 5. Tests — what was actually run, and where

**Development-time runs (this worktree, the repository's own Compose stack).** All exit 0:

| Command | Result |
| --- | --- |
| Phase 18 `police/domain/police` unit suite | 14 passed |
| `police.integration` / `police.concurrency` / `police.security` / `police.http` | 13 / 5 / 10 / 8 passed |
| api `test:unit` / `test:security` / `test:integration` / `test:concurrency` | 323 / 131 / 531 / 75 |
| `@prsystem/db` `test:migrations` / `test:security` / `test:unit` / `test:integration` / `test:concurrency` / `test:regression` | 148 / 2,425 / 88 / 41 / 16 / 51 |
| `@prsystem/ports` / `@prsystem/authz` unit | 65 / 943 |
| worker `test:unit` / `test:integration` / `test:security` | 21 / 2 / 8 |
| `pnpm run lint` / `typecheck` / `format:check` | exit 0 |
| the eight governance validators on the final tree | all exit 0; governance 17/17, drift fixtures 301/301 |

**Three kernel assertions had to be re-stated rather than satisfied**, because Phase 18 is where the
thing they anticipated actually happens.

- `sec-police-isolation` asserted that *no* principal spans the platform and police schemas. Two now
  do, and the test asserts the sharper rule instead: the worker may name the police schema and holds
  no privilege on any table in it, and the Police role may name the platform schema and holds
  privileges on exactly eight account, idempotency and outbox tables — the list is exact, not a
  subset.
- `sec-rls` asserted that the Police realm is refused at the platform sentinel. Its work is
  platform-wide by nature, so the test now asserts which realms are admitted and why the sentinel
  still widens nothing there.
- The ACL matrix gave the Police role no grants at all. It now names the four platform tables the
  realm reads and writes through the kernel, with a comment for each.

**One fixture defect was found and fixed.** The `restaurant_schedule` ACL fixture chose a weekday by
`sequence % 7`, which collided with a seeded row as soon as the sequence shifted. It now picks the
next unused weekday.

**The governed battery** ran in a clean detached checkout of the Phase 18 implementation commit
`3758aeb` with a fresh install, a fresh `TURBO_CACHE_DIR` and `TURBO_FORCE=true`, after a preparatory
`pnpm run build`. **All 28 executions exited 0 on the first attempt.** Exit codes and durations are
in [`phase-18-battery-log.md`](phase-18-battery-log.md), results in
[`phase-18-evidence.json`](phase-18-evidence.json), restated in the Phase 18 record.

**`pnpm run audit:tree` moved from one moderate to three.** The new pair is `GHSA-82fw-gwwq-j7x9`,
published after the Phase 17 battery of 2026-09-06, and it is registered as `DSR-02`: dev-only,
unreachable because no suite declares a module mock, patched only in a Vitest major, and due for
review in Phase 22. `pnpm run audit:prod` is clean, and the gate's threshold is unchanged.

**Still true of how these runs must be made.** The api and db suites must not run against the same
PostgreSQL cluster at once. Every count above is from a serial run; one api security suite failed
once under a parallel run and passed on its own, which is that same contention.

**Historical evidence (unchanged, not re-measured):** the Phase 03 to 17 batteries and the Phase 05
CI ledger are frozen records of earlier trees.

## 6. Integration obligations now open on later phases

**Phase 18 discharged what the last checkpoint named of it.** `stay.checked_in` is consumed exactly
as Phase 08 emits it, and the retention purge's effect on matching is asserted rather than assumed:
an anonymised stay is marked `NOT_ELIGIBLE_EXACT_RD`, so it has no registration number left to match.

- **Phase 19 (Platform Operation)** carries the same four open items, unchanged: an Operation surface
  for administering a commission contract and one for reviewing a `HELD` or `ADJUSTMENT_DUE` payable
  (both `A-P14-1`); the Restaurant Manager invitation flow, which is Phase 04's existing
  `hotel.restaurant.manager_invite` (`A-P15-2`); and the Operation screens for the Phase 16
  moderation queue, whose API exists and whose portal does not. Phase 18 adds a fifth: the **Police
  account provisioning surface**. The service and the four-digit bootstrap exist and are tested, and
  no HTTP route creates a Police account — the first Police Admin is a deployment concern, and doc 13
  §5.1's Admin-creates-account screen belongs to a portal Phase 19 owns.
- **Also open, and recorded rather than assumed:** wiring Phase 09's overdue-conflict
  `CANCELLED_HOTEL` resolution to the booking command Phase 14 added (`A-P14-11`), and scheduling on
  the worker's queues the two settlement jobs, the Phase 13 expiry sweep and Phase 15's
  invoice-expiry and refund-SLA sweeps — five services with tests and no scheduler entry yet. Phase
  18 removes nothing from that list and adds nothing to it: its matcher is wired into the worker
  deployment on its own queue, as Phase 17's three sweeps are.
- **Two Police sweeps are implemented and not yet scheduled**: the stale-location sweep and the SMS
  delivery drain. Both are service methods with tests, called by the Police module rather than by a
  queue, and both belong on the worker's queues when Phase 19 or 22 wires the outstanding five.
- **`EXT-09` and `EXT-10` bound what Phase 18 can be.** The escalation timer and the Police Admin's
  historical check-in search are configuration rows that do not exist, so neither runs; the
  four-digit bootstrap and the full-registration-number SMS are security exceptions ЦЕГ has not
  approved. All four are Phase 20 gates and none of them is a code change.
- Every phase that resolves a lifecycle blocker keeps calling `LifecycleService.finalizeIfClear`.

## 7. Processes, containers and services

- **No task-owned process is running.** The Phase 18 battery checkout was removed after its run, so
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
  `EXT-11` (BLOCKED, conformance-gated simulators), `INT-OTP-01`, `INT-MAIL-01`, `INT-STORAGE-01`,
  the Phase 19 offline verification surface, 17 P1 configuration items, and selecting `GATE-SEC` as a
  required GitHub status check.
- **`EXT-05` (CallPro) is now consumed and stays BLOCKED.** The canonical `SmsPort` and its
  deterministic simulator exist; the production adapter answers `DISABLED`, so a Match alert's SMS is
  recorded as undelivered rather than sent. The endpoint, the authentication scheme, the callback
  signature and the segment billing are all still unapproved.
- **`EXT-09` (ЦЕГ) and `EXT-10` (Police security) are what this phase is most bounded by.** Four
  things wait on written approval and none of them is a code change: the escalation minutes; the
  check-in retention period that enables the historical search; the four-digit bootstrap security
  exception; and the legal basis for putting a full registration number in an SMS. The first two are
  configuration rows that do not exist, so the features do not run.
- **`DSR-02` is new.** `GHSA-82fw-gwwq-j7x9` affects Vitest below 4.1.11; the workspace pins 3.2.7.
  It is a devDependency, unreachable without a module mock, and patched only in a major upgrade that
  is a change of its own. Recorded, contained and due for review in Phase 22.
- **Three items are recorded for the customer's attention.** A Match SMS carries a person's full
  registration number to a phone (`POL-DEC-009`), which is a deliberate exception ЦЕГ must accept in
  writing. The all-hotel check-in list shows every hotel's guests, unmasked, to a Police Admin
  (`POL-DEC-010`), which needs its own written legal basis. And a four-digit bootstrap code is ten
  thousand guesses (`POL-DEC-022`): every compensating control doc 13 §5.3 requires is implemented,
  and the exception itself is still unapproved.
- The main-checkout reconciliation of §1 remains the one decision this checkpoint asks of the
  customer.

## 9. Exact next action

**Phase 19 — Platform Operation — is the current phase and is authorized to begin under the standing
authorization.** Before editing: reread `CLAUDE.md`, this checkpoint, `phase-status.md` (current
position, ledger, the Phase 17 and 18 records), `build-plan.md` §"Phase 19", and the requirement
files that phase assigns; list its owned DEC IDs from `requirements-traceability.md` §2 and the
family tables. Then verify `git status` matches §4.

**The exact next command.**

```
cd /Users/zorigtgantumur/Documents/Work/prsystem/.claude/worktrees/prsystem-phases-06-23-d506eb \
  && git log --oneline -3 && git status --porcelain \
  && sed -n '/^### Phase 19/,/^### Phase 20/p' docs/implementation/build-plan.md
```

Begin from the permission model, not from the screens. doc 14's Operation actions are
explicit-grant-only with step-up — a role name grants nothing — and the five open items §6 lists are
Operation surfaces over commands other phases already built. Establishing which named permission
each screen runs under, and which of them are new rows of doc 18 §5, decides most of the phase before
any dashboard is drawn.
