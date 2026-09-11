# Minibar configuration count variance

Local implementation pending PostgreSQL and browser acceptance. The preceding
accepted source remains the 767-test paid-correction increment in document 64.

Business authority: docs/22 §§7–11 and docs/26 §§18–22. Current Manager at package
25,000/30,000 and Manager Plus at 30,000 resolve configuration count discrepancies.
Cleaner records immutable physical counts and completes assigned bounded transfers;
Reception does not approve waste or stock adjustment. Hotel Admin needs a separate
operational Manager role. Shortage override and partial physical rollback remain
outside this increment.

The Manager decision pins the request revision, counted product/posting, original
baseline, current physical quantity, stock revision, reason and actor. COUNT derives
a positive/negative adjustment from the recorded count; WASTE is valid only for a
decrease. The server determines quantity and does not accept a client replacement
count, charge or selling price. Existing average cost applies; a positive count at
zero hotel stock requires the Manager's explicit unit cost. No guest charge or cash
event is created. If a separate earlier adjustment already matches the physical
count, the decision records that reconciliation without duplicating stock movement.

A decision alone does not post inventory. Cleaner final confirmation commits the
approved adjustment, immutable decision posting, complete return/refill plan,
configuration application, task/blocker transitions, audit and command receipt in
one transaction. The original count and every superseded decision remain immutable.
Cancellation before application retains decision history and changes no inventory.
Application still requires all counts, resolved variance, full warehouse funding,
current exact target/version/lifecycle, a safe room and current assigned Cleaner.

Changing the pinned stock revision/physical quantity or losing the approving
Manager's current authority makes a pending decision stale. Manager must record a
new decision; Cleaner cannot silently adopt it or change the count. Account and
membership locks precede catalog/room locks during application; approving actors
are revalidated, and a concurrent new approval outside those locks is rejected.
Exact command retries return the original decision/application with no duplicate
movement. A failed adjustment or deferred database proof rolls back all effects.

Migration 066 adds forced tenant RLS and immutable decision/posting tables. The
decision trigger proves the request, original count, current inventory and Manager
authority. The posting trigger requires the latest valid decision and assigned
Cleaner. Deferred proof links each posting to a complete application and an exact
adjustment at the approved actor/reason/quantity/cost. A decision posting cannot
commit without application. The shared count proof also rejects physical drift
since an exact count, accounting for the current request's own transfers.

Runtime grants: reconciliation readers need SELECT on minibar_count_resolution and
minibar_count_resolution_posting. The Manager command needs INSERT on the decision
table; the application adapter needs INSERT on its posting table and the existing
minibar_adjustment/minibar_receipt/audit grants. Existing account/membership, request,
task, room and application grants remain. Immutable tables need no UPDATE/DELETE.
The Cleaner API does not gain a generic adjustment command; its source is the
validated Manager decision. Public Cleaner plans omit unit-cost values.

The existing shared Reception form, native select, table, feedback, dirty guard and
retry owners render the Manager decision in room reconciliation details. The form
shows recorded versus physical quantity, derived change, reason and confirmation.
Cleaner sees approval/expiry text and cannot complete a stale decision. Refresh
revalidates revisions; uncertain responses preserve the exact idempotency key.
No new visual tokens, URL state or persistent browser storage are introduced.

Eighteen new PostgreSQL tests cover negative/positive counts, waste, OFF return,
fractional and zero-stock cost, no-movement acknowledgement, cancellation, current
permissions/package, stale stock/revisions, concurrency/replay, immutable RLS
history, atomic failure and mismatched adjustment-proof rejection. The new browser
suite covers Cleaner count, Manager validation/native keyboard, read failure, CAS,
unknown-outcome retry, stale approval, reapproval, Cleaner application and 320px.

Local discovery: 785 collected, 106 executed successfully, 679 database skips.
Strict UI audit: zero findings; JavaScript syntax and token drift checks passed.
Chromium download timed out locally. GitHub upload was rejected by automatic
approval review; repository ownership/public status has since been verified, but
full acceptance is not claimed before an authorized publication and successful CI.

Historical post-checkout/financial-only correction, shortage override, partial
physical rollback, Restaurant, Operation, Police and production readiness remain.
Approved development provider mocks remain; this increment does not merge or deploy.
