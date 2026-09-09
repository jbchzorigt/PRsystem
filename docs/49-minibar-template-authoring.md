# Stage 5 — template authoring

2026-09-09. Implements docs/26 §§24–29 authoring and Publish/Default rules.
This is the second stage-five package, following the accepted warehouse receipt
foundation. It does not complete the whole Minibar/Restaurant/Operation stage.

## Implemented

- Separate template entity and exact numbered draft/published versions. Template
  creation, empty draft, source-version clone and draft item replacement.
- Drafts contain at most 100 unique same-hotel active products with positive
  integer targets; empty drafts can be saved but cannot be published. A clone
  retains source items, including later-inactive products, until edited.
- Publish rechecks current parent/product eligibility, then freezes product IDs,
  quantities and display labels. It does not freeze selling prices; the later
  check-in price book owns those prices. PostgreSQL creates the snapshot itself.
- First Publish installs the sole Default atomically. Later publishes leave it
  intact. Separate Default command targets a currently eligible exact Published
  version. Deferred database checks enforce the published/default invariant.
- Published lines/versions cannot be edited or deleted, even by an owner query.
  Composite foreign keys protect tenant, template and clone/product lineage.
- Current account, session, membership, package-role intersection, subscription
  and suspension checks precede idempotent replay. CAS uses the template revision
  across authoring commands; concurrent stale actions conflict. Template, version,
  lines, default, immutable audit and receipt commit or roll back together.
- Manager UI with bounded template/version pages, exact-version detail, paged
  product chooser, add/change/remove draft lines, clone, Publish and Default.
  Forms use shared validation, uncertain retry and dirty/conflict recovery.

## API and grants

Prefix `/hotels/{tenant_id}/minibar/templates`:

| Method | Suffix | Purpose |
| --- | --- | --- |
| POST / GET | root | Create / bounded template list |
| POST / GET | `/{template_id}/versions` | Empty/clone draft / bounded version list |
| GET / PUT | `/{template_id}/versions/{version_id}` | Exact detail / replace draft items |
| POST | `/{template_id}/versions/{version_id}/publish` | Validate and freeze draft |
| POST | `/{template_id}/versions/{version_id}/default` | Select exact Published default |

Migration 044 is append-only. Restricted application grants are SELECT/INSERT
on the three template tables; UPDATE(revision,default_version_id) on template,
UPDATE(state) on version, DELETE on draft items (guarded by version state).
Existing product row-lock, staff command receipt and operational audit grants
remain required. No template/version DELETE or snapshot UPDATE grant is needed.
The role must not own tables or bypass forced tenant RLS.

## Verification

15 new PostgreSQL tests cover publish/default invariants, clones, immutable
history, active-product/parent gates, package/role/replay revocation, cross-tenant
and cross-template IDs, exact CAS races, strict input, pagination, side-effect
isolation and commit failure. Local suite: 537 discovered, 100 passed, 437 skipped
because PostgreSQL is unavailable locally. Full PostgreSQL CI remains pending.
Browser authoring flow passed with safe retry, conflict/reload, picker failure,
validation/focus, native select keyboard use, role gating, 320px and no storage.
All five browser suites passed locally; 10 new generated requests match the real
API models. Strict UI audit: zero findings. Token drift check passed; design lint
has zero errors and six existing orphaned-token warnings. Mobile/desktop
screenshots were inspected. Final PostgreSQL/publication evidence remains pending.

## Next boundaries

Archive and template entity lifecycle need the canonical room/current/pending,
stay and reconciliation reference gates before exposure. Room configuration,
rollout, warehouse↔room transfer and active-stay refill remain next work.
Authoring commands neither touch existing Reception mock minibar nor create room
pointers, readiness blockers, stock movements, Cleaner tasks, guest charges or
price books. Reception/Cleaner exact-version read access belongs to their future
room/task scope; these authoring endpoints remain Manager-only. No deployment.
