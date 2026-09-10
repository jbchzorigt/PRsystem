# Automatic next-stay minibar preparation

Checkout now produces an exact-current-version preparation request when a
canonical room has a physical deficit or surplus. It does not move inventory.
The existing full-plan reconciliation performs count, warehouse refill / excess
return and atomic application. This reuses the accepted cost, stock, task,
variance/shortage and immutable application proof.

The automatic request has `request_kind=NEXT_STAY` and a unique relational link
to the just-completed `stay_checkout`. Database validation requires that closed
stay, the same room and exact currently applied template/version. A new Publish
or Default cannot change the pinned target. No old-template routine refill is
created when a user configuration or rollout is already pending. Fully stocked
rooms need no preparation request. Inactive/retiring dependencies block future
admission without preventing the current guest's settled checkout.

The existing Cleaner configuration queue also exposes unassigned next-stay tasks.
A current Cleaner can claim only this source kind; rollout assignment remains a
Manager action. Claim, immutable physical counts and full-plan apply use existing
CAS, idempotency, tenant, package and subscription guards. Manager may also assign
this task through the existing prepare command. Cancel leaves physical stock
unchanged and normal opening-readiness checks still apply; a subsequent explicit
configuration request can finish preparation.

Application does not mark the room clean. Ordinary checkout cleaning and its
buffer remain independent admission conditions. Insufficient warehouse stock or
count variance continues to block application; no shortage override is inferred.
Guest charges and the closed stay's opening/price book remain unchanged.

## Migration and grants

Migration 054 adds the checkout link and automatic producer, and extends the
existing scheduled-task wake-up functions to `NEXT_STAY`. Published migrations
001–053 are unchanged. Canonical checkout writers need the existing configuration
producer grants: SELECT/INSERT configuration request, reconciliation, cleaning
source/action/task and operational event; SELECT its exact target/product/stock
sources, and UPDATE room revision. They do not gain history UPDATE/DELETE. The
self-claim adapter uses the existing task assignment and open-work grants.

## Verification candidate

11 new PostgreSQL tests cover exact automatic target and lineage, no stock effect
at creation, Cleaner claim/count/apply, separate cleaning readiness, pending
configuration precedence, later publication, retirement checkout, missing counts,
current roles, retry and concurrent claim, and the no-consumption/full-room case.
The added Chromium suite checks Cleaner self-claim, count and physical apply with
six actual API payloads, lost responses and narrow-screen reflow. Full PostgreSQL
acceptance will be recorded from CI; local skipped discovery is not acceptance.

Remaining stage 5/6 work includes exception/paid corrections, non-guest stock-out,
variance/override, partial rollback, product/template lifecycle, online canonical
room capacity, Restaurant, Operation, Police and production readiness. Real
providers remain within the user-approved mock boundary; no merge/deployment.
