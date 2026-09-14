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

The Reception Payments destination now opens the bounded closed-stay list and
original-price billing detail without requesting guest PII or current physical
room availability. Manager uses the shared reason/quantity/acknowledgement form;
Reception reuses the existing collection and receipt-refund flows. Dirty refresh,
stale revisions, exact retry after a lost response, read failure, empty pages,
keyboard focus and 320px layout are covered by minibar-billing.cjs.

Expired subscription discovery follows the existing completion-overview rule:
only stays recorded before the persisted lock boundary are listed, and every
returned root is independently authorized. Security suspension still rejects the
list. Closed preview does not expose a later guest's current room availability.

The first PostgreSQL run (34813708926, source 964e19dd8bf2f37c62b2ac375ce3e3fefc4145f5)
passed 21 of 22 focused tests; the revoked-session test incorrectly expected 403.
The existing authentication contract correctly returns 401 UNAUTHENTICATED. The
test was corrected without changing production authorization; the next run
(34814024203, source ee4f5d2c777e7953345c34e1ddf1e9ececce309e) passed all 22 focused
tests and 836/836 full backend tests without skips (852.578 seconds). UI and two expiry-boundary regressions extend the new suite to 24 tests.

Implementation is present; final UI-source PostgreSQL acceptance is pending.
The backend source above is accepted at 836/836; it does not validate the two
new expiry-boundary tests or the complete UI source. Local discovery collects
838 tests: 106 execute successfully and 732 require PostgreSQL, so local skips
are not database acceptance. The new Chromium suite exercises 8 actual API
commands including stale-revision denial, exact retry, refunds, collection and
session revocation. It also verifies zero availability, unchanged input, Manager
Plus, immutable history pages, detached forms/reads and locked-price totals.
The shared finance renderer restricts historical collection to the current linked
billing charge. Separate finance and billing reads must agree on revision.
Existing 18 browser suites remain regression gates; this adds the nineteenth. Tests in test_minibar_billing.py exercise the new real PostgreSQL path.
Stage 5/6 also retains partial physical rollback, Restaurant, Operation, Police
and production readiness. This increment does not provide retroactive physical
inventory edits or remove those remaining implementation gates.


## 2026-09-14 — local verification and publication gate

Local source `378e0c312b7a75b3d5f22defb10a44cf55b83bea` passed all 19 Chromium
suites and 129 actual API-model command checks. The configured accessibility
command runs the same 19 suites, including keyboard, dirty-dialog, native-select,
responsive and privacy assertions. Desktop and 320px screenshots were inspected.
Strict UI audit: zero findings. Design lint: zero errors and six pre-existing
warnings. Runtime token check and git diff check passed. No new visual tokens.

Publication of the ten changed source/documentation files to public repository
`jbchzorigt/PRsystem`, branch `feat/approved-risk-controls` (Draft PR #1), was
rejected by automatic approval review because it requires explicit end-user
authorization for this new public source upload. The branch remains at
`ee4f5d2c777e7953345c34e1ddf1e9ececce309e`; no new source was published and no
new-source CI was started. After user approval, regenerate the upload from the
current local HEAD, recheck the remote parent, publish and complete PostgreSQL
focused/full CI. Current 838-test source is not yet database-accepted.


The user explicitly approved publishing this complete new package to public
PR #1 and completing CI ("зөвшөөрнө."). The approval gate is resolved; publication
and exact-source PostgreSQL acceptance continue from the current local HEAD.
