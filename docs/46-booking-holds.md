# Transactional mock booking holds

Stage 4 remains in progress. This package persists category holds and reconciles
mock payment evidence. It does not create a verified booker or expose production
booking. All new endpoints require development/test mode, an isolated development
or test database, and an identity vault. Production rejects them.

## API boundary

A current Manager explicitly configures a versioned commission contract with
`PUT /hotels/{tenant}/mock/booking-contract`, then creates a test hold with
`POST /hotels/{tenant}/mock/booking-holds`. The caller supplies category, arrival,
nights, provider and idempotency key; the server calculates the immutable price.
The response contains one opaque, booking-scoped mock guest token. Only its hash
and tenant/object-bound encrypted envelope are persisted. Staff replay recovers
the same token. Audit events do not contain it.

The token authorizes only `GET /guest/booking-holds/{tenant}/{booking}` and its
`POST /attempts` and `POST /reconcile` subroutes. It gives no staff privileges.
Switching QPay/Khaan keeps the original ten-minute deadline, supersedes the old
attempt and preserves its later payment evidence. Attempts are capped at twenty
for resource safety. No provider is selected by a client paid flag.

## Inventory and payment invariants

Creation, walk-in/reservation overlap checks, time amendments and reconciliation
share the room-catalog advisory lock. Category claims reserve whole-stay capacity,
including cleaning buffers. The conservative capacity bound can undercount
fragmented/disjoint demand; it is not an exact public availability API. Only
active, nonblocked, non-minibar rooms are eligible in this package.

An elapsed ACTIVE hold retains its claim until reconciliation queries every
issued invoice and persists expiry. The Manager batch endpoint
`POST /hotels/{tenant}/mock/booking-holds/expire?limit=25` processes at most fifty
elapsed holds and never returns their tokens. Unknown/pending provider status
is not payment. Invalid evidence aborts the transaction and retains inventory.
Unsent invoices are not created after expiry.

Only stored mock merchant/invoice/currency/amount/payment/time evidence confirms
a booking. A global billing-capture key prevents reuse across funding services.
Confirmation snapshots the current valid commission contract without changing
the quoted price. Contract/capacity/subscription failure records full refund due.
A capture observed before persisted expiry may confirm after the wall-clock
hold deadline while inventory remains held. A capture after persisted expiry
never reopens the booking; it records a full refund obligation. Extra captures
also record full refund obligations. Cash balances are unaffected.

Hold source fields, capture/event/command history are immutable. Every table
has forced tenant RLS. Capture, confirmation and audit changes commit together;
provider invoice creation is deterministic so a database rollback is retryable.
Only bounded local SQLite mock calls occur under the lock; live providers must
use a separate outbox/worker adapter rather than network calls under this lock.

## Remaining integration

Verified guest enrollment/OTP, public listing eligibility, Manager upgrade/hotel-caused cancellation, cancellation/no-show mutation, refund execution,
commission posting/payout, scheduled expiry/reconciliation and customer UI remain.
An unapplied confirmed category hold continues to claim inventory for its
snapshotted interval. The same-category Reception adapter below atomically
replaces that claim with the actual stay. Refund due
is an immutable obligation, not evidence that money has been returned. Minibar
online capacity waits for the stage-five canonical configuration adapter.

## Validation

Eighteen new integration tests cover last-unit concurrency, walk-in capacity,
authoritative capture, duplicate/late payments, fixed expiry, provider switching,
tenant/token/role isolation, production rejection, contract snapshots, RLS,
immutable sources, concurrent capture, expired-contract refund obligations and
commit rollback. Source `71133bf093ff96d4323f3e5f489f3385728332de` passed
all **456 backend tests without skips**, plus browser/API-contract/design/token
checks in [CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34190759319).
Local discovery ran 88 tests and skipped 368 PostgreSQL-dependent tests.
The subsequent documentation-only commit records this evidence.


## Same-category Reception application

`POST /hotels/{tenant}/booking-holds/{booking}/check-in` accepts the physical
`room_id`, actual staying guest, optional bounded backdate/reason and idempotency
key. A current Reception with an open shift is required. The mock guest token
cannot use this endpoint. Production remains closed to mock evidence.

Under the existing cash/catalog/room transaction locks, the server rechecks the
confirmed hold, its applied capture, same active category, non-minibar/nonblocked
room, actual readiness, start/end bounds and all competing claims. The amount,
nights, planned end and checkout time use the paid snapshot, regardless of new
room/hotel tariffs. The actual guest follows existing encrypted identity checks.

One immutable, tenant-RLS `booking_hold_application` links hold, capture and stay.
The category claim is excluded from future inventory calculations only when this
row commits together with the stay, prepaid room charge and command receipt.
The cash drawer is unchanged and the platform-paid mock booking has zero deposit.
No physical room is assigned or inventory released by a separate preparatory call.
A retry returns the same stay/code; a different request cannot consume it twice.
Guest hold status exposes its linked `stay_id`. Checkout uses the existing
Reception finance/readiness workflow; platform refund execution remains separate.

Seven new integration tests cover immutable paid pricing/checkout, replacement
of the category claim, duplicate concurrent check-in, unpaid/early arrival,
dirty/different-category rooms, token/client-money/production rejection and
commit rollback. Source `157ff47f7c8ce89293ae1d1fd81710485047d377` passed
**463 backend tests without skips**, plus browser/API-contract/design/token
checks: [CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34197849312).
Local discovery ran 88 tests and skipped 375 PostgreSQL-dependent tests.
The following documentation-only commit records this evidence.
Higher-category Manager upgrades, hotel-caused cancellation, staff booking inbox
and customer/reception UI for this new source remain future integrations.
