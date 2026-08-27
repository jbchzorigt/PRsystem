# ADR-0017 — PostgreSQL Row Level Security as defence in depth for tenant isolation

**Status:** Accepted · **Date:** Phase 01 · **Closes:** DM-01
**Relates to:** ADR-0001 (single deployment), ADR-0005 (four realms), ADR-0013 (module boundaries)

## Context

ADR-0001 puts every tenant and all four realms in one process and one database. Tenant isolation
therefore rests entirely on code discipline: the authorization pipeline, scoped repositories and
composite foreign keys. Each is sound, but each is also a single class of mistake away from a
cross-tenant read — a forgotten predicate in a hand-written query, a repository method reachable
without a scope, a projection built without `hotel_id`.

`06-tenant-boundaries.md` left this open as **DM-01**.

## Decision

Adopt PostgreSQL Row Level Security as an additional, independent layer. RLS **supplements** the
existing controls; it never replaces them.

1. **Scope of RLS.** Enable RLS on every hotel-scoped and restaurant-scoped operational table.
   Apply `FORCE ROW LEVEL SECURITY` so that the table owner is also subject to the policy.
2. **Transaction-scoped tenant context.** Every runtime transaction sets a server-derived tenant
   context — `SET LOCAL app.hotel_id`, `app.restaurant_id`, `app.realm` — from the resolved
   authorization result. `SET LOCAL` is chosen deliberately: the value dies with the transaction and
   cannot survive on a pooled connection.
3. **Never from the request.** The context is derived from the session's membership after pipeline
   stage 4. A `hotel_id` in a URL or body remains a request *target*, never a source of authority.
4. **Retain every existing control.** Composite tenant foreign keys, mandatory repository predicates
   and the seven-condition pipeline all stay. A query that would be denied by RLS should already have
   been denied earlier; RLS exists to catch the case where it was not.
5. **Database roles.**

   | Role | Grants | RLS |
   | --- | --- | --- |
   | `prsystem_migrate` | DDL owner; runs migrations only | not used at runtime |
   | `prsystem_api` | DML on hotel/restaurant/guest/operation schemas | subject to RLS; no `BYPASSRLS` |
   | `prsystem_worker` | DML plus job tables | subject to RLS; no `BYPASSRLS` |
   | `prsystem_police` | DML on the `police` schema only | subject to RLS; not grantable to the above |
   | `prsystem_maintenance` | retention, rebuild, break-glass | `BYPASSRLS`, used only by named audited jobs |

   No ordinary API or worker role holds `BYPASSRLS`.
6. **Police separation.** Police data lives in its own schema, behind its own repository boundary,
   reached only by `prsystem_police`. That role is not available to Hotel, Restaurant, Guest or
   Operation runtimes. This makes ADR-0005's isolation a database-level guarantee rather than only a
   module-graph guarantee.
7. **Background jobs.** A job carries explicit scope in its payload and establishes it
   transactionally, exactly as a request does. A job that iterates tenants opens one transaction per
   tenant and sets the context inside it. There is no ambient or inherited scope.
8. **Public, global and cross-tenant data.** Three explicit categories, each with a stated rule:

   | Category | Examples | Rule |
   | --- | --- | --- |
   | Public projection | Published hotel listing, search index, published reviews and rating aggregate | Separate tables, no RLS, populated only from tenant-scoped sources; contain no C2/C3 data |
   | Global reference | Packages, permission catalog, config versions | No tenant column; read-only at runtime |
   | Cross-tenant system job | Operation KPI aggregation, retention sweep, projection rebuild | Runs as `prsystem_maintenance` under a named job identity, per-tenant transaction where possible, fully audited |

   Operation KPI aggregation reads only subscription metadata, never guest or operational hotel data,
   so widening its role does not widen its data reach.

## Alternatives rejected

- **Schema per tenant.** Hundreds of schemas make migrations, connection pooling and cross-tenant
  reporting expensive, for isolation that composite keys plus RLS already provide.
- **Database per tenant.** Contradicts ADR-0001 and makes the platform operationally unmanageable at
  the target tenant count.
- **RLS instead of scoped repositories.** A single mechanism means a single point of failure, and RLS
  cannot express the package or subscription-state gates.
- **Session-scoped `SET` instead of `SET LOCAL`.** Leaks across pooled connections — precisely the
  bug this decision exists to prevent.

## Consequences

- Every runtime query runs inside a transaction, because the tenant context is transaction-scoped.
  Autocommit reads outside a transaction are not permitted for tenant-scoped tables.
- Policy definitions live in migrations and are covered by `GATE-MIGR` constraint-presence checks.
- A missing context is a hard failure: with `FORCE ROW LEVEL SECURITY` and no `app.hotel_id`, the
  policy matches nothing and the query returns zero rows rather than everything.
- Owning phases must add the tests in §Verification below. A phase that introduces a tenant-scoped
  table without an RLS policy fails `GATE-MIGR`.

## Verification

Required in the owning phases (Phase 03 establishes the mechanism; Phases 04–19 extend it per table):

| Test | Gate | Asserts |
| --- | --- | --- |
| Cross-tenant read under RLS | `GATE-INTEG` | With hotel A's context, a direct query for hotel B's row returns zero rows even when the repository predicate is removed |
| Missing scope | `GATE-INTEG` | With no `app.hotel_id` set, tenant-scoped tables return zero rows and writes fail |
| Connection-pool context leak | `GATE-CONC` | Transaction A sets context, commits, returns the connection to the pool; transaction B on the same physical connection sees no inherited context |
| API path | `GATE-INTEG` | Every tenant-scoped route executes with a context established from membership, not from the request |
| Worker path | `GATE-INTEG` | Every job sets context transactionally; a job without scope fails rather than running unscoped |
| Role separation | `GATE-INTEG` | `prsystem_api` cannot read the `police` schema; no runtime role holds `BYPASSRLS` |
| Policy presence | `GATE-MIGR` | Every hotel/restaurant-scoped table has RLS enabled and forced |
