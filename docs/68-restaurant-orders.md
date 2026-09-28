# Restaurant ordering implementation and acceptance

2026-09-15: өргөтгөсөн Restaurant implementation нь [934-test acceptance](73-remaining-modules-acceptance.md)-д багтан баталгаажсан. Доорх өмнөх CI төлөв нь түүхэн тэмдэглэл болно.

## Current boundary

The implementation follows the independent state axes in docs/08. It adds a
restaurant-scoped menu, a guest-owned durable order intent, idempotent invoice
creation, server-provider reconciliation, fulfillment, refund decisions and
provider-confirmed refunds. No restaurant amount enters hotel cash, guest
charges, deposit allocations or hotel settlement.

The application/mock path now includes guest and restaurant staff screens,
Manager Plus registration/profile/schedules/link activation, validated menu
images, Reception refund requests, in-app notification history and a bounded
provider reconciliation worker. Acceptance of this expanded source is pending.
Live QPay credentials, merchant approval, exact provider protocol/QR response and
production worker scheduling remain external gates. The API fails closed when a
restaurant has no trusted deployment-supplied gateway.

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
UPDATE, table ownership, or RLS bypass. Schedule exception changes require the Manager Plus owner, revision and reason;
INSERT/DELETE on that projection is paired with an immutable configuration event.
Grant INSERT on configuration events, UPDATE on the edited profile columns and
menu `image_data`, SELECT/INSERT on notifications, and SELECT/INSERT plus
`checked_at` UPDATE on worker cursors. Do not grant history UPDATE/DELETE.

## Verification

The first source `7192269` failed before business tests because its restricted
fixture lacked restaurant membership row-lock permission. Source `9cc88a6` fixed
only that fixture grant; all 11 dedicated PostgreSQL tests passed in
[CI 34823856657](https://github.com/jbchzorigt/PRsystem/actions/runs/34823856657).
The initial full backend regression was still running when the expanded UI,
catalog and worker source was prepared; it is not acceptance of the newer source.

Expanded local discovery: 884 tests, 134 pass and 750 PostgreSQL-dependent skips.
25 restaurant policy tests and 3 image-decoding tests pass. Eighteen dedicated
PostgreSQL tests cover the expanded source. Twenty browser suites passed, with
Restaurant's focused suite subsequently extended to 12 API commands covering
image add/remove, notification history, Manager Plus schedules and link disable.
Local skips and browser fixtures are not PostgreSQL acceptance.

## Development provider operation

`PRSYSTEM_DEV_RESTAURANTS` is a JSON array of configured restaurant IDs. Each gets
an isolated SQLite mock provider store and distinct `MOCK_ONLY_RESTAURANT_<id>`
merchant. Restart the development app after adding a restaurant to this trusted
configuration. Existing normal hotel payment gateway configuration is unchanged.

- `python -m prsystem.development restaurant-payment RESTAURANT_ID ORDER_ID SUCCEEDED`
  simulates a provider capture; it does not move money.
- `python -m prsystem.development restaurant-tick --limit 25` reconciles already
  requested invoices/refunds and persists due in-app notices.
- `python -m prsystem.development restaurant-refund RESTAURANT_ID REFUND_ATTEMPT_ID SUCCEEDED`
  simulates a provider refund result; a following tick records it.

The worker never creates an unrequested invoice or approves/initiates a refund.
It can recover an invoice that the provider already created before a database
failure. Cursor ordering gives unprocessed and least-recently-checked orders
priority across all configured restaurants. Duplicate notices are constrained by
order/code/audience; the thirty-minute order gate derives from current refund
state even when the worker is delayed. Guest checkout notices commit with the
handoff and checkout transaction. Notifications are in-app; no SMS/email sender
is invoked by this Restaurant module.
