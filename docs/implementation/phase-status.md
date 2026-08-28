# PRsystem — Phase Status

**Branch:** `claude/mvp-implementation`
**Base commit:** `c1c2abc` (`docs: add hotel booking MVP requirements baseline`)
**Phase namespace:** 01–23 as fixed in [build-plan.md](build-plan.md) §3. Approved and immutable —
no phase may be dropped, merged, renumbered or reordered.

Legend: `DONE` · `IN PROGRESS` · `BLOCKED` · `NOT STARTED` · `SECURITY_REPAIR_REQUIRED`

---

## Current position

| Field | Value |
| --- | --- |
| Current phase | **03 — Platform kernel** |
| Phase state | **`SECURITY_REPAIR_REQUIRED`** — customer review rejected the database bootstrap and privilege model; repair in progress, no acceptance claimed |
| Next phase | 04 — IAM, tenancy, RBAC, and staff lifecycle |
| Next phase state | `NOT STARTED` — requires explicit authorization to begin |
| Blocking conflicts | None. Four documented drift resolutions, zero unresolved P0 conflicts. |

---

## Phase ledger

| # | Phase | State | Migrations | Gates run | Commit |
| --- | --- | --- | --- | --- | --- |
| 00 | Requirement intake and governance baseline | `DONE` | — | `GATE-GOV` | `07a9fd0`, `d2cbc65` |
| 01 | Architecture and threat model | `DONE` | — | `GATE-GOV` 13/13 | `b0ec3f3`, repair pending |
| 02 | Monorepo scaffold | `DONE` | `0000_baseline` | `GATE-GOV` 13/13, workspace 15/15, `GATE-LINT`, `GATE-TYPES`, `GATE-UNIT` 108, `GATE-MIGR` 4, `GATE-E2E` 15, audits | `f3d7b3d`, `071362a` |
| 03 | Platform kernel | `SECURITY_REPAIR_REQUIRED` | `0001_kernel` | `GATE-MIGR` 49, `GATE-INTEG` 51, `GATE-CONC` 16, `GATE-SEC` 18/18 (439 tests), regression 51, `GATE-E2E` 15, `GATE-UNIT` 175, `GATE-GOV` 13/13, workspace 15/15, coverage 51/51, CI bypass fixtures 26/26, pool fixture 3/3 | `8a62b0b` … `85d745c`, `66c2c65`, `f3e0c16`, `f88cc38`, `46fdce1`, `816756d`, `41b1e35`, `08f0fa0`, _final documentation commit_ |
| 04 | IAM, tenancy, RBAC, and staff lifecycle | `NOT STARTED` | — | — | — |
| 05 | Hotel onboarding and subscription | `NOT STARTED` | — | — | — |
| 06 | Hotel, room, category, and tariffs | `NOT STARTED` | — | — | — |
| 07 | Minibar inventory and templates | `NOT STARTED` | — | — | — |
| 08 | Availability, guest identity, reception, and stay | `NOT STARTED` | — | — | — |
| 09 | Cleaner and checkout coordination | `NOT STARTED` | — | — | — |
| 10 | Folio, deposit, payment, and correction | `NOT STARTED` | — | — | — |
| 11 | Shift, cash drawer, expense, and hotel finance | `NOT STARTED` | — | — | — |
| 12 | Public discovery and Guest authentication | `NOT STARTED` | — | — | — |
| 13 | Online booking and inventory hold | `NOT STARTED` | — | — | — |
| 14 | Online payment, refund, commission, and settlement | `NOT STARTED` | — | — | — |
| 15 | Restaurant | `NOT STARTED` | — | — | — |
| 16 | Verified reviews | `NOT STARTED` | — | — | — |
| 17 | Guest registry, exports, and Hotel Admin reports | `NOT STARTED` | — | — | — |
| 18 | Police monitoring | `NOT STARTED` | — | — | — |
| 19 | Platform Operation | `NOT STARTED` | — | — | — |
| 20 | External adapters | `NOT STARTED` | — | — | — |
| 21 | Responsive UI and accessibility | `NOT STARTED` | — | — | — |
| 22 | Security, concurrency, recovery, and full E2E | `NOT STARTED` | — | — | — |
| 23 | Release candidate audit | `NOT STARTED` | — | — | — |

---

## Phase 00 record

### Scope completed

- **Pre-flight.** The worktree was empty and not a git repository. Initialized from
  `https://github.com/jbchzorigt/PRsystem.git`; `main` verified clean at `c1c2abc`; branched to
  `claude/mvp-implementation`. No tracked file was modified at any point.
- **Requirement intake.** All 27 files [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) …
  [docs/26-room-minibar-lifecycle.md](../26-room-minibar-lifecycle.md) read completely — 10 212 lines.
  Seven files exceeded the single-read cap and were read across multiple paginated reads: `02`, `05`,
  `09`, `13`, `18`, `22`, `26`.
- Created [CLAUDE.md](../../CLAUDE.md) with the permanent engineering rules.
- Created the five implementation-governance documents under `docs/implementation/`.
- Inventoried **279 canonical DEC IDs** across 22 decision families.
- Inventoried **11 external integration gates** (EXT-01 … EXT-11) plus three production security
  exceptions carried by the Police module.
- Recorded **17 P1 configuration items** and **four documentation drift resolutions**.

### Repair applied after review

The first submission drifted from the approved plan: it contained 21 phases and altered the approved
ordering. The repair restored the approved structure without touching any requirement document.

- Restored the exact approved 23-phase structure, numbering and titles (01–23).
- Phase 01 is now architecture and threat-model documentation only; Phase 02 is the monorepo
  scaffold; Phase 03 is the platform kernel.
- Full external adapters moved to Phase 20. Earlier phases may define typed provider ports and
  deterministic simulators only where the phase cannot be built or gated without them; the permitted
  set is enumerated in [build-plan.md](build-plan.md) §2.
- All 279 DEC mappings preserved and reassigned so that **each decision has exactly one owning
  phase**. Consumption by a later phase is expressed as a sequencing constraint, not a second owner.
- Added `tools/validate-governance.mjs` and made governance validation a standing gate.

### Changed file groups

| Commit | Files |
| --- | --- |
| `07a9fd0` | `CLAUDE.md`; `docs/implementation/` (five documents, new) |
| repair | `docs/implementation/build-plan.md`, `phase-status.md`, `requirements-traceability.md`, `external-integration-gates.md`, `assumptions-and-conflicts.md`; `tools/validate-governance.mjs` (new) |

### Migrations

None.

### DEC coverage

Inventory only. All 279 decisions are `PENDING` with exactly one owning phase in 01–23. Phase load is
tabulated in [requirements-traceability.md](requirements-traceability.md) §2.

### Test gates

Current counts, measured on the tree the seventh repair describes. Earlier
sections quote the counts current when they were written and are labelled as
historical snapshots.

```bash
node tools/validate-governance.mjs                       # GATE-GOV 13/13
node tools/validate-workspace.mjs                        # 15/15
node tools/validate-regression-coverage.mjs              # 51/51 structural CI checks
node tools/validate-regression-coverage.fixtures.mjs     # 26/26 bypasses rejected
node tools/validate-pool-error-fixture.mjs               # 3/3 — an idle-pool error fails a suite
node tools/scan-secrets.mjs                              # 0 findings
pnpm run format:check                                    # clean
pnpm run lint                                            # GATE-LINT — 16 projects + e2e
pnpm run typecheck                                       # GATE-TYPES — 25 graphs, tests included
pnpm run test:unit                                       # GATE-UNIT — 175 passed
pnpm run test:migrations                                 # GATE-MIGR — 49 passed
pnpm run test:integration                                # GATE-INTEG — 51 passed
pnpm run test:concurrency                                # GATE-CONC — 16 passed
pnpm run test:regression                                 # 51 passed
pnpm run test:security                                   # GATE-SEC — 18/18 sub-gates, 439 tests
pnpm run test:e2e                                        # GATE-E2E — 15 passed
pnpm run audit:prod                                      # no known vulnerabilities
pnpm run audit:tree                                      # clean at high; now blocking
pnpm run build                                           # 16 projects
pnpm run openapi                                         # /api/v1 document
git diff --check                                         # clean
```

Results are recorded in the repair commit message and reported to the customer.

### Security and concurrency evidence

Not applicable to a documentation phase.

### Remaining blockers

