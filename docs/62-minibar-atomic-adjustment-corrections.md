# Atomic minibar stock adjustment correction

Accepted source: `8da79f221399e55a3b3574bf0c05543425cd3795`.
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34558835222):
**744/744 backend tests without skips in 833.251 seconds**, including the
30-test adjustment gate (50.055 seconds). All focused PostgreSQL gates,
15 Chromium suites and 102 actual browser/API command checks passed. Strict local
UI audit had zero findings; design/token CI passed with six pre-existing design
warnings. Local discovery passed 106 tests with 638 database skips; full database
acceptance is the linked CI run. Chromium was unavailable locally; browser
validation and screenshot generation ran in CI. The screenshot artifact download
returned HTTP 403 locally, so no local visual inspection is claimed.
The preceding 736-test milestone is documented in [61](61-minibar-stock-adjustments.md).

Manager can correct an inventory adjustment with one command. The server first
reverses the original movement at its exact original cost, then posts the correct
WASTE, COUNT_PLUS, COUNT_MINUS or RETURN at the restored stock's weighted average.
Product, room and stay remain the original movement's scope. Changing that scope
requires a separately designed workflow. Neither side edits historical records.
Both receipts, the immutable correction source, audit and idempotency result commit
together. Failure of replacement or deferred database proof rolls back everything.

The command checks current Manager/package authority before replay, stock revision,
physical location quantity and exact current stay. Already reversed sources and
reversals cannot be corrected; a replacement may itself be corrected by a new
linked command. Posted-report locks and zero-stock valuation constraints remain.
Intermediate reversal must satisfy existing stock/value bounds. This operation
cannot bypass an otherwise invalid original-cost reversal.

Migration 061 adds a forced-RLS immutable correction source and an optional link
from its two adjustments. Deferred database proof requires the original reversal,
matching product/location/stay/actor/reason, exactly two linked adjustments and
consecutive stock receipt revisions. The source timestamp is server-generated.
Runtime correction adapters need SELECT/INSERT on minibar_adjustment_correction
in addition to the document-61 stock adjustment grants. No UPDATE/DELETE grants
are required. Existing readers continue using their current stock grants.

POST /hotels/{tenant}/minibar/products/{product}/adjustment-corrections takes the
original adjustment ID, replacement kind/quantity, reason, original room/stay,
expected stock revision/physical quantity and an idempotency key. The result links
the original, reversal and replacement. The Manager history exposes the correction
link and a native form with explicit effects and acknowledgement. Unknown-outcome
retry keeps the exact same payload/key. History remains bounded and tenant-scoped.

The additional PostgreSQL tests cover linked correction chains, atomic replacement
failure, original versus restored-average cost, room non-guest exclusion, posted
report lock, current authority, idempotency, stale preview, concurrency, tenant
isolation, immutable/incomplete source proof and deferred failure/retry. The
existing stock-adjustment Chromium suite also covers replacement and lost-response
retry at 320px. The linked CI run is the full acceptance evidence.

Paid/post-report minibar corrections still need payment allocation release and
service refund/new receivable integration at the locked stay price; this inventory
command does not create those financial effects. Configuration variance, shortage
override, partial physical rollback, Restaurant, Operation, Police and production
readiness remain. Approved development provider mocks remain unchanged.

Later extension: [returned unpaid report reconciliation](63-minibar-returned-report-adjustments.md)
permits stock adjustment only after explicit RETURN to REQUESTED and while unpaid
with no pending payment. Other posted-report locks remain. See document 63 for
the shared report-lock predicate and additional runtime SELECT grants.
