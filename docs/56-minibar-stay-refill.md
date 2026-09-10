# Active-stay minibar refill

Contract: docs/22 §6.3, docs/25 §6.1 and docs/26 product retirement.

Reception or the current package-eligible Manager requests one price-book product
and quantity on an active canonical stay. The immutable request pins the stay,
room, product and check-in application. Neither its task snapshot nor Cleaner
queue contains a selling price. Requesting does not reserve or move inventory.

A current Cleaner claims the task, then confirms an actual positive quantity up
to the requested quantity. A smaller actual quantity closes that request; any
remaining desired refill requires a new request. Completion records an immutable
warehouse → room movement, exact cost basis, current assignment and server time.
Hotel-wide quantity, value and guest finance are unchanged. Insufficient stock
rolls the command back; the Cleaner can record an unavailable reason. Reception
or a package-eligible Manager can cancel an unfinished request with a reason.

Requests require current entitlement. Completion, unavailable and cancellation
use the trusted existing stay completion root after the subscription lock; new
sales/refill requests remain blocked. Current membership, Cleaner assignment,
work state, security suspension, tenant, package and idempotency are checked.
Generic cleaning posting cannot bypass the canonical physical proof. Existing
Manager reassignment works while entitlement is active.

Checkout initiation shares cashbook → catalog → room → stay ordering with refill
commands and rejects every unresolved refill. A database trigger enforces the
same boundary. No new request or movement can follow checkout intent. Reports
retain opening + confirmed refill availability, immutable refill request IDs and
the checkout cutoff per product. Prices remain the check-in price book. Unpaid
correction reverses original consumption cost and reuses the same refill evidence.

Migration 053 adds forced tenant RLS and immutable request/result history. Product
RETIRING completion requires request time before deactivation time; INACTIVE
completion is forbidden. The product lifecycle command adapter remains separate.
Existing migrations 001–052 are unchanged.

## Restricted application grants

All stock readers, receipt/configuration writers and checkout/report adapters
need SELECT on `minibar_refill_request` and `minibar_refill_result`: the shared
room quantity and checkout proof functions read these tenant-scoped tables.
The refill adapter additionally needs INSERT on both. No UPDATE/DELETE grants
are needed for this immutable history. Reuse existing cleaning source/task/action,
open-work, actor, receipt and operational-event grants; no new financial write
grant is needed for refill. Report adapters retain their existing finance grants.

## Verification candidate

16 new PostgreSQL tests cover no-op requests, exact stock/value conservation,
locked selling price, cutoff evidence, idempotency, cancellation/unavailable,
warehouse shortage, role/assignment/package/expiry boundaries, retirement,
immutable RLS history, atomic rollback, correction and concurrent checkout/refill.
The additional Chromium suite exercises nine actual API command payloads, loss
of a completion response, retry, dirty-form protection, field validation and
320px reflow. Local discovery is not PostgreSQL acceptance; CI evidence will be
recorded after the source run completes.

## Remaining stage 5/6 scope

Automatic next-stay refill, manager exception reports, paid quantity corrections,
non-guest stock-out/waste/adjustment, variance/shortage override, partial physical
rollback, product/template lifecycle, online canonical room capacity, Restaurant,
Operation, Police and production readiness remain. External providers retain the
user-approved mock boundary. No merge or deployment is included.