- No P0 product blockers. [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §2 records
  zero open P0 items.
- Eleven EXT gates block production release only. Development proceeds against typed ports plus
  deterministic simulators with production adapters disabled until Phase 20 (CLAUDE.md §9).
- Seventeen P1 items are configuration and acceptance values that do not reopen schema or API design;
  each has a documented interim default in
  [assumptions-and-conflicts.md](assumptions-and-conflicts.md) §4.

### Commits

- `07a9fd0835893c0c9e3d11777f51f4dbd580cdb9` — initial Phase 00 baseline.
- Repair commit SHA recorded at commit time.

---

## Phase 01 record

### Scope completed

Documentation only. No workspace, package manifest, lockfile, dependency, application code, migration
or test code was created, and `docs/00` … `docs/26` were not modified.

Delivered under [docs/architecture/](../architecture/README.md):

| Deliverable | Document |
| --- | --- |
| System context (C4 L1), actors, boundary crossings, three separated money flows | `01-system-context.md` |
| Container and deployment view, request and callback lifecycles, worker queues | `02-container-and-deployment.md` |
| Module ownership register (19 modules), dependency rules, cross-module flows | `03-module-ownership-and-dependencies.md` |
| Logical ERD per bounded context with database-level invariants | `04-logical-data-model.md` |
| Four authentication realms and the seven-condition authorization pipeline | `05-authentication-realms-and-authorization.md` |
| Tenant boundaries and five-layer enforcement incl. forced RLS | `06-tenant-boundaries.md` |
| Data classification C0–C4 and the handling matrix | `07-data-classification.md` |
| Eleven trust boundaries and their validation | `08-trust-boundaries.md` |
| STRIDE threat model: 83 threats, mitigations, residual register | `09-threat-model.md` |
| Money and time invariant specification | `10-money-and-time-invariants.md` |
| Concurrency strategy: 10 race classes, 21-entry race register | `11-concurrency-strategy.md` |
| Migration strategy: versioned only, expand/contract, append-only enforcement | `12-migration-strategy.md` |
| Telemetry and redaction policy | `13-telemetry-and-redaction.md` |
| Test strategy and the 8-gate catalog | `14-test-strategy-and-gates.md` |
| Non-functional targets **proposed** for P1-10, all `PROVISIONAL_ARCHITECTURE_DEFAULT`; P1-10 stays `OPEN` | `15-non-functional-targets.md` |
| Typed port surface per EXT gate, plus `KeyManagementPort`, and the 8-scenario conformance suite | `16-external-port-catalog.md` |
| DEC → control → gate mapping for all 279 decisions; 41-control catalog | `17-dec-control-mapping.md` |
| 20 architecture decision records | `adr/ADR-0001` … `adr/ADR-0020` |

`tools/validate-governance.mjs` extended with Phase 01 architecture checks 8–13, and check 7 widened
to cover the architecture set.

### Design decisions closed on review

The customer required the four open design questions to be closed before Phase 02. All four are now
resolved; **none remains open**.

| ID | Decision | ADR |
| --- | --- | --- |
| DM-01 | PostgreSQL Row Level Security as defence in depth — forced RLS, transaction-scoped server-derived context, five database roles, separate migration owner *(as decided in Phase 01; the role model is now 11 group roles and 7 login principals — see D-09)*, Police schema and role, explicit public/global/cross-tenant handling, required RLS tests in owning phases | [ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md) |
| DM-02 | Monthly-partitioned append-only audit in two separately granted streams, pre-created partitions with a horizon alert, fail-closed high-risk audit, retention by data class with legal hold and no invented Police duration, no `UPDATE`/`DELETE` for runtime roles | [ADR-0018](../architecture/adr/ADR-0018-audit-partitioning.md) |
| DM-03 | Same-transaction read models within a module; cross-module projections eventually consistent via outbox and idempotent inbox with observable freshness; critical commands never read a projection; all projections rebuildable | [ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md) |
| DM-04 | Provider-neutral `KeyManagementPort`, envelope encryption with versioned DEKs, separate Hotel/Guest and Police key scopes, versioned keyed-HMAC lookup, key version stored with ciphertext, rotation and rewrapping, development simulator, production fails closed, no plaintext key anywhere | [ADR-0020](../architecture/adr/ADR-0020-key-management.md) |

Four controls were added to carry them: `CTL-DATA-11` (RLS), `CTL-DATA-12` (partitioned fail-closed
audit), `CTL-BOUND-03` (projection critical-path isolation) and `CTL-SEC-04` (key management). The
first three are universal and apply to every command.

### Non-functional status correction

The first Phase 01 submission claimed P1-10 was closed. That was wrong: architecture may **propose**
measurable targets, but only an approved customer decision makes them a product requirement.

- Every value in `15-non-functional-targets.md` now carries the status
  `PROVISIONAL_ARCHITECTURE_DEFAULT`, explicitly including **RPO ≤ 5 minutes** and **RTO ≤ 4 hours**.
- **P1-10 status: `OPEN`.** P1 accounting is **17 total · 17 pending · 0 closed**, consistent across
  every governance document and enforced by `GATE-GOV` check 13.
- Phase 22 measures the values; Phase 23 reports achieved-or-not per target and returns the release
  decision to the customer. Measurement alone never closes the item.

### Changed file groups

- `docs/architecture/` — 18 new documents plus `adr/` (17 new files)
- `docs/implementation/requirements-traceability.md` — §26 control mapping, §27 validation
- `docs/implementation/phase-status.md` — this record
- `tools/validate-governance.mjs` — checks 7–11

### Migrations

None. No schema exists.

### DEC coverage

Phase 01 owns **0 decisions**. It establishes the control and gate vocabulary that all 279 decisions
are mapped through; every decision now has a control and gate mapping, verified by check 11.
No decision moves to `COVERED` in this phase.

### Test gates

```bash
node tools/validate-governance.mjs      # GATE-GOV — 13/13 passed
git diff --check                        # clean, exit 0
```

`GATE-TYPES`, `GATE-LINT`, `GATE-UNIT`, `GATE-INTEG`, `GATE-CONC`, `GATE-MIGR`, `GATE-E2E` and
`GATE-SEC` are **not applicable**: no code, no schema and no workspace exist until Phase 02. None was
run and none is claimed as passing.

### Security and concurrency evidence

Design-level only. The threat model records 83 threats with named mitigations, controls and verifying
gates, and a residual register of 15 Medium risks with named owners. No Critical or High residual risk
remains. Concurrency evidence is the 21-entry race register, each entry bound to a `GATE-CONC` test to
be written by its owning phase.

### Remaining blockers

No P0 product blockers. Eleven EXT gates block production release only. **Seventeen P1 items remain
open**, including P1-10. The four Phase 01 design questions `DM-01` … `DM-04` are **closed** by
ADR-0017 … ADR-0020; none remains open.

---

## Phase 02 record

### Scope completed

Infrastructure only. **No business entity, domain table, authentication, RBAC, platform kernel table,
outbox, idempotency, audit implementation, external adapter, business page or workflow was created**,
and `docs/00` … `docs/26` were not modified.

| Deliverable | Location |
| --- | --- |
| pnpm 9.15.9 workspace + Turborepo 2.10.12 pipeline, exact-pinned lockfile | `pnpm-workspace.yaml`, `turbo.json`, `pnpm-lock.yaml` |
| Strict TypeScript base — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` | `tsconfig.base.json` |
| NestJS 11 + Fastify 5 API, liveness and readiness with injectable probes, OpenAPI document | `apps/api/` |
| BullMQ worker skeleton with queue registry and graceful shutdown | `apps/worker/` |
| Five Next.js 15 App Router portal shells | `apps/web-public|hotel|restaurant|police|operation/` |
| Fail-closed validated environment; errors never echo a secret value | `packages/config/` |
| Structured logging, correlation IDs, redaction by field name and value shape | `packages/telemetry/` |
| Drizzle + versioned migration runner and the business-table-free baseline | `packages/db/` |
| Synthetic-identity generator in a reserved range; boundary-rule test | `packages/testing/` |
| Playwright harness and portal-shell smoke tests | `playwright.config.ts`, `e2e/` |
| ESLint module-boundary rule plus a fixture proving it fires | `eslint.config.mjs`, `tools/lint-fixtures/` |
| Local topology: PostgreSQL 17.6, Redis 7.4.2, MinIO, Mailpit — pinned, health-checked | `docker-compose.yml`, `.env.example` |
| Workspace validator (11 checks) and secret scanner | `tools/validate-workspace.mjs`, `tools/scan-secrets.mjs` |
| CI: governance, verify, e2e and compose-with-migrations jobs | `.github/workflows/ci.yml` |
| Local development guide | [../development.md](../development.md) |

### Scope clarification, not a deferral

Drizzle, the migration runner and the Playwright harness are delivered **in this phase**, scoped to
what exists before the data model: a business-table-free baseline migration proved fresh and
repeat-applied, and non-business portal-shell smoke tests. Recorded in
[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.2. Nothing was moved out of Phase 02.

### Migrations

`packages/db/migrations/0000_baseline.sql` — installs `btree_gist` and `pgcrypto`. **It creates no
table.** `test:migrations` asserts that after applying the whole journal, zero base tables exist
outside the migration ledger, so Phase 03 starts from a verified clean slate.

### DEC coverage

Phase 02 owns **0 decisions**; all 279 remain `PENDING`. Its traceable obligations and their gates are
recorded in [requirements-traceability.md](requirements-traceability.md) §2.1.

### Test gates

Run in order from a **clean install** (`rm -rf node_modules` → `pnpm install --frozen-lockfile`), with
`.env.example` sourced into the environment. All 15 exited 0.

```bash
pnpm install --frozen-lockfile        # 306 packages, lockfile unchanged
node tools/validate-workspace.mjs     # 15/15
node tools/validate-governance.mjs    # GATE-GOV 13/13
node tools/scan-secrets.mjs           # 186 tracked text files, 0 findings
pnpm run format:check                 # clean
pnpm run lint                         # GATE-LINT — 11 projects + e2e sources
pnpm run typecheck                    # GATE-TYPES — 13 project graphs
pnpm run test:unit                    # GATE-UNIT — 12 files, 108 tests passed
pnpm run build                        # 11 build tasks (7 applications)
pnpm run openapi                      # openapi 3.0.0, /health/live + /health/ready
docker compose up -d --wait           # 4 services healthy
pnpm run test:migrations              # GATE-MIGR — 1 file, 4 tests passed
pnpm run test:e2e                     # GATE-E2E — 15 tests passed across 5 portals
pnpm run audit:prod                   # production tree — no known vulnerabilities
pnpm run audit:tree                   # full tree — 0 high or critical (1 moderate: DSR-01)
git diff --check                      # clean
```

`GATE-INTEG`, `GATE-CONC` and `GATE-SEC` are **not applicable** — no schema, no concurrent command
and no authorization path exists yet. None was run and none is claimed as passing.

### Defects found and fixed during the gate run

| Defect | Cause | Fix |
| --- | --- | --- |
| Duplicate `fastify` copies broke `typecheck` | direct pin 5.12.1 vs `@nestjs/platform-fastify@11.2.3`'s exact 5.11.3 | aligned the direct pin to 5.11.3 |
| Registration-number redaction never fired | the value-shape regex matched 8 digits; a Mongolian registration number is `YYMMDD` + 4 | corrected to 10 digits, matching `packages/testing` |
| API failed to boot and OpenAPI generation aborted silently | Swagger UI needs `@fastify/static`; readiness probes resolved env while the DI container was built | serve the JSON document only; probes now connect on first use, so a missing dependency reports **not ready** instead of aborting start-up |
| Portal builds failed intermittently with a misleading `<Html> should not be imported outside of pages/_document` | `next build` inherited `NODE_ENV=development` when `.env` was sourced, prerendering error pages against a development React build | portal `build` scripts pin `NODE_ENV=production`; reproduced and verified in both directions |
| 2 high, 3 moderate advisories | transitive `postcss@8.4.31` via `next@15.5.24` | exact `pnpm.overrides` pin to `postcss@8.5.26` |

### Security and concurrency evidence

- Redaction is a property of the logger, not of call sites: 55 telemetry tests cover the field-name
  deny-list, the value-shape deny-list (JWT, PEM, PAN, registration number, base64 blob), nesting,
  arrays and depth bounds.
- `packages/config` fails closed on a malformed environment and its error listing carries **no secret
  value** — asserted by a dedicated test.
- Readiness reports carry an error **name** only; no connection string, host or credential — asserted
  by a test over a real listener.
- Test identities are synthetic and confined to a reserved `99` prefix range.
- The cross-module import ban is proved by a fixture that ESLint must reject, executed as a test.
- Compose binds every service to `127.0.0.1` on a PRsystem-only port range under the compose project
  `prsystem`; no container outside that project was created, reused or stopped.
- No concurrency evidence is claimed: no concurrent command exists yet.

### Dependency security closure

Closed before acceptance. The remaining advisory is **`GHSA-67mh-4wv8-2f99`** (Moderate, esbuild
development server), reaching the workspace only through
`packages/db → drizzle-kit@0.31.10 → @esbuild-kit/esm-loader@2.6.5 → @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20`.
It is **constrained, not silenced**: no audit ignore, no unstable Drizzle pre-release, no forced
`esbuild` override, and the migration infrastructure is intact.

| Verified condition | Evidence | Enforced by |
| --- | --- | --- |
| `drizzle-kit` is a devDependency only | declared once, in `packages/db` devDependencies | `validate-workspace` 12 |
| Absent from the production dependency tree | `pnpm why drizzle-kit --prod` empty; `pnpm run audit:prod` → **no known vulnerabilities, exit 0** | `validate-workspace` 12, CI |
| `apps/api` and `apps/worker` never import it | 50 source files scanned, zero imports in any form | `validate-workspace` 13 |
| No command runs the esbuild development server | no `--serve` / `--servedir` in any script or workflow | `validate-workspace` 14 |
| CI blocks moderate-or-higher **production** advisories | `pnpm run audit:prod`, blocking | `validate-workspace` 15 |
| The full-tree high audit remains enabled | `pnpm run audit:tree`, advisory | `validate-workspace` 15 |

Full record, exploit condition, review owner and removal condition:
[dependency-security-register.md](dependency-security-register.md) **DSR-01**, with mandatory review
in **Phase 20** and **Phase 22**.

**The development dependency tree is not claimed to be advisory-free.** It carries DSR-01, reported
openly. What is claimed, and evidenced, is that the production dependency tree is clean at moderate
and above.

### Remaining blockers

`DSR-01` remains **OPEN — contained**; it blocks nothing in Phase 02 and is not a production
dependency. Eleven EXT gates still block production release only. **Seventeen P1 items remain open**,
including P1-10. No P0 product blocker. No requirement conflict was discovered in this phase.

---

## Phase 03 record

### Scope completed

The platform transaction kernel. **No business-domain table exists**: no hotel, guest, room, staff,
subscription, booking, restaurant or Police case row type, and no login, account, membership, RBAC or
staff-lifecycle code. `docs/00` … `docs/26` were not modified.

| Module | Delivered |
| --- | --- |
| `packages/money` | branded `bigint` MNT, integer basis points, the single `ROUND_HALF_UP` division, JSON-string wire form |
| `packages/time` | UTC instants, hotel-local date derivation, `[start,end)` intervals, integer minutes and half-hour units, calendar/service-month arithmetic with end-of-month clamping |
| `packages/contracts` | `/api/v1`, canonical error envelope with 14 stable codes, cursor pagination, correlation/idempotency/revision headers, UUIDv7 stable ids |
| `packages/ports` | `KeyManagementPort`, fail-closed `LocalKeyManagement` simulator, `UnavailableKeyManagement`, envelope encryption with AAD binding, versioned keyed-HMAC lookup tokens |
| `packages/db` | tenant context, transaction/unit-of-work boundary, scoped-repository foundation with revision CAS, and the kernel stores: idempotency, outbox, inbox, provider events, audit, projections, partitions |
| `packages/outbox` | at-least-once relay with lease and backoff; idempotent consumer helper |
| `apps/api` | `/api/v1` global prefix, canonical error filter |
| `apps/worker` | two kernel queues, audit partition-maintenance job |

### Migrations

`packages/db/migrations/0001_kernel.sql` — schemas `platform`, `audit`, `police_audit`, `police`;
17 kernel tables plus 8 monthly audit partitions; RLS enabled **and forced** on all 7 tenant-scoped
tables; append-only triggers; partition and horizon functions; all 11 EXT gates seeded closed.

### Database roles

Ten `NOLOGIN` group roles. A deployment creates one login user per runtime and grants it exactly one
group, so no credential is invented in a migration. `database-bootstrap-runbook.md` §2 is the
authoritative table; this is the same content stated in terms of duties.

| Role | Duty | Grants | `BYPASSRLS` |
| --- | --- | --- | --- |
| `prsystem_migrate` | DDL owner; migrations only | owns the schemas and platform tables | no |
| `prsystem_api` | request handling | DML on `platform`; audit only by executing the definer wrapper, with **no direct grant on either audit stream**; no `police_audit`; **nothing at all** on `outbox_delivery` | no |
| `prsystem_worker` | jobs and the outbox relay | as API, plus `outbox_delivery` `SELECT, UPDATE`, export and projection tables, **column-scoped** `UPDATE (state, finished_at, error_name, as_of)` on `job_run`, and **no `INSERT`** on `job_run` | no |
| `prsystem_police` | Police realm | `police` / `police_audit` only | no |
| `prsystem_audit_writer` | function owner | owns both audit append functions (approved shared owner, ADR-0018) | no |
| `prsystem_partition_mgr` | function owner | owns the audit streams, their partitions and the partition functions | no |
| `prsystem_maintenance_fn` | function owner | owns the cross-tenant maintenance functions; sets tenant scope one tenant at a time | no |
| `prsystem_maintenance` | **break-glass only** | **owns nothing and holds no standing grant, not even schema `USAGE`**; zero members | **yes** — the only one |
| `prsystem_audit_reader` | read-only | scoped `SELECT` on `audit.platform_event` only | no |
| `prsystem_police_audit_reader` | read-only | scoped `SELECT` on `police_audit.security_event` only | no |

**Maintenance is not the worker, and the worker is not break-glass.** Normal cross-tenant maintenance
runs as a `SECURITY DEFINER` function owned by `prsystem_maintenance_fn`, invoked by the worker under
a named job identity, with tenant scope established per tenant. `prsystem_maintenance` is reachable by
nobody — including the migration principal — and exists only as a documented break-glass identity for
a DBA acting under an incident. ADR-0017 §§4–5 and §7 now say the same thing; the earlier §7 wording
is recorded as drift resolution **D-08**.

Every approved membership carries exactly `ADMIN FALSE, INHERIT TRUE, SET TRUE`. PostgreSQL retains
membership options that a later `GRANT` omits, so bootstrap states all three explicitly rather than
re-granting and assuming the options reset.

### Invariant evidence

| Invariant | How it is enforced | Proved by |
| --- | --- | --- |
| Missing tenant scope fails closed | `FORCE ROW LEVEL SECURITY`; `hotel_id = platform.current_hotel_id()` is NULL-safe-false | zero rows on read, `row-level security` error on write |
| Tenant A cannot reach tenant B | RLS policy plus repository predicate | targeted cross-tenant read returns 0 rows, cross-tenant write refused |
| Pool reuse leaks no context | `SET LOCAL` plus a targeted reset on release | `max: 1` pool proves the same physical connection carries nothing forward |
| No runtime role bypasses RLS | `NOBYPASSRLS` asserted per role in the migration | `pg_roles` assertion over all 6 non-maintenance roles |
| Audit is append-only | raising trigger on `UPDATE`/`DELETE`; `TRUNCATE` refused by privilege and by a per-partition trigger | all three refused |
| High-risk audit failure fails the mutation | audit and effect share one `UnitOfWork` | a refused audit payload leaves zero orphan outbox rows |
| Audit readers cannot cross | separate schemas, separate grants | four cross-boundary reads all `permission denied` |
| A retry creates one effect | unique index on `(realm, actor, operation, key)` | 6 concurrent identical requests → 1 claim, 1 effect row |
| Same key, different payload | stored `request_hash` compared before replay | refused, and no second effect |
| One consumption per event | unique `(consumer, dedup_key)` | 5 racing consumers → 1 claim |
| Two workers never share a row | `FOR UPDATE SKIP LOCKED` | disjoint claim sets |
| A crashed worker loses nothing | lease expiry on the delivery row only | event redelivered, payload identical |
| No secret in a durable record | `jsonb ?|` check constraints plus logger redaction | planted canaries refused, and a whole-database sweep finds none |

### DEC coverage

Phase 03 owns **0 decisions**; all 279 remain `PENDING`. Obligations and gates are recorded in
[requirements-traceability.md](requirements-traceability.md) §2.1.

### Test gates

Counts below are the current ones, re-measured on the tree described by the fourth repair. Earlier
sections of this document quote the counts that were current when they were written and are labelled
as historical snapshots where they differ.

```bash
node tools/validate-governance.mjs    # GATE-GOV 13/13
node tools/validate-workspace.mjs     # 15/15
node tools/validate-regression-coverage.mjs  # 9/9 — no security regression suite omitted
node tools/scan-secrets.mjs           # 283 tracked text files, 0 findings
pnpm run format:check                 # clean
pnpm run lint                         # GATE-LINT — 16 projects + e2e sources
pnpm run typecheck                    # GATE-TYPES — 25 project graphs
pnpm run test:unit                    # GATE-UNIT — 175 passed
pnpm run test:migrations              # GATE-MIGR — 22 passed (fresh, frozen-baseline upgrade,
                                      #   determinism, idempotence, atomic failure, version
                                      #   evidence, 11 fingerprint sensitivity cases)
pnpm run test:integration             # GATE-INTEG — 51 passed
pnpm run test:concurrency             # GATE-CONC — 17 passed
pnpm run test:regression              # 23 passed — every reproduced review defect
pnpm run test:security                # GATE-SEC — 14/14 sub-gates, 326 tests
pnpm run test:e2e                     # GATE-E2E — 15 passed
pnpm run audit:prod                   # no known vulnerabilities
pnpm run audit:tree                   # 1 moderate (DSR-01)
pnpm run build                        # 16 projects
pnpm run openapi                      # /api/v1 document
git diff --check                      # clean
```

PostgreSQL 17.6 (aarch64-unknown-linux-musl, Alpine), extensions `btree_gist` and `pgcrypto`.
Race-focused suites (`test:concurrency`, `test:regression`, `SEC-OWNERSHIP`) were run **three
consecutive times**: 34/34 on each run.

`GATE-SEC` is a **cumulative** gate. Phase 03 implements its kernel security subset — roles, RLS,
the ACL matrix, ownership, audit, partitions, maintenance accountability, Police isolation, key
management, PII leakage, secrets, startup and the review regressions. Phase 22 expands the same gate
with headers, CSP, the penetration/security-review pass and the release checks. It is neither "full"
nor "partially exercised": it is complete for what Phase 03 owns.

### Defects found and fixed during the gate run

| Defect | Why it mattered | Fix |
| --- | --- | --- |
| RLS suites ran through a superuser connection | a superuser bypasses RLS unconditionally, `FORCE` included, so the policy assertions proved nothing | added a runtime-role pool to the harness; every policy-sensitive test now connects as `prsystem_api` / `prsystem_police` |
| `RESET ALL` on connection release | would have cleared the connection's role as well as the tenant context | reset only the `app.*` keys |
| `UnavailableKeyManagement` threw synchronously | a caller using `.catch()` would get an unhandled exception at the call site | returns a rejected promise |
| `ALTER ROLE` issued unconditionally | role attributes live in a cluster-wide catalog, so two parallel migrations collided with `tuple concurrently updated` | write only when the current attribute differs; tolerate a concurrent creator |
| Journal check flagged the anti-`TRUNCATE` triggers as destructive | a check that cries wolf trains the reader to ignore it | match statement-initial verbs only |

### Security and concurrency evidence

- 45 integration and 10 concurrency assertions run against real PostgreSQL. No mock, no SQLite.
- Every tenant identifier, seed and identifier in the suites is synthetic; registration numbers use
  the reserved `99` range.
- Envelope encryption is proved for round trip, tamper detection on both ciphertext and wrapped key,
  AAD binding across row/column/table, cross-scope refusal, key versioning, rewrap and resumability.
- Lookup tokens differ across identity type, country, realm scope and a namespace-boundary shift.
- The local KMS refuses to construct outside `local`, `ci` or `test`, and its error names no key.

### Security repair after customer review (Phase 03)

> **Historical snapshot.** Records the first repair as it stood. Role counts, gate counts and test counts here are those of that pass, not the current ones; the current model is 11 group roles and 7 login principals, and the current gate table is in *Fifth security repair* below.

The first Phase 03 submission was rejected. Eight defects were found in the database bootstrap and
privilege model; all are repaired, and the repair is gated rather than asserted.

| # | Defect | Repair |
| --- | --- | --- |
| 1 | `0001_kernel.sql` created and altered cluster-global roles, so it raced across databases and required the migration principal to hold `CREATEROLE` | Roles moved to `packages/db/bootstrap/cluster-roles.sql`, run once per cluster under an advisory lock by a privileged operator. The migration now **verifies** the role model and refuses to run when it is missing or unsafe. |
| 2 | `GRANT ALL ON ALL TABLES IN SCHEMA platform TO prsystem_maintenance` | Removed. `prsystem_maintenance` now owns nothing, grants nothing, and is reachable by nobody — including the migration principal. Cross-tenant maintenance is a SECURITY DEFINER function owned by `prsystem_maintenance_fn`, which holds **no** `BYPASSRLS` and sets tenant scope per tenant. |
| 3 | Runtime roles held direct `INSERT` on the audit tables | Runtime roles now hold **no** table privilege on any audit relation. Appending is `audit.append_platform_audit_event` / `police_audit.append_police_security_event`, which derive server time, realm, actor and scope from the trusted transaction context. |
| 4 | Payload sanitisation was a top-level `?|` key test, so a nested object passed | Replaced by the recursive `platform.contains_denied_key`, walking objects and arrays at any depth, insensitive to case and separators. |
| 5 | `ensure_month_partitions` accepted any schema and table, had no bound, no fixed `search_path` and no lock | Allow-listed to the two audit streams, bounded to 1–24 months, `SECURITY DEFINER` owned by `prsystem_partition_mgr`, fixed `search_path`, fully qualified, advisory-locked, `PUBLIC` execute revoked, and it re-establishes owner, grants and TRUNCATE protection on each new partition. |
| 6 | The EXT register was seeded against the wrong subjects on 7 of 11 rows, and KMS was wrongly attributed to EXT-10 | Reseeded to the canonical `docs/00` §4 mapping, asserted row-for-row against the source document. POS, email and key management moved to a separate `platform.internal_gate` namespace (`INT-KMS-01`, `INT-MAIL-01`, `INT-POS-01`). ADR-0020 corrected. |
| 7 | Security tests ran on a superuser connection with `SET ROLE`, which proves nothing | Every security assertion now runs over a real LOGIN principal created by the bootstrap. `SET ROLE` leaves `session_user` unchanged and a superuser bypasses RLS unconditionally — both would have reported a pass while proving nothing. |
| 8 | No named, blocking security gate existed | `GATE-SEC` (`pnpm run test:security`) aggregates thirteen sub-gates and fails closed on an unavailable database, a skipped suite, a sub-gate that ran zero tests, or a missing artefact. |

**Defects found by the repair's own gates**, and fixed: the principal guard matched role membership by
*substring*, so `prsystem_maintenance_fn` satisfied a check for `prsystem_maintenance`; `RESET ALL`
on connection release cleared the connection's role; and the test login password was generated
per-process while roles are cluster-global, so parallel workers invalidated each other's pools.

`0001_kernel.sql` was edited in place rather than superseded. That is safe and was **proven** before
editing: the remote has exactly one ref, `refs/heads/main` at `c1c2abc`, and zero tags;
`0001_kernel.sql` is absent from `origin/main`; and commit `8a62b0b` is an ancestor of no remote ref.
The migration has never been pushed, tagged or released.

### Second repair after review (Phase 03)

> **Historical snapshot.** Counts and role descriptions are those of the second pass.

The first repair was also rejected. Nine further defects, each reproduced by a failing test before
being fixed — the reproductions are kept in `packages/db/src/regression/phase03-repair.test.ts`.

| # | Defect | Repair |
| --- | --- | --- |
| 1 | The migration CLI read `DATABASE_URL`; the runner used a pool, so its advisory lock, `SET ROLE` and journal were not one session; objects ended up owned by the deploying **login** | `MIGRATION_DATABASE_URL` is required with no fallback and is validated before any connection is opened. The runner uses one `Client`: verify principal → database advisory lock → `SET ROLE prsystem_migrate` → journal → reset. Two runners against a **completely empty** database now both succeed — one applies, one observes the completed journal. |
| 2 | The upgrade test copied the *current* `0000` at runtime, so it proved that head upgrades from head | The Phase 02 baseline is a committed fixture with a `sha256` the suite asserts. |
| 3 | Bootstrap's advisory lock was transaction-scoped and taken in the target database, so it ended before the grants and did not serialise runners targeting different databases | One **session-level** lock on a designated coordination database, held across group roles, logins, memberships, database grants, `public` grants and the final invariant check; released in `finally`. Proven by two independent OS processes bootstrapping two databases in one cluster. |
| 4 | Grants were additive, so a stale `CREATE` could survive | Exact final grants: revoke, then grant. Each runtime login holds exactly its approved closure, `prsystem_maintenance` has zero members, and every reachable role is checked for all five privileged attributes. |
| 5 | `assertApiConnectionPrincipal`, `assertWorkerConnectionPrincipal` and `selectKeyManagement` had **no runtime callers** | Wired into `createApp` and the worker entrypoint, before HTTP listen, before Redis and before any `Worker` is constructed, with the guard pool released in `finally`. Runtime membership is an exact closure rather than a containment check, and every function-owner role is in the forbidden set. |
| 6 | A stale worker could acknowledge a delivery another worker had reclaimed | `claimOutboxBatch` returns `claimedBy` and `claimRevision`; `markOutboxPublished` and `markOutboxFailed` compare-and-swap on event, state, claimant **and** revision, returning a typed `stale_claim` without mutating anything. `event_uuid` remains the stable outbound key across redeliveries. |
| 7 | Maintenance accepted a caller-supplied `p_audit_ref` — a reference the caller invents is not evidence | The signature is now the job-run id alone. Context (hotel, non-Police realm, actor, correlation) is required, the running `job_run` is locked, and the audit id is **generated** by `audit.append_platform_audit_event` in the same transaction. `platform.operational_alert` carries that id and is described as telemetry, not as the audit record. |
| 8 | RLS assertions swallowed failures with `.catch(() => rowCount: 0)`, so a `NOT NULL` or syntax error read as proof of a privilege boundary | Replaced by a machine-readable matrix: 7 tenant tables × 3 runtime logins × 4 verbs. Allowed actions use complete valid rows and prove same-tenant success and cross-tenant refusal; forbidden actions assert SQLSTATE `42501` exactly. |
| 9 | "Concurrency" tests shared a backend and had no barrier | Distinct pools with asserted-distinct `pg_backend_pid()`, plus an explicit in-critical-section barrier. Both `SKIP LOCKED` workers now claim non-empty disjoint sets, the provider-reference race is genuinely concurrent, and the stable-key test seeds and redelivers a real event. |

Wiring the guards also surfaced a lifecycle gap: readiness probes connect lazily and were never
closed, so a shutdown left a connection open. `ReadinessService` now implements
`OnApplicationShutdown`.

Documentation corrected in the same pass: ten group roles (not nine), current test counts, the
cumulative-gate wording above, removal of the false "startup guards wired" claim, `INT-KMS-01` in
place of `EXT-10` for key management, and a truthful note that `prsystem_audit_writer` owning both
append functions is an approved **infrastructure-role** arrangement, distinct from runtime realm
separation.

### Remaining blockers

`DSR-01` remains **OPEN — contained**. `GATE-SEC` now runs as its **own** GitHub Actions job named exactly `GATE-SEC`, because only a job
name is selectable as a required check — a step inside another job is not. **Selecting it as a
required status check remains pending:** the job must run on GitHub at least once before it can be
chosen, and nothing has been pushed, so it has not yet run. Branch protection is a repository setting
deliberately not configured here. Eleven EXT gates are seeded closed in `platform.external_gate`
and block production release only. **Seventeen P1 items remain open**, including P1-10. No P0 product
blocker. One documentation conflict was found and resolved as **D-05**; three scope questions were put
to the customer and approved before any edit.

### Third security repair (customer review 3) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Counts here (302 GATE-SEC tests, 14 sub-gates, 10 group roles) are those of the third pass and are superseded.

The second repair was **not accepted**. Nine further defects were raised. All nine are now closed in
code and tests. Phase 03 stays `SECURITY_REPAIR_REQUIRED` until customer acceptance; no acceptance is
claimed here.

#### Production defects fixed

| # | Defect | Repair |
| --- | --- | --- |
| 1 | `bootstrapCluster` opened its work pool with the raw `adminUrl`, so schema and database ACL work could harden the database named in the URL rather than `options.database` | Coordination stays on the configured coordination database; a separate target connection is derived, `current_database()` is verified against `options.database`, and every database-scoped grant, revoke and final invariant runs on the target. The database-scoped `REVOKE ALL ON SCHEMA public FROM PUBLIC` was removed from `cluster-roles.sql`, where it had been executing against the wrong database. The redundant transaction advisory lock was removed, and the stale comment naming `prsystem_maintenance` as the maintenance-function owner now names `prsystem_maintenance_fn`. |
| 2 | `readPrincipalFacts` excluded all `pg_*` roles, tested `pg_has_role(..., 'USAGE')` only, missed `INHERIT FALSE, SET TRUE` memberships, and read attributes only for `session_user` | Replaced by a recursive closure over `pg_auth_members` following **both** `inherit_option` and `set_option`, with no predefined-role exclusion. Every reachable role returns its five privileged attributes, which are all rejected. Runtime closures are exact per realm; the migration closure is exactly `prsystem_migrate` plus its three approved function-owner roles. Bootstrap reconciles **all** direct membership edges read from `pg_auth_members`, not only those it intended to create. |
| 3 | The bootstrap concurrency test used `dbs.map(() => spawnSync(...))` — sequential by construction | Two OS processes are spawned asynchronously and both are started before either is awaited, with a parent-controlled readiness and start barrier. The test asserts two distinct pids and proves observable overlap (`second.enteredAt <= first.leftAt`). Every pool and client is closed before the test databases are dropped. |
| 4 | The maintenance audit-failure test inserted its target **inside** the transaction it rolled back, so "the row survived" was vacuous | The expired key and `job_run` are seeded and committed first; the audit partition is detached in a separate committed transaction; only then is maintenance invoked and rolled back. The function itself now requires the exact maintenance `job_name`, a `job_identity` matching the trusted transaction actor, the same hotel, and `running` state; on success it transitions the job to `succeeded` with `finished_at` in the same transaction. Wrong job type, wrong identity, replay and two concurrent invocations sharing one job are all rejected. |
| 5 | The RLS/ACL matrix contained vacuous cells: false predicates, and early returns for `outbox_delivery` INSERT | The direct `INSERT` grant on `platform.outbox_delivery` was **revoked**; delivery rows are created only by `platform.enqueue_outbox_delivery()`, now `SECURITY DEFINER` with a fixed `search_path`, owned by `prsystem_migrate`, `REVOKE ALL ... FROM PUBLIC`. Every declared cell executes a real operation: same-tenant SELECT returns seeded rows for the active hotel only, and every allowed UPDATE/DELETE asserts the exact affected row count. |
| 6 | Several `GATE-CONC` races shared one pool, had no barrier, and accepted any loser | Same-key idempotency, inbox deduplication, the provider-reference race and the rollback race each use dedicated single-connection pools with asserted-distinct `pg_backend_pid()`, an in-critical-section barrier, and an exact winner plus a **coherent** loser. |
| 7 | The migration equivalence fingerprint listed function *names* but not bodies, and omitted schemas, default privileges, sequences, types and views | The fingerprint now covers `platform`, `audit`, `police_audit`, `police` and the migration ledger schema: schema ownership and ACLs, default privileges, relations with kind/owner/ACL/RLS flags/partition key and bound, columns, constraints, indexes, policies, sequence definitions with ownership and ACLs, enums/domains/composites, view and matview definitions, functions with identity arguments, return type, complete `pg_get_functiondef`, security mode, configuration, owner and ACL, triggers, inheritance, and extensions with versions. |
| 8 | The startup test called guard helpers directly and probed an unused port, which proves nothing about `createApp` or worker startup | Worker startup was extracted into `apps/worker/src/startup.ts`, an orchestration boundary taking the Redis connection and consumer construction as injected factories. |
| 9 | ADR-0017 stated `prsystem_maintenance` "owns nothing, grants nothing" while the migration granted it `USAGE` on four schemas | The grants were removed and replaced with an explicit `REVOKE`. ADR-0017 §7 also contradicted its own §4/§5 by naming `prsystem_maintenance` as the cross-tenant job role; corrected to the `prsystem_maintenance_fn`-owned `SECURITY DEFINER` function and recorded as drift resolution **D-08**. The approved shared `prsystem_audit_writer` is preserved, not split. |

#### Previously vacuous tests, now non-vacuous

| Test | Why it proved nothing | What it executes now |
| --- | --- | --- |
| Bootstrap concurrency | `spawnSync` in a `map` ran the two "concurrent" bootstraps one after the other | Two async processes with a start barrier, distinct pids, and asserted overlapping critical sections |
| Maintenance audit failure | The target row was inserted in the transaction under test and rolled back with it | Target committed beforehand; failure forced from a separate transaction; the pre-existing row, the untouched job state and the unchanged telemetry count are all asserted |
| `outbox_delivery` matrix cells | INSERT cells returned early; some cells used `AND false` predicates | The grant was redesigned away; INSERT is now a real forbidden case asserting `42501`, and every remaining cell asserts exact row counts |
| Cross-tenant `outbox_delivery` insert (`sec-rls`) | Matched `/violates/`, which the **primary key** satisfied — the definer trigger had already created that event's delivery row | Split into a grant refusal (`42501`) for runtime logins, and a genuine cross-tenant policy refusal for the table owner under `FORCE ROW LEVEL SECURITY`, asserting SQLSTATE `42501` and `row-level security policy` |
| Provider-reference race | `Promise.allSettled` with a conditional pid assertion accepted a **rejected** transaction as a valid loser | Both transactions must fulfil; outcomes are exactly one `first_delivery` and one `duplicate` with `payloadMatches: true`; pids are asserted distinct unconditionally |
| Audit/outbox rollback race | Two identical attempts with a blanket `.catch(() => 'rolled_back')` | One transaction deliberately writes audit and outbox rows then throws; its rejection is asserted by its own error; none of its audit, outbox or idempotency effects survive; the other commits exactly one coherent effect |
| Concurrent migration runners | Only the already-migrated no-op case | Adds an **empty** database where both runners have real work: exactly one applies the journal, the other applies none, and both agree on a non-empty final ledger |
| Fingerprint equivalence | Could not have failed for a changed function body or view definition | Three sensitivity tests prove the fingerprint changes when a function body changes, when a view definition changes, and when a grant is revoked |
| Startup ordering | Guard helpers called directly, then an unused port checked | Real `createApp` runs three times against a bootstrapped database: a positive control that **binds** the port (so the observation can fail), an invalid principal, and an unconfigured KMS — neither refusal creates a listener. The worker boundary proves the Redis and BullMQ factories are **never invoked** when either guard refuses, with a positive control that they are invoked when both pass. |

#### Gates executed on the final tree

PostgreSQL **17.6** on aarch64-unknown-linux-musl (Alpine), extensions `btree_gist` and `pgcrypto`.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm run validate:workspace` | 0 | 15/15 |
| `pnpm run validate:governance` | 0 | 13/13 |
| `pnpm run scan:secrets` | 0 | 270 tracked text files, 0 findings |
| `pnpm run format:check` | 0 | clean |
| `pnpm run lint` | 0 | 16/16 tasks |
| `pnpm run typecheck` | 0 | 25/25 tasks |
| `pnpm run test:unit` | 0 | 175 tests |
| `pnpm run build` | 0 | 16/16 tasks |
| `pnpm run openapi` | 0 | document generated |
| `pnpm run compose:config` | 0 | valid |
| `pnpm run test:migrations` | 0 | 12 tests (`GATE-MIGR`) |
| `pnpm run test:integration` | 0 | 46 tests (`GATE-INTEG`: 41 db + 5 api) |
| `pnpm run test:regression` | 0 | 14 tests |
| `pnpm run test:e2e` | 0 | 15 tests (`GATE-E2E`) |
| `pnpm run audit:prod` | 0 | no advisory at moderate or above |
| `pnpm run audit:tree` | 0 | no advisory at high or above |
| `git diff --check` | 0 | no whitespace error |
| `pnpm run test:security` ×3 | 0, 0, 0 | **14/14 sub-gates**, 302 tests, each run |
| `pnpm run test:concurrency` ×3 | 0, 0, 0 | **17 tests**, each run (`GATE-CONC`) |

`GATE-SEC` sub-gates (identical across all three runs): SEC-ROLE 12, SEC-RLS 31, SEC-ACL-MATRIX 114,
SEC-OWNERSHIP 10, SEC-MAINTENANCE 13, SEC-STARTUP 13, **SEC-STARTUP-WORKER 4 (new)**, SEC-REGRESSION 9,
SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7, SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6.

No gate was skipped, and no sub-gate ran zero tests — `tools/gate-sec.mjs` fails on either condition.
No result below is a static-regex-only or early-return case. The one remaining static source check,
regression `R6`, is explicitly marked supplementary in its own comment; the executable startup
evidence is `apps/api/src/security/startup-order.test.ts` and `apps/worker/src/startup.test.ts`.

Commit for this repair: `7f43445`. Previous commits are unchanged; nothing was
amended, rebased, force-pushed, pushed, merged or deployed.

#### External and manual actions still pending

- **Selecting `GATE-SEC` as a required GitHub status check.** Unchanged and still pending: the job
  must run on GitHub at least once before it can be selected, and nothing has been pushed. Branch
  protection remains a repository setting deliberately not configured here.
- `DSR-01` remains **OPEN — contained** (dev-only, no compatible stable upgrade).
- Eleven EXT gates remain seeded closed; seventeen P1 items remain open, including P1-10.

### Fourth security repair (customer review 4) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Counts here (326 GATE-SEC tests, 14 sub-gates) are those of the fourth pass and are superseded.

The third repair was **not accepted**. Eight further defects were raised; all eight are closed. Phase
03 stays `SECURITY_REPAIR_REQUIRED` and no approval is claimed.

#### Production defects fixed

| # | Defect | Repair |
| --- | --- | --- |
| 1 | `dist/` is ignored, several suites consume generated JavaScript, and the standalone gate commands bypassed Turborepo entirely — so a gate could consume stale or pre-existing build output | `test:migrations` and `test:security` now route through Turborepo (`turbo run test:migrations`, `turbo run build && node tools/gate-sec.mjs`), and `test:migrations`, `test:integration`, `test:concurrency`, `test:regression` and `test:security` all declare `dependsOn: ["build", "^build"]`. CI builds explicitly before the compose and GATE-SEC gates. No generated file is committed. |
| 2 | `tools/gate-sec.mjs` named a single regression file, so `phase03-repair2.test.ts` was **excluded from GATE-SEC** while the gate still reported PASS | `SEC-REGRESSION` runs the whole `src/regression` directory and requires every manifest entry as an artefact. `tools/regression-manifest.mjs` is the exhaustive list; `tools/validate-regression-coverage.mjs` cross-checks disk, manifest, the real sub-gate configuration object and the CI workflow. CI runs the complete regression suite as its own step. |
| 3 | The principal guard filtered its closure on `inherit_option OR set_option`, so an `ADMIN TRUE, INHERIT FALSE, SET FALSE` membership was **invisible**, and bootstrap reconciled role-name pairs while re-granting with options omitted | Reachability is now `pg_has_role(..., 'MEMBER')` — the only capability true for every membership — with USAGE, SET and ADMIN modelled separately and ADMIN derived from `pg_auth_members`. Every reachable role is attribute-checked; ADMIN OPTION anywhere in the closure is rejected; every direct membership must carry exactly `ADMIN FALSE, INHERIT TRUE, SET TRUE`. Bootstrap states all three options explicitly, because PostgreSQL retains the ones a `GRANT` omits, and then re-reads and proves the result. `assertRuntimeContainment` makes a migration refuse while any runtime principal can reach an owner role. |
| 4 | The empty-database migration race used `Promise.all`, which cannot show lock contention; the maintenance race had no barrier and a bare `catch` that accepted any error as a valid loser; cross-tenant maintenance was tested with a nonexistent UUID | The migration race runs two OS processes released together by the parent, asserting distinct pids and observable overlap — a sequential run now fails — plus exactly one application, one no-op, and identical fingerprints against a solo install. The maintenance race adds an in-critical-section barrier, overlap, and an exact loser SQLSTATE (`22023`). Cross-tenant maintenance now creates and commits a **real** tenant-B job and proves the refusal, the untouched row, and the absent audit event. |
| 5 | `sec-rls.test.ts` inserted partial rows and accepted `null value ...` as isolation evidence, and converted arbitrary UPDATE/DELETE errors into `rowCount: 0` | Complete valid rows come from a shared fixture module that the ACL matrix also uses, so the two suites cannot drift. Structural SQLSTATEs are explicitly rejected. Where the API holds the verb the exact affected count must be zero, and where it does not the exact SQLSTATE must be `42501`; the two are no longer collapsed. Both tenants are seeded, so "zero rows affected" is no longer a statement about an empty table. |
| 6 | The fingerprint omitted global and schema-local default ACLs, column ACLs, relation options, replica identity, access method, tablespace and sequence dependencies | All are covered, and each is sensitivity-tested. |
| 7 | The API held `UPDATE` on `platform.outbox_delivery` with no code path needing it, and the worker held table-wide `UPDATE` on `platform.job_run` — the very fields the maintenance function authorises on | The API holds `SELECT` only. The worker's `job_run` grant is column-scoped to `(state, finished_at, error_name, as_of)`, and `platform.job_run_transition_guard` makes `job_run_id`, `hotel_id`, `job_name`, `job_identity` and `started_at` immutable and terminal states terminal. |
| 8 | Governance documents disagreed on roles, counts and maintenance execution | Corrected below; superseded blocks are labelled as historical snapshots. |

#### Defects the strengthened tests exposed

Making the RLS assertions exact immediately failed seven cases, for two reasons that the previous
shape had been hiding:

- five tables had **no tenant-B rows at all**, so "tenant A affected zero of tenant B's rows" was
  true of an empty table and would have passed with no policy in place;
- `outbox_event` and `outbox_delivery` were converting a **permission denial** into `rowCount: 0`.

Both are now fixed rather than accommodated.

#### Validator negative test

`validate:regression-coverage` was proved to fail, not merely to pass. A regression fixture
(`phase03-omitted-probe.test.ts`) was added without listing it in the manifest:

```
[FAIL] every regression suite on disk is listed in the manifest  not listed: phase03-omitted-probe.test.ts
regression coverage: 8/9 checks passed, 1 FAILED   exit 1
```

The probe was removed and the validator returned to `9/9`, exit 0. The probe is not committed.

#### Gates executed

PostgreSQL **17.6** on aarch64-unknown-linux-musl (Alpine); `btree_gist` and `pgcrypto`.

| Command | Exit | Collected result |
| --- | --- | --- |
| `pnpm run validate:governance` | 0 | 13/13 |
| `pnpm run validate:workspace` | 0 | 15/15 |
| `pnpm run validate:regression-coverage` | 0 | 9/9 |
| `pnpm run scan:secrets` | 0 | 283 files, 0 findings |
| `pnpm run format:check` | 0 | clean |
| `pnpm run lint` | 0 | 16/16 tasks |
| `pnpm run typecheck` | 0 | 25/25 tasks |
| `pnpm run test:unit` | 0 | 175 tests |
| `pnpm run build` | 0 | 16/16 tasks |
| `pnpm run openapi` | 0 | document generated |
| `pnpm run compose:config` | 0 | valid |
| `pnpm run test:migrations` | 0 | 22 tests |
| `pnpm run test:integration` | 0 | 51 tests |
| `pnpm run test:regression` | 0 | 23 tests |
| `pnpm run test:e2e` | 0 | 15 tests |
| `pnpm run audit:prod` | 0 | nothing at moderate or above |
| `pnpm run audit:tree` | 0 | nothing at high or above |
| `git diff --check` | 0 | clean |
| `pnpm run test:security` ×3 | 0, 0, 0 | 14/14 sub-gates, **326 tests**, each run |
| `pnpm run test:concurrency` ×3 | 0, 0, 0 | **17 tests**, each run |

GATE-SEC sub-gates, identical across all three runs: SEC-ROLE 12, SEC-RLS 31, SEC-ACL-MATRIX 113,
SEC-OWNERSHIP 10, SEC-MAINTENANCE 24, SEC-STARTUP 13, SEC-STARTUP-WORKER 4, **SEC-REGRESSION 23**
(9 before this repair, because two suites were excluded), SEC-AUDIT 42, SEC-PARTITION 14,
SEC-POLICE-ISOLATION 7, SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6.

#### Clean-checkout reproducibility proof

Run in a disposable `git clone --no-hardlinks` of this repository at `4cf3adb`, never in the working
tree, with an isolated `TURBO_CACHE_DIR` and **no pre-build step** — each gate had to build the
checked-out source itself.

State before the run, verified rather than assumed:

| Check | Result |
| --- | --- |
| `dist` directories present | 0 |
| `node_modules` directories present | 0 |
| Turborepo caches present | 0 |
| Files under `packages/*/dist` | 0 |
| Tracked build output in git | 0 |
| Worktree clean at the cloned commit | yes |

| Command (CI's own) | Exit | Collected result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | lockfile honoured |
| `pnpm run validate:regression-coverage` | 0 | 9/9 |
| `pnpm run scan:secrets` | 0 | 283 tracked text files, 0 findings |
| `pnpm run test:migrations` | 0 | 22 tests |
| `pnpm run test:security` | 0 | 14/14 sub-gates |
| `pnpm run test:integration` | 0 | 51 tests |
| `pnpm run test:concurrency` | 0 | 17 tests |
| `pnpm run test:regression` | 0 | 23 tests |

Counts match the working-tree run exactly, and `packages/db/dist/migrate.js` — which the migration
race child process requires by path — was produced by the run itself.

**This proof found a real defect.** A first attempt used `git archive`, which has no `.git`
directory; `tools/scan-secrets.mjs` enumerates tracked files with `git ls-files` and died on an
unhandled exception, failing GATE-SEC with an unreadable stack trace. The scanner now reports what is
missing and exits 2, so an environment without git metadata cannot be confused with a clean scan. CI
uses `actions/checkout`, which provides a real working tree, so the proof was repeated with
`git clone` — the equivalent environment.

#### External and manual actions still pending

- **Selecting `GATE-SEC` as a required GitHub status check** — still pending; the job must run on
  GitHub at least once before it can be selected, and nothing has been pushed.
- `DSR-01` remains **OPEN — contained**.
- Eleven EXT gates remain seeded closed; seventeen P1 items remain open, including P1-10.

### Fifth security repair (customer review 5) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Counts here (16 sub-gates, 372 GATE-SEC tests) and the
> role/grant descriptions are those of the fifth pass and are superseded by
> *Sixth security repair* below.

The fourth repair was **not accepted**. One approved architecture decision (D-09) and nine further
defects were raised; all are closed. Phase 03 stays `SECURITY_REPAIR_REQUIRED` and no approval is
claimed. **This section holds the current counts and role model.**

#### D-09 — the scheduler boundary

The role model is now **11 group roles and 7 canonical login principals**. Issuing a privileged
maintenance job and executing one are separate powers with separate credentials.

| | Scheduler | Worker |
| --- | --- | --- |
| Issues a privileged maintenance job | **yes**, via `platform.schedule_maintenance_job` only | no — holds no `INSERT` on `job_run` |
| Executes one | no | **yes**, only when its transaction actor is the named executor |
| Direct privilege on `platform.job_run` | **none** | `SELECT`, `UPDATE (state, finished_at, error_name, as_of)` |
| Ordinary non-privileged jobs | no | **yes**, via `platform.begin_worker_job`, which refuses the `platform.maintenance.%` namespace categorically |

The previous arrangement let the worker mint its own authorisation: it held unrestricted `INSERT` on
`platform.job_run`, and the maintenance function authorises on `job_name`, `job_identity` and
`state` — columns of that same table. Three layers now prevent it: the missing `INSERT` grant, the
`job_run_privileged_has_issuer` check constraint, and the function's own issuer check behind it.

#### Production defects fixed

| # | Defect | Repair |
| --- | --- | --- |
| 2 | Reconciliation granted every canonical login unconditionally, so the documented group-only/IaC workflow issued `GRANT ... TO <missing-role>` and failed | Login edges are reconciled only for principals that exist; group-to-group owner edges always. Omitted-but-existing principals are validated (safe attributes, exactly one membership with exact options) and **never re-passworded**; unsafe drift fails closed naming the principal. Unexpected membership policy is documented and deterministic: revoke, then re-read and fail if anything unapproved survived. |
| 3 | Containment covered API, Worker and Police only; ADMIN capability was derived by hand | Readers and the scheduler are contained identically. `pg_has_role(..., 'MEMBER WITH ADMIN OPTION')` is used directly — the earlier claim that `pg_has_role` cannot test ADMIN was wrong and is removed. Expected edges are now *required*, not merely un-forbidden, and the whole migration graph (login → `prsystem_migrate` → three owner roles, all `ADMIN FALSE, INHERIT TRUE, SET TRUE`, nothing missing or extra) is validated. |
| 4 | The SQL precondition checked `USAGE` alone, and `verifyPrincipal: false` could switch verification off | The precondition independently rejects MEMBER, SET-only and ADMIN-only reach, privileged attributes on any runtime/reader/scheduler principal, predefined roles, unexpected closure, and missing or malformed migration-owner edges. `verifyPrincipal` is deleted: no option, public or private, disables the check. |
| 5 | Wall-clock overlap between processes is not proof that PostgreSQL made anything wait | Both races now observe the lock. The migration race has a third session hold the advisory key while two runners queue on it, asserting `pg_blocking_pids` names the holder before releasing it. The maintenance race has backend A lock the committed `job_run` row while B blocks inside the function, asserting the same. Both were negative-proved: removing the advisory lock fails the first ("saw 0" waiters), removing `FOR UPDATE` fails the second (`40P01` instead of `22023`). |
| 6 | A test titled "gives an ordinary runtime no way to obtain the platform sentinel scope" proved nothing of the sort — it selected sentinel rows from an unseeded table | Replaced. A custom GUC is writable by the session holding the connection, and the replacement test *demonstrates* that rather than denying it. What the mechanism does buy — a query with no tenant predicate still confined, transaction-local scope, pool cleanup, FORCE RLS — is tested accurately. `PLATFORM_SCOPE` must now be paired with the operation realm at the application context boundary. Server-derived authorization resolution is Phase 04 and is not claimed to exist. |
| 7 | A selected-catalogue JSON fingerprint is not the normalized schema dump the architecture requires | `schema.ts` declares the kernel in Drizzle, with a blocking column-and-nullability drift check against the migrated database. Fresh and upgrade are compared by **byte-identical normalized `pg_dump --schema-only`** from the pinned PostgreSQL 17 container, normalizing only the version header, the random `\restrict` token, the database name and blank runs — owners, grants, policies, functions, triggers and `reloptions` are all compared. The catalogue fingerprint is retained as a supplementary check, and now covers views, so `security_invoker` / `security_barrier` / `check_option` are visible; it previously excluded them. |
| 8 | The CI validator searched the workflow with a context-free regex | The workflow is parsed structurally: the regression step must be in the blocking `compose` job, executable rather than commented, without `continue-on-error`, given `DATABASE_URL`, and preceded in step order by the build; the coverage validator must itself be on the blocking path; and `pnpm run test:security` must run it before GATE-SEC. |
| 9 | The runbook claimed exact final grants while only `PUBLIC` and named project roles were inspected | Bootstrap enumerates every grantee of the target database and of schema `public`, revokes anything outside the allow-list, and asserts the surviving set exactly. The allow-list is the database owner, the owner of schema `public` (`pg_database_owner`), `prsystem_migrate`, and the runtime/reader/scheduler roles — the two owner entries being the documented operator exceptions. |
| 10 | Documentation described a superseded role model | Corrected across the runbook, ADR-0017, ADR-0018, architecture 02 and 06, and this file. Earlier repair sections are labelled historical snapshots. |

#### Defects the strengthened tests exposed

- The catalogue fingerprint's storage projection **excluded views**, so a change of view security mode
  was invisible to it. Found by the new view-security sensitivity case.
- `assertRuntimeContainment` checked reach to owner roles but not privileged attributes or
  predefined-role membership, so the TypeScript runner passed three cases the SQL caught. Found by
  the E1/E2 regressions, which assert both layers.
- Adding `js-yaml@4.1.0` for the structural CI parse introduced two **high** advisories
  (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj). Caught by `audit:tree` in this repair's own validation
  run and fixed by pinning `js-yaml@4.3.2`; `audit:tree` is clean at high and above.
- **A real flake in a blocking security gate.** Running GATE-SEC three consecutive times failed once,
  and then — after a first, insufficient fix — failed again on a different sub-gate. In both cases
  every test in the suite passed and the runner still exited non-zero, which GATE-SEC reported only
  as `0/N failed`. The cause was a `pg.Pool` idle-client `error` event with no listener:
  `DROP DATABASE ... WITH (FORCE)` terminates the backends a pool is still holding, and an `error`
  event with no listener is a process-level exception raised *after* the tests have finished. Every
  test pool now goes through `quietPool`, which handles idle-client errors while leaving query
  rejections intact, and GATE-SEC now prints the runner's own output when a suite passes its tests
  but exits non-zero. Five consecutive GATE-SEC runs are clean.

  The first attempt at this fix — hardening the child-process pipe handling in the concurrency race —
  addressed a genuine latent problem but was **not** the cause, and is recorded here as such rather
  than as a success.

#### Negative proofs executed

| Claim | How it was disproved-if-false | Result |
| --- | --- | --- |
| The migration advisory lock is real | removed `pg_advisory_lock` from the runner | test failed: "expected two runners waiting on the migration lock, saw 0" |
| The `job_run` row lock is real | removed `FOR UPDATE` from the maintenance function | test failed: `40P01` instead of `22023` |
| The CI regression step is blocking | commented it out | validator exit 1 |
| … | `continue-on-error: true` | validator exit 1 |
| … | moved it to another job | validator exit 1 |
| … | removed `DATABASE_URL` | validator exit 1 |
| … | removed the build step | validator exit 1 |
| No regression suite is omitted | added an unlisted regression file | validator exit 1 |

Every mutation was reverted and the source restored; `ci.yml` was verified byte-identical afterwards.

#### Pristine-clone reproducibility

Two **independent** `git clone --no-hardlinks` checkouts at `074a674`, each with its own isolated
`TURBO_CACHE_DIR` and **no pre-build step**, verified beforehand to contain zero `dist` directories,
zero `node_modules` and zero Turborepo caches:

| Clone | Command | Exit | Result |
| --- | --- | --- | --- |
| A | `pnpm install --frozen-lockfile` then `pnpm run test:migrations` | 0, 0 | 31 tests |
| B | `pnpm install --frozen-lockfile` then `pnpm run test:security` | 0, 0 | 16/16 sub-gates |

Clone B ran GATE-SEC without any other gate having produced build output for it; it built
`packages/db/dist` itself. The main working tree was never cleaned or mutated, and both clones were
deleted afterwards.

#### Gates executed on the final tree

PostgreSQL **17.6** on aarch64-unknown-linux-musl (Alpine); `btree_gist` and `pgcrypto`.

| Command | Exit | Collected result |
| --- | --- | --- |
| `pnpm run validate:governance` | 0 | 13/13 |
| `pnpm run validate:workspace` | 0 | 15/15 |
| `pnpm run validate:regression-coverage` | 0 | 16/16 |
| `pnpm run scan:secrets` | 0 | 0 findings |
| `pnpm run format:check` | 0 | clean |
| `pnpm run lint` | 0 | 16/16 tasks |
| `pnpm run typecheck` | 0 | 25/25 tasks |
| `pnpm run test:unit` | 0 | 175 tests |
| `pnpm run build` | 0 | 16/16 tasks |
| `pnpm run openapi` | 0 | document generated |
| `pnpm run compose:config` | 0 | valid |
| `pnpm run test:migrations` | 0 | 31 tests |
| `pnpm run test:integration` | 0 | 51 tests |
| `pnpm run test:regression` | 0 | 36 tests |
| `pnpm run test:e2e` | 0 | 15 tests |
| `pnpm run audit:prod` | 0 | nothing at moderate or above |
| `pnpm run audit:tree` | 0 | nothing at high or above |
| `git diff --check` | 0 | clean |
| `pnpm run test:security` ×3 | 0, 0, 0 | 16/16 sub-gates, **372 tests**, each run |
| `pnpm run test:concurrency` ×3 | 0, 0, 0 | **16 tests**, each run |

#### GATE-SEC — 16 sub-gates

SEC-ROLE 12, SEC-RLS 33, SEC-ACL-MATRIX 112, SEC-OWNERSHIP 10, **SEC-BOOTSTRAP 10 (new)**,
**SEC-SCHEDULER 22 (new)**, SEC-MAINTENANCE 24, SEC-STARTUP 13, SEC-STARTUP-WORKER 4,
SEC-REGRESSION 36, SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7, SEC-KMS 17,
SEC-PII-LEAK 10, SEC-SECRETS 6. **372 tests**, identical across three consecutive runs.

### Sixth security repair (customer review 6) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Counts here (18 sub-gates, 421 GATE-SEC tests) are those
> of the sixth pass; the current figures are in *Seventh security repair* below.

The fifth repair was **not accepted**. Seven defects were raised; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED` and no approval is claimed. **This section holds the current counts.**

| # | Defect | Repair |
| --- | --- | --- |
| 1 | Eight `TS2304` errors sat unnoticed in `test-support/provision.ts`, because every package excluded test sources from the *typecheck* as well as from the build | The missing `import type { Pool }` is restored, and all nine such packages gained a `tsconfig.test.json` that each package's blocking `typecheck` script now runs alongside the build config. Proven by re-breaking the import and watching the gate fail. |
| 2 | `rolcanlogin` was read and never asserted; an existing canonical login could hold no membership or the wrong one; database and `public` owners were trusted automatically, whoever they were | LOGIN is required. Every *existing* canonical login must hold exactly its designated group with exact options, in the TypeScript guard and the migration SQL alike. An explicit operator-owner contract refuses every project role as owner outright and additionally requires an approved operator identity; `pg_database_owner` is accepted for `public` only when the database owner is itself approved. Owner-role closure is checked before reconciliation could paper over it. |
| 3 | D-09 was a database mechanism with no deployable shape, and both issuer and executor were read from the caller-writable `app.actor_ref` | `issuer_ref` and `job_identity` come from `session_user`; execution compares `session_user`; the executor must be a server-validated Worker login; scheduling requires `p_hotel_id = platform.current_hotel_id()`. Issuance is an API control-plane capability on its own `SCHEDULER_DATABASE_URL`, pool and startup guard, with no route in Phase 03, and the worker never receives the credential. Terminal jobs and their evidence are frozen, the text fields are bounded, and the API's unused `SELECT` on `outbox_delivery` is revoked. |
| 4 | The Drizzle declaration covered 12 of 14 root tables and compared only what it already listed | All 14 are declared, including both audit streams. The exact live root-table set is compared, along with type, nullability, keys, constraints and indexes. The container is resolved through `docker compose ps -q postgres`, never by matching a container name — an unrelated `hotel-platform-postgres` must never be touched. |
| 5 | CI commands were matched with a substring test, which accepts `\|\| true`, a pipe, backgrounding, `echo`, and a comment | Required commands are matched as exact whole run lines in a named blocking job, with status-discarding constructs rejected. Eleven bypasses are applied to a temporary copy of the workflow by an automated fixture harness that requires the validator to reject each one. |
| 6 | The pool fix attached an empty error handler to every pool, discarding every idle-client error a suite might genuinely need to see | Pools are tracked with their database, closed before it is dropped, and only an error on a pool explicitly marked as tearing down — matching a termination SQLSTATE or message — is suppressed. Everything else fails the suite. |
| 7 | Documentation contradicted the code on ownership, audit grants, actor claims and counts | Corrected below; superseded sections are labelled historical snapshots. |

#### What the strengthened checks found

- The typecheck exclusion was hiding **23** errors, not eight: 8 `TS2304`, 2 `TS2440`, 1 `TS2558`
  and 12 `TS7006`.
- Making CI matching exact revealed that `validate:regression-coverage` was running in the `compose`
  job rather than the blocking `governance` job. Moved.
- Declaring all 14 tables showed the previous comparison had been walking only its own list, so the
  two audit streams were neither declared nor compared.

#### GATE-SEC — 18 sub-gates, 421 tests

SEC-ROLE 12, SEC-RLS 33, SEC-ACL-MATRIX 111, SEC-OWNERSHIP 10, **SEC-LOCK-EVIDENCE 16 (new)**,
**SEC-POOL-ERRORS 5 (new)**, SEC-BOOTSTRAP 19, SEC-SCHEDULER 31, SEC-MAINTENANCE 24, SEC-STARTUP 20,
SEC-STARTUP-WORKER 4, SEC-REGRESSION 40, SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7,
SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6. Identical across three consecutive runs.

#### Current role and grant model

Eleven group roles, seven canonical login principals. Corrections this repair made to the record:

- **Break-glass versus function owner.** `prsystem_maintenance` is break-glass only and owns nothing;
  the maintenance *functions* are owned by `prsystem_maintenance_fn`, which holds no `BYPASSRLS`.
- **Audit grants.** `prsystem_api` and `prsystem_worker` hold **no direct grant on either audit
  stream**. They append only by executing the `SECURITY DEFINER` wrapper, whose owner
  `prsystem_audit_writer` is the sole holder of `INSERT`.
- **Actor claims.** `app.actor_ref` is correlation metadata. Authorisation compares `session_user`.
- **Outbox delivery.** The API holds nothing; the relay is entirely a worker concern.
- **Pool errors.** Only an expected teardown termination is suppressed, and not every raw `Pool` in
  the tree goes through the helper — the harness and the db suites do, and
  `assertNoUnexpectedPoolErrors` is what makes an escape a failure rather than a silence.

### Seventh security repair (customer review 7) — `SECURITY_REPAIR_REQUIRED`

The sixth repair was **not accepted**. Eight defects were raised; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED` and no approval is claimed. **This section holds the current counts.**

| # | Defect | Repair |
| --- | --- | --- |
| 1 | The startup guard created a scheduler pool, verified it, and closed it. The capability existed on paper with no connection holding it, and the only proof was a test constructing the service by hand | `MaintenanceModule` registers the pool and service in the Nest container; the guard validates *that* pool after the container exists and before `listen`; Nest closes it through `OnApplicationShutdown`. `SCHEDULER_ENABLED` defaults on and a production API with the capability and no `SCHEDULER_DATABASE_URL` fails env validation. `.env.example` documents it. The test starts the real application, resolves the service and pool from the container, issues through the application-owned pool and proves shutdown ends it |
| 2 | The functions trusted the role graph as of the last bootstrap, so a login granted a second group afterwards could issue *and* execute | `platform.assert_exact_role_closure` re-validates at call time: LOGIN, no privileged attribute, exactly one membership with exact options, nothing else reachable, no ADMIN OPTION. The scheduler validates itself and its executor; the maintenance function validates the executing principal |
| 3 | Column-scoped `UPDATE` still let a Worker mark any tenant-visible row succeeded — another Worker's job, or a privileged job whose function never ran | The Worker holds `SELECT` only. `platform.finish_worker_job` performs ordinary transitions, requiring `job_identity = session_user` and refusing the privileged namespace. A maintenance job terminalises only inside its audited function |
| 4 | `prsystem_migrate_login` was absent from the raw SQL closure checks, and the runner never looked at ownership | The migration login is checked for attributes, ADMIN and unexpected membership alongside the others. The runner validates database, schema and kernel-object ownership before any new DDL and again after. `PRSYSTEM_APPROVED_OPERATOR_OWNERS` is the shipped contract |
| 5 | Comparing two `pg_dump` outputs cannot catch a defect the fresh and upgrade paths share | One exported comparator, used by the blocking gate *and* by nine mutation tests. Compares the exact 14-table set, columns with type/nullability/default/identity, primary keys including the composite audit key, foreign keys, unique and check constraints, and index definitions |
| 6 | The pool-error report was process-global: one suite's reset erased another's failure, and only suites that asked ever failed | Per-database accounting; `drop()` asserts its own database's account after orderly closure. A fixture proves an ordinary suite exits non-zero without calling the assertion itself |
| 7 | The `governance` job ran pnpm validators with no pnpm setup and no install | It installs with a frozen lockfile first, and the validator requires that of every job using pnpm. `if:`-disabled steps, expression `continue-on-error`, and a substring-matched root script are all rejected now |
| 8 | Documentation contradicted the code | Corrected; superseded sections labelled historical |

#### What the new checks found on the way

- Adding `MaintenanceModule` to `AppModule` broke `pnpm run openapi`: the pool factory read the fully
  validated `env()`, and document generation deliberately runs with no runtime environment. Caught by
  the gate, fixed by reading the one variable the factory needs.
- The full-tree audit carried `continue-on-error: true` while passing — dead weight that also
  functioned as a bypass. It is blocking now.

#### GATE-SEC — 18 sub-gates, 439 tests

SEC-ROLE 12, SEC-RLS 33, SEC-ACL-MATRIX 110, SEC-OWNERSHIP 10, SEC-LOCK-EVIDENCE 16,
SEC-POOL-ERRORS 5, SEC-BOOTSTRAP 19, SEC-SCHEDULER 38, SEC-MAINTENANCE 24, SEC-STARTUP 21,
SEC-STARTUP-WORKER 4, SEC-REGRESSION 51, SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7,
SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6. Identical across three consecutive runs.

---

## Update protocol

At the end of every phase, append to the phase ledger:

1. State transition and date.
2. Migration file names added.
3. Exact gate commands executed with pass and fail counts, including
   `node tools/validate-governance.mjs`.
4. Commit SHA.

Never mark a phase `DONE` on the strength of a command that was not run.
