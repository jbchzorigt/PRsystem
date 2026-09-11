# Explicit room minibar rollout — accepted stage 5 increment

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

Accepted source: `62dd2f5199a57e5da83427dd55121b3bcaa93ccc`, tree
`82d82f9e518410aaf9e33cbfb896ad7647f1e5ef` (identical to local `0932262`).
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34425289850)
passed **598/598 backend tests without skips in 562.245 seconds**, including
all 13 rollout tests. All eight Chromium suites, 48 actual browser/API command
contracts, shared-token validation and design lint passed. Strict local UI audit
had zero findings; design lint retained six existing unused-token warnings and
zero errors. Desktop and 320px screenshots were inspected. The configured
e2e/accessibility command includes rollout.

Local discovery ran 100 tests and skipped 498 PostgreSQL-dependent tests;
the linked full CI supplies acceptance evidence. Browser scenarios cover disabled
no-op, preview retry, reason/acknowledgement, CAS reload, unknown-response key
retention, scheduled messaging and mobile layout. The feature source and CI
correction were published to `feat/approved-risk-controls` and Draft PR #1.

Multi-room batches, variance/override, partial physical rollback, canonical guest
opening/refill/report, product/template entity lifecycle, Restaurant and Operation
remain. The existing canonical ON guest-opening gate remains until that adapter
is implemented. External providers remain approved mocks. No merge/deployment.

## CI correction

Initial source `af81ae6cb0b3b7faec28885dcd2309d72e600425` executed all 597
backend tests without skips in 571.360 seconds: 596 passed, one failed.
[Initial CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34424434050)
identified a real assignment bug: readiness treated the rollout's own
automatically-created COUNT source as unfinished preceding work. Prepare now
loads the authoritative reconciliation source and excludes only that source
from the existing safe-room predicate. Other stay, payment, report and work
dependencies remain checked. A regression introduces a separate late refill,
verifies assignment is denied without changing the task, then completes that
dependency and verifies the original task is assigned and applied exactly once.
The existing end-to-end assign/count/apply test remains unchanged.
