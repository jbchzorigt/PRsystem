# Multi-room minibar rollout — stage 5 increment

Implements docs/26 §§36–38 with one exact Published version, independent room
requests and immutable confirmation history. Initial selection is 2–100 unique
rooms. A retry is a new linked batch selecting 1–100 prior skipped/cancelled
rooms; the single-room retry variant avoids stranding one unsuccessful child.
Current Default changes never retarget a batch or its accepted children.

## Confirmation and progress

Read-only preview returns each room's READY_NOW, SCHEDULE_AFTER_STAY or INELIGIBLE
result, current revision and server preview time. It creates no request, stock
movement or archive blocker. Preview time is advisory, not a durable preview token.
Confirmation independently checks current authorization, exact Published target,
product lifecycle and every selected room revision/eligibility. Missing or stale
rooms are SKIPPED with a reason; accepted rooms receive ordinary canonical rollout
requests, assignment blockers and their own scheduled/ready task lifecycle.

The bounded manifest, per-room results, seal, event and idempotency receipt commit
atomically. Per-room savepoints isolate known eligibility failures. An unexpected
infrastructure failure aborts the unpublished confirmation so the same command
can be retried. After acceptance each child's count, stock and application outcome
is independent: one shortage cannot undo another applied room. Successful replay
returns the original command result; clients reload current progress afterward.

Progress is derived from child requests and immutable skipped outcomes, never a
caller-writable batch state. It includes all selected/accepted and per-state
counts. No accepted rooms yields FAILED_VALIDATION; any accepted nonterminal room
keeps IN_PROGRESS; all selected rooms applied yields COMPLETED; all accepted rooms
cancelled yields CANCELLED; other terminal mixtures yield PARTIALLY_COMPLETED.
Cancellation checks a hash of current room outcome/revisions, cancels remaining
unmoved requests and their tasks, and leaves applied children untouched. Current
role/package/tenant checks precede replay on both mutations.

Retry validates same target and a subset of old skipped/cancelled rooms, then
rechecks current room conditions. It cannot reopen history or retry applied/live
children. Archived targets stay readable but cannot accept a new retry. Pending
children use existing archive dependency gates; a zero-accepted historical batch
adds no new live reference or blocker.

## Database and runtime privileges

Migration 049 adds forced tenant RLS to minibar_rollout_batch, minibar_rollout_result
and minibar_rollout_seal. Triggers reject history mutation, wrong/unselected child
lineage, target mismatch, appended results after sealing, missing results/orphan
children, and commit without the seal, matching actor receipt and audit event.
Snapshots and timestamps come from server state. Child lineage is part of the
existing immutable configuration request. No SECURITY DEFINER or owner runtime.

Add SELECT, INSERT on the three new tables to the application role, alongside
existing docs/50–53 configuration/reconciliation privileges. The configuration
request's new rollout_batch_id column uses existing table INSERT grants. Ordinary
non-batch writers return before querying batch tables in the new child trigger.
No UPDATE/DELETE privilege is needed on batch history. Tests exercise the actual
restricted role, tenant isolation, concurrent duplicate/competing requests,
partial eligibility, commit failure, revision conflicts and independent apply.

## API and Manager UI

POST `/hotels/{tenant}/minibar/templates/{template}/versions/{version}/rollout-batches/preview`
accepts room_ids and optional retry_of_batch_id. POST the same path without
`/preview` accepts rooms (room_id, expected_room_revision), reason, idempotency_key
and optional retry_of_batch_id. GET that path lists bounded keyset history
(default 20, maximum 50). GET `/hotels/{tenant}/minibar/rollout-batches/{batch}`
reads progress; POST its `/cancel-remaining` accepts expected_revision, reason
and idempotency_key. All are restricted to entitled Manager/Manager Plus roles.
Reception reads per-room pending requests through the existing read-only surface.

The shared native selection owner keeps up to 100 choices across 100-room pages,
with explicit current-page select, clear/remove controls, count and keyboard use.
Preview, progress, cancel and linked retry reuse existing forms and guards. Lost
responses preserve keys; stale progress requires explicit refresh. All selection,
IDs and input remain in memory. Archived version history stays accessible.

## Verification and remaining scope

Candidate: 622 discovered backend tests, 106 local tests passed and 516 PostgreSQL
cases require the full CI gate. New coverage: 18 database and six pure policy tests.
The ninth browser suite checks page selection retention, keyboard use, per-room
preview, reason/acknowledgement, unknown-response replay, cancel conflict, applied
preservation, one-room linked retry, history recovery, privacy and 320px layout.
Acceptance evidence is recorded after the complete PostgreSQL CI run.

This increment uses the existing atomic full-plan transfer adapter. Persisted
partial physical transfers and ROLLBACK_REQUIRED/ROLLED_BACK execution are not yet
implemented; their progress vocabulary is reserved for that later adapter. It
cannot claim partial physical rollback. Canonical guest opening/refill/report,
variance/override, product/template entity lifecycle, Restaurant and Operation
remain stage 5 work. External providers remain approved mocks. No merge/deployment.

## CI correction

Initial source c347f0126f4cf6c9a4472d3dd945ad5d80cc35d4 ran all 622 tests without
skips in 641.721 seconds: 607 passed, 14 failed and one errored. The failures were
batch confirmation paths: PostgreSQL SELECT FOR SHARE/UPDATE on immutable parent
history requires UPDATE privilege, which the deliberately restricted role lacks.
Migration 050 replaces those unnecessary parent locks with ordinary reads. A
parent cannot commit without its complete immutable seal, so another transaction
never observes an unsealed parent that it can append to. Operational room locks,
seal/lineage checks, RLS and immutable triggers remain. No UPDATE/DELETE grants
were added; the existing history regression now asserts both privileges absent.
A focused real-database batch gate precedes the complete CI regression to expose
this boundary promptly. Final acceptance remains pending.
