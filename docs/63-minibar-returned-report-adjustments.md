# Returned unpaid minibar report stock reconciliation

Accepted source: `1abf10237621c4f7ddf4679793127d7e5738a01a`.
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34562376377):
**751/751 backend tests without skips in 879.780 seconds**, including 37 stock
adjustment tests in 64.169 seconds. All focused PostgreSQL gates, 15 Chromium
suites and 102 actual browser/API command checks passed. Design/token checks
passed with six pre-existing design warnings. Local discovery passed 106 tests
with 645 database skips; the linked CI is full database acceptance.
The previous 744-test milestone is [62](62-minibar-atomic-adjustment-corrections.md).

Reception can explicitly return an unpaid report to REQUESTED through the existing
review command. Manager can then record or atomically correct a stay-scoped
non-guest inventory adjustment. Reposting uses the existing assigned Cleaner or
Manager exception workflow: reverse the old consumption at original cost, apply
the corrected availability/count at locked stay prices, credit the old unpaid
charge and create the new charge, atomically. Original report/price/receipt history
is retained. The report snapshots the updated adjustment IDs and cutoff.

A report in REPORTED or DISPUTED state remains locked. Paid minibar charges and
pending payment intents remain locked even if inspection state is inconsistent.
This does not implement paid quantity correction, service refunds or historical
post-checkout inventory correction. Current physical stock/value, exact stay,
Manager/package authority and optimistic revisions still apply. A correction
cannot temporarily overdraw stock while waiting for a later report reversal.

Migration 062 adds one shared invoker-rights report-lock predicate and replaces
only the initial report-state condition in the existing adjustment guard. Runtime
stock preview/adjustment adapters require SELECT on reception_minibar_inspection,
guest_charge and guest_payment_intent, in addition to the prior adjustment grants.
The predicate and all queries use explicit tenant/stay scope. No source history
UPDATE/DELETE permissions are added. Room/stay locks serialize adjustment with
report, review, payment and checkout paths.

Seven PostgreSQL regression tests cover returned-report non-guest reclassification,
old report preservation, corrected charge at locked prices, dispute lock, actual
cash payment lock, defensive paid/pending-payment state checks, and atomic stock
replacement followed by report completion. Existing Manager and Cleaner forms
already consume the preview and report workflow; no new UI or endpoint is needed.

Paid/post-report financial
correction, configuration variance/shortage override, partial physical rollback,
Restaurant, Operation, Police and production readiness remain. External providers
retain the approved development mocks; no merge or deployment is included.
