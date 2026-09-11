# Stage 5 — product and warehouse receipts

2026-09-09. First stage-five implementation package; full Minibar/Restaurant/
Operation acceptance remains open. Policy: docs/22 §§3–5, 10–11; docs/07,25,26.

## Implemented scope

- Manager product creation with name, category label, unit, selling price,
  mandatory nonnegative purchase cost, warehouse opening count and initial
  ACTIVE/INACTIVE state. Zero opening count still records one opening event.
- Positive warehouse purchase receipts with server stock revision and immutable
  cost/product/actor/role/package/time snapshots. Opening and purchase are stock
  receipts; they do not assert vendor payment, cash expense or hotel revenue.
- The latest immutable receipt derives warehouse quantity and inventory value.
  Receipt insertion independently validates sequence and value conservation in
  PostgreSQL while locking the product. No mutable balance field or balance edit
  API exists. Historical receipts cannot be updated/deleted.
- Integer stock/value arithmetic retains the exact weighted average as a reduced
  numerator/denominator. Zero stock has no established average; its next receipt
  establishes cost. Display approximation does not define COGS rounding policy.
- Strict server models reject client balances/averages, negative, fractional,
  boolean and overflowing quantities. Product + opening + audit + command receipt
  commit together. Retry cannot duplicate inventory; changed commands conflict.
- Current Manager at 25,000/30,000₮ or Manager Plus at 30,000₮ is required for all
  inventory/cost reads and writes. Hotel Admin needs a matching operational role.
  Current account/membership, security suspension, subscription and forced tenant
  RLS remain independent checks, including retries. New purchase on an inactive
  product is blocked, while its existing warehouse stock remains visible.
- Manager warehouse list, product form, purchase form and history in the shared
  Reception console. Product and history pages are bounded, forms preserve retry
  input, and stock conflicts require explicit reload/review.

## API and minimum grants

Prefix `/hotels/{tenant_id}/minibar/products`, authenticated hotel staff realm.

| Method | Suffix | Purpose |
| --- | --- | --- |
| POST | root | Product and opening receipt |
| GET | root | Product/warehouse list; after ID, limit 1–100 |
| POST | `/{product_id}/receipts` | Purchase receipt with expected stock revision |
| GET | `/{product_id}/ledger` | Immutable history; after stock revision, limit 1–100 |

Migration 043 is append-only. The restricted application role needs SELECT/INSERT
on `minibar_product` and `minibar_receipt`, UPDATE(revision) on `minibar_product`
for its row lock, existing staff command receipt SELECT/INSERT and operational
event INSERT. It must not own tables, bypass RLS or obtain receipt UPDATE/DELETE.
`tests/test_minibar_warehouse.py` demonstrates grants and uses an owner only for
fixture creation, fault injection and verifying the database's immutable guard.

## Verification

16 PostgreSQL tests cover atomic opening, exact/zero cost, current role/package,
tenant RLS, expiry/suspension, immutable history, quantity overflow, pagination,
concurrent requests and commit rollback. Source `f84e4d79d5de138e7966b57266fcb2a05c3dd813`
passed all **522 backend tests without skips** on PostgreSQL in **420.340 seconds**.
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34296600033)
also passed all four Chromium suites, 17 generated browser requests validated
against API models, design lint and token checks. All 16 new warehouse tests passed.
Local discovery: 522 tests, 100 passed and 422 PostgreSQL-dependent skipped.
All four browser suites passed locally. The new suite exercised five commands
validated against real API models; existing Reception/Booking six-command payload
suites passed too. Strict UI audit and token checks passed. The linked remote
PostgreSQL run is the full acceptance evidence; local skips are not acceptance.
Design lint: zero errors and six existing orphaned-token warnings; runtime token
export is unchanged. Final mobile/desktop inventory screenshots were inspected.

## Publication

The user explicitly approved public publication of local `c1bd8e1` on 2026-09-09.
Its identical source tree was published as `f84e4d79d5de138e7966b57266fcb2a05c3dd813`
to `feat/approved-risk-controls`, Draft PR #1. Automatic approval review accepted
the explicit authorization. Its 522-test CI passed, including all new warehouse
tests; the subsequent documentation-only commit records that evidence.
No merge or deployment is included.

## Next stage-five work

Template Draft/Publish/Default authoring follows in
[the second stage-five package](49-minibar-template-authoring.md).
This receipt foundation has no warehouse stock-out yet. Product/category edits
and lifecycle, linked reversal/correction, waste/adjustment, version Archive,
room configuration/rollout, warehouse↔room transfers, active-stay refill,
consumption/COGS and report/guest-finance integration remain to implement.
No current product or canonical warehouse receipt is imported into
`cleaning_stock` or Reception's room-scoped mock product IDs. Existing mock room
readiness, checkout and booking inventory gates remain in place until an exact
template/configuration/stock adapter is implemented and verified. Restaurant
fulfillment and Operation reports are later stage-five work. External APIs remain
mocked by the user's prior decision; no deployment is included.
