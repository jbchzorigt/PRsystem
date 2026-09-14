# Restaurant ordering implementation and acceptance

## Current boundary

The implementation follows the independent state axes in docs/08. It adds a
restaurant-scoped menu, a guest-owned durable order intent, idempotent invoice
creation, server-provider reconciliation, fulfillment, refund decisions and
provider-confirmed refunds. No restaurant amount enters hotel cash, guest
charges, deposit allocations or hotel settlement.

This is **not full Restaurant acceptance**. Remaining work includes the product
screens, validated menu image uploads, schedule editing and special closure UI,
notification delivery/acknowledgement, Reception refund initiation, and a provider
worker for unattended invoice/payment reconciliation. Live QPay credentials and
merchant approval remain external gates. The API fails closed when a restaurant
has no trusted deployment-supplied gateway.

## Persistence and concurrency

Migration 071 preserves order price/name/phone/room snapshots. The intent commits
before invoice creation, so a retry after provider success plus database failure
uses the same order key and original amount. Application commands serialize on
the hotel–restaurant link and order row. Guest creation/invoice operations lock
the room and stay; payment reconciliation uses the checkout lock order. Checkout
requires one explicit, guest-informed handoff per unfinished paid order.

Order records and events use forced row-level security. SQL protects immutable
snapshots, terminal fulfillment and captured payment identity; a deferred
constraint requires an append-only event for each revision. Command receipts
bind exact parameters and actor to the retry key. Restaurant authentication uses
the existing separate realm and current membership revision.

The application verifies merchant, invoice, amount and currency using the
configured server gateway. A browser cannot set PAID/REFUNDED. Captures confirmed
after expiry and captures for inactive links/items do not reopen fulfillment.
Refund retries retain the provider idempotency key, including after a reported
failure; late success can resolve the outstanding request without a second refund.

## Decisions tested

- Seven weekday schedule validation, overnight hours, closure dates and exact
  closing boundaries; invoice expiry never exceeds the ordering window.
- Immutable server prices, unavailable items, integer validation and overflow.
- Distinct capture/refund/fulfillment axes; accept and refund race; allowed ETA.
- Five/ten minute acceptance warnings and refund eligibility; ETA plus 15 minutes.
- Mandatory versus discretionary approval, predefined rejection reasons,
  retained delivery evidence, provider failures and stable retry keys.
- Five/ten/thirty minute refund alerts and link pause until terminal resolution.
- Guest/restaurant realm boundaries, no phone disclosure through the menu,
  immutable contact snapshot with current phone on owned order detail.
- Invoice crash recovery, unchanged hotel balances, forced RLS, immutable audit,
  transaction rollback on mismatched provider evidence and checkout handoff.

## Runtime permissions

Use a restricted non-owner, non-superuser, NOBYPASSRLS application role. In
addition to existing authenticated hotel/guest/restaurant grants, the adapter
requires SELECT on the five new ordering tables and schedule exception table;
INSERT on menu items, order intents, events, command receipts and handoffs;
UPDATE only `(category,name,description,price_mnt,active,available,revision)` on
menu items, `(invoice_id,state,revision)` on order records and `(active,revision)`
on hotel_restaurant. Retain SELECT/row-lock grants on the restaurant, room and
stay records. Do not grant event/receipt/handoff UPDATE or DELETE, order snapshot
UPDATE, table ownership, or RLS bypass. Schedule exception mutation has no
application endpoint yet.

## Verification

Local: 24 restaurant policy tests pass. The complete local discovery finds 873
tests: 130 pass and 743 PostgreSQL-dependent tests skip. Eleven new PostgreSQL
tests are included in a dedicated CI step and full discovery. PostgreSQL
acceptance is pending; local skips are not evidence of database correctness.
