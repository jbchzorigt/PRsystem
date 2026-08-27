# PRsystem — Phase Status

**Branch:** `claude/mvp-implementation`
**Base commit:** `c1c2abc` (`docs: add hotel booking MVP requirements baseline`)
**Phase namespace:** 01–23 as fixed in [build-plan.md](build-plan.md) §3. Approved and immutable —
no phase may be dropped, merged, renumbered or reordered.

Legend: `DONE` · `IN PROGRESS` · `BLOCKED` · `NOT STARTED`

---

## Current position

| Field | Value |
| --- | --- |
| Current phase | **02 — Monorepo scaffold** |
| Phase state | `DONE` (all blocking gates green from a clean install; awaiting customer acceptance) |
| Next phase | 03 — Platform kernel |
| Next phase state | `NOT STARTED` — requires explicit authorization to begin |
| Blocking conflicts | None. Four documented drift resolutions, zero unresolved P0 conflicts. |

---

## Phase ledger

| # | Phase | State | Migrations | Gates run | Commit |
| --- | --- | --- | --- | --- | --- |
| 00 | Requirement intake and governance baseline | `DONE` | — | `GATE-GOV` | `07a9fd0`, `d2cbc65` |
| 01 | Architecture and threat model | `DONE` | — | `GATE-GOV` 13/13 | `b0ec3f3`, repair pending |
| 02 | Monorepo scaffold | `DONE` | `0000_baseline` | `GATE-GOV` 13/13, workspace 15/15, `GATE-LINT`, `GATE-TYPES`, `GATE-UNIT` 108, `GATE-MIGR` 4, `GATE-E2E` 15, audits | `f3d7b3d`, +dep closure |
| 03 | Platform kernel | `NOT STARTED` | — | — | — |
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

Phase 00 is a documentation phase; no application gate exists yet, and none is claimed as passing.
The governance gate was executed:

```bash
node tools/validate-governance.mjs
git diff --check
git status --porcelain
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
| DM-01 | PostgreSQL Row Level Security as defence in depth — forced RLS, transaction-scoped server-derived context, five database roles, separate migration owner, Police schema and role, explicit public/global/cross-tenant handling, required RLS tests in owning phases | [ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md) |
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

## Update protocol

At the end of every phase, append to the phase ledger:

1. State transition and date.
2. Migration file names added.
3. Exact gate commands executed with pass and fail counts, including
   `node tools/validate-governance.mjs`.
4. Commit SHA.

Never mark a phase `DONE` on the strength of a command that was not run.
