# Stage 5 — pending room minibar configuration

2026-09-09. Implements the request/blocker and pre-movement cancellation portion
of docs/26 §§14–22. Warehouse receipts and template authoring remain the two
accepted complete packages. The larger room reconciliation package is partial.

## Implemented boundary

- Manager at 25,000/30,000₮ and Manager Plus at 30,000₮ request ON with an exact
  eligible Published template/version, or OFF for an existing configured room.
  Hotel Admin and Reception can read; a separate Manager role is needed to write.
- The server/database pin source room revision/mode/category and the exact target
  template name, version and immutable published product/quantity snapshot.
  Later Default changes cannot retarget an existing request.
- One pending request per room. An active stay yields SCHEDULED_AFTER_STAY;
  otherwise READY_FOR_RECONCILIATION. These are captured request states, not proof
  that checkout, stock reconciliation or physical readiness has completed.
- The same transaction creates the authoritative MINIBAR_CONFIGURATION blocker,
  increments the room revision, records an immutable audit and saves the command
  receipt. Existing stays, reservations, prices, finance and stock stay intact.
- New walk-in (including backdated arrival), physical booking and category
  assignment/capacity exclude the room. PostgreSQL also blocks new stay/reservation
  insertion and reassignment/reactivation while pending. Existing stay completion
  remains possible. Generic mock configuration and category reassign cannot bypass
  the request. Cleanliness remains a separate readiness dimension.
- Cancellation requires current Manager authority, reason and request revision.
  It atomically preserves CANCELLED history, clears only its own blocker and
  completes eligible waiting room/category retirement. Exact retries cannot
  resurrect a cancelled request. The schema exposes no movement/apply transition.
- Forced tenant RLS, composite lineage, immutable request/target identity,
  source-consistent blockers, catalog/room locks, CAS and pre-replay permission
  checks protect concurrent requests, check-in, cancellation and audit rollback.
- Shared Manager exact-version room chooser, reason/acknowledgment, room pending
  facts, read/cancel/OFF forms and Reception read-only detail. History and chooser
  are bounded, with load recovery, stale-response guards and private in-memory
  state. There is no physical completion button.

## API and grants

All paths are below `/hotels/{tenant_id}`:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/rooms/{room_id}/minibar-configuration/requests` | Exact ON/OFF request |
| GET | `/rooms/{room_id}/minibar-configuration` | Current, pending, bounded requests |
| POST | `/minibar/configuration-requests/{request_id}/cancel` | Pre-movement cancel |

Migration 045 is additive. In addition to docs/48–49 and existing Reception
roles, the restricted application role needs SELECT/INSERT on
`minibar_configuration_request`, UPDATE(state,revision,cancelled_by,cancel_reason,
cancelled_at) on that table; SELECT/INSERT and UPDATE(state) on
`reception_dependency_blocker`. Existing room/category/product row-lock, room
revision, stay read, staff receipt/audit and retirement-function grants are
required. Room readers and assignment writers require SELECT on the blocker.
No request DELETE, target/source snapshot UPDATE or stock mutation grant is added.
The role must not own tables or bypass RLS.

## Verification candidate

16 new PostgreSQL tests cover pinned targets, OFF/mock isolation, new assignment
and backdate blockers, existing booking/stay retention and settled checkout,
capacity release, request/check-in concurrency, CAS/retry, revoked authority,
strict inputs, RLS, DB guards, retirement and injected commit rollback.
Local discovery: 553 tests, 100 executed and 453 skipped because PostgreSQL is
unavailable in this runtime. Full PostgreSQL CI is required for acceptance.
All five local browser suites pass; the extended template suite exercises 14
commands against actual API models. Strict UI audit has zero findings, shared
token checks pass and mobile screenshots were inspected. Remote source/run and
final result will be recorded after CI.

## Remaining room package work

Physical safe-point rechecks and generated Cleaner reconciliation tasks; actual
counts and variance decisions; canonical warehouse/room transfers; shortage and
allowed exception handling; posted-movement rollback on cancellation; atomic
current configuration switch; archived/product lifecycle and canonical guest
opening/price/refill integration remain unimplemented. An active-stay request
must eventually wait for real checkout/report/payment/refill terminal evidence,
not a clock deadline. Future movement APIs must replace the pre-movement-only
cancel transition with movement-aware rollback. Legacy mock inventory must not be
imported into canonical balances. Stock requests currently remain pending until
cancelled or until the later reconciliation adapter is implemented.

Restaurant fulfillment, Operation, live providers/workers and production release
remain separate. This increment is not full stage-five completion or deployment.
