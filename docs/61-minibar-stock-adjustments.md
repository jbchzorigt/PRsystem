# Manager minibar stock adjustments

Implementation candidate; full source acceptance is pending.

Manager/package-scoped WASTE, COUNT_PLUS, COUNT_MINUS and room RETURN commands
create immutable adjustment evidence and a matching stock receipt in one
transaction. A stock revision, expected location quantity and exact current stay protect
against stale selection, including transfers that do not change stock revision; reason and current role/package are checked before receipt replay.
All movements preserve actor, location, reason, quantity and exact rational cost.
Warehouse and room quantities cannot become negative; zero stock cannot retain
positive valuation. Existing inactive products allow controlled adjustments.

Waste and negative adjustment use the current hotel-wide weighted average.
Positive adjustment uses that average too; if total stock is zero, Manager must
supply unit cost. RETURN moves room stock back to warehouse while hotel-wide
quantity/value remain unchanged. There is no guest charge or cash event.

A linked REVERSAL restores the original quantity and cost once, retaining both
records. Reversing a reversal is forbidden. A reversal must retain its original
location and stay and must satisfy present stock/value constraints. In particular,
original-cost reversal that strands valuation at zero stock is rejected instead
of silently repricing historical cost. A corrected replacement is a new movement;
this increment does not introduce an atomic multi-command replacement workflow.

Active-stay room movement records the current stay. Non-guest stock-out reduces
billable availability; generic positive adjustment adds physical stock only.
Reports snapshot adjustment IDs, billable delta, physical quantity and the latest
persisted checkout/adjustment cutoff. Charges use max(0, opening + confirmed refill
+ non-guest billable delta - actual count) and the check-in selling-price book.
Unexplained physical loss beyond billable consumption remains COUNT_VARIANCE and
requires a Manager inventory adjustment. Cleaner does not assign that loss to a
financial category. An initial requested inspection may be resolved this way;
after any report is posted, that stay's adjustments are locked. Paid quantity
correction and post-report adjustment are separate remaining work.

Migration 059 adds the forced-RLS immutable adjustment source and extends the
existing receipt proof. A deferred source-to-receipt check prevents unmatched
physical changes. Migration 060 protects zero-stock valuation. No history
UPDATE/DELETE privilege is needed. Every runtime reader of canonical room stock
or stay availability needs SELECT on minibar_adjustment, including booking,
Reception, Cleaner and lifecycle adapters. The Manager adjustment adapter also
needs INSERT on minibar_adjustment and the existing INSERT/SELECT receipt,
product/room/stay row-lock, membership/access, report and audit/idempotency grants.
All functions retain invoker rights and tenant scope.

The Manager warehouse UI uses existing location selectors, forms, confirmation,
feedback and bounded history, including linked reversals. Unknown-outcome retry
keeps the same key; changed values use a new key. Read failures, current-report
locks, stale revisions and zero-stock cost are explicit. Cleaner count bounds
show physical quantity separately from billable quantity. No new visual tokens.

Focused PostgreSQL coverage includes warehouse and room conservation, stay
consumption exclusion, generic additions, count variance, zero-stock cost,
fractional WAC and original-cost reversal, duplicate/reversal guards, stock
bounds, stale stay/revision, current role/package, inactive products, tenant
isolation, immutable history, direct source forgery and deferred rollback/retry.
Browser coverage exercises preview/retry, reason/acknowledgement, conflict,
uncertain completion, room return/reversal, positive/negative adjustments,
zero-stock cost, report lock, keyboard, reduced motion and 320px layout.

The initial CI configuration mistakenly duplicated the PostgreSQL focused gate
inside the browser job, where psycopg/PostgreSQL were unavailable. That duplicate
step is removed; the actual PostgreSQL adjustment gate passed. This is a workflow
correction, not a relaxation of inventory or authority checks.

Remaining stage-five scope includes paid quantity corrections, dedicated count
variance resolution for configuration tasks, shortage override, partial physical
rollback, Restaurant fulfillment and Operation. Police and production readiness
also remain. External providers retain the approved development mock boundary.
No merge or deployment is included.
