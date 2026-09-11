# Canonical minibar in online booking

Accepted source: `4732d4dd5446b305a4c9e40fbdd9be57903cf557`.
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34447882812):
**696/696 backend tests without skips in 807.838 seconds**, including the
13-test canonical booking gate. All 13 Chromium suites, browser/API request
contracts, design lint and token checks passed. Local database skips are not
used as acceptance evidence.

Future category capacity includes ACTIVE rooms with an eligible current exact
Published configuration, ACTIVE template/products and the minibar package.
Pending configuration and unrelated room blockers still exclude capacity.
The canonical marker is bypassed only through that validated configuration;
MOCK_ON rooms remain excluded. Category holds do not pin a room, version, minibar
price or opening quantity, and do not move inventory.

Actual assignment rechecks physical readiness, full stock, current exact version,
current product selling prices and existing booking claims under the catalog and
room locks. The stay gets the existing database-verified immutable opening and
price book. Paid room price, duration and deposit exemption remain bound to the
booking. Capture application, opening, stay, finance, audit and idempotency share
one transaction. Booking providers remain the explicitly approved test mocks;
this is not live-provider acceptance.

Same-category candidate and higher-category upgrade checks use the same
configuration gate plus physical opening readiness. A usable canonical room
prevents an incorrect hotel-caused cancellation. Lifecycle changes preserve
confirmed bookings, which must then be fulfilled by reactivation, relocation or
the existing authorized cancellation flow.

Migration 056 adds an invoker-rights, tenant-scoped read function. The booking
runtime needs SELECT on minibar_product, minibar_template,
minibar_template_version, minibar_configuration_request,
minibar_configuration_application and the canonical stock sources used by
minibar_guest_opening (minibar_receipt and minibar_transfer). These are existing Reception/minibar read grants;
no financial or immutable-history UPDATE/DELETE privilege is introduced.

The focused PostgreSQL suite covers future capacity, no early minibar snapshot,
locked arrival price, paid consumption/checkout, pending configuration,
retirement/package gates, tenant isolation, dirty-room arrival, last-room
concurrency, double application, hotel cancellation and deferred rollback/retry.
Existing browser forms and API shapes are reused without UI changes.

Remaining phase-five work: paid quantity corrections, non-guest stock-out,
variance/shortage override, partial physical rollback, Restaurant and Operation. Product/template entity lifecycle
is tracked separately in [document 60](60-minibar-entity-lifecycle.md). Police and production readiness remain in
phase six. No merge or deployment is included.
