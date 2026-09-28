# Minibar product and template lifecycle

Accepted source: `7d2cf463cb9443e3d89469e6d969dd4d30caad1a`.
[CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34449347356): the focused
18-test PostgreSQL lifecycle gate, all 14 Chromium suites and 92 actual
browser/API command contracts passed. Strict local UI audit has zero findings;
design/token CI passed with the six pre-existing design warnings. **714/714 backend tests passed without skips in 832.546 seconds** in the
full PostgreSQL run. Local discovery ran 106 tests and skipped 608 database-dependent
tests; the linked remote run is the full acceptance evidence.

Current Manager/package authority, expected entity revision, mandatory reason
and idempotency protect DEACTIVATE, CANCEL_RETIRING and REACTIVATE. The separate
GET preview exposes grouped dependency counts. The warehouse and template-detail
interfaces reuse the existing confirmation, error and navigation primitives.

Deactivation blocks new receipts, template/configuration selection, check-in and
new refill requests through existing current-state gates. A pending earlier
refill may finish while its product is RETIRING under the existing server-time
proof. Active stays keep their exact version, opening and selling price book.

Room stock/current configuration, active stays, pending configuration/refill and
active Published templates keep a product RETIRING. Templates wait for room,
stay and pending work references. Warehouse stock does not block INACTIVE and
remains visible in inventory and valuation. The template's Published history and
Default pointer remain unchanged. Template reactivation requires active products.

Immutable intent snapshots record the requesting actor and reason. Deferred
configuration, stay and refill triggers check the final transaction state and
record a separate SYSTEM completion tied to that intent when the last blocker
is gone. Template retirement can release a waiting product in the same command.
No guest charge, price snapshot, inventory quantity or cost is rewritten.

## Runtime grants

Migrations 057–058 are additive. All source adapters executing stay/configuration/refill
terminal writes need SELECT on minibar_lifecycle_intent, including when no
retirement exists. The shared operational runtime additionally needs:

- SELECT, INSERT on minibar_lifecycle_intent and minibar_lifecycle_completion;
- UPDATE(status,revision,deactivation_requested_at) on minibar_product;
- UPDATE(status,revision) on minibar_template;
- existing SELECT on room/stay/configuration/template/item/version/product,
  minibar receipt/transfer and refill request/result sources used for blockers.

The runtime remains a non-owner, non-superuser with forced tenant RLS. Functions
use invoker rights. Immutable history has no UPDATE/DELETE grant. Server role and
package gates remain necessary; these database grants alone do not authorize a
staff user to perform a lifecycle transition.

## Verification and remaining scope

The focused suite covers dependencies, automatic completion, preserved stock and
Published history, reactivation order, cancel, retry/CAS, current role/package,
tenant isolation, required reason, concurrency and deferred rollback. Browser
coverage includes loading failure, CAS recovery, uncertain completion, required
acknowledgement, retirement/cancel/reactivation and 320px reflow.

Templates can be created ACTIVE or INACTIVE; authoring requires ACTIVE.
Hard-delete is available only without business history or dependencies. Every
created product has an immutable opening receipt (including a zero opening), so
it cannot be hard-deleted. An empty template with no versions, assignments or
lifecycle history can be deleted. Database preconditions and a deferred audit
proof reject direct deletion without immutable actor/reason evidence. Retry
returns the existing receipt even after the entity is gone.

The deletion adapter additionally needs DELETE on minibar_template and
minibar_product; database guards retain all used entities. The browser exposes
the separate permanent-delete confirmation only after an eligible preview.

Initial focused CI passed 12/15 tests. The other three stopped in test setup:
two passed the reason keyword twice and one attempted to create a second
Primary Hotel Admin using the ordinary staff fixture. The tests now merge
overrides and use the existing Hotel Admin token; application gates are unchanged.
Paid quantity correction, non-guest stock-out, variance/shortage override, partial
physical rollback, Restaurant, Operation, Police and production readiness remain.
Provider integrations stay within the user-approved mock boundary. No merge or
deployment is included.
