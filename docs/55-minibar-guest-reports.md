# Canonical guest minibar — stage 5 implementation

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

The initial server candidate `7ddedcabec855170db0f2b1860763aa09ed7eb63` passed the
14-test focused PostgreSQL guest-flow gate. Final full-suite and browser acceptance
will be recorded after the complete UI/test candidate passes CI.

## Remaining integration

Active-stay refill, automatic next-stay refill, manager exception report, paid
quantity correction, non-guest waste/adjustment, shortage overrides, partial
physical rollback, product/template lifecycle and online canonical room capacity
remain. After checkout, a consumed room stays ineligible for a new check-in until
stock is restored and ordinary cleaning/buffer readiness passes. For now the
existing explicit same-version configuration/count/full-apply path can restore
stock at the safe point; it is not an automatic refill service. Restaurant,
Operation and stage 6 production readiness are still outstanding.
