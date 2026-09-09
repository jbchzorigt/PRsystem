# Canonical minibar reconciliation — stage 5 increment

Manager prepares an exact pending configuration for an assigned current Cleaner.
The server captures room stock from the immutable canonical ledger. The Cleaner
records each physical count, then confirms the entire derived transfer plan.
OFF → ON, exact published version replacement and ON → OFF are supported when
counts match and warehouse stock funds the entire target. Application does not
mark the room clean. Legacy MOCK_ON stock cannot enter this ledger.

## Atomicity and source authority

Migration 046 adds immutable tenant-scoped reconciliation, transfer and application
records. Every transfer must have application proof at commit, enforced by a
deferred constraint trigger. Warehouse/room balances, exact hotel cost snapshots,
room current pointer, request/blocker, Cleaner task, audit and receipt commit in
one transaction. No pending request can retain a partial posted transfer.
Cancellation closes unfinished count work; an applied request is immutable and
reversal requires a new exact configuration request. Count discrepancies and
shortages block completion; no quantity is silently adjusted.

Preparation and completion require durable checkout of previous stays and no
outstanding financial/minibar work. Assigned task authority, subscription/package,
current staff roles, revisions, count lineage and target product/template lifecycle
are rechecked. Suspended Cleaner continuation preserves completed counts; a new
assignee owns the unfinished work. Lost-response retries return the original result
without repeating transfers. Canonical ON rooms remain blocked from guest opening
until the canonical guest inventory adapter is implemented.

## Stock and cost

Migration 046 backfills the new receipt total_quantity_after from warehouse_after;
before this migration there were no canonical room transfers. Original receipt
fields stay unchanged. New receipt totals represent hotel-wide stock. Warehouse
availability is hotel total minus all canonical room quantities. Transfers conserve
hotel quantity/value and average cost, storing the exact value/quantity ratio.
A later purchase uses hotel-wide stock, including room stock, for weighted cost.
No transfer asserts a sale, cash expense, vendor payment or guest charge.

## Application grants

In addition to docs/48–50 grants, runtime needs SELECT on minibar_reconciliation,
minibar_transfer and minibar_configuration_application (warehouse readers also
need SELECT on minibar_transfer), INSERT on these three tables for reconciliation
commands, and UPDATE(minibar_application_id) on room. Existing task/action/posting,
staff_open_work, room revision/mode, request state/revision, blocker and audit
permissions are retained. Do not grant UPDATE/DELETE on immutable ledger tables.
Tenant RLS is enabled and forced; PUBLIC has no table privileges.

## UI and verification

Manager assigns counts from pending room details and reads the derived plan.
Cleaner has a bounded assigned queue, explicit actual-count inputs, shortage and
variance messages, and a physical-transfer confirmation before full application.
Shared forms own validation, CAS, idempotency, dirty state and retries. Detached
loads are discarded, load failures remain retryable, and no sensitive state is
persisted in browser storage.

Candidate verification: local discovery has 569 tests, 100 executed and 469
PostgreSQL tests skipped. Full PostgreSQL CI is required before acceptance.
Six Chromium suites cover existing flows plus assignment/count/apply, validation,
lost responses, queue recovery, keyboard and 320px layout. The new suite emits
actual requests for validation against API models.

## Remaining scope

This is the exact-count, fully funded, full-plan adapter. Variance adjudication,
waste/adjustment, shortage override, partial physical transfer/compensating rollback,
routine or active-stay refill, canonical guest opening/price/report/checkout,
product/template lifecycle and correction, Restaurant and Operation remain.
The broader room reconciliation package and stage 5 are not marked complete.
External providers remain the user-approved mocks. No merge or deployment.
