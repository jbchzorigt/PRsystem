# Manager physical minibar exception reports

Contract: docs/21 §3–5 and docs/25 locked selling prices.

A current Manager (25/30k package) or Manager Plus (30k) can submit a physical
inspection with a mandatory reason when Cleaner cannot report. Hotel Admin,
Reception and Cleaner do not inherit this exception authority. No photograph,
second approval, client price or client task authority is accepted.

The adapter locks the same checkout inspection as the Cleaner command. It creates
an immutable Manager-role/reason/package proof and a task which opens and finishes
inside the same report transaction. If a Cleaner task is open, its immutable
lineage continues to the Manager task; the prior work closes atomically. Failure
restores the original assignment, stock and finance. The exception is never left
as an independently assignable task for a user without Cleaner role.

Both ordinary and exception reports use the same physical count, confirmed refill
cutoff, immutable check-in price book, rational consumption cost, charge, audit,
report version and idempotency transaction. An unpaid correction requires the
existing Reception return and produces a new report, linked consumption reversal
and replacement charge. Paid/pending payment cannot be bypassed. Eligible old-stay
completion remains available after subscription expiry; current roles and security
suspension are checked before replay.

Reception and Manager checkout detail visibly identify the exception and its
reason. The Manager form reuses existing blank count, required reason, no-use
acknowledgement, error retention and unknown-outcome retry controls.

Migration 055 adds forced tenant RLS and immutable `minibar_manager_exception`.
Its deferred foreign key requires the complete canonical report in the same
transaction. All canonical report writers need SELECT on this proof table; the
Manager exception adapter additionally needs INSERT, plus existing report,
physical task/posting, open-work and finance grants. No history UPDATE/DELETE
permission is added. Published migrations 001–054 remain unchanged.

## Accepted verification

Accepted source `bf7c2387caf32d0ca2a05ea0ca4fa60ab89431c7`, tree `04690ffc77499aeddf35f99fe37de7d936190141`
(identical to local `7d99e67`), passed **683/683 backend tests without skips
in 761.607 seconds**. [Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34442659855).
The focused gates passed 18 batch, 13 exception, 11 next-stay, 16 active-stay
refill and 21 canonical guest tests. All 13 Chromium suites, 84 actual browser/API
payload checks, design/token checks and strict local UI audit passed (zero audit
findings). Local discovery executed 106 tests and skipped 577 PostgreSQL tests;
the linked run provides the skip-free acceptance evidence.

The 13 new exception tests cover Manager/package boundaries, original Cleaner
continuation, reason/quantity validation, no-use, locked-price correction, paid
checkout, rollback, expiry, replay, competing reports and immutable tenant-scoped
history. The browser suite checks six actual command payloads, required fields,
exception identification, correction, unknown-outcome replay and 320px reflow.

The first focused run passed 11/13 tests. Its fixture inherited a 30k package,
while two assertions assumed 25k. The fixture now explicitly selects 25k before
opening the stay and tests Manager Plus after an explicit change to 30k. The
preview assertion also uses the GET helper. Application authorization rules were
unchanged; the corrected focused gate and full regression passed.

Remaining stage 5/6 scope: paid quantity corrections, non-guest stock-out,
variance/shortage override, partial physical rollback, product/template lifecycle,
online canonical room capacity, Restaurant, Operation, Police and production
readiness. External providers retain the approved mock boundary. No merge/deploy.
