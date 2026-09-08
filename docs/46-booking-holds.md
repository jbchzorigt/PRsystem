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

Verified guest enrollment/OTP, public listing eligibility, Manager upgrade/hotel-caused cancellation, unpaid cancellation/no-show mutation, refund execution,
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

## Paid mock guest cancellation

`POST /guest/booking-holds/{tenant}/{booking}/cancel` accepts only an idempotency
key and the booking-scoped mock token. It is limited to captured, confirmed,
unapplied bookings. Staff tokens do not impersonate the mock guest. The existing
production, isolated-database, tenant and hotel security gates remain in force.

The immutable `booking_hold_cancellation` records the terminal outcome, captured
amount, retained first-night amount, refund obligation, commission, hotel payable,
confirmation contract and server time. The existing policy supplies a full refund
at least 24 hours before planned arrival; otherwise the first night is retained.
Commission uses the contract snapshotted at capture confirmation, even if the
quote or current contract differs. Retained plus refund equals capture; commission
plus hotel payable equals retained. These are settlement facts, not payout events.

The shared catalog/hold lock serializes cancellation with payment reconciliation
and Reception application. The cancellation row, event and command receipt commit
together. Inventory claims exclude this terminal overlay; guest status derives
CANCELLED_GUEST/CANCELLED without rewriting the original confirmation record.
Check-in explicitly rejects the overlay. A retry cannot create a second obligation;
a different terminal command is rejected. Duplicate captures observed later add
full refund obligations and never reopen the booking. Rollback retains the claim.

Eight integration tests cover free/late cancellation, confirmation contract rate,
check-in races, unpaid/applied guards, late duplicate captures, token/client-money
isolation and commit rollback/immutable history. Source
`edaf44e31fda5c3cb2c504ef3d48cb442623fb07` passed **471 backend tests without
skips**, plus browser/API-contract/design/token checks.
[CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34201253745).
Local: 88 executed, 383 PostgreSQL-dependent skipped. The subsequent
documentation-only commit records this evidence.
Provider refund execution, unpaid hold cancellation, no-show mutation, hotel-caused
cancellation, Manager upgrades, settlement posting/payout and UI remain separate.

## Original-payment mock refund execution

`POST /guest/booking-holds/{tenant}/{booking}/refunds/reconcile` accepts an empty
strict JSON object and the booking token. Production and tenant/security gates
apply. It derives each positive obligation from immutable capture/cancellation
facts; the client cannot supply an amount or provider evidence.

A unique request per capture commits before any provider call. Subsequent bounded
mock dispatch/query transactions reuse that persisted request ID and the original
payment's provider, merchant, payment ID and amount. Zero obligations create no
request or provider command. Multiple captured transactions have independent
refund requests; cancellation and late/duplicate capture obligations are not
combined into an unrelated payment return.

Only exact merchant/original-payment/currency/amount evidence with a valid server
confirmation time and unique provider reference records immutable completion.
Pending, unknown, failed and final-failed results keep the obligation outstanding.
Retry never creates a replacement attempt, including after final failure; the
same request may later report success. Definitive replacement/correction needs
a separate reconciliation workflow. A database rollback after provider success
reuses the committed request and records completion exactly once on retry.

Guest status reports total required, provider-confirmed and remaining MNT, request
statuses and the independent NONE/REQUIRED/PENDING/REFUNDED axis. Booking state,
capture history, cash drawers and released inventory do not change on refund.
Confirmed requests are not resent or polled by this endpoint. Provider withdrawals,
chargebacks and post-completion reconciliation/adjustments remain a separate gate
before payout. Live providers still need worker/outbox integration rather than
network calls under the mock transaction lock. Real API credentials remain deferred.

Nine integration tests cover pending/success, late success after failed states,
concurrent dispatch, zero-refund suppression, mismatched evidence, independent
multi-capture balances, token/production restrictions, completion rollback and
request-commit-before-dispatch. PostgreSQL CI is pending. No-show, hotel cancellation,
Manager upgrade, settlement/payout and staff/customer UI remain unfinished.
