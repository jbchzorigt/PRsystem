# Controlled SHORT opening for one next stay

Authority: docs/22 §8, docs/25 and docs/26 §§18–22. Implementation: migrations 068–069,
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
The exact-source CI status is recorded below; the previous accepted baseline is
790/790 in docs/65. Stage 5/6 is not complete: partial physical rollback, historical
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
this source payload to that public destination. At that point no upload, commit/ref change or PR
update was performed; remote remained `8737516f22e8758412b6596a7efa77555c5011aa`.

The blocked next action was to rebuild and publish the current payload without
force, then run the 24 focused PostgreSQL tests and complete 814-test regression.
These local results do not replace PostgreSQL execution.

The user explicitly authorized publishing these changes to public PR #1 and
completing CI in the follow-up message “зөвшөөрнө.” The publication block is resolved;
exact-source PostgreSQL validation is the remaining acceptance gate.

## Published CI follow-up — 2026-09-14

The approved source was published to PR #1. Initial CI
[34807128322](https://github.com/jbchzorigt/PRsystem/actions/runs/34807128322)
exposed two integration errors: the database-focused step had also been inserted
into the browser job, and the shortage plan used `b` for both a PL/pgSQL loop
variable and a baseline query alias. The first caused the browser job to fail;
the second failed all 24 focused tests at the initial task read, before approval.

The workflow-only correction is source `70868a90e31637c18bed7d4b510a32a115ff8703`.
Forward migration 069 disambiguates the baseline alias; published migration 068
is unchanged. Source `3a95ed86e0cbd012ca4ab1f7aaaf5a4ba556ba6c` is under
[CI 34807508176](https://github.com/jbchzorigt/PRsystem/actions/runs/34807508176).
Neither failed run is acceptance evidence.

That run passed 23/24 focused PostgreSQL tests in 49.816 seconds and all 18 browser
suites, 121 API command checks and design/token gates. The remaining test replaced
a static preview function with an ordinary bound function, causing TypeError before
it could exercise the database tampering guard. The fixture now preserves static
binding. Current source `96cc3bdba0a73e559d3795421bf3b581c19f134d` is under
[CI 34807672321](https://github.com/jbchzorigt/PRsystem/actions/runs/34807672321).

The latest source passed all 24 focused shortage tests and all 18 browser suites,
121 actual API command checks and design/token gates (zero errors, six existing
design warnings). The final full regression subsequently passed, as recorded below.

## Exact-source acceptance — 2026-09-14

[Source `96cc3bdba0a73e559d3795421bf3b581c19f134d`](https://github.com/jbchzorigt/PRsystem/commit/96cc3bdba0a73e559d3795421bf3b581c19f134d)
(tree `76d0823c51ab3d6bfb637e2b448805cf623df91a`) passed
[CI 34807672321](https://github.com/jbchzorigt/PRsystem/actions/runs/34807672321).

- **814/814 backend tests passed without skips in 920.267 seconds.**
- **24/24 focused shortage PostgreSQL tests passed in 41.649 seconds**, together
  with all ten existing focused database gates.
- **18/18 Chromium suites and 121 actual browser/API command checks passed.**
- Domain, design and token gates passed. Design lint has zero errors and six
  pre-existing warnings; local strict UI audit has zero findings. Local desktop
  and 320px screenshots were visually inspected.

This accepts the Manager review → atomic Cleaner application → one-use SHORT
opening flow, including immutable/RLS protections, authority and stock invalidation,
concurrent/idempotent commands, rollback, zero opening and locked-price refill
billing. The documentation follow-up changes no application code.

Stage 5/6 is still incomplete: historical post-checkout/financial-only correction,
partial physical rollback, Restaurant, Operation, Police and production readiness
remain. The user-approved development provider mock boundary is unchanged.
