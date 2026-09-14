# Historical minibar billing correction

Authority: docs/25 §8.2 (snapshot-priced quantity corrections after payment),
docs/22 §6.1 (financial waiver does not reverse missing physical stock), and the
existing Manager/Manager Plus, settlement/refund and immutable-history contracts
in docs/20, docs/24, docs/25 and docs/64. This increment covers canonical reports
on CLOSED stays. The active-stay physical replacement remains in docs/64.

Manager/eligible Manager Plus reviews the original report and current billed
quantities, records a reason and explicitly acknowledges a financial-only change.
Every product is from the original immutable report/price book. The server derives
line amounts from its locked unit price and bounds quantities by the report's
recorded billable availability. Current product name, price, lifecycle, room stock
and subsequent guests are never used to reprice or rewrite historical inventory.
Zero opening without recorded refill cannot become billable through this action.

The immutable billing revision links the original report, previous correction,
old/new charge, released allocations, receipt credit, actor/name, reason and server
time. It does not alter the physical report, consumption/COGS, stock, room state,
configuration, Cleaner tasks, stay or checkout snapshot. A prior financial waiver
starts with zero billed quantities; changing it requires an explicit new correction.

One transaction releases still-effective allocations, credits the old charge,
creates the replacement receivable and reapplies released funds in stable
receipt/allocation order up to the new total. Excess remains refundable on each
original receipt. DEPOSIT allocation and PAYMENT service-credit counters retain
their distinct meanings. No automatic cash collection, refund or provider dispatch
is created. Further corrections append a new revision, including from a zero total.

Reception settles only the current linked historical correction charge through
existing cash/POS/provider-intent and deposit-allocation routes, with current shift,
finance revision, original source/reference and duplicate guards. Other closed-stay
charges remain unavailable for new collections. Refunds retain the original receipt,
drawer/channel, reservation, approval, proof and late-result reconciliation rules.
The stay is never reopened. Provider integrations keep the approved development
mock boundary; production continues to reject mock provider evidence.

Stale report/billing/finance revisions, unchanged quantities, foreign products,
invalid quantities/prices, frozen finance, pending minibar payment or receipt
correction reject the command. Current Manager authority and existing-obligation
subscription rules are rechecked. Exact retry precedes stale-revision checks after
authorization. Stay/finance serialization and immutable unique revisions prevent
duplicate releases. Database guards independently derive the billing snapshot;
deferred proof validates the charge, all releases/reallocations and receipt/service
credit projections. All three new history tables have forced tenant RLS and reject
UPDATE/DELETE.

Runtime readers need SELECT on minibar_billing_correction, minibar_billing_release
and minibar_billing_reallocation. The writer needs INSERT on those tables, existing
canonical report/checkout/staff read grants, finance/receipt/charge projection grants,
allocation/charge-adjustment/audit INSERT grants and the existing paid-release and
paid-reallocation SELECT grants. No UPDATE/DELETE on billing history is needed.

API: GET minibar/billing-stays (bounded closed-stay list, no guest PII), GET
stays/{stay}/minibar-billing (current basis and revision-keyset history), and POST
stays/{stay}/minibar-billing-corrections (quantities, three expected revisions,
reason, financial_only_reviewed: true, idempotency key).

Implementation and exact-source CI acceptance are pending. The prior accepted
baseline is 814/814 backend tests, 18 browser suites and 121 API command checks
in docs/66. Tests in test_minibar_billing.py exercise the new real PostgreSQL path.
Stage 5/6 also retains partial physical rollback, Restaurant, Operation, Police
and production readiness. This increment does not provide retroactive physical
inventory edits or remove those remaining implementation gates.
