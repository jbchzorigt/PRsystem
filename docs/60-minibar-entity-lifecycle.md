# Minibar product and template lifecycle

Implementation candidate; full PostgreSQL acceptance is pending.

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

Migration 057 is additive. All source adapters executing stay/configuration/refill
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
Never-used hard-delete remains unimplemented.
Paid quantity correction, non-guest stock-out, variance/shortage override, partial
physical rollback, Restaurant, Operation, Police and production readiness remain.
Provider integrations stay within the user-approved mock boundary. No merge or
deployment is included.
