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

Verification candidate: 13 new real-PostgreSQL tests exercise Manager/package
boundaries, original Cleaner continuation, reason/quantity validation, no-use,
locked-price correction, paid checkout, rollback, expiry, replay and competing
Manager/Cleaner reports, and immutable tenant-scoped history. The new Chromium suite validates six real API payloads,
required fields, exception identification, correction, unknown-outcome replay and
320px reflow. CI acceptance will be recorded after the full run completes.

Remaining stage 5/6 scope: paid quantity corrections, non-guest stock-out,
variance/shortage override, partial physical rollback, product/template lifecycle,
online canonical room capacity, Restaurant, Operation, Police and production
readiness. External providers retain the approved mock boundary. No merge/deploy.
