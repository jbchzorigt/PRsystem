# Canonical guest minibar — accepted stage 5 increment

Connects a fully stocked canonical room to production CASH check-in, assigned
Cleaner inspection, immutable consumption, guest charge, unpaid report correction
and checkout. This increment implements the ordinary walk-in path. External
payment/restaurant providers retain their existing approved mock boundary.

## Opening and selling prices

Check-in reads the room's exact applied Published version, ACTIVE parent/products
and actual canonical stock under the existing catalog/room transaction. Pending
configuration and other dependency blockers still deny check-in. The temporary
CANONICAL_MINIBAR adapter blocker is bypassed only after the new authoritative
opening check succeeds; online category capacity still excludes canonical rooms.

The immutable stay stores the exact application/version, product metadata and
revision, every opening quantity, target quantity and selling price. A relational
application FK and insert trigger verify the server-generated snapshot. Snapshot
time is check_in_recorded_at even for a backdated actual arrival. Later catalog
prices, Default changes and scheduled configuration cannot reprice this stay.
No report accepts client prices or falls back to the live catalog.

Full target stock is required in this increment. Shortage overrides, including
zero-opening lines under an override, are not yet enabled. Once that explicit
adapter exists it must retain every version product in the price book, including
zero-opening lines; a missing product is never inferred as free or billable.

## Inspection and posting

Checkout initiation creates a canonical inspection source with one COUNT action
per price-book product. A current Cleaner claims it, then submits every physical
remaining count against the report and assignment revisions. Empty count inputs
and the explicit no-consumption acknowledgement prevent an inferred report.
Existing staff open-work ownership, suspension/reassignment and generic-post
protection apply. Eligible existing stay inspection/claim/report work can complete
after subscription lock; security suspension and package/role checks still apply.

The transaction records physical postings, consumption receipts, the locked-price
guest charge, immutable report/proof, task completion, inspection state, finance
audit and idempotency result together. Receipt → report foreign keys and deferred
proof triggers reject unattached movements and canonical reports without physical
evidence. Report proof checks the exact product set, opening/price metadata,
quantity/amount arithmetic, assigned task, payment lock and resulting room stock.
The mock report route and generic cleaning post cannot finalize canonical work.

Consumption uses negative quantities in the same immutable stock-revision chain
as purchases. Hotel total and room stock decrease together; warehouse stock does
not change. Selling price remains separate from weighted-average COGS. Integer
numerators/denominators retain exact rational inventory value and cost without
floating-point arithmetic or rounding, including purchases after consumption.
Warehouse/room transfers preserve that rational value and hotel total.
Historical opening/purchase cost is read from the original unit_cost_mnt,
including rows that predate the rational consumption columns.

Reception can return an unpaid report with a reason. A new source/version requires
a fresh claim and physical count. The new transaction reverses every preceding
consumption at its original cost, credits its old guest charge, then posts the new
consumption at the current weighted average and the original selling price. Old
reports and movements remain immutable. A paid charge or pending payment locks
this correction path. A dispute waiver only credits the charge: it does not undo
physical consumption. Final checkout requires the latest completed report proof
and the existing full financial settlement gates.

## Runtime permissions and migrations

Apply new migrations 051–052 with the migration owner; previously published
migrations are unchanged. Runtime needs SELECT, INSERT on minibar_guest_inspection
and minibar_guest_report; SELECT-only readers require SELECT on those tables.
The existing stay, checkout-intent, inspection/report, cleaning source/action/task/
posting/open-work, guest finance/charge/adjustment, catalog, product/receipt/transfer
and audit grants remain necessary. The changed room-quantity function also needs
SELECT on minibar_receipt for canonical warehouse/room readers. Receipt insertion
uses the existing product revision UPDATE grant for serialization. Report proof
updates only existing mutable completion fields. Both new history tables force
tenant RLS, deny PUBLIC and reject UPDATE/DELETE. Do not grant history mutation.

## UI and verification

Reception reads the locked price book in the stay panel and uses the existing
checkout-initiation/review/settlement controls. Cleaner opens “Зочны минибар шалгах”,
claims available work and reports physical counts. Shared form/table/feedback
owners cover validation, load retry, lost-response replay, dirty-state protection,
blocked assignments, pagination, keyboard focus and a 320px viewport. The stock
history distinguishes consumption and linked correction from purchase receipts.

Accepted source `45c65c12fc92a9ec4f39315c96a3eff8e9974067`, tree
`a5bae16d387e06697e2476a5803d4445b85569b3` (identical to local `c96269d`),
passed **643/643 backend tests without skips in 677.837 seconds**.
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34437621164)
also passed the focused 21-test guest-flow gate, the 18-test batch gate, ten
Chromium suites, 63 actual browser/API command checks and design/token checks.
Strict local UI audit: zero findings. Local-only discovery executes 106 tests
and skips 537 database tests; the linked PostgreSQL run is the acceptance evidence.

One preceding full run passed 642/643 tests: the failing assertion compared the
same timestamp serialized with five versus six fractional digits. The test now
compares parsed instants, preserving the requirement that the price book uses
check_in_recorded_at. The final full run passed; no business rule was weakened.

## Subsequent integration and remaining scope

[Active-stay refill](56-minibar-stay-refill.md),
[automatic next-stay preparation](57-minibar-next-stay-refill.md) and
[Manager physical exception reports](58-minibar-manager-exceptions.md) now have
accepted follow-up implementations. A consumed room remains unavailable until
physical preparation, ordinary cleaning and the snapshot buffer all pass.

Paid quantity correction, non-guest waste/adjustment, shortage overrides, partial
physical rollback, product/template lifecycle, online canonical room capacity,
Restaurant, Operation, Police and production readiness remain.
