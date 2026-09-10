# Explicit room minibar rollout — stage 5 candidate

Implements docs/26 §§33–35 at the existing full-plan reconciliation boundary.
Manager selects an exact Published version and one physical room. Preview is
read-only and returns READY_NOW, SCHEDULE_AFTER_STAY or INELIGIBLE with a stable
reason. Confirm repeats current role/package/tenant, room/category lifecycle,
ON mode, same-template/different-version, Published/product and pending checks.
No-op, foreign, inactive or mock configurations cannot become rollout targets.

The ordinary configuration command remains available for changing template or
ON/OFF mode. Explicit rollout writes request_kind=ROLLOUT with immutable server
source/target snapshots. Request, source-backed check-in/assignment blocker,
initial ready task (when safe), room revision, event and receipt commit together.
Current configuration, stock, prices, stay/booking snapshots and cleanliness do
not change at confirmation. Existing archive blockers retain both exact versions.

## Safe point and assignment

Migration 048 materializes an unassigned canonical Cleaner task and COUNT plan
exactly once when durable checkout, payment/correction, minibar report and prior
refill/count dependencies are terminal. Active stays and unfinished dependencies
keep the request scheduled without a task. Database triggers on the persisted
terminal sources advance the request; no client ready flag or GET mutation is
used. A scheduled transition carries original requester, exact target, task and
server time in an immutable system-transition event.

Only canonical rollout tasks may have no assignee. They confer no staff authority
and do not appear in a Cleaner's queue. The existing Manager prepare command
validates the current Cleaner and atomically assigns that task, registers open
work and advances the request to IN_PROGRESS. Ordinary tasks still require an
assignee. Suspension/continuation retains the established assignment version and
source. Reads show the pending request to Reception; only Manager can assign or
cancel. Final physical counts/transfers/application use the existing target,
source, lifecycle, variance, shortage and atomic proof checks.

Pre-apply cancellation closes assigned or unassigned tasks and clears only its
own blocker. No pending request can have committed partial transfers in this
adapter. Applied rooms require a new explicit request to return to a prior
eligible version; historical pointers and movements are never overwritten.

## API and grants

GET `/hotels/{tenant}/minibar/templates/{template}/versions/{version}/rollout/{room}/preview`
and POST the same path without `/preview`. The command accepts only
expected_room_revision, reason and idempotency_key. Preview facts are advisory;
confirmed exact IDs are pinned. Current authorization precedes idempotent replay.

Use the existing configuration/reconciliation privileges from docs/50–51. All
operational writers of safe-point sources additionally need SELECT on
minibar_configuration_request. Writers that can resolve an actual scheduled
rollout need SELECT on room/stay/checkout/payment/correction/inspection/action,
canonical product/transfer and reconciliation sources; INSERT on cleaning_source,
minibar_reconciliation, cleaning_action, cleaning_task and operational_event;
UPDATE(state,revision) on configuration requests and existing blocker grants.
These are invoker functions with forced tenant RLS, not SECURITY DEFINER bypasses.
The runtime must use its application role, never migration credentials.

## Verification and remaining scope

Candidate has 12 new database/API tests plus the dedicated rollout browser suite.
Local discovery: 100 executed, 497 PostgreSQL-dependent tests skipped (597 total).
All eight Chromium suites and 48 browser/API commands passed on 2026-09-10.
Shared-token validation and strict UI audit passed (zero findings). The required
e2e/accessibility command now includes rollout. Desktop/mobile screenshots were
inspected. Full PostgreSQL CI is required before acceptance. Browser scenarios cover disabled
no-op, preview retry, reason/acknowledgement, CAS reload, unknown-response key
retention, scheduled messaging and 320px layout, with real API model validation.

Multi-room batches, variance/override, partial physical rollback, canonical guest
opening/refill/report, product/template entity lifecycle, Restaurant and Operation
remain. The existing canonical ON guest-opening gate remains until that adapter
is implemented. External providers remain approved mocks. No merge/deployment.
