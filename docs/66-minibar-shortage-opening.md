# Controlled SHORT opening for one next stay

Authority: docs/22 §8, docs/25 and docs/26 §§18–22. Implementation: migration 068,
MinibarShortages, reconciliation, canonical opening and shared Reception UI.

Manager at 25,000/30,000₮ or Manager Plus at 30,000₮ may approve a shortage after
all physical counts and variance decisions are complete, while the room is CLEAN,
previous checkout is complete, and the exact target remains active/Published.
Reception and Cleaner cannot approve; Hotel Admin needs the operational role.

## Command and physical execution

`POST /hotels/{tenant}/minibar/configuration-requests/{request}/shortage-approvals`
accepts expected request revision, the server preview token, mandatory reason,
`physical_counts_reviewed: true`, and an idempotency key. It accepts no quantity,
price, cost, actor or target override. Preview includes every counted product,
physical quantity, exact target and server-derived quantity to place:
`min(target, actual count + available warehouse stock)`. Removed/excess products
must still return to their exact goal (zero for removed products).

Approval is immutable and creates no stock/cash/charge or usable opening permit.
It pins original count postings, current room/request/stock revisions, resolved
variance, warehouse quantity, target and previous stay. Cleaner refreshes and
confirms the complete physical plan. Its assigned transaction posts the shortage
link, approved variance adjustments, all transfers, exact configuration application,
one-use permit, audit and receipt together. Any failure rolls everything back.
There are no independently committed partial physical movements in this adapter.
Cancellation before application retains history and leaves stock unchanged.

Changed stock/room/counts/authority invalidates a pending approval. Manager reviews
the refreshed plan with a new key/revision. If stock becomes sufficient for the
complete target, ordinary full application succeeds without using the old exception.

## Check-in and billing

The resulting configuration retains full exact-version targets. Reception sees
**Дутуу — Manager зөвшөөрсөн**, reason, actor/time and the complete count/goal table.
The permit belongs only to this room/application and its next stay. Current Manager
permission, active Published dependencies, CLEAN/readiness, previous-stay identity,
room revision, and a room-local immutable movement stamp are rechecked. Movement
and reversal invalidate a permit even if net room quantity returns to its old value.
Unrelated warehouse purchases do not invalidate an unchanged counted room.

Existing walk-in and booking arrival use the same opening function. Account locks
include the approving Manager before catalog/room locks; changed approver identity
requires retry. The stay insert atomically consumes the permit through an immutable
unique use record with deferred matching-stay proof. Failed check-in consumes nothing.
The opening remains `stock_status: SHORT`; it stores the approval, actual quantities,
full target version and all check-in prices. A permit can never serve a later stay.
Normal historical/time/buffer/cleaning, booking/deposit and unrelated blockers remain.

Opening quantity zero is retained in the price book. Before documented active-stay
refill it has no billable availability. Later documented refill uses the original
check-in price. Generic positive stock adjustments still create no billable guest
availability; target quantities are never substituted for actual opening quantities.

## Runtime permissions and verification

Readers need SELECT on minibar_shortage_approval, minibar_shortage_posting,
minibar_shortage_permit and minibar_shortage_use under forced tenant RLS. Manager
commands need INSERT on approval; assigned reconciliation needs INSERT on posting
and permit; check-in needs INSERT on use. No UPDATE/DELETE on these four history
tables is needed or granted. Existing underlying inventory, room, staff, application
and stay privileges remain necessary for invoker-rights functions and guards.

Tests: test_minibar_shortages.py and tests/browser/minibar-shortages.cjs, plus full
PostgreSQL regression and actual browser/API request-model validation. The browser
covers reason/review validation, keyboard, loading/retry, CAS/discard, uncertain
approval/application retries, stale approval, Reception read-only and 320px.
Acceptance is pending exact-source CI; the previous accepted baseline is 790/790
in docs/65. Stage 5/6 is not complete: partial physical rollback, historical
post-checkout/financial-only correction, Restaurant, Operation, Police and production
readiness remain separate work.

## Local verification and publication block — 2026-09-14

Local tested code: `4b723da3d4309921597f422f10c857e0823dbb2e`
(tree `598cd7edbe67f73f879c146b6d3d8b164caa46d0`).

- All 18 configured Chromium/e2e/accessibility suites passed locally, including the
  new shortage flow; 121 actual browser commands passed API model validation.
- Desktop and 320px shortage screenshots were visually inspected. Strict UI audit
  reports zero findings; existing token export check, Python/JS syntax and SQL
  grammar parsing pass. No design token or shared geometry changed.
- Local domain run: 814 discovered, 106 passed, 708 skipped without PostgreSQL.
  The 24 new database tests are among the skipped tests and are NOT accepted yet.
- The warehouse browser exposed a late submit on a detached completed form. The
  shared form now ignores detached submit events; the browser test explicitly
  dispatches one after successful navigation and confirms no extra command.

GitHub automatic approval review rejected the tree upload twice. The second
rejection followed verification that authenticated jbchzorigt owns the public
jbchzorigt/PRsystem repository with push/admin access, and that local baseline tree
matches PR #1 head. Review still requires explicit user authorization to publish
this source payload to that public destination. No upload, commit/ref change or PR
update was performed. Remote remains `8737516f22e8758412b6596a7efa77555c5011aa`.

After explicit authorization: rebuild the payload from the current local HEAD
against the unchanged PR branch, publish normally without force, run the 24 focused
PostgreSQL tests and complete 814-test regression, fix any failures, then record
exact-source acceptance. These local results do not replace PostgreSQL execution.

The user explicitly authorized publishing these changes to public PR #1 and
completing CI in the follow-up message “зөвшөөрнө.” The publication block is resolved;
exact-source PostgreSQL validation is the remaining acceptance gate.
