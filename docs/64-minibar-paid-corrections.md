# Paid minibar quantity correction for active stays

Implementation pending full PostgreSQL/browser acceptance. The preceding accepted
source remains the 751-test increment in document 63.

Manager/eligible Manager Plus can correct the physical counts of the current
canonical REPORTED, paid minibar report while the stay is ACTIVE. Reason, exact
report revision and finance revision are mandatory. Pending minibar payments,
frozen finance, another receipt correction, missing canonical report, unchanged
counts, foreign products, invalid counts or insufficient stock reject the command.
Historical post-checkout correction is outside this increment.

One transaction releases the current report's non-reversed payment allocations,
records immutable release evidence, restores the original consumption at original
cost and posts a new Manager exception report. Existing report machinery preserves
the stay selling-price snapshot, inventory/COGS evidence, physical count bounds,
old unpaid-charge reversal, task completion and audit. The correct replacement
consumption uses the weighted average after restoration. The original report,
payment receipt and allocations are not edited; their paid/allocated projections
are updated through the new linked records.

Released funds are reapplied to the replacement report in stable receipt/allocation
order, up to the replacement total. Excess becomes available credit on its original
receipt; a shortfall is an unpaid receivable on the new charge. No collection or
refund cash movement is invented. Existing Reception cash or routed refund reserve,
approval, original-drawer, provider evidence and completion rules execute a refund
separately. PAYMENT receipts become refundable only after a paid minibar allocation
release; ordinary fully allocated PAYMENT receipts remain ineligible. DEPOSIT
rules remain. A receipt participating in paid minibar reallocation cannot later be
rewritten through generic receipt correction; its refund route remains available.
Late routed-refund coverage recognizes released service-payment credit as well as
deposit liability, preserving the existing freeze/reconciliation controls.

Migration 063 adds forced-RLS immutable correction/release/reallocation sources,
server timestamps, tenant/stay/report/allocation/receipt foreign keys and deferred
proof of the matching Manager report, old charge credit, exact released allocations,
bounded same-receipt reallocation and totals. The paid adapter needs SELECT/INSERT
on all three new tables plus the existing canonical Manager exception, finance,
allocation and audit grants. All statement/refund/receipt-correction runtime roles
need SELECT on minibar_paid_release; no history UPDATE/DELETE grant is required.
The adapter sets the tenant context after current-role authentication. Current
Manager package, report and inventory guards remain authoritative before replay.

The Manager form uses the shared locked price book, physical count inputs, reason,
acknowledgement, finance/report revision, dirty guard, error feedback and exact
unknown-outcome retry. Reception sees released PAYMENT credit in the existing refund
form. No price override, provider success flag or cash completion is client supplied.

Fifteen new PostgreSQL tests cover full/partial payment, overcharge/full reversal,
increased consumption, chained corrections, exact replay, stale revision, role and
payload guards, rollback during report/deferred proof, historical price/report
preservation, RLS/immutability, concurrency, pending payment and both cash/routed
refund completion. A new Chromium suite covers read failure, validation, conflict,
unknown outcome, refund access, reduced motion, 320px and private storage.

Full acceptance is pending. Post-checkout paid correction, financial-only disputes,
configuration variance/shortage override, partial physical rollback, Restaurant,
Operation, Police and production readiness remain. Provider integrations retain
the approved development mock boundary; no merge or deployment is included.

The first focused CI run exposed a projection mismatch: the original guest_finance
allocated counter tracks deposit allocations, not service PAYMENT allocations.
Migration 064 adds service_credit separately; received/allocated retain deposit
semantics, while refundable available includes service credit. PAYMENT release and
reapplication update this credit; DEPOSIT release and reapplication update only the
existing allocated counter. Deferred proof derives service credit from all linked
PAYMENT releases minus reallocations. Runtime finance writers need UPDATE on
service_credit. Cash/routed refund reservation and completion retain their existing
combined liability reservation/refund counters and receipt-scoped evidence.
New deposit-funded and mixed-source tests check this separation. The initial browser
interaction suite passed, but its API contract gate requires five commands; the
suite now also executes the actual refund-completion form as its fifth command.
