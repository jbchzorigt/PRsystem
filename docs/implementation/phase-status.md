# PRsystem — Phase Status

**Branch:** `claude/mvp-implementation`
**Base commit:** `c1c2abc` (`docs: add hotel booking MVP requirements baseline`)
**Phase namespace:** 01–23 as fixed in [build-plan.md](build-plan.md) §3. Approved and immutable —
no phase may be dropped, merged, renumbered or reordered.

Legend: `DONE` · `IN PROGRESS` · `BLOCKED` · `NOT STARTED` · `SECURITY_REPAIR_REQUIRED` ·
`AWAITING_CUSTOMER_ACCEPTANCE`

---

## Current position

| Field | Value |
| --- | --- |
| Current phase | 06 — Hotel, room, category, and tariffs |
| Phase state | `NOT STARTED` — implementation requires explicit authorization to begin |
| Phase 03 state | `DONE` |
| Phase 04 state | `DONE` |
| Phase 05 state | `DONE` |
| Phase 04 acceptance | `ACCEPTED` |
| Phase 04 accepted at | `e5fcf19c4164c72106b6d2408f460751ad30685f` |
| Phase 05 acceptance | `ACCEPTED` |
| Phase 05 accepted at | `35314ba210f609269863f0b528bbe827e6a5d3ce` |
| Customer acceptance | `ACCEPTED` |
| Phase 03 accepted at | `3ac74a6244a7c350b7489be05778884a9fe65c3c` |
| Customer review number | 19 |
| Latest implemented repair number | 19 |
| Blocking conflicts | None. Four documented drift resolutions, zero unresolved P0 conflicts. |

---

## Phase ledger

| # | Phase | State | Migrations | Gates run | Commit |
| --- | --- | --- | --- | --- | --- |
| 00 | Requirement intake and governance baseline | `DONE` | — | `GATE-GOV` | `07a9fd0`, `d2cbc65` |
| 01 | Architecture and threat model | `DONE` | — | `GATE-GOV` | `b0ec3f3`; later corrections to its documents ride with the Phase 03 repairs |
| 02 | Monorepo scaffold | `DONE` | `0000_baseline` | `GATE-GOV` 13/13, workspace 15/15, `GATE-LINT`, `GATE-TYPES`, `GATE-UNIT` 108, `GATE-MIGR` 4, `GATE-E2E` 15, audits | `f3d7b3d`, `071362a` |
| 03 | Platform kernel | `DONE` | `0001_kernel` | the full battery — counts in [Current Phase 03 evidence](#current-phase-03-evidence) | `8a62b0b` …; every repair is listed in the same section |
| 04 | IAM, tenancy, RBAC, and staff lifecycle | `DONE` | `0002_iam_rbac_staff`, corrected in place by remediations 1–4 | the Phase 04 battery — counts in [Phase 04 remediation 4](#phase-04-remediation-4) | accepted at the commit named in [Phase 04 acceptance](#phase-04-acceptance); the work itself is in the Phase 04 record and the four remediations |
| 05 | Hotel onboarding and subscription | `DONE` | `0003_onboarding_subscription`, `0004_onboarding_remediation`, `0005_onboarding_remediation2`, `0006_onboarding_remediation3` | the Phase 05 battery — counts in [Phase 05 remediation 3](#phase-05-remediation-3) | accepted at the commit named in [Phase 05 acceptance](#phase-05-acceptance); the work itself is in the Phase 05 record and remediations 1 to 3 |
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

## Phase 03 acceptance

The customer accepted Phase 03 at commit `3ac74a6244a7c350b7489be05778884a9fe65c3c`, the tree the
nineteenth-repair evidence below was measured on. That snapshot is frozen: review 19 is the final
Phase 03 security review, the results in [Current Phase 03 evidence](#current-phase-03-evidence) are
the accepted ones, and the nineteen repair records are history and are not rewritten.

The accepted phase, its state, the acceptance itself and the commit it was given at are declared in
[`tools/phase-03-battery.mjs`](../../tools/phase-03-battery.mjs), outside this document and outside
the manifest that reports them, and `validate-governance` check 15 holds both to them. This document
can no more withdraw the acceptance than it could have granted it.

Phase 04 has since been implemented, remediated four times, and accepted in its own right; see
[Phase 04 acceptance](#phase-04-acceptance). Phase 05 is the current phase and has **not started**.
Beginning it requires a further explicit authorization.

Carried forward into Phase 04 and beyond, unchanged by the acceptance:

- **17 P1 configuration items**, open, tracked in
  [assumptions-and-conflicts.md](assumptions-and-conflicts.md).
- **11 EXT gates** (EXT-01 … EXT-11), seeded closed against deterministic simulators, in
  [external-integration-gates.md](external-integration-gates.md); each opens in the phase that needs
  its provider.
- **`DSR-01`**, OPEN and contained, in
  [dependency-security-register.md](dependency-security-register.md), with its mandatory review in
  Phase 23.
- **Selecting `GATE-SEC` as a required GitHub status check**, an external repository-settings action
  that needs push authorisation and has not been attempted.

---

## Phase 04 acceptance

The customer accepted Phase 04 at commit `e5fcf19c4164c72106b6d2408f460751ad30685f` — the
fourth-remediation tree, whose measured gates are the table in
[Phase 04 remediation 4](#phase-04-remediation-4). That is the accepted evidence and it is frozen;
the Phase 04 implementation battery is not re-run to restate it.

The acceptance and the commit it was given at are declared in
[`tools/phase-03-battery.mjs`](../../tools/phase-03-battery.mjs), outside this document, and
`validate-governance` check 15 holds the Current position rows to both. This document can no more
withdraw the acceptance, or move it to a different tree, than it could have granted it.

The four Phase 04 remediation records below are history. Each states the state it was written under
and keeps saying it; the acceptance does not rewrite them.

**Phase 05 is unchanged by this.** It remains the current phase in `NOT STARTED`, and implementing
it requires a further explicit authorization. An acceptance closes the phase behind it and
authorizes nothing ahead of it.

Carried forward past the acceptance, unchanged:

- **17 P1 configuration items**, open — including the reset lease, retry and dead-letter numbers —
  in [assumptions-and-conflicts.md](assumptions-and-conflicts.md).
- **11 EXT gates** (EXT-01 … EXT-11), seeded closed against deterministic simulators, in
  [external-integration-gates.md](external-integration-gates.md); each opens in the phase that needs
  its provider.
- **`INT-MAIL-01`** — no contracted transactional mail provider; the notification port stays a
  deterministic simulator and the production adapter stays disabled.
- **The scheduled invokers** for the password-reset intake drain and the handoff-discovery
  reconciliation, assigned to their owning future phases; Phase 04 built the operations, not the
  schedule that calls them.
- **`DSR-01`**, OPEN and contained, in
  [dependency-security-register.md](dependency-security-register.md), with its mandatory review in
  Phase 23.
- **Selecting `GATE-SEC` as a required GitHub status check**, an external repository-settings action
  that needs push authorisation and has not been attempted.

Phase 03's acceptance, its commit, its review number and its evidence are untouched by this and
remain exactly as recorded above.

---

## Phase 05 acceptance

The customer accepted Phase 05 at commit `35314ba210f609269863f0b528bbe827e6a5d3ce` — the commit
that records remediation 3 and its measured evidence. That is the accepted evidence and it is
frozen: the battery in [Phase 05 remediation 3](#phase-05-remediation-3), measured at implementation
commit `0c67eca1fc687b443199d3ff11114d68285d9f60`, is not re-run to restate it, and the remediation
1 and 2 tables above it stay what they are — historical measurements, labelled as such.

The acceptance and the commit it was given at are declared in
[`tools/programme-state.mjs`](../../tools/programme-state.mjs), outside this document, and
`validate-governance` check 15 holds the Current position rows to both. Three acceptances now name
three distinct commits, and the check refuses any two of them being the same. This document can no
more withdraw the acceptance, or move it to a different tree, than it could have granted it.

The three Phase 05 remediation records below are history. Each states the state it was written
under and keeps saying it; the acceptance does not rewrite them.

The CI ledger for the accepted commit is a separate persisted artifact,
[phase-05-ci-ledger.md](phase-05-ci-ledger.md): the workflow's 41 run steps with their commands,
exit codes, per-step log hashes, the disposable Compose projects and their volume cleanup, and the
two deviations from the workflow. It states in its own terms that its five jobs shared one checkout
and one build cache and that it is therefore not a proof of five independently pristine workspaces.

**Phase 06 is unchanged by this.** It remains the current phase in `NOT STARTED`, and implementing
it requires a further explicit authorization. An acceptance closes the phase behind it and
authorizes nothing ahead of it.

Carried forward past the acceptance, unchanged and still open:

- **`EXT-03`, `EXT-04` and `EXT-11`** — BLOCKED, running against conformance-gated deterministic
  simulators with the production adapters disabled, in
  [external-integration-gates.md](external-integration-gates.md).
- **`INT-OTP-01`** and **`INT-MAIL-01`** — no contracted OTP or transactional mail provider.
- **The Phase 19 offline verification surface**, assigned to its owning phase.
- **17 P1 configuration items**, open, in
  [assumptions-and-conflicts.md](assumptions-and-conflicts.md).
- **`DSR-01`**, OPEN and contained, in
  [dependency-security-register.md](dependency-security-register.md), with its mandatory review in
  Phase 23.
- **Selecting `GATE-SEC` as a required GitHub status check**, an external repository-settings action
  that needs push authorisation and has not been attempted.

Phase 03's and Phase 04's acceptances, their commits and their evidence are untouched by this and
remain exactly as recorded above.

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

### Corrections applied after governance intake

The first submission drifted from the approved plan: it contained 21 phases and altered the approved
ordering. The correction restored the approved structure without touching any requirement document.

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

Phase 00 is a documentation phase: governance and the whitespace check are the
only gates that apply to it.

```bash
node tools/validate-governance.mjs
git diff --check
```

The Phase 03 battery is not recorded here. It lives inside the bounded Phase 03
evidence section, because a Phase 00 record carrying Phase 03 results is exactly
the confusion the structural check exists to prevent.

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
| The full-tree high audit remains enabled | `pnpm run audit:tree`, blocking | `validate-workspace` 15 |

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
| `prsystem_worker` | jobs and the outbox relay | as API, plus `outbox_delivery` `SELECT, UPDATE`, export and projection tables, and **`SELECT` only** on `job_run` — no `INSERT` and no `UPDATE`; ordinary transitions go through `platform.finish_worker_job` | no |
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

<!-- phase-03-repair-history:begin -->

### First security repair (customer review 1) — `SECURITY_REPAIR_REQUIRED`

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

### Second security repair (customer review 2) — `SECURITY_REPAIR_REQUIRED`

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
| 7 | The API held `UPDATE` on `platform.outbox_delivery` with no code path needing it, and the worker held table-wide `UPDATE` on `platform.job_run` — the very fields the maintenance function authorises on | The API holds `SELECT` only. The worker's `job_run` grant is column-scoped to `(state, finished_at, error_name, as_of)`, and `platform.job_run_transition_guard` makes `job_run_id`, `hotel_id`, `job_name`, `job_identity` and `started_at` immutable and terminal states terminal. **Superseded by the seventh repair:** the column-scoped `UPDATE` was removed entirely and the worker now holds `SELECT` only. |
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
claimed.

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

#### D-09 — the scheduler boundary

The role model is now **11 group roles and 7 canonical login principals**. Issuing a privileged
maintenance job and executing one are separate powers with separate credentials.

| | Scheduler | Worker |
| --- | --- | --- |
| Issues a privileged maintenance job | **yes**, via `platform.schedule_maintenance_job` only | no — holds no `INSERT` on `job_run` |
| Executes one | no | **yes**, only when its authenticated `session_user` is the named executor |
| Direct privilege on `platform.job_run` | **none** | `SELECT` only — transitions go through `platform.finish_worker_job` |
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
`SECURITY_REPAIR_REQUIRED` and no approval is claimed.

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

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

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The sixth repair was **not accepted**. Eight defects were raised; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED` and no approval is claimed.



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

### Eighth security repair (customer review 8) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The seventh repair was **not accepted**. Eight defects were raised; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED` and no approval is claimed.

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

| # | Defect | Repair |
| --- | --- | --- |
| 1 | `SCHEDULER_ENABLED` was decorative: the Nest provider read `SCHEDULER_DATABASE_URL` straight from `process.env` and built the privileged pool whenever the variable existed, and the credential requirement applied only to `APP_ENV=production` | Configuration is service-specific. `loadApiEnv` owns the capability, its credential and the only default (on for production, off elsewhere) and returns a discriminated `SchedulerConfig`. Enabled with no URL is refused in **every** environment; disabled with a URL is refused as stale privileged configuration. `loadWorkerEnv` neither declares nor parses the scheduler variables and refuses to start if either is present. `MaintenanceModule` and `AppModule` take the resolved configuration by injection; disabled means no pool, no lifecycle hook and no service. OpenAPI generation states `enabled: false` explicitly |
| 2 | `platform.assert_exact_role_closure` validated the calling login and took the expected group on trust. PostgreSQL does not inherit role attributes, so altering `prsystem_worker` or `prsystem_job_scheduler` itself changed what every member could do while each member's own catalogue row looked untouched | The function resolves the group and requires it to be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS, and scans the whole reachable closure for a privileged attribute rather than relying on the reachability loop's set staying `{login, group}` |
| 3 | Ownership accepted *any* of the four kernel owner roles for *any* kernel object, so `prsystem_maintenance_fn` owning `platform.job_run` passed — handing the owner of the maintenance functions the ability to rewrite the ledger constraining them. `PRSYSTEM_APPROVED_OPERATOR_OWNERS` was optional, so an unset deployment skipped the database-owner check entirely | `packages/db/src/ownership-manifest.ts` names one expected owner per object, covering the database, `public`, all five kernel schemas, every kernel table, partition parent, partition, view, sequence, the drizzle ledger and every kernel function including each `SECURITY DEFINER` one. Partitions resolve through `pg_inherits` and extension members are excluded through `pg_depend`. Every project role that is not a kernel owner must own nothing anywhere. The approved-owner list is mandatory in the runner and in `pnpm run migrate`, checked before a connection is opened |
| 4 | The runbook claimed multiple deployment-managed Worker logins were supported; membership in `prsystem_worker` was the whole executor test, so any login granted the group became a schedulable executor and could create job rows under its own identity | Phase 03 supports exactly one login per runtime group, shared by every process of that runtime. `assert_exact_role_closure` requires the canonical login for the group; `begin_worker_job` validates the closure at all, which it previously did not. Bootstrap fails closed on any non-canonical login that is a member of a group role. Tests needing another job identity write a controlled `job_run` row |
| 5 | `schema.ts` was consulted only for its list of table names, so an edit to a declared column's type, nullability, default or key changed nothing the gate looked at — the snapshot still matched the database and the run stayed green | `schema.ts` states defaults, identity, and simple, composite and unique keys, with defaults given as their exact PostgreSQL text. `schema-projection.ts` emits a machine-readable projection and diffs it against the snapshot; `compareSchema` runs that first. The snapshot keeps only genuinely SQL-only properties. Index scanning excludes partition children through `pg_inherits` instead of a `%_20%` name match |
| 6 | Pool-error accounting was keyed by the database a pool connects to, but a `createTestDatabase` lifecycle owns a coordination pool that connects elsewhere; its errors were filed under a database no teardown asserted. Unattributed errors were likewise recorded and never read | Pools carry a logical scope, defaulting to their database and settable explicitly; the lifecycle claims its coordination pool and gives it an `application_name`. `drop()` asserts that scope together with the unattributed bucket. Resetting stays per scope |
| 7 | A step-level `if:` was rejected and a job-level one was not, so `jobs.gate-sec.if: false` disabled the whole gate. The pnpm-job list was hard-coded, so a job added later went unchecked. Only install-before-first-use was ordered, so a setup placed after the install read as correct. Every root-script fixture was a hand-written string that had silently dropped the pool-error stage, so each mutated several properties at once | Required jobs are checked for a job-level condition; pnpm jobs are discovered from the workflow; the ordering asserted is setup < frozen install < first non-install pnpm command. Script fixtures are built from the real `test:security`, mutate exactly one stage, assert the mutation happened and that every untouched stage survived, and require the specific diagnostic |
| 8 | Documentation contradicted the code in eleven current statements | Corrected; repository-wide searches for each superseded statement are clean, and what survives is inside blocks explicitly labelled historical |

#### Failing-first evidence

Every defect was reproduced before it was fixed. Where the fix changed a module, the previous
version was restored temporarily and the new cases were run against it.

| Item | Reproduction | Result before the fix |
| --- | --- | --- |
| 1 | 15 configuration cases, 5 API cases | module absent; disabled-API-with-a-credential started and served |
| 2 | 6 cases mutating `prsystem_worker` and `prsystem_job_scheduler` with LOGIN, BYPASSRLS, CREATEROLE | 6 failed — scheduling and execution both succeeded |
| 3 | 11 upgrade cases against a journal with one genuinely pending migration | 11 failed against the previous runner |
| 4 | 3 cases — scheduling to, starting a job as, and bootstrapping with a non-canonical Worker login | 3 failed |
| 5 | `schema.ts` drifted by dropping `.notNull()` from `job_run.job_name` | both declaration tests **passed** — the silent-pass defect, demonstrated. 13 of 76 cases failed against the previous comparator |
| 6 | coordination-pool and unattributed-pool fixtures | both exited 0 with the error unread |
| 7 | job-level `if: false`, setup-after-install, new pnpm job without setup | accepted by the previous validator (26/29 caught) |

Two additions are recorded as **coverage, not defect fixes**: the four live mutations for identity
and unique-constraint drift in item 5 pass against the previous comparator as well. They were
required by the scope and are not claimed as repairs.

#### Test gates on the final tree

| Command | Exit | Result |
| --- | --- | --- |
| `node tools/validate-governance.mjs` | 0 | 13/13 checks |
| `node tools/validate-workspace.mjs` | 0 | 15/15 checks |
| `node tools/scan-secrets.mjs` | 0 | 315 tracked text files, 0 findings |
| `pnpm run format:check` | 0 | clean |
| `pnpm run lint` | 0 | 16/16 tasks |
| `pnpm run typecheck` | 0 | 25/25 tasks |
| `pnpm run test:unit` | 0 | 19/19 tasks |
| `pnpm run build` | 0 | 16/16 tasks |
| `pnpm run openapi` | 0 | document generated |
| `pnpm run compose:config` | 0 | valid |
| `pnpm run test:migrations` | 0 | **76** tests |
| `pnpm run test:integration` | 0 | **51** tests (db 41, outbox 5, api 5) |
| `pnpm run test:concurrency` ×3 | 0, 0, 0 | **16** tests each run |
| `pnpm run test:regression` | 0 | **51** tests |
| `node tools/validate-regression-coverage.mjs` | 0 | **66/66** checks |
| `node tools/validate-regression-coverage.fixtures.mjs` | 0 | **30/30** bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 0 | **9/9** checks, 3 fixtures |
| `pnpm run test:security` ×3 | 0, 0, 0 | **18/18 sub-gates, 458 tests**, each run |
| `pnpm run test:e2e` | 0 | 15 tests |
| `pnpm run audit:prod` | 0 | no known vulnerabilities |
| `pnpm run audit:tree` | 0 | 0 high or critical (1 moderate: DSR-01) |
| `git diff --check` | 0 | no whitespace error |

#### GATE-SEC — 18 sub-gates, 458 tests

SEC-ROLE 12, SEC-RLS 33, SEC-ACL-MATRIX 110, SEC-OWNERSHIP 10, SEC-LOCK-EVIDENCE 16,
SEC-POOL-ERRORS 5, SEC-BOOTSTRAP 21, SEC-SCHEDULER 49, SEC-MAINTENANCE 24, SEC-STARTUP 27,
SEC-STARTUP-WORKER 4, SEC-REGRESSION 51, SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7,
SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6. Identical across three consecutive runs.


#### The five CI jobs, reproduced in isolated clones

Each job ran in its own clone of `8fc1b7d` with its own checkout, its own pnpm store, its own
`node_modules`, its own Turborepo cache and its own docker compose project. No clone reused
another's dependencies, build output or cache, and the host stack was stopped for the duration so a
clone's compose was genuinely its own.

| Job | Steps | Result |
| --- | --- | --- |
| governance | install, validate-governance, validate-workspace, validate-regression-coverage, validate-ci-bypass-fixtures, scan-secrets | all exit 0 |
| verify | install, format:check, lint, typecheck, test:unit, build, openapi, audit:prod, audit:tree | all exit 0 — see the note below on format:check |
| e2e | install, `playwright install --with-deps chromium`, test:e2e | all exit 0 |
| compose | install, compose config, compose up, build, test:migrations, test:integration, test:concurrency, test:regression, validate:pool-error-fixture | all exit 0 |
| gate-sec | install, compose up, build, test:security | all exit 0 — **18/18 sub-gates, 458 tests**, identical to the host run |

`format:check` exited 2 on its first run in the `verify` clone. The cause was the reproduction
harness, not the checkout: it had placed that clone's pnpm store *inside* the working copy, and
prettier globbed the store's content-addressed files. The store was moved outside and the step re-run
in the same clone: exit 0, "All matched files use Prettier code style!". The first result is recorded
rather than replaced.

The harness also aborted after the last job, before its own cleanup step: the script was edited while
it was running, which shifted the byte offsets bash re-reads from. The five job results were
unaffected — the loop had been parsed as one compound command before the edit — but the step that
restarts the host compose stack never ran, and the stack was restarted by hand afterwards.

The five clones above ran against `8fc1b7d`, the final **code** commit. The final HEAD adds this
documentation commit on top of it. Three of the jobs cannot be affected by a markdown-only change;
the two that can — `governance`, whose validators read these documents, and `verify`, whose
`format:check` globs them — were re-run in two further fresh, dependency-free clones of the final
HEAD, and every step of both exited 0, `format:check` included.

---

## Current Phase 03 evidence

<!-- phase-03-gate-battery:begin -->

The Phase 03 gate battery, in the order it is run. The commands are listed
without their counts on purpose: measured results are in the table below, and two
copies of a moving number is how the ledger came to disagree with this section.

```bash
node tools/validate-governance.mjs                       # GATE-GOV
node tools/validate-governance.fixtures.mjs              # documentation drift fixtures
node tools/validate-secret-scan.fixtures.mjs             # secret-scan fixtures
node tools/validate-workspace.mjs                        # workspace structure
node tools/validate-regression-coverage.mjs              # structural CI checks
node tools/validate-regression-coverage.fixtures.mjs     # CI bypass fixtures
node tools/validate-pool-error-fixture.mjs               # an idle-pool error fails a suite
node tools/scan-secrets.mjs                              # committed secrets
pnpm run format:check
pnpm run lint                                            # GATE-LINT
pnpm run typecheck                                       # GATE-TYPES
pnpm run test:unit                                       # GATE-UNIT
pnpm run test:migrations                                 # GATE-MIGR
pnpm run test:integration                                # GATE-INTEG
pnpm run test:concurrency                                # GATE-CONC
pnpm run test:regression
pnpm run test:security                                   # GATE-SEC
pnpm run test:e2e                                        # GATE-E2E
pnpm run audit:prod
pnpm run audit:tree                                      # blocking
pnpm run build
pnpm run openapi
pnpm run compose:config
git diff --check
```

<!-- phase-03-gate-battery:end -->

**The one canonical place for Phase 03 gate results.** The phase ledger row and
the gate-battery block above link here and restate no counts;
`validate-governance` check 15 parses both regions and fails if either starts
carrying its own copy again, which is how they came to read `49 / 439 / 51 / 26 /
3` while this section read something else.

<!-- phase-03-evidence:begin -->

Measured on the nineteenth-repair tree. Every command exited 0.

| Command | Status | Result |
| --- | --- | --- |
| `node tools/validate-governance.mjs` | PASS | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | PASS | 112 of 112 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | PASS | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | PASS | 15 of 15 |
| `node tools/scan-secrets.mjs` | PASS | 333 indexed files, none reported |
| `pnpm run format:check` | PASS | clean |
| `pnpm run lint` | PASS | 16 of 16 projects |
| `pnpm run typecheck` | PASS | 25 of 25 graphs |
| `pnpm run test:unit` | PASS | 19 of 19 projects |
| `pnpm run build` | PASS | 16 of 16 projects |
| `pnpm run openapi` | PASS | document generated |
| `pnpm run compose:config` | PASS | valid |
| `pnpm run test:migrations` | PASS | 138 |
| `pnpm run test:integration` | PASS | 51 — db 41, outbox 5, api 5 |
| `pnpm run test:concurrency` | PASS | 16 each run |
| `pnpm run test:regression` | PASS | 51 |
| `node tools/validate-regression-coverage.mjs` | PASS | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | PASS | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | PASS | 12 of 12, four fixtures |
| `pnpm run test:security` | PASS | 18 of 18 sub-gates, 488, each run |
| `pnpm run test:e2e` | PASS | 15 |
| `pnpm run audit:prod` | PASS | no known vulnerabilities |
| `pnpm run audit:tree` | PASS | none at high or critical; one moderate, DSR-01 |
| `git diff --check` | PASS | clean |

### GATE-SEC sub-gate counts

SEC-ROLE 21, SEC-RLS 33, SEC-ACL-MATRIX 110, SEC-OWNERSHIP 10, SEC-LOCK-EVIDENCE 16,
SEC-POOL-ERRORS 5, SEC-BOOTSTRAP 21, SEC-SCHEDULER 55, SEC-MAINTENANCE 24, SEC-STARTUP 38,
SEC-STARTUP-WORKER 8, SEC-REGRESSION 51, SEC-AUDIT 42, SEC-PARTITION 14, SEC-POLICE-ISOLATION 7,
SEC-KMS 17, SEC-PII-LEAK 10, SEC-SECRETS 6. Byte-identical across three consecutive runs.

<!-- phase-03-evidence:end -->

---

### Ninth security repair (customer review 9) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The eighth repair was **not accepted**. Ten defects were raised; all are closed.
Phase 03 stays `SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting
customer review, and **no acceptance is claimed**.

| # | Defect | Repair |
| --- | --- | --- |
| B1 | `MIGRATION_DATABASE_URL` was declared in the shared runtime schema, so `ApiEnv` and `WorkerEnv` both parsed and returned it while `.env.example` claimed both rejected it | The shared schema no longer declares it. `loadMigrationEnv` owns the migration-only contract; both runtime loaders refuse the variable by presence, empty assignment included, and never echo its value. The templates are split into runtime-only and migration-only, enforced by `validate-workspace`. No shipped API or worker source reads the key or imports the loader |
| B2 | `assertRuntimePrincipal` verified an exact group closure and never that `session_user` was the canonical login for it, so a new LOGIN with one otherwise-perfect membership passed startup | One canonical mapping in `roles.ts`, from which bootstrap and the guards both read. The guard requires the canonical login for all six contained groups, reporting `not_canonical`. A test holds the SQL `CASE` to the same table, and another asserts only `roles.ts` declares it |
| B3 | `finish_worker_job` checked the realm and `job_identity = session_user` and never called `assert_exact_role_closure` | The closure is revalidated before the job row is read or locked. The repair also found the catalogue incomplete: a Worker can execute **seven** definers, not four. All seven are enumerated with the guard each applies — three deliberately run no closure — and the live grants and bodies are held to that list |
| B4 | Only the scheduler guard's own failure closed the application; correlation setup, the OpenAPI document and `app.listen()` ran outside any cleanup, so an `EADDRINUSE` left a privileged scheduler connection alive in a process that had not started | Every step from the container's creation to the successful return runs inside one `try`; any failure closes the application and rethrows the original error unchanged. The scheduler pool carries an `application_name` so its backends are visible and assertable |
| B5 | The manifest accepted any name in `PRSYSTEM_APPROVED_OPERATOR_OWNERS`, so a kernel owner could be approved as database owner — while bootstrap forbade every project role there unconditionally | Every group role and canonical login is rejected as owner of the database or `public` before the allow-list is consulted. The project-role definition moved to `roles.ts` so bootstrap and the manifest read one set |
| B6 | Functions were keyed by `schema.name`, so an added overload inherited an exception; and the reverse census excluded all four kernel owners, so a narrow owner could hold arbitrary objects in `public` or a rogue schema | Functions are keyed by exact identity signature. A whole-database census permits a narrow owner only its declared entries, with partition descendants resolved through `pg_inherits` and extension members through `pg_depend`. Every name column is cast to `text`, which was silently truncating signatures at 63 bytes |
| B7 | The projection called foreign keys, checks, indexes and generated columns non-expressible; Drizzle 0.45.2 expresses all four, and 28 checks, 2 foreign keys and 6 indexes were declared in `schema.ts` not at all | `schema.ts` declares all of them, checks carrying the exact PostgreSQL predicate text. The projection renders them and reads generated state from the declaration. The snapshot header now lists what genuinely remains SQL-only, with the reason for each |
| B8 | Scope accounting covered the `createTestDatabase` lifecycle, so a suite managing its own `quietPool` recorded errors into a scope nothing read | A setup file registers an unconditional end-of-file assertion over every scope. The harness's bookkeeping moved onto `globalThis`, because the setup file and the test files resolved the module differently and the first version of the hook inspected an empty map |
| B9 | The validator ignored `step.shell`, so `shell: bash -c 'true' {0}` beside a correct `run:` line passed; and it required only a subset of the blocking commands | `tools/ci-manifest.mjs` is the single contract for all five jobs: exact command, correct job, blocking, default shell, required database, required order. Checks rose from 66 to 164 |
| B10 | The ledger and the gate-battery block each held their own copy of the counts and had gone stale; several documents still described superseded behaviour | Counts live in one section; the ledger and the battery link to it, and `validate-governance` check 15 fails if either restates them. Check 14 holds the runbook's GATE-SEC catalogue to `gate-sec-config.mjs` — it listed 8 of 18 |

#### Failing-first evidence

Every defect was reproduced before it was fixed. Where the fix changed a module,
the previous version was restored temporarily and the new cases run against it;
no temporary mutation was committed.

| Item | Reproduction | Result before the fix |
| --- | --- | --- |
| B1 | both runtime loaders handed a valid `MIGRATION_DATABASE_URL` | **accepted**, and returned the credential value |
| B2 | 6 non-canonical logins, one per contained group, each with an exact closure | 6 accepted |
| B3 | a non-canonical Worker login finishing a job assigned to itself; the canonical Worker finishing after gaining `pg_read_all_data` | both succeeded |
| B4 | startup against an occupied port | 1 scheduler backend left connected |
| B5 | 8 cases: kernel owner, narrow owner, runtime and login, each as database and as `public` owner | 8 accepted |
| B6 | an extra overload, a `public` function, a relation and a function in a rogue schema, the wrong narrow owner on a declared function | 5 accepted |
| B7 | 8 declaration mutations, plus removing `.onDelete('restrict')` from `schema.ts` | mutations undetectable; the real `schema.ts` edit left "matches the declaration exactly" **passing** |
| B8 | a self-managed `quietPool` fixture with no `createTestDatabase` | exited 0 with the error unread |
| B9 | a custom shell template, and removal of the migration gate, the E2E suite, the production audit and the compose teardown | 5 accepted (30/35 caught) |
| B10 | — | the stale counts are the defect; corrected and guarded by checks 14 and 15 |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing an explicit push authorisation, and was not attempted.

---

### Tenth security repair (customer review 10) — `SECURITY_REPAIR_REQUIRED`

The ninth repair was **not accepted**: the clean-clone jobs proved the gates ran,
and independent negative tests proved several were still incomplete. Six defects
were raised; all are closed. Phase 03 stays `SECURITY_REPAIR_REQUIRED`, the
repair is committed and awaiting customer review, and **no acceptance is
claimed**.

| # | Defect | Repair |
| --- | --- | --- |
| 1 | `assertMigrationPrincipal` verified an exact `prsystem_migrate` closure and treated it as sufficient, so a new LOGIN with one otherwise-perfect membership applied DDL through the real runner | The canonical migration login is required first, before any DDL, from the same `CANONICAL_LOGIN_BY_GROUP` mapping bootstrap and the runtime guard use. Reported as `not_canonical` |
| 2 | The "whole-database" census queried three catalogues by hand, so foreign tables and enum, domain and composite types were invisible; extension members were exempt from the narrow-owner invariant; and the dependency predicate matched on `objid` with no `classid` | The census reads `pg_shdepend`, which is the catalogue's own record of ownership and covers every ownable class. An unnameable class fails closed. Extension membership is reported, never an exemption. Every dependency match carries `classid`, `objid`, `objsubid`, `refclassid` and `deptype` |
| 3 | `drizzleProjection` dropped foreign-key `ON UPDATE`, unique `NULLS NOT DISTINCT`, the generated expression and index order, NULL ordering and operator class; `only`, `with` and `concurrently` were unclassified. The mutation tests altered the produced projection, so they proved only the differ | The projection takes its tables as input and `schema-extraction.test.ts` compares pairs of real declarations differing in one property. Every persistent property is projected; `concurrently` is refused as construction-only |
| 4 | The validator accepted `exit 0` above the exact command, a workflow-level default shell, a required-job default shell, and teardown that had lost `if: always()` | A required step's executable lines must be exactly its command. Custom shells are rejected at step, job-default and workflow-default level. `cleanup: true` is consumed: teardown requires `always()`, everything else requires no condition |
| 5 | Check 14 scanned every `SEC-*` mention rather than the catalogue section; check 15 looked only at the ledger row, so a fabricated count in the gate battery, a removed or changed canonical link and a duplicated canonical section all passed | Both checks parse their real regions and take an overridable path, and `validate-governance.fixtures.mjs` proves them with nine drift fixtures and three controls |
| 6 | The refusal of `MIGRATION_DATABASE_URL` was asserted on the thrown error alone, missing the stack and the logger's structured fields | The real entrypoints run as child processes and everything they write is searched, including a field-by-field walk of every JSON line |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| 1 | a non-canonical migration login through `runMigrations` | **applied both migrations**; the call did not throw |
| 2 | foreign table, enum, domain, composite type, an extension function held by a narrow owner, and extended statistics as an unknown class | 6 accepted |
| 3 | 14 extraction cases over real declarations | 14 failed; the previous projection took no argument, and the nine properties appear zero times in its source |
| 4 | `exit 0` before the command, workflow default shell, job default shell, teardown without `always()` | 4 accepted (36/40 caught) |
| 5 | a sub-gate removed from the catalogue but mentioned elsewhere, a fabricated count in the gate battery, the ledger's canonical link removed | the previous checks reported **15/15 PASS** |
| 6 | — | **no defect**: both runtimes already redact and all four cases passed first time. Recorded as evidence, not a repair. Proved non-vacuous by interpolating the value into the refusal message, which fails all four; the mutation was restored and not committed |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.

---

### Eleventh security repair (customer review 11) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The tenth repair was **not accepted**: the exact-final-HEAD clone proof was
valid, and the remaining defects were false-green coverage *inside* the gates it
executed. Five defects were raised; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. C1 and C6 were accepted and are
unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| D1 | The `pg_shdepend` census covered only restricted and narrow owners, and the expected-owner comparison covered only schemas, relations and functions. An external role owning an omitted class inside a kernel schema passed both | A third census enumerates every owned object located in a kernel schema, whoever owns it, through `pg_shdepend` joined with `pg_identify_object`, and applies the exact rule — manifest exception, partition descendant inherits its parent, otherwise the DDL owner. An object it cannot name fails closed |
| D2 | Four extraction false-greens: SQL parameters were discarded, identity was reduced to "is an identity", column-level `.unique()` was unread, and RLS and policies were called unsupported | Parameterised fragments are refused; identity sequences, column-level uniqueness and RLS enablement and policies are projected, added to the snapshot and compared against the live catalogue. `FORCE ROW LEVEL SECURITY` remains the one SQL-only RLS property. A version-pinned inventory classifies every table, column and index key |
| D3 | `working-directory` on a required step ran the package script instead of the root aggregator; a `needs:` on a job with `if: false` skipped the required job | `working-directory` is rejected at step, required-job default and workflow default level; `needs` is rejected on a required job |
| D4 | The Phase 03 gate battery sat inside the Phase 00 record; the position and ledger still said ninth; superseded sections still claimed to hold current counts; check 14 could be fooled by a decoy catalogue; check 15 missed ordinary ratios | The battery is bounded by explicit markers inside the canonical section and Phase 00 records only its own gates. Check 14 anchors to the catalogue heading; check 15 parses bounded regions, compares the cardinal and ordinal in the position against the newest repair section, and rejects every mutable result form outside the canonical section |
| D5 | The secret scanner skipped an entire line containing any allow-listed literal, so an allowance could conceal a real credential beside it | Allowed spans are cut out and the remainder is scanned. `validate-secret-scan.fixtures.mjs` proves it, including the reported bypass verbatim |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| D1 | an enum, a domain, a composite type and extended statistics in `platform` owned by `outside_owner` | four accepted, and the upgrade applied its pending DDL |
| D2 | 28 paired extraction cases over genuine declarations | 13 failed against the previous projection |
| D3 | `working-directory` on the step and at both default levels; `gate-sec` made to depend on a skipped job | four accepted |
| D4 | a decoy catalogue before the real one; a ratio inserted into the ledger row; the battery moved out of its markers; a stale review number; a historical section reclaiming "current counts" | the previous checks accepted them |
| D5 | the reported line, tracked | reported nothing |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Twelfth security repair (customer review 12) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The eleventh repair was **not accepted**. Seven further false-negatives were
raised, each independently reproduced; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. D3, C1 and C6 were accepted and are
unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| E1 | The kernel-object census derived its inventory from `pg_shdepend`. PostgreSQL records no ownership row there for an object owned by a *pinned* role, and the bootstrap superuser initdb creates (OID 10) is pinned — so an enum, a domain, a composite type or extended statistics in a kernel schema could be reassigned to the bootstrap operator and stay invisible | The census is generated from the catalogues themselves. Every schema-contained ownable class is classified in `OWNABLE_SCHEMA_CATALOGUES`, the query is built from that map, and the owner is read from the catalogue's own owner column, which has no pinned-role gap. Derived types and indexes are excluded with their reason — PostgreSQL refuses to reassign them independently. Fail-closed on an unclassified `relkind` or `typtype`, on an object it cannot name, and — through a coverage guard read from the running server — on a schema-contained catalogue in neither classification map |
| E2 | `column.default` went straight to `sqlToQuery(...).sql` instead of through `render()`, so a parameterised default projected as `default $1` and two genuinely different defaults were indistinguishable | Defaults go through the same refusal that checks, generated expressions and predicates already used |
| E3 | Policy role targets were stringified generically, and `String(pgRole('role_a'))` is `[object Object]`, so two policies granted to different roles projected identically | Single and array targets render by their canonical role names; a representation that cannot be named is refused rather than stringified |
| E4 | `enumValues` was classified as non-persistent. PostgreSQL enum labels and their order are stored in `pg_enum` and decide what the column accepts and how it sorts; same-named declarations with different labels projected identically | Enum type identity and ordered labels are projected, carried in the canonical snapshot and compared against `pg_enum` in `enumsortorder`. A `pgEnum` column is told apart from a `text({ enum })` hint by carrying a `PgEnum` object, not by having `enumValues` |
| E5 | `diffDeclarations` derived its declared-table set from the projected columns, so a zero-column table was absent from it — and every reverse comparison is scoped by that set, so removing a table's last column returned an empty difference | The projection carries an explicit declared-table inventory, independent of column count |
| E6 | The canonical evidence read "Measured on the tenth-repair tree" while the position and the newest section both said eleventh, and governance passed 15 of 15 | Check 15 parses the label and compares its ordinal with the current-position pair and the newest repair section. All three ordinals are read from the document; none is hard-coded. Two drift fixtures cover it |
| E7 | The scanner removed every occurrence of an allow-listed value from the line and scanned the remainder, so an allowance suppressed any credential that merely contained it — suffix, prefix and both | Detection runs first and each detected value must equal an allowance exactly. `generic-assignment` captures the quoted value; every match on a line is examined. No line-level or file-level exemption is reintroduced. The truncated PEM allowance is removed and the telemetry fixture assembles the header at runtime |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| E1 | an enum, a domain, a composite type and extended statistics created in `platform` by the admin connection, which is the pinned bootstrap superuser | four accepted, and the upgrade applied its pending DDL. A companion case asserts the premise directly: `pg_shdepend` holds zero ownership rows for such an object |
| E2 | two different parameterised defaults, and the equivalent literal | both projected as `default $1`; the literal was already accepted |
| E3 | `pgRole('probe_role_a')` and `pgRole('probe_role_b')` on otherwise identical policies | both projected `TO [object Object]` |
| E4 | same-named `pgEnum` declarations differing by an added label and by order, and a `text({ enum })` control | no enum was projected at all, so all three compared equal |
| E5 | a declared table with no columns, against a snapshot holding one column for it | an empty difference |
| E6 | the label alone, against the position and the newest section | the previous check accepted it; the new check fails on the unmodified document |
| E7 | allowed-value-plus-suffix, prefix-plus-allowed-value, and both | each reported 0 findings |

Twelve of the 42 extraction cases and all four bootstrap-ownership cases were
observed failing on `d63da9f` before any fix was written.

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Thirteenth security repair (customer review 13) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The twelfth repair was **not accepted**. Six further defects were raised, each
independently reproduced; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. E1 and the accepted parts of E2–E5 and
E7 are unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| F1 | Enum labels were joined with `", "` in the declaration and again in the live query. A label is arbitrary text, so `['a, b']` and `['a', 'b']` — different PostgreSQL types — produced the same string | Labels are an ordered list end to end: projection, canonical snapshot and `array_agg(... ORDER BY enumsortorder)`. Comparison serialises them as JSON, which round-trips, so both label boundaries and order are visible |
| F2 | Policy targets had the same defect: one role named `a, b` and the two roles `a` and `b` both rendered `TO a, b`, and they authorise different things | A policy is carried in parts — permissiveness, command, an ordered list of exact role names, `USING` and `WITH CHECK` — in the projection, the snapshot and `pg_policies`, with `roles` left an array. Membership is decided by Drizzle's own `is(value, PgRole)`, so a structural `{ name: string }` lookalike is refused rather than silently read |
| F3 | Enums were discovered only through table columns, so an exported `pgEnum` nothing references projected nothing — while `CREATE TYPE` creates it and Drizzle Kit loads it | `DECLARED_ENUMS` is an explicit inventory, projected alongside column-discovered enums with each type appearing exactly once. `exportedEnums` holds that inventory to what the schema module actually exports. Two declarations of one qualified enum with different labels are refused |
| F4 | Two declarations of the same qualified table had their columns appended together, so two partial declarations were unioned into an apparent table that could match the snapshot while neither declaration described it | A duplicate qualified table name is refused before anything is projected. A foreign key to a table outside the projected list is unaffected |
| F5 | `marked()` took the first begin and the first end marker, so a correct-looking decoy pair before the canonical section supplied the region while the real block went unread; and the newest heading's review numeral was captured and never compared | `markedRegion` requires exactly one of each marker in the document and the end to follow the begin; containment is asserted on the region's exact character bounds against the section's. The current-position cardinal, its repair ordinal, the heading numeral and the measured-evidence label are mapped to integers and must agree, and every repair heading must spell its own number consistently |
| F6 | The scan CLI honoured `PRSYSTEM_SCAN_ROOT` and `PRSYSTEM_SCAN_FILES`, so the gate itself was redirectable: the root alone pointed the repository's file list at another directory, read nothing, and exited 0 | The scanner core moves to `tools/secret-scan.mjs` and the fixture harness calls `scanFiles` directly. The CLI enumerates git-tracked files and reads no configuration at all. `scanFiles` fails closed on an empty list, a missing or unreadable file, an absolute path, a path escaping the root, a duplicate or empty entry, and a missing, relative, non-directory root or non-array list. The CI validator refuses both variables in `env` at workflow, job and step level |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| F1 | `['a, b']` against `['a', 'b']`, plus quote, Unicode, boundary and order cases | 16 of 61 declaration cases failed; against the live catalogue the joined form read `'a', 'b'` back as `["a, b"]`, identical to the one-comma-label type |
| F2 | `pgRole('probe_x, probe_y')` against `[pgRole('probe_x'), pgRole('probe_y')]`, in the declaration and as a real `ALTER POLICY` on `platform.job_run` | both produced the same target text; a `{ name: string }` lookalike was accepted as a role |
| F3 | an exported enum no column references | `enums: []` and an empty declaration diff |
| F4 | two partial declarations, two conflicting declarations, and the same table object twice | all three were unioned and accepted |
| F5 | a decoy marker pair before the canonical section masking a stale label; the newest heading renumbered from `(customer review 12)` to `(customer review 11)` | 15 of 15 PASS in both cases |
| F6 | `PRSYSTEM_SCAN_ROOT` alone, an empty `PRSYSTEM_SCAN_FILES`, a nonexistent supplied file, an absolute path and a `../` traversal; and both variables on the CI scan step | the first three scanned 0 files and exited 0; the last two followed the path out of the root; the CI validator reported 249 of 249 |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Fourteenth security repair (customer review 14) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The thirteenth repair was **not accepted**. Four defects were raised, each
independently reproduced; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. E1 and the lossless enum-label and
policy-target value representations are unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| G1 | The declared registries were a hand-kept list beside the module, so anything Drizzle Kit would create that the list omitted was invisible: an unregistered exported table, a same-name enum registered in place of the exported one, a standalone `PgSequence`, or any other persistent entity kind | `classifyExports` reads the top-level export surface through Drizzle's own identity — `isPgEnum`, `isPgSchema`, `isPgSequence` and the `drizzle:entityKind` stamp — and every Drizzle export must fall in exactly one supported category. `assertDeclaredInventory` binds tables and enums to their registries by object identity in both directions. Exported `PgSchema` objects are classified explicitly; a standalone sequence and every other persistent kind are refused by name until they have declaration, snapshot and live coverage. Duplicate registry entries are refused |
| G2 | Every comparison key was a dotted concatenation, and `table` was itself `schema.name`. A dot in any identifier made two different objects key alike; one silently replaced the other as the maps were built, and a changed predicate on the loser was no difference at all | Schema, table, column, constraint, index, policy and enum components are carried separately through the projection, the canonical snapshot and every live query. Keys are built with `identityKey`, which is JSON of the components and round-trips; the dotted name survives only as the subject a difference is reported under. Both comparison helpers refuse a duplicate key outright instead of resolving it by insertion order |
| G3 | Four semantic bypasses in check 15: a unique marker pair wrapping only a decoy label while the real table sat outside with a stale one; decoy prose above a stale `Phase state` row; duplicate, out-of-order and malformed repair headings ignored; and only 11 of 13 records parsed, because reviews 1–2 used other heading spellings | The marked region must hold exactly one measured-on label and a result row for every command the gate battery lists. Exactly one `Phase state` row is required and is the only source of the cardinal and ordinal. Review numbers must be unique and run 1..N in document order, ending at the review the position names. Reviews 1–2 are normalised, and any `###` heading mentioning a security repair or a customer review must match the canonical form exactly |
| G4 | The secret scan could be replaced or made to omit: `GIT_INDEX_FILE`, `GIT_DIR` and `GIT_WORK_TREE` chose the inventory; filename extension excluded content; a file over 2,000,000 bytes was skipped; and tracked symlinks were followed | Every `GIT_*` variable is stripped before enumeration and the repository git resolves must be the root that was asked for. The inventory carries each entry's index mode: symlinks are scanned as their stored link text and never opened, gitlinks are refused, any other mode fails closed. Extensions decide nothing; files are read in bounded chunks so size never decides either. `lstat` throughout, and an inventory-mismatched entry fails closed. The CI validator refuses the three `GIT_*` variables alongside the `PRSYSTEM_*` pair at workflow, job and step level |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| G1 | an exported table absent from the registry; a same-name enum with different labels registered in place of the exported one; an exported standalone sequence; an exported `PgRole` | each accepted — together with G2, 13 of 74 declaration cases failed |
| G2 | colliding pairs in policies, columns, constraints, indexes and enums — `a.b`/`c` against `a`/`b.c` | the four table-scoped pairs each reported **no difference**; the colliding enums were rejected as one contradictory type |
| G3 | markers wrapping a decoy label; decoy prose above a stale `Phase state` row; a duplicated latest heading; a malformed near-match; a gap; a transposition | governance passed **15 of 15** on every one |
| G4 | an alternate one-entry index via `GIT_INDEX_FILE`; the same through `GIT_DIR`/`GIT_WORK_TREE`; a plaintext credential in `leak.png`; a credential on line 1 of a 2.1 MB file; symlinks to `/dev/null` and `/dev/zero` | the two index redirections each reported **1 tracked text file, 0 findings** and exit 0, with the fixture harness still reporting 27 of 27; `leak.png` and the oversized file passed with the credential unread; `/dev/null` counted as scanned; `/dev/zero` ran until an external 20 s timeout killed it |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Fifteenth security repair (customer review 15) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The fourteenth repair was **not accepted**. Two defects were raised, both
independently reproduced; both are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. G1 and G2 are unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| H1 | `gitInventory` read each entry's blob name and threw it away, and `scanEntries` scanned the mutable working-tree path instead. A credential staged and then overwritten with clean text reported nothing while it sat in the index, ready to be committed | The inventory retains and validates the blob name and the index stage. A non-zero stage is refused — an unmerged path has no single indexed content. An object that is not a git object name, one the repository does not hold, and one that is not a blob are each refused rather than skipped. Content comes from the indexed blob, read in one `git cat-file --batch`, spilled to a file and scanned back in bounded chunks. The working tree is scanned *additionally*, never instead: it cannot mask content already read, so an entry absent from the working tree or present in another form is noted on stderr and the scan continues. A finding seen in both is reported once, against the index, and each finding names its source. `GIT_*` sanitisation, root verification, mode handling, gitlink refusal, extension-independent scanning and bounded processing are unchanged |
| H2 | Eight governance mutations passed 15 of 15: a result changed to `FAILED — not run`; two conflicting rows for one command; two measured-on labels on one line; a second review-number statement in the Phase state row; the position changed to `DONE` while the ledger stayed `SECURITY_REPAIR_REQUIRED`; a stale review ordinal in the ledger; a malformed historical heading behind an empty canonical decoy; and an extra noncanonical fifteenth heading | The results table is a one-to-one command mapping — one row per battery command, no unknown commands, and `Status` is its own column with one accepted value. The battery block gains the three supplemental commands the table already reported, so the two lists are the same list. Measured-on labels are counted as occurrences. The Phase state row is parsed structurally: exactly one review count, one repair ordinal and one phase state, and that state must equal the ledger's and the newest repair heading's. The ledger no longer keeps its own copy of the review ordinal, and restoring one is refused. The repair history is bounded by explicit markers running to the end of the document; inside it every `###` heading must be a canonical repair heading or one of two declared section headings, and no canonical repair heading may sit outside it |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| H1 | a credential staged into a tracked file, then the working-tree file overwritten with clean text | the real repository scan reported **331 tracked files, 0 findings** and exit 0. Running the new fixture harness against the 8fb172b scanner core gives **30 of 50** correct: the four index validations, the unmerged path and all six staged fixtures fail. Nine of the twenty failures are the CLI rows, which fail only because the mixed state pairs the new CLI with the old core, and are not independent evidence |
| H2 | the eight mutations listed above, each asserted to have changed the document | governance passed **15 of 15** on every one |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Sixteenth security repair (customer review 16) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The fifteenth repair was **not accepted**. Two defects were raised, both
independently reproduced; both are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. G1, G2, H1 and H2 are unchanged except
where I2 supersedes H2's parsing.

| # | Defect | Repair |
| --- | --- | --- |
| I1 | `git replace` substitutes one object for another, repository-locally, and `cat-file --batch` honours the substitution while still printing the OID that was asked for. Staging a credential, pointing a replace ref at a clean blob and tidying the working tree gave a clean scan: the header said the recorded object, the bytes said something else, and nothing compared them | Both layers, each proved to hold on its own. Replacement processing is disabled explicitly — `--no-replace-objects` on every git invocation and `GIT_NO_REPLACE_OBJECTS=1` in the environment those subprocesses inherit, after every other `GIT_*` variable has been stripped. And every returned object is hashed back to a git object name — `blob <size>\0` then the content, in the repository's own object format — and required to equal the OID the index recorded. The hash is computed incrementally from the chunks the scan already reads, so bounded processing is unchanged |
| I2 | Eight governance mutations passed 15 of 15, each shaped so that no pattern was looking at it: swapped `Status`/`Result` headers; a duplicate row without backticks; a one-space-indented duplicate row; `PASS` beside a Result saying the command was not run; a blank Result; a malformed `####` record behind an empty canonical `###` decoy; an `##` repair heading; and an indented `###` repair heading | The evidence table is parsed as a table: exactly one inside the region, an exact ordered header, every row Markdown would render including up to three leading spaces, exactly three cells, exactly one backticked battery command, `Status` exactly `PASS`, and a non-empty Result that does not claim failure, a skip, a command not run or a non-zero exit. The current position is four structured rows — phase state, customer review number, latest implemented repair number, customer acceptance — with unique keys and exact values, compared with the ledger, the repair history and the evidence label. Headings are read at every ATX level and at up to three spaces of indentation; any heading describing a repair or a customer review must be a canonical, unindented H3 record inside the bounded history |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| I1 | a staged credential, a clean blob, `git replace`, a tidied working tree | `scanRepository` reported **`scanned 1, findings 0`** while `--no-replace-objects cat-file` showed the credential still in the blob. The three replacement fixtures each report **0 findings** against the ab9c69d scanner core. With the flag removed, the hash check alone refuses the substitution — measured, restored, not committed |
| I2 | the eight mutations listed above, each asserted to have changed the document | governance passed **15 of 15** on every one |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Seventeenth security repair (customer review 17) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The sixteenth repair was **not accepted**. Two defects were raised, both
independently reproduced; both are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**. The disabled replacement processing
and the streamed object-hash verification are unchanged.

| # | Defect | Repair |
| --- | --- | --- |
| J1 | The index was the whole inventory, so a credential already committed could be hidden behind clean staged content: `HEAD:<path>` named the secret blob, `:<path>` named the replacement, and the scan reported zero findings | The checked-out commit and the index are enumerated independently and both are mandatory. Where they name the same blob for the same path there is nothing to scan twice, and that identical-blob case is the only one deduplicated. A path with different HEAD and index objects is scanned twice and each finding names its source. HEAD must resolve to a commit — unborn, non-commit or unreadable means one of the two sources is missing and is refused. A tree where a blob is expected, a gitlink, a bad object name and a non-zero index stage fail closed on either side. In CI each of the five jobs now scans immediately after checkout and before `pnpm install`, so the first look at HEAD and the index happens before any dependency lifecycle script can run; the manifest marks the step `beforeInstall` and the validator enforces the ordering |
| J2 | Line-oriented regular expressions cannot model Markdown. Eight constructs passed or were misdiagnosed: a GFM row without outer pipes, `PASS` beside "exit 1", a duplicate `Current position` H2, a three-cell row in a two-column table, a second ledger state token, a correct measured-on label hidden in an HTML comment beside a stale visible one, and Setext, raw `<h3>` and tab-separated ATX repair headings | The document is parsed with `marked@18.0.11` — pinned, CommonMark with GFM, no transitive dependencies — and the check reads the tree, with every top-level token carrying its exact character span. What the document must say is declared once in `docs/implementation/phase-03-evidence.json`: phase, state, review and repair numbers, acceptance, repair history, and for every battery command its execution count, actual exit codes and measured result. Success is decided by the exit codes; the Result column must equal the manifest text exactly, so free text decides nothing. Rows are also checked as written, because GFM pads and truncates rows to the header width. Raw HTML in a governed region is refused unless it is one of the six approved boundary markers |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| J1 | a committed credential, clean content staged over it | `scanRepository` reported **`scanned 1, findings 0`** with the credential plainly in `HEAD:leak.ts`. The eight new fixtures give **56 of 63** against the 1aa3335 scanner core; the committed-secret case reports **0 findings** and the staged-deletion case detects nothing at all |
| J2 | the eight listed mutations, each asserted to have changed the copied document | five passed **15 of 15**; the other three were refused for unrelated reasons. Of the twelve new fixtures, **seven are accepted outright** by the 1aa3335 validator and five are refused for a different reason |

#### Dependency change

`marked@18.0.11` added to root `devDependencies`, pinned exactly, with no
transitive dependencies; the lockfile grows by one package. `pnpm run
audit:prod` reports no known vulnerabilities and `pnpm run audit:tree` reports
one moderate — the pre-existing `DSR-01`, unchanged.

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Eighteenth security repair (customer review 18) — `SECURITY_REPAIR_REQUIRED`

> **Historical snapshot.** Superseded. Current results are in
> [Current Phase 03 evidence](#current-phase-03-evidence).

The seventeenth repair was **not accepted**. Five defects were raised, each
independently reproduced; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**.

| # | Defect | Repair |
| --- | --- | --- |
| K1 | Entries were deduplicated on `[path, object]`, so a regular file in HEAD and a symlink in the index naming the same blob collapsed into one entry carrying HEAD's mode. The working-tree pass then found a symlink where it expected a regular file, noted it and moved on, and the link text carrying the credential went unread | The mode is part of an entry's identity: it decides how the entry may be read and belongs to the source that recorded it. Deduplication keys on path, object and mode, so a mode transition produces two entries, each read the way its own source describes it, and the working-tree pass uses the index entry's mode |
| K2 | The validator proved only that the scan preceded one exact command line. `pnpm/action-setup` with `run_install: true`, an `npm ci`, a `corepack pnpm install`, a local action and a bare `git reset` all ran arbitrary code with the checkout in place and passed | Every required job begins with the canonical checkout and then the scan, checked as an exact prefix: step 0 must be `actions/checkout@vN` carrying no `run` and no `if`, step 1 must be the scan, and pnpm and Node are set up afterwards. The checkout may not override `repository`, `ref` or `path`, a job checks out exactly once, and an action that installs while setting up is refused by name |
| K3 | The manifest, the gate-battery block and the evidence table could be edited together, so the document decided what it had to prove: removing `test:security` from all three, or reducing the battery to one command, or declaring `DONE`, or advancing to Phase 04, all passed | `tools/phase-03-battery.mjs` declares the required commands with their execution multiplicities and the governed state, outside the manifest's reach. The manifest records measurements against that requirement and carries an exact key set. The current phase, phase state, customer acceptance and the Phase 04 ledger row are each checked against the governed state, and the repair history must be unique, ordered and exactly contiguous in both sources |
| K4 | Only top-level tokens were inspected, so a blockquote was a hiding place; and raw source was read as visible text, so link titles, entity references and link destinations could say one thing to the parser and another to a reader | The tree is walked recursively — blockquotes, list items, table cells, inline children — and every rule applies to descendants. Visible text is extracted semantically, with entities decoded and link destinations, titles, reference definitions, code and raw HTML excluded. Markers are exact, unique, top-level HTML comment tokens and the marker text may occur nowhere else. The ledger link is validated by its own `href`. The raw-HTML restriction covers the evidence section, the current position, the ledger and the repair history |
| K5 | The production CLI accepted `PRSYSTEM_RUNBOOK`, `PRSYSTEM_PHASE_STATUS` and `PRSYSTEM_EVIDENCE_MANIFEST`, so pointed at clean decoys it validated documents nobody ships while the canonical ones drifted | The checks move to `tools/governance-checks.mjs`, which takes the three paths as arguments. The CLI names the canonical documents and reads no configuration. The fixture harness calls the core directly. CI refuses all three variables at workflow, job and step level |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| K1 | HEAD `100644` and index `120000` over one blob, the working-tree link text carrying the credential | `scanned 1, findings 0`, with a note about a mode mismatch derived from the wrong source. Three of the four new fixtures fail against the de9b324 core |
| K2 | the four listed mutations plus a local action, a second checkout at another ref, an arbitrary step and each checkout override | all eight passed **489 of 489** |
| K3 | the seven coordinated mutations across manifest, battery block and table | five passed **15 of 15**; two were refused for unrelated reasons |
| K4 | the eleven listed mutations | seven were accepted outright; four were refused for unrelated reasons |
| K5 | the three variables pointed at clean decoys while the canonical document was set to `DONE` | the CLI reported **15 of 15**, and the CI validator named none of the three |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.


### Nineteenth security repair (customer review 19) — `SECURITY_REPAIR_REQUIRED`

The eighteenth repair was **not accepted**. Five defects were raised, each
independently reproduced; all are closed. Phase 03 stays
`SECURITY_REPAIR_REQUIRED`, the repair is committed and awaiting customer
review, and **no acceptance is claimed**.

| # | Defect | Repair |
| --- | --- | --- |
| L1 | The index mode was trusted and a working-tree type mismatch only produced a note, so the content was skipped and the scan exited 0. A clean regular file replaced by an unstaged secret symlink, and a clean symlink replaced by an unstaged secret regular file, each reported `scanned 1, findings []` | The working tree is read by what `lstat` says it is: a regular file as content, a symlink as its stored link text and never through the target. The divergence is still reported but decides how to read the entry, never whether. Anything that is neither is refused outright |
| L2 | The environment could end the scan before it read anything: `NODE_OPTIONS: --require=./tools/bypass-scan.cjs` on the scan step turned a repository holding a committed credential from exit 1 into exit 0 with no output, and coverage validation still reported 657 of 657 | `ALLOWED_ENV` names what each level may declare instead of listing what it may not. The workflow may set `NODE_VERSION` and `PNPM_VERSION`, a required job may set nothing at all, an ordinary step may set `DATABASE_URL`, and the scan step may set nothing. Anything else is refused, named or not |
| L3 | Seven coordinated mutations passed all fifteen checks, including rolling every pointer to the review number back together, deleting the newest record with them, appending a bold `DONE` beside the ledger token, reordering the battery in both sources, duplicating a JSON member name, and recording failure prose beside zero exits | `governedReviewNumber` is declared outside the document and all four statements of it must agree; the repair history must be exactly `1..governedReviewNumber`; the manifest and battery block must match `REQUIRED_BATTERY`'s order; duplicate JSON member names are refused before parsing; the Phase 03 and Phase 04 ledger state cells must render exactly their governed token; the Current position's next-phase rows are governed; and result prose may not contradict the recorded exits |
| L4 | A blockquoted canonical H2 made the section span govern the blockquote; a measured-on label inside a list was invisible to the visible-text walk; a second blockquoted ledger declaring Phase 03 `DONE` was never counted; and `<h3 >…</h3 >` and `re<span></span>pair` rendered as headings no pattern matched | Canonical section H2s must be their own top-level heading; visible text recurses through `items`, table headers, rows and cells; exactly one rendered ledger table and exactly one Phase 03 and Phase 04 row exist in the whole document; and raw HTML is refused everywhere except the six approved boundary comments, so there is no HTML left to parse |
| L5 | `runGovernanceChecks({ phaseStatusPath })` honoured the argument in check 15 and nowhere else, so a scratch document with Phase 22 deleted returned 15 of 15 — and the CLI non-redirection controls pointed at byte-identical valid copies, which a redirectable CLI would also have passed | The document is read once, from the supplied path, and the other two injected paths were audited the same way. Each CLI decoy is now a document that fails on its own, with three further controls proving it fails when actually read |

#### Failing-first evidence

| Item | Reproduction | Before the fix |
| --- | --- | --- |
| L1 | both type-change directions | `scanned 1, findings []` with only a note; three of five new fixtures fail against the 4d77df0 core |
| L2 | six workflow mutations, plus a scratch repository holding a real committed credential | all six passed **657 of 657**; the scanner exited 1 plainly and **0 silently** under `NODE_OPTIONS --require` |
| L3 | seven coordinated mutations | five passed all fifteen checks; two were refused for unrelated reasons |
| L4 | six rendered-Markdown mutations | four passed **15 of 15**; two were refused for unrelated reasons |
| L5 | Phase 22 deleted from a supplied scratch document | **0 failures of 15** |

#### Standing items, unchanged

17 P1 configuration items open, 11 EXT gates seeded closed, `DSR-01` OPEN and
contained. Selecting `GATE-SEC` as a required GitHub status check remains an
external action needing explicit push authorisation, and was not attempted.

---

## Update protocol

At the end of every phase, append to the phase ledger:

1. State transition and date.
2. Migration file names added.
3. Exact gate commands executed with pass and fail counts, including
   `node tools/validate-governance.mjs`.
4. Commit SHA.

Never mark a phase `DONE` on the strength of a command that was not run.

<!-- phase-03-repair-history:end -->

---

## Phase 04 record

**Scope.** IAM, tenancy, RBAC and the staff lifecycle: `RBAC-DEC-001`–`017` and
`STAFF-DEC-001`–`009`, twenty-six decisions in all. Phase 04 also absorbs the
authorization work the customer moved out of Phase 03 — the four realms, server
sessions and auth-epoch revocation, the seven-stage pipeline, the permission
catalog, the package gate, the subscription state gate with its 48-hour grace and
hard lock, the multi-role union and the step-up marker.

### Scope completed

- **The permission catalog.** `packages/authz` carries doc 18 §§3, 5 and 6 row for
  row, with each row's heading transcribed from the source. A cell is one of the
  four forms the document actually uses — `✓`, `—`, `Нэмэлт <role> role`,
  `Read-only`/`Request` — with its package annotation, its scope limit and its
  audited single-actor condition, because flattening those into a boolean is how
  `Нэмэлт role` stops being enforced.
- **The seven-stage pipeline.** Realm, active account and membership, named
  permission, tenant and resource scope, package entitlement, account/hotel/
  subscription state, recent step-up. It is a pure function: the same decision is
  asserted in a unit test and re-evaluated inside the transaction that applies
  the effect. Stages 2–4 return one indistinguishable `NOT_FOUND` with an
  identical body; stages 5–7 are actionable.
- **The package gate above the role.** A role the package does not permit
  contributes nothing to the granted set, *and* the result is intersected with
  what the package entitles. A Manager Plus role on a 25,000₮ hotel therefore
  fails twice, independently, and the role assignment is refused as well as every
  action it would have opened.
- **Migration `0002_iam_rbac_staff`.** The tenant root, accounts, credentials,
  sessions, the per-hotel session scope, memberships, role grants, invitations and
  their requested roles, password resets, explicit permission grants, and the
  IAM-owned work handoff queue with its append-only movement history.
- **The staff lifecycle.** Invitation create, resend, revoke, inspect and accept;
  acceptance by a new account with a user-chosen password and by an existing
  verified account without a second one; role add and remove; suspend, terminate
  and explicit reactivation with a reason; self-service and Hotel-Admin-initiated
  password reset; all-device logout; scope-targeted session invalidation.
- **The handoff queue.** `TAKEOVER_REQUIRED` for a suspended Reception's open
  shift, reassignment for a Cleaner task or a Restaurant order, a linked
  `CONTINUATION` where a movement has already posted, and
  `UNASSIGNED_REQUIRES_ACTION` where no eligible replacement exists.

### Migrations

`0002_iam_rbac_staff.sql`. Thirteen tables, all in the `platform` schema; eight
tenant-scoped with `ENABLE` and `FORCE ROW LEVEL SECURITY` and five account-scoped
carrying no tenant column at all. Five transition guards, no `DELETE` grant
anywhere, and `0001_kernel` unchanged.

### What Phase 04 deliberately did not build

- **No later-phase aggregate.** A Restaurant, a Reception shift, a Cleaner task
  and a Restaurant order are referenced by an opaque `subject_ref` with no foreign
  key. Phases 15, 11, 09 and 15 own those tables; the linkage is completed there.
- **No subscription or billing table.** Subscription state arrives through a
  typed, fail-closed contract. The production adapter answers nothing, so every
  hotel action is denied until Phase 05 supplies one.
- **No production email adapter.** `INT-MAIL-01` stays closed. A typed port and a
  deterministic simulator exist; the production path refuses, which aborts the
  command rather than issuing a link nobody received.
- **No realm-specific login flow beyond the Hotel realm.** Guest, Operation and
  Police authentication belong to Phases 12, 19 and 18.

### Test gates

Every command below was run on the final tree.

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 114 of 114 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 374 indexed files, none reported |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1 220 across 11 projects |
| `pnpm run test:migrations` | 138 |
| `pnpm run test:integration` | 85 — db 41, outbox 5, api 39 |
| `pnpm run test:concurrency` | 26 — db 16, api 10 |
| `pnpm run test:regression` | 51 |
| `pnpm run test:security` | 18 of 18 sub-gates, 629 tests |
| `pnpm run test:e2e` | 15 |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Migration evidence

Fresh install, upgrade from `0001_kernel`, and a repeat application that is a
no-op, all against real PostgreSQL, with the normalized schema dump compared
between the fresh and upgraded databases and the live catalogue compared against
both halves of the declaration.

### Security and concurrency evidence

- **The matrix.** Every row of doc 18 §§3, 5 and 6 is asserted column by column,
  in every package, including both halves of every `Нэмэлт role` cell: the column
  refuses the action **and** each role the cell names actually grants it.
- **Realm and tenant isolation.** A cross-tenant target and a genuinely missing
  one produce byte-identical bodies. Without a tenant context every IAM table
  returns zero rows and refuses writes. Under the platform sentinel no tenant row
  is reachable at all.
- **Revocation.** A password reset closes every session in every membership; a
  suspension or a role change closes only the affected hotel's scope and leaves
  the account's other hotels working; a reactivation never revives a closed one.
- **Secrets.** No invitation token, reset token, session token or password
  appears in any IAM table, in the audit stream at any depth, or in the outbox
  intent. A plaintext password written straight into the credential column is
  refused by a check constraint.
- **Concurrency, on real connections released by a barrier.** Two identical
  invitation creates produce one membership and one live invitation; a
  termination and a stale acceptance never both apply; a stale membership
  revision is refused rather than overwriting; two Managers claiming one takeover
  item produce one claimant and one version bump; two assignments produce one
  assignee; two continuation attempts produce exactly one linked continuation
  while the original keeps its actor, its movement and its history; and a
  suspended actor's retry is refused because authorization is re-read at commit.

### Remaining blockers

- **`INT-MAIL-01`** — no contracted email provider. The port and its simulator
  exist and the production path fails closed.
- **The subscription contract** — Phase 05 supplies the authoritative source. Until
  it does, the production adapter answers nothing and every hotel action is denied.
- **17 P1 configuration items**, still open. The authentication numbers among them
  — token TTLs, resend intervals, attempt and rate limits, password cost — are
  carried in one versioned record stamped onto every artefact derived under it,
  and are marked `p1-provisional`.
- **11 EXT gates**, seeded closed; each opens in the phase that needs its provider.
- **`DSR-01`**, OPEN and contained, with its mandatory review in Phase 23.
- **Selecting `GATE-SEC` as a required GitHub status check**, an external
  repository-settings action needing push authorisation. Not attempted.


---

## Phase 04 remediation 1

A bounded runtime, authorization, database and lifecycle security repair on top
of `62fd743`. Phase 04 was **not** customer-accepted; it was recorded
`SECURITY_REPAIR_REQUIRED` while this work ran, and is now `DONE` and
`AWAITING_CUSTOMER_ACCEPTANCE`. Phase 03 was not reopened and `0001_kernel` was
not touched.

This section is titled *remediation* rather than *repair* deliberately: the
governance validator reserves the word for the canonical Phase 03 repair-record
form, and borrowing that vocabulary for a different phase's record would make the
two indistinguishable to every check that reads them.

Every defect below was reproduced by a regression that failed against `62fd743`
for the stated reason before anything was changed.

### A — the direct realms and Guest ownership

| Defect at `62fd743` | Repair |
| --- | --- |
| `authorizeDirect` allowed any Operation or Police action whose **dotted action id** appeared in `account_permission_grant`. `operation.credential_material_view`, `operation.hotel_operational_data_manage`, `operation.police_data_view` and `police.all_hotel_checkin_export` — rows doc 18 refuses to *both* columns — were all executable by storing one string | The pipeline now evaluates the canonical §5 and §6 matrices. A row with `permission: null` / `grantableTo: []` names no permission and is unreachable; a Police `deny` cell refuses whatever is stored; the account's **realm role** selects the column and an account with none is refused; and the row's canonical name (`SUBSCRIPTION_SUSPEND`, `REVIEW_MODERATE`, `WANTED_CASE_EXPORT`) must be held, never its action id |
| Nothing stopped an unknown, denied, wrong-realm or non-grantable permission being written | `user_account` now carries `realm_role`; `account_permission_grant` carries `(realm, realm_role)` with a composite foreign key to that one account row and a CHECK enumerating the exact permissions each column may ever hold. Wrong realm, wrong column, unknown name and dotted id are all unrepresentable. `AccountRepository.grantPermission` checks the same matrix first, so the refusal has a reason |
| Separation of duties and `own_police_scope` were metadata nothing read | Both are enforced. An approval whose counterpart is the actor is refused, and so is one whose counterpart the caller did not load — an unknown requester is not a different requester |
| `booking.cancel_own` was **allowed** when `resourceOwnerAccountId` was absent | A Guest row the matrix marks with an ownership scope denies without an explicitly loaded owner |
| `authorizeCommand` re-resolved the principal and dropped `stepUpAt`, so every step-up-gated action was refused and no fresh challenge could satisfy it | The session's step-up recency is carried into the commit-time re-resolution |

### B — the tenant context is server-derived

The command shape bound RLS to the URL's `hotelId`, claimed the idempotency key
and took `FOR UPDATE` on the target **before** membership was proven. A caller
with no membership in a hotel could make its rows queue behind a lock, which is
itself the disclosure the opaque denial exists to prevent.

Every hotel command now passes a gate that runs in the account scope first:
resolve the account, find a membership covering the target, and require a live
scope grant on it. Only then is the hotel context bound; nothing about the target
is read, locked or claimed before that. The three account policies —
`own_membership_read`, `own_membership_roles_read`, `own_account_scope` — are
confined to the platform sentinel, because PostgreSQL composes permissive
policies with OR and an unconditional account policy **widened every real hotel
transaction** to the actor's rows in other hotels. That confinement is proved to
be load-bearing by a test that removes it and observes the widening.

### C — a scope session is authority, not a record

`session_scope_grant` was written and revoked but never issued and never
consulted. Sign-in now issues one row per active membership, stamped with the
revision it was granted against; the gate and the commit-time re-evaluation both
require it live at the current revision. So a newly granted role needs a new
login, a suspension-then-reactivation never revives the old bearer, and the same
session keeps working in the account's other hotels. Composite foreign keys tie
account, session realm, membership and hotel together. `touchSession` uses
`LEAST(now() + idle, absolute_expires_at)` — without it an ordinary request near
the end of a long session failed on the row's own CHECK. The self-service reset
establishes the token-derived account context before revoking scope grants and
asserts the count it handled; previously the UPDATE matched nothing and reported
success. Revoked sessions, scope grants and permission grants are terminal at the
database boundary: the API role can revoke and can never un-revoke.

### D — invitation and role lifecycle

Acceptance read `request.principal` on a route with no guard, so the
existing-account path was unreachable: an `OptionalSessionGuard` now verifies a
bearer when one is presented and refuses an invalid one rather than downgrading
it. The Primary Hotel Admin's `HOTEL_ADMIN` grant is refused to the staff API and
to a broad SQL revocation. Restaurant scope is correct in both directions: a
hotel-scoped Manager Plus invites the first Restaurant Manager without holding a
restaurant membership, a Restaurant Manager stays inside their own restaurant,
and the role/scope combinations are refused at the service, at the role grant and
at the requested role. The restaurant's linkage to the hotel is a typed
fail-closed contract, because Phase 15 owns that aggregate.

### E — secrets and reset

Invitation inspection was a `GET` with the token in the query string; it is now a
`POST` with the secret in the body. The accept-time idempotency payload recorded
the literal `token: 'redacted'`, so two different invitations under one key
replayed the first one's result; it now records a purpose-bound keyed digest of
the presented token — never the token — and a different secret under the same key
is a key reuse. The self-service reset returns an identical `202` and an
identical body for an unknown address, an inactive one, a registered one, a
throttled resend and an unreachable provider. The Hotel-Admin-initiated reset
keeps its operational failures visible, because there the initiator is
authenticated and already inside the tenant.

### F — the handoff queue

The queue listing returned every open item to anyone holding `queue_view`; it now
applies the cell's own scope — Reception sees the items assigned to it, a Cleaner
its own task, a Restaurant Manager its own restaurant, a Manager the queue. An
item claimed by one Manager could be assigned or resolved by another; it now
requires an explicit `released` transition. The movement history recorded the
**previous claimant** as the actor of an assignment; it records the account that
acted. And `openWork` was trusted request data — a caller could fabricate or omit
authoritative work. It comes from an injected `OpenWorkPort` owned by the domain
modules; with none registered yet the answer is a determinate empty list, and a
registered provider that cannot answer refuses rather than reporting nothing.

### G — migration decision

`0002_iam_rbac_staff.sql` is corrected **in place**, not by a forward migration.
It belongs to the phase under repair: it has never been customer-accepted and has
never been applied to a deployed cluster, so ADR-0004's immutability — which
attaches to *accepted* migrations — does not attach to it, and correcting it
keeps the Phase 04 delta at exactly one migration, which is what a deployment
applies. `0000_baseline` and `0001_kernel` are untouched and are now pinned by
checksum in `src/test-support/frozen-phase-03/`.

The upgrade tested is therefore the real one: a frozen accepted Phase 03 database
(`0000_baseline + 0001_kernel`, 0 → 2 migrations) receiving only the Phase 04
migration (2 → 3), then a repeat application that applies nothing and mutates no
ledger row, with the normalized `pg_dump` of the upgraded database compared to a
fresh install and the live catalogue compared to the declaration on both.

### One assertion corrected rather than satisfied

`iam.concurrency.test.ts` asserted that a suspension racing an acceptance meant
the acceptance must have failed. That conflated *interleaving* with *sequence*:
the two serialise on the membership row, and "accept committed, then the Hotel
Admin terminated" is an ordinary order, not a violation. The test now asserts the
invariant that matters — the stored state matches the answer each caller was
given — and would still fail on a genuine interleaving.

### Test gates — Phase 04 remediation 1

Every command below was run on the committed tree.

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 114 of 114 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 382 indexed files, none reported |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1 240 across 11 projects |
| `pnpm run test:migrations` | 142 |
| `pnpm run test:integration` | 108 — db 41, outbox 5, api 62 |
| `pnpm run test:concurrency` | 26 — db 16, api 10 |
| `pnpm run test:regression` | 51 |
| `pnpm run test:security` | 18 of 18 sub-gates, 619 tests |
| `pnpm run test:e2e` | 15 |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Remaining blockers — unchanged by this remediation

`INT-MAIL-01`; the Phase 05 subscription contract; the new Phase 15 restaurant
directory contract and the Phase 09/11/15 open-work providers, all fail-closed;
17 P1 configuration items; 11 EXT gates seeded closed; `DSR-01` OPEN and
contained with its Phase 23 review; and `GATE-SEC` as a required GitHub status
check, which needs push authorisation and was not attempted.

---

## Phase 04 remediation 2

A second bounded security remediation on top of `03edeeb`, fixing four defects
and nothing else. Phase 04 stays `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`;
Phase 03 was not reopened, Phase 05 was not started, and `0000_baseline` and
`0001_kernel` are untouched.

Each defect was reproduced first. The failing run against `03edeeb` is in
`apps/api/src/modules/iam/iam.remediation2.test.ts`: **8 of 9 failed**, each for
the reason its name states.

### R1 — a suspension survived a provider outage

`setMembershipState` changed the membership, revoked its scope grants and *then*
asked the owning module what open work the person still held — inside the same
transaction. The provider failing rolled all of it back: the suspension returned
`500` and the member stayed **ACTIVE with live sessions**, because a different
system was down.

The security transition now commits with a durable
`platform.work_handoff_discovery` marker beside it, atomically. Enumeration is a
separate retryable step: it runs once immediately, and the response says
`COMPLETED` or `PENDING` truthfully. A provider that cannot answer is never
rendered as "no open work" — the marker persists, its attempts are counted and
monotonic, and `POST …/staff/handoff/discovery/reconcile` settles it when the
module returns. Recovery is idempotent by three independent mechanisms: the
items are opened under the marker's stored seed, the open-item index is one row
per subject, and the marker's completion is a compare-and-set. The inline
success path is unchanged.

### R2 — a session realm no key bound to its account

`server_session.realm` was independent of the account it referenced, so a
`hotel` account could be given a `police` session by one insert through the
runtime login — and every realm check downstream would then have been reading a
realm nobody's account ever had. `user_account` gained
`UNIQUE (account_id, realm)`, and the session's single-column reference is now a
composite `(account_id, realm)` foreign key, which implies the old one. The
regression inserts a Police session for a Hotel account as `prsystem_api` and
requires SQLSTATE `23503`; a session in the account's own realm still inserts.
The scope-grant keys are unchanged.

### R3 — an unverified address could accept an invitation

Authenticated acceptance checked that the account was active and that its
address matched the invitation, but not that the address had ever been proved.
`emailVerifiedAt` must now be non-null. Identity still comes only from the
verified session, and the refusal is the same `not found` an unknown token gets.

### R4 — the reset endpoint's timing oracle

The public endpoint returned an identical `202` for every address while doing
account-specific work — a lookup, a keyed token derivation and a synchronous
wait on the notification provider — **only** when the account existed. A caller
who could not read the response could still time it, and a slow provider widened
that gap to seconds.

The request now performs one bounded insert into
`platform.password_reset_intake` and returns; it touches no account table, no
key material and no provider. Eligibility, the resend interval, superseding a
live token, minting a new one and delivery all happen when the queue is drained,
where taking longer for one address than another tells nobody anything. Each
entry is settled in its own transaction, exactly once, with an operator-facing
outcome that never reaches the caller. Single-live-token behaviour, throttling,
auditability and token secrecy are unchanged.

The deterministic test holds the provider's promise open for the whole of a
known-address request *and* an unknown-address request, and requires both to
return the same body promptly — no sleeps and no wall-clock thresholds. A second
test drains the queue and requires that only the eligible address was sent to.

The scheduled invocation of the drain lands with the email provider: no adapter
exists, `INT-MAIL-01` is still open, and the only sender today is a simulator.
Recorded as a carry-forward below.

### Migration path

`0002_iam_rbac_staff.sql` corrected **in place** again, for the reason recorded
in [assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.5: it has
never been customer-accepted and never applied to a deployed cluster, so the
Phase 04 delta stays exactly one migration. Two tables added
(`work_handoff_discovery`, tenant-scoped with `FORCE ROW LEVEL SECURITY`;
`password_reset_intake`, account-global), two transition guards, one account
identity key and one composite session key.

Tested exactly as before: the frozen accepted Phase 03 state
(`0000_baseline + 0001_kernel`, checksum-pinned, 0 → 2) receives only the Phase
04 migration (2 → 3), a repeat application applies nothing and mutates no ledger
row, and the normalized `pg_dump` of the upgraded database equals a fresh
install with the live catalogue matching the declaration on both.

### Test gates — Phase 04 remediation 2

Every command below was run on the committed tree.

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 114 of 114 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 383 indexed files, none reported |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1 240 across 11 projects |
| `pnpm run test:migrations` | 142 |
| `pnpm run test:integration` | 117 — db 41, outbox 5, api 71 |
| `pnpm run test:concurrency` | 26 — db 16, api 10 |
| `pnpm run test:regression` | 51 |
| `pnpm run test:security` | 18 of 18 sub-gates, 637 tests |
| `pnpm run test:e2e` | 15 |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Carried forward

Unchanged: `INT-MAIL-01`; the Phase 05 subscription contract; the Phase 15
restaurant directory; the Phase 09/11/15 open-work providers; 17 P1
configuration items; 11 EXT gates seeded closed; `DSR-01` OPEN and contained
with its Phase 23 review; and `GATE-SEC` as a required GitHub status check,
which needs push authorisation and was not attempted.

New, and small: **scheduling the reset-intake drain and the handoff-discovery
reconciliation.** Both processors exist, are durable and are tested; neither has
a scheduled invoker yet. The drain's belongs with the email provider it would
deliver through, and the reconciliation's with the modules that own the work it
would enumerate — both of which are the phases already named above.

---

## Phase 04 remediation 3

The final bounded remediation, on top of `6c20d99`. Three defects, all in work
the previous two remediations introduced. Phase 04 stays `DONE` and
`AWAITING_CUSTOMER_ACCEPTANCE`; Phase 03 is untouched and Phase 05 has not
started.

Reproduced first, in `apps/api/src/modules/iam/iam.remediation3.test.ts`:
**11 of 12 failed** against `6c20d99`. The twelfth — two concurrent drains
sharing one intake — *passed* by luck, which is the defect: `SKIP LOCKED` made
the outcome a race rather than a rule, and only the leased claim below makes it
deterministic.

### R1-A — a derived idempotency key that did not fit

A client key may legally be 200 characters, which is also the column's limit.
The implementation appended `:discovery`, and later `:${kind}:${ref}`, so a
perfectly valid request produced an internal key the database refused. Because
that refusal surfaced inside a best-effort retry it was swallowed: the
suspension committed and its discovery stayed `PENDING` forever.

Every internal key is now derived through one helper. It digests
length-prefixed components with SHA-256 behind a versioned, human-readable
operation tag — fixed length, always inside 8–200, deterministic,
collision-resistant, and unambiguous, so `("ab","c")` and `("a","bc")` are
different keys. Nothing is truncated: trimming a caller's key to fit would make
two different requests collide, which is worse than the error it replaced.

### R1-B — a marker that outlived the state it described

A `PENDING` discovery marker survived reactivation, and reconciliation checked
neither membership state nor revision. A recovered provider could therefore hand
an **active employee's** shift to a replacement, and a later termination reused
the suspension's marker, reason and seed.

A marker now carries the `expected_state` and the `membership_revision` it was
raised against, paired by a CHECK to the reason it records. Reconciliation locks
the membership first and compares both; a mismatch supersedes the marker and
creates nothing. Reactivation supersedes its own pending marker in the same
transaction as the state change. The open-marker index is now partial on
`PENDING`, so a settled marker no longer blocks the next transition from raising
its own — a later termination gets a new marker with its own revision, reason
and seed. Markers are still append-only: superseding is a transition, and no
past security event is rewritten.

### R4 — a queue that was neither owned nor durable

Four defects in one path. `claimResetIntake` only held a row for the length of
the selecting transaction, which committed before any delivery, so two workers
could each believe they owned one entry. A provider failure was terminalised as
`PROCESSED/unavailable`, so nothing ever retried it. And delivery happened
inside the transaction that recorded the reset, so a provider that accepted a
link the transaction then failed to commit sent a link to nothing.

The claim is now a single `UPDATE` that writes a `claim_token` and a lease
expiry; every settlement is a compare-and-set on that token with its affected-row
count asserted, so a worker whose lease was reclaimed writes nothing — including
no second settlement audit. An expired lease is reclaimable. A provider or
infrastructure failure returns the entry to `PENDING` behind an exponential,
capped backoff; `ignored` and `throttled` stay terminal, because they are
decisions rather than outages. After a bounded number of attempts the entry
becomes an operator-visible `DEAD_LETTER`.

The reset and its delivery intent are committed **before** the provider is
contacted. The one-time secret is held under envelope encryption with its key
version and an AAD binding it to that row, column and id — under its own
`auth.delivery_secret` key scope — and destroyed once the provider has accepted
it. Every delivery carries a stable `delivery_id`; the port and its simulator
treat a repeat of that id as already sent, so a delivery whose acknowledgement
was lost is retried under the same identity and the recipient still sees one
message. The lease, retry, backoff and dead-letter numbers are provisional and
versioned with the rest of P1-06; none is a customer-approved value.

The Hotel-Admin-initiated reset now goes through the same queue, because two
delivery mechanisms would be two ways to hold a live link. Its attribution
travels on the intake, so the reset it produces still records who initiated it.

### Migration path

`0002_iam_rbac_staff.sql` corrected in place once more — Phase 04 is unaccepted
and undeployed, so the delta stays exactly one migration. `0000_baseline` and
`0001_kernel` are untouched and still checksum-pinned. The upgrade gate again
runs the frozen accepted Phase 03 state (0 → 2) plus only the Phase 04 migration
(2 → 3), a repeat that applies nothing, and fresh/upgrade schema equality.

### Test gates — Phase 04 remediation 3

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 114 of 114 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 386 indexed files, none reported |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1 246 across 11 projects |
| `pnpm run test:migrations` | 142 |
| `pnpm run test:integration` | 129 — db 41, outbox 5, api 83 |
| `pnpm run test:concurrency` | 26 — db 16, api 10 |
| `pnpm run test:regression` | 51 |
| `pnpm run test:security` | 18 of 18 sub-gates, 637 tests |
| `pnpm run test:e2e` | 15 |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Carried forward — unchanged

`INT-MAIL-01`; the Phase 05 subscription contract; the Phase 15 restaurant
directory; the Phase 09/11/15 open-work providers; 17 P1 configuration items,
now including the reset lease, retry and dead-letter numbers; 11 EXT gates
seeded closed; `DSR-01` OPEN and contained with its Phase 23 review; `GATE-SEC`
as a required GitHub status check, needing push authorisation and not attempted;
and the scheduled invokers for the reset drain and the discovery reconciliation,
which land with the phases that own what they call.

---

## Phase 04 remediation 4

The last bounded remediation, on top of `7acc36f`. Five defects, all in work the
previous remediations introduced. Phase 04 stays `DONE` and
`AWAITING_CUSTOMER_ACCEPTANCE`; Phase 03 is untouched and Phase 05 has not
started.

Reproduced first, in `apps/api/src/modules/iam/iam.remediation4.test.ts`:
**9 of 11 failed** against `7acc36f` (the two that passed are that file's
controls — a legitimate worker transition, and the plaintext-token sweep).

### F1 — a lock order that could deadlock, and a marker a termination reused

`listPending` took `FOR UPDATE` on the marker and *then* locked the membership;
a reactivation locks the membership and then settles the marker. Opposite
orders, so PostgreSQL resolved it by killing one with `40P01` — the suspension
path surfaced it as a `500`.

There is now one order everywhere: **membership first, marker second.** The
candidate read takes no lock at all, and each marker is re-read under its own
lock once the membership is held, then revalidated against marker state,
membership state and membership revision. Nothing relies on deadlock-victim
selection or a retry loop.

Separately, a direct `SUSPENDED → TERMINATED` reused the suspension's marker,
because the open-marker index made the insert a no-op. A transition now
supersedes whatever question the previous one left open and asks its own, so the
termination gets a marker with its own reason, revision and seed — two rows in
history, not one rewritten.

### F2 — a dead letter a runtime could reopen

`password_reset_intake_guard()` protected only `PROCESSED`. A `prsystem_api`
probe moved `DEAD_LETTER` back to `PENDING`. Both settled states are now
terminal, and the table gained a delete guard: the restricted runtime can
neither reopen, rewrite nor remove either. The owned `CLAIMED → PROCESSED` and
`CLAIMED → DEAD_LETTER` transitions are unaffected.

### F3 — an intake with no reset of its own

The intent was looked up account-wide, as "any undelivered reset". With two
entries for one address — a self-service request and a Hotel Admin sending the
link — the second adopted the first's delivery identity and attribution, and a
lease reclaimed after a lost settlement could mint a second link.

`password_reset_request` now carries a `NOT NULL intake_id` foreign key, with one
live intent per intake enforced by a partial unique index. Every lookup,
retry and reclaim resolves by intake; `initiated_by` and
`initiated_by_account_id` always come from that intake, and the guard refuses to
rebind an intent to another one.

### F4 — a lost acknowledgement modelled as a failure to send

The simulator could only fail *before* recording. It now has a mode that accepts
and records the delivery and then throws, which is the case a retrying sender
must survive. The first attempt is retryable; the retry recovers the same intent
by intake, carries the same delivery id, and the provider recognises it — so
provider attempts are two and visible messages are one, the intake settles
`sent`, and no second reset row or delivery id exists. The separate case where
delivery *and* `markResetDelivered` commit but settlement is lost now settles
from the delivered row without sending again, even once the resend interval has
passed.

### F5 — an expired intent that would still have been delivered

Reuse never checked `expires_at`. Expiry is now compared against the database
clock before the secret is decrypted and long before a provider is contacted. An
expired intent is terminalised with its sealed secret destroyed, and — if the
entry still has retry budget — replaced by a fresh intent bound to the same
intake and attribution; otherwise the entry is dead-lettered. The link that is
actually sent has a future expiry and completes the flow.

Four database rules back it: the encrypted components are complete
(`num_nonnulls … = ANY (ARRAY[0,3])`) and destroy-only — they cannot be
rewritten or attached to a row that never had them; a delivered or terminal row
may hold no secret at all; and `intake_id` is immutable. No plaintext token
reaches the database, the outbox, the audit stream or a response.

### Migration path

`0002_iam_rbac_staff.sql` corrected in place — Phase 04 is unaccepted and
undeployed, so the delta stays one migration. `0000_baseline` and `0001_kernel`
are untouched and still checksum-pinned; the upgrade gate again runs the frozen
accepted Phase 03 state (0 → 2) plus only the Phase 04 migration (2 → 3), a
repeat that applies nothing, and fresh/upgrade schema equality.

### Test gates — Phase 04 remediation 4

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 114 of 114 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 387 indexed files, none reported |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1 246 across 11 projects |
| `pnpm run test:migrations` | 142 |
| `pnpm run test:integration` | 140 — db 41, outbox 5, api 94 |
| `pnpm run test:concurrency` | 26 — db 16, api 10 |
| `pnpm run test:regression` | 51 |
| `pnpm run test:security` | 18 of 18 sub-gates, 637 tests |
| `pnpm run test:e2e` | 15 |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Carried forward — unchanged

`INT-MAIL-01`; the Phase 05 subscription contract; the Phase 15 restaurant
directory; the Phase 09/11/15 open-work providers; 17 P1 configuration items,
including the reset lease, retry and dead-letter numbers; 11 EXT gates seeded
closed; `DSR-01` OPEN and contained with its Phase 23 review; `GATE-SEC` as a
required GitHub status check, needing push authorisation and not attempted; and
the scheduled invokers for the reset drain and the discovery reconciliation.

---

## Phase 05 record

Hotel onboarding and subscription. Authorized, implemented and gated on top of
the accepted Phase 04 commit `e5fcf19`. Phase 05 is `DONE` and
`AWAITING_CUSTOMER_ACCEPTANCE`; Phase 06 is the current phase and has **not**
started.

**Decisions closed:** the 26 this phase owns — `ONB-DEC-001`…`008`,
`SUB-DEC-001`…`009`, `LIFE-DEC-001`…`007`, `OPS-DEC-006` and `OPS-DEC-007`. With
Phase 04's 26, 52 of the 279 canonical decisions are now `COVERED`.

### Scope completed

**Onboarding.** Citizen and organization applications with every required field
of doc 15 §2.1 and §2.2, validated server-side and refused as a shape rather than
patched. The owner's registration number is envelope-encrypted under its own key
scope, and exact lookup goes through a versioned, type- and country-namespaced
keyed HMAC — never the plaintext and never an unkeyed digest, because a
registration-number space is small enough to enumerate. One owner may hold many
hotels; each hotel gets its own tenant, payment and subscription. The canonical
application state machine of §7 is implemented exactly, in a database trigger as
well as in the service, so no path — including a direct statement — can produce a
transition the document does not list.

**The pre-tenant isolation model.** An application exists before any tenant does,
so it carries no `hotel_id` at all. There is no nullable tenant column, no
platform sentinel standing in for one, and no broad runtime grant. The isolation
is `app.onboarding_ref`, a transaction-local reference established only after the
applicant presents the bearer secret their own draft was minted with, plus an
explicit Operation-realm review policy. Unset, the reference is NULL and every
onboarding policy matches zero rows — the absence of a scope is nothing, not
everything. Classified `PRE_TENANT_ISOLATED`, and the classification checker
holds it to no tenant column, forced RLS, and policies actually being present.

**Pricing and payment.** The three monthly prices and the four terms, total =
monthly × months, discount structurally zero, VAT-inclusive with the tax taken
out of the price rather than added on top, and the provider fee recorded beside
the gross as the platform's cost. Every amount is integer MNT and the VAT split
is integer half-up arithmetic — no float and no numeric cast anywhere near
money. Price, tax-configuration, package-feature, term, currency, provider and
confirmation snapshots are immutable, enforced by a guard rather than by
convention. One active payment attempt per application and one live billing
intent per subscription, both by partial unique index. The first valid confirmed
payment wins under a row lock; every later or duplicate capture becomes a
reconciliation case. QPay and Khaan Bank share one provider-neutral model.

**Durable provisioning.** The payment success is made immutable first. Then one
logical job builds the tenant, the owner link, the subscription, the Primary
Hotel Admin membership and the default `Үндсэн касс` drawer in a single
transaction, through `platform.provision_paid_hotel`. No runtime holds INSERT on
any of those tables; the wrapper belongs to the established narrow, NOLOGIN
definer owner and re-derives the payment, the state, the terms and the owner from
the rows it locks. It is **not** exempt from row level security: it mints the
tenant id, binds the scope to it, and every row it writes has to satisfy the
ordinary tenant policy — which is what proves the graph it built belongs to the
hotel it created. `PROVISIONING_FAILED` is recorded in a transaction of its own,
outside the one that rolled back. Five automatic attempts, then
`ONBOARDING_PROVISION_RETRY`; a retry takes no parameters at all, so there is
nothing an operator could pass that would change the payment, the owner, the
package, the term, the amount, `starts_at` or `expires_at`.

**Activation.** A new Hotel Admin gets one single-use link, minted outside the
database, stored as a digest, sealed as ciphertext bound to its own row, and
delivered by a leased queue so an email outage costs a retry rather than a
rolled-back hotel. The account is created without a credential and cannot sign
in until the link is redeemed. A proved existing active account gets no link, no
token, no delivery row and no second account. Phase 04's account, credential,
membership, token, notification and session lifecycle is reused throughout;
there is no second password or session model.

**Subscription lifecycle.** The Phase 04 fail-closed port is replaced by a
database-backed `SubscriptionStatePort` that reads the authoritative row at
request time — never a projection — and still answers `undefined` for a hotel
that was never provisioned. `starts_at` is the confirmed payment instant; expiry
adds calendar months in `Asia/Ulaanbaatar` with end-of-month clamping that does
not carry forward. `ACTIVE`, `EXPIRING_SOON` at 168 hours, `GRACE` for 48,
`EXPIRED` after, and suspension above all of them. Renewal continues from the
existing expiry before expiry and inside grace, and restarts at confirmation
after it. Upgrade-only floor, service-month boundary, incremental second
upgrade, higher-package renewal, monotonic `billing_revision`, and a boundary
worker that takes the same lock and the same compare-and-set a callback takes.

**eBarimt and reconciliation.** One issuance intent per confirmed payment, a
typed port with a deterministic simulator, a leased retry queue, a manual
resolution queue, and `SUBSCRIPTION_EBARIMT_RETRY`. Receipt fields arrive from
the port together or not at all; the database refuses a partial set and refuses
to rewrite a complete one, and the retry API takes no receipt parameters — so
the flow doc 16 §4.1 forbids has no surface to happen through. Email goes out
only after the receipt officially exists. `PAID_REQUIRES_RECONCILIATION` is
closed by `SUBSCRIPTION_PAYMENT_RECONCILE` with an outcome, an account and a
reason, and there is no parameter for a package, a term, an entitlement,
`starts_at` or `expires_at`.

### Changed file groups

- **Migration:** `packages/db/migrations/0003_onboarding_subscription.sql`, plus
  the journal entry.
- **Schema contract:** `packages/db/src/schema.ts`,
  `packages/db/src/schema-snapshot.ts`, `packages/db/src/classification.ts`,
  `packages/db/src/classification-check.ts`,
  `packages/db/src/ownership-manifest.ts`,
  `packages/db/src/test-support/tenant-rows.ts`, and the new frozen Phase 04
  artefact under `packages/db/src/test-support/frozen-phase-04/`.
- **Kernel:** `packages/db/src/tenant-context.ts`,
  `packages/db/src/unit-of-work.ts` gained the pre-tenant scope axis.
- **Ports:** `packages/ports/src/key-management.port.ts` gained one key scope and
  three HMAC scopes.
- **Domain:** `apps/api/src/modules/onboarding/` — contracts, domain, repositories,
  services, HTTP and test support.
- **Wiring:** `apps/api/src/app.module.ts`, `apps/api/src/bootstrap.ts`,
  `apps/api/src/openapi.ts`, `apps/worker/src/queues.ts`.
- **Phase 04 suites re-pointed at the authoritative source:**
  `apps/api/src/modules/iam/test-support/iam-harness.ts` and the five suites that
  boot the real application, plus `packages/db/src/security/sec-scheduler.test.ts`
  and `packages/db/src/security/sec-partition.test.ts`.
- **Governance:** traceability, this document, assumptions and conflicts,
  external gates, the port catalog, module ownership, the runbook sub-gate
  catalogue, `tools/phase-03-battery.mjs`, `tools/governance-checks.mjs`,
  `tools/gate-sec-config.mjs` and the governance fixtures.

### Migrations

`0003_onboarding_subscription.sql`, forward-only. `0000_baseline`,
`0001_kernel` and `0002_iam_rbac_staff` are untouched and checksum-pinned, and a
new frozen Phase 04 artefact holds all three exactly as accepted at `e5fcf19`.
`GATE-MIGR` runs both upgrade paths — an accepted Phase 03 database reaching head
in two migrations, and an accepted Phase 04 database receiving exactly one — plus
a fresh install, a repeat that applies nothing, and fresh/upgrade schema
equality.

Sixteen tables: six pre-tenant (`subscription_owner`, `onboarding_application`,
`onboarding_phone_verification`, `onboarding_owner_proof`,
`onboarding_payment_attempt`, `onboarding_event`) and ten tenant-scoped
(`hotel_profile`, `hotel_owner_link`, `hotel_subscription`,
`subscription_billing_intent`, `subscription_payment`, `subscription_event`,
`ebarimt_issuance`, `cash_location`, `hotel_admin_activation`,
`activation_delivery`).

### Scope alignments applied

The three the authorization named, recorded in
[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.9: the phone-OTP
port moved forward with its own blocked control `INT-OTP-01` (CallPro is **not**
assumed to carry OTP), the hotel location persisted and validated as integer
micro-degrees with no `GeoPort` and no geocoding, and the cash-location root
introduced early for the default drawer with nothing of Phase 11 in it.

### What the gates caught

Four defects, all found by running the battery rather than by reading it.

**The onboarding module could not be constructed.** The subscription routes are
guarded by Phase 04's `SessionGuard`, and Nest instantiates a guard in the module
that hosts the controller — so `SessionService` had to be resolvable from
`OnboardingModule`, and it was not. Every suite that boots the real application
aborted the worker process rather than failing a test, because a Nest
initialization error calls `process.abort()`. `AppModule` now constructs the IAM
dynamic module once and imports the same object into both places, so the
container resolves one module, one pool and one `SessionService` — importing it
rather than rebuilding it, because a second `SessionService` would be exactly the
second session model this phase was told not to create.

**The Phase 04 application suites were still asserting the simulator.** They took
the port the running application holds and required it to be
`SimulatedSubscriptionState`; from this phase it is `DatabaseSubscriptionState`,
which is the point. They now assert the authoritative adapter, and the IAM
harness seeds a real `platform.hotel_subscription` row beside the simulator entry
so a seeded hotel is entitled for both the service-level and the HTTP-level
caller. That is the phase's "authoritative subscription state wired into Phase 04
IAM" evidence, proved by the accepted Phase 04 suites themselves rather than by a
new test written to agree with the change.

**A paid callback on a dead attempt tried a transition the database forbids.**
`ONB-DEC-008`'s two-provider race is order-dependent, and one order was wrong:
when the callback for a superseded attempt arrived *before* the winning one, the
service asked for `CANCELLED → PAID`, which the transition guard refused — the
guard was right and the service was wrong. A late success may resurrect only an
expired attempt (doc 15 §4.1); a capture on a cancelled or failed one is money
held against no live attempt, so it now becomes a reconciliation case in its own
right, reasoned `superseded_attempt_paid` rather than `application_already_paid`,
whether or not the application was ever paid. Covered deterministically as well
as by the race, so the case no longer depends on which callback wins.

**`SEC-PARTITION` held a dated literal.** It proved the worker cannot drop
`audit.platform_event_2026_08` — a month the bootstrap no longer creates, so
Postgres reported a missing table and the assertion had stopped testing the
privilege it names. The partition is now looked up from the catalogue, so the
check cannot expire again. `SEC-SCHEDULER`'s R9 catalogue also needed the three
Phase 05 boundary-worker readers entered with their invocation-time guards;
that gate exists precisely to refuse an uncatalogued definer, and it did.

### Test gates — Phase 05

| Command | Result |
| --- | --- |
| `node tools/validate-governance.mjs` | 15 of 15 |
| `node tools/validate-governance.fixtures.mjs` | 118 of 118 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | 12 of 12 |
| `node tools/scan-secrets.mjs` | 419 indexed files, 0 findings |
| `pnpm run format:check` | clean |
| `pnpm run lint` | 17 of 17 projects |
| `pnpm run typecheck` | 27 of 27 graphs |
| `pnpm run test:unit` | 1,294 across 11 projects |
| `pnpm run test:migrations` | 144: fresh, both upgrade paths, repeat and schema equality |
| `pnpm run test:integration` | 203: db 41, outbox 5, api 157 |
| `pnpm run test:concurrency` | 33: db 16, api 17 |
| `pnpm run test:regression` | 51, every reproduced Phase 03 defect |
| `pnpm run test:security` | 19 of 19 sub-gates |
| `pnpm run test:e2e` | 15 passed |
| `pnpm run build` | 17 of 17 projects |
| `pnpm run openapi` | document generated |
| `pnpm run compose:config` | valid |
| `pnpm run audit:prod` | no known vulnerabilities |
| `pnpm run audit:tree` | none at high or critical; one moderate, `DSR-01` |
| `git diff --check` | clean |

### Security and concurrency evidence

`SEC-ONBOARDING-ISOLATION` is the new nineteenth sub-gate: an applicant reaches
their own application and nobody else's; an anonymous statement reaches none;
an applicant cannot write into another's scope or read an owner profile they are
not linked to; the pre-tenant and tenant axes are disjoint in both directions;
the runtime holds no INSERT on anything provisioning creates; and no plaintext
registration number, one-time code or activation token reaches a row, an audit
record, an outbox payload or a response body. The applicant bearer token is the
one deliberate exception: it is returned once, in the creation response, and
is never persisted, logged, audited or placed in an outbox payload — only its
keyed digest is stored (wording corrected in remediation 1, R9).

Concurrency is proved with genuinely simultaneous calls on separate
connections: two identical callbacks make one paid transition; two providers
paying one application leave one subscription and one reconciliation case; two
provisioning runners create one hotel and one of everything under it; two
boundary sweeps apply one entitlement; a boundary sweep racing a second-upgrade
callback leaves one consistent state; a renewal and an upgrade quoted at once
leave at most one live intent; and two activation drains deliver one message.

### Remaining blockers

- **`EXT-03` (QPay), `EXT-04` (Khaan Bank), `EXT-11` (eBarimt)** — BLOCKED. Ports
  and deterministic simulators ship in this phase; the production adapters do not
  exist and the ports fail closed outside local, CI and test. Adapters are Phase
  20.
- **`INT-OTP-01`** — new, and blocked. No OTP provider is contracted; CallPro is
  an SMS send contract and not an OTP service.
- **`INT-MAIL-01`** — unchanged. Activation and receipt email both run on the
  Phase 04 notification port behind the same control.
- **The scheduled invokers** for the service-month boundary, the activation
  delivery drain and the eBarimt issuance queue. Phase 05 implements all three
  operations and registers their queue names; what invokes them on a cadence is
  assigned to a later phase, exactly as the Phase 04 reset drain and
  discovery reconciliation were.
- **17 P1 configuration items**, all open. Phase 05 adds no closure and stamps a
  `p1-provisional-tax-2026-08` tax-configuration version onto every quote and
  payment so P1-11's eventual answer is a new version rather than a silent
  reinterpretation of old rows.
- **`DSR-01`** — OPEN and contained, review in Phase 23.
- **Selecting `GATE-SEC` as a required GitHub status check** — still an external
  repository-settings action needing push authorisation, not attempted.

Phase 06 is the current phase and has **not** started. Beginning it requires a
further explicit authorization.

---

## Phase 05 remediation 1

Phase 05 was **not accepted**. One bounded remediation pass was performed on
top of `2ca6e26187ccf54f44be05d564e3b8d482758dc7`, the Phase 05 record's
final commit, against the ten blockers R1–R10 of the customer's review. Phase
05 stays `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`; Phase 06 has **not**
started. No acceptance is claimed by this record.

### Method

Every defect was reproduced before it was fixed. The regressions were written
first — `onboarding.remediation1.test.ts`, `subscription.remediation1.test.ts`
and `onboarding.authorization.http.test.ts` under `apps/api`, the worker
end-to-end suite `apps/worker/src/onboarding.e2e.test.ts` and its consumer
unit test, the BullMQ signal test, and the `packages/ports` conformance suite —
and run against `2ca6e26`: in `apps/api` 25 of 36 cases failed and 11 could
not run (the harness lacked the Operation actor, the worker runtime and the
application-state query; the schema lacked the claim columns); both worker
suites failed to load, because no `@prsystem/api/onboarding-worker` entry
existed; all 27 conformance cases failed, because no canonical contract
existed. The wiring defects were reproduced over real HTTP and the real worker
entry points rather than by direct service calls.

### What changed, by blocker

- **R1 — authorization.** Subscription status, renewal and upgrade resolve the
  live membership and the session's scope grant through the Phase 04 gate
  before the hotel is bound, then authorize the catalogued action
  `hotel.subscription.pay` against the locked subscription row. Manager,
  Reception, a suspended membership, a stale grant and a foreign or unknown
  hotel all receive the same `NOT_FOUND`, with no lock, provider invoice,
  billing intent or hotel-scoped audit side effect. The Hotel-session eBarimt
  queue route is gone; `/operation/ebarimt/manual-queue` and the retry,
  provisioning-retry and reconciliation routes are an Operation surface that
  requires the realm, an explicit named grant, a step-up inside its window and
  an audit record. Proved over HTTP with two hotels.
- **R2 — owners.** No `subscription_owner` row exists before payment: the
  runtime lost INSERT on the table and the applicant policy went with it. An
  existing owner is probed by identifier token and never mutated; the
  challenge goes to the **stored** verified contact, its plaintext is never
  returned and the new application's contact is never proof. Ownership is also
  proved by a signed-in account already linked to the owner. The
  existing-email path binds the application to the signed-in account with the
  proof method recorded, and the boundary revalidates realm, state, email and
  proof under the row lock. Offline verification is an Operation action
  mapped to `operation.subscription_contact_change_approve` with no HTTP route
  in this phase (assumptions §3.9 (4)).
- **R3 — the durable job.** A confirmed payment makes the application row
  itself due: claim token, lease, `provision_available_at` and attempt count
  live on it, discovered by a definer that hides exhausted rows. The worker
  deployment registers a BullMQ consumer per Phase 05 queue and a repeatable
  sweep; the callback's Redis message is a best-effort latency signal, and a
  signal that fails changes nothing. An expired lease is reclaimed, a crash
  while `PROVISIONING` is recovered, five persisted exponential attempts are
  followed only by the permissioned manual retry. Proved end to end from the
  provider callback over HTTP through the worker's own consumer to exactly one
  hotel, subscription, owner link, Primary membership, drawer and activation
  delivery.
- **R4 — one transaction.** Hotel, owner link, subscription, membership,
  activation, delivery intent, `onboarding.hotel.provisioned` outbox event and
  the `PROVISIONED` transition share one `xmin`. A failure after that commit
  — proved with a trap on the settlement write — never reports the hotel as
  failed, and a replay of a settled row creates nothing.
- **R5 — eBarimt.** Onboarding, renewal and upgrade payments each open exactly
  one issuance intent inside the payment's transaction; replays and duplicate
  callbacks add none. The worker's issuance consumer issues through the port
  and emails the receipt with its own `ebarimt_receipt` template. Manual
  retry accepts no receipt field and requires the Operation permission and a
  step-up.
- **R6 — idempotency.** The business key is claimed before the provider is
  called and the same key is the provider's idempotency key; a lost
  acknowledgement recovers the same invoice; a changed payload under the same
  key is refused; two simultaneous callers with one key create one invoice
  and one attempt or intent; the quoted snapshot is re-locked and compared
  before the intent is persisted, so a moved `billing_revision` refuses the
  quote; the previous usable intent is staled only when the replacement is
  durable.
- **R7 — pending upgrade.** Renewal at the pending target keeps the target and
  its `effective_at` while extending expiry; renewal directly above it is
  refused until the incremental upgrade is done; renewal never touches the
  paid pending upgrade.
- **R8 — activation.** The new account and its Primary membership stay
  `PENDING_ACTIVATION` / `PENDING` until the link is redeemed; a proved
  existing account is `ACTIVE` at once with no new credential token; redemption
  sets the credential, verifies the email, activates both rows, consumes the
  link and bumps the auth epoch in one transaction through a checked CAS on the
  revision the previous write returned. A trap rolls every write back and the
  link stays redeemable; two simultaneous redemptions activate once.
- **R9 — state and ledger.** `GET /onboarding/applications/state` returns the
  canonical state and minimal safe progress. Payment attempts, subscription
  payments and billing intents carry the provider fee and derive the net
  amount; nothing hard-codes a fee of zero. The security wording is
  corrected: the applicant bearer token is intentionally returned **once**, in
  the creation response, and is never persisted, logged, audited or placed in
  an outbox payload; only its keyed digest is stored.
- **R10 — governance.** EXT-03, EXT-04 and EXT-11 are recorded as port and
  simulator shipped only on the canonical contracts and the passing
  conformance suite. The phone-OTP early-port entry in the build plan matches
  the recorded §3.9 alignment. The programme's governed state moved out of the
  Phase 03 evidence owner into `tools/programme-state.mjs`; Phase 03 and 04
  evidence are byte-identical. This section's evidence is a machine-readable
  manifest, `phase-05-evidence.json`, validated by governance check 16.

### Migration path

`0004_onboarding_remediation.sql`, forward-only, on top of `0003`. `0000`–`0003`
are untouched and checksum-pinned. `GATE-MIGR` runs the fresh install, the two
upgrade paths (an accepted Phase 03 database and an accepted Phase 04 database
reaching head), a repeat that applies nothing, and fresh/upgrade schema
equality, with the declaration and snapshot aligned.

### Changed file groups

- **Ports:** `packages/ports/src/` — `port.ts`, `payment-gateway.port.ts`,
  `ebarimt.port.ts`, `phone-verification.port.ts`, `notification.port.ts`,
  `conformance.test.ts`; the `apps/api` contract files re-export them.
- **Database:** the migration and journal, `schema.ts`, `schema-snapshot.ts`,
  `ownership-manifest.ts`, `kernel/idempotency.ts`, `test-support/tenant-rows.ts`,
  the migration, regression and scheduler tests.
- **API:** `modules/onboarding/` services, repositories, controllers
  (`operation.controller.ts` new), contracts (`provisioning-signal.ts`,
  `bullmq-provisioning-signal.ts` new), `worker/onboarding-worker.ts` new, the
  test harness and the suites; `modules/iam` account repository and context;
  `bootstrap.ts`, `openapi.ts`, the package's `exports`.
- **Worker:** `jobs/onboarding.ts`, `main.ts`, `queues.ts` and the suites.
- **Authorization and configuration:** `packages/authz` account states,
  `packages/config` `QUEUE_PREFIX`, `.env.example`.
- **Dependencies:** `fastify` 5.11.3 → 5.12.1 in `apps/api` and as a workspace
  override (`@nestjs/platform-fastify` 11.2.3 pins the older patch), closing
  GHSA-w2qp-rph6-63g4 and GHSA-3m5p-2c4r-xxw2 — two moderate advisories
  published after the Phase 05 battery that `audit:prod` refused on this
  tree. A compatible stable upgrade, so no register entry (CLAUDE.md §1).
- **Governance:** `tools/programme-state.mjs` new, `tools/phase-03-battery.mjs`,
  `tools/governance-checks.mjs`, `tools/validate-governance*.mjs`, this document,
  the traceability, gate, plan, assumptions and port-catalog documents.

### DEC coverage

No status changes: the 26 Phase 05 decisions stay `COVERED`, with their code and
test columns extended to the canonical ports, migration `0004`, the worker
consumers and the remediation, HTTP-authorization and end-to-end suites. No
decision was marked `COVERED` without production wiring and a regression.

### Remaining blockers

- `EXT-03`, `EXT-04`, `EXT-11` — BLOCKED; canonical ports and simulators,
  conformance-gated; production adapters are Phase 20.
- `INT-OTP-01`, `INT-MAIL-01` — unchanged.
- The offline ownership-verification HTTP surface — Phase 19; the production
  action is not reachable and is not claimed to be.
- 17 P1 items, `DSR-01`, and the `GATE-SEC` required-check selection — unchanged.

### Evidence — historical measurement

Historical: the remediation 1 battery as measured on the tree of
`fee4e3f5041c56b4be5cce610dd22289fce2ad99`, the six remediation-1 commits. It
is superseded as the governed Phase 05 evidence by remediation 2 below and is
kept here unchanged as the record of what was measured then. Every command
exited 0.

| Command | Status | Result |
| --- | --- | --- |
| `node tools/validate-governance.mjs` | PASS | 16 of 16 |
| `node tools/validate-governance.fixtures.mjs` | PASS | 132 of 132 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | PASS | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | PASS | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | PASS | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | PASS | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | PASS | 12 of 12 |
| `node tools/scan-secrets.mjs` | PASS | 439 indexed files, 0 findings |
| `pnpm run format:check` | PASS | clean |
| `pnpm run lint` | PASS | 17 of 17 projects |
| `pnpm run typecheck` | PASS | 28 of 28 graphs |
| `pnpm run test:unit` | PASS | 1,324 across 11 projects |
| `pnpm run test:migrations` | PASS | 144: fresh, both upgrade paths, repeat and schema equality |
| `pnpm run test:integration` | PASS | 244: db 41, outbox 5, api 196, worker 2 |
| `pnpm run test:concurrency` | PASS | 35 each run: db 16, api 19 |
| `pnpm run test:regression` | PASS | 51, every reproduced Phase 03 defect |
| `pnpm run test:security` | PASS | 19 of 19 sub-gates, 841, each run |
| `pnpm run test:e2e` | PASS | 15 passed |
| `pnpm run audit:prod` | PASS | no known vulnerabilities |
| `pnpm run audit:tree` | PASS | none at high or critical; one moderate, DSR-01 |
| `pnpm run build` | PASS | 17 of 17 projects |
| `pnpm run openapi` | PASS | document generated |
| `pnpm run compose:config` | PASS | valid |
| `git diff --check` | PASS | clean |

Phase 05 remained `AWAITING_CUSTOMER_ACCEPTANCE` at the end of remediation 1.

---

## Phase 05 remediation 2

Phase 05 is still **not accepted**. A second bounded pass — the correctness
closure — was performed on top of `2c2bed064a7fb6899a0fa01aa096f2740ae45e4b`,
the remediation 1 evidence commit, against the seven findings of the customer's
review. Phase 05 stays `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`; Phase 06 has
**not** started. No acceptance is claimed by this record.

### Method

Every finding was reproduced before it was fixed. The regressions —
`onboarding.remediation2.test.ts` under `apps/api` (twenty cases, findings 1 to
6), two consumer-startup cases in `apps/worker/src/jobs/onboarding.test.ts`
(finding 3) and three conformance cases in `packages/ports/src/conformance.test.ts`
(finding 7) — were run against `2c2bed0` first: all twenty API cases failed,
the three conformance cases failed and the two worker cases failed. Each
failure was checked to be the defect and not the test: a replay refused with
CONFLICT and with the "only ever raised" rule, a stale-quote refusal that the
retry re-executed, the intent lock held while waiting on the subscription
(SQLSTATE 55P03), a pending proof with no delivered challenge, an expiry and a
refusal audit rolled back with their errors, a boundary with no claim
parameter, a claim taken before its backoff, a fifth-attempt crash left
PROVISIONING for ever, a failed receipt mail never retried, an audited
Operation decision with no effect, and a fabricated zero fee. Two cases needed
a test-side correction before they reproduced the defect and not a fixture
mistake: the Primary Admin row is guarded against a direct suspension, so
revocation is the membership-revision bump every real revocation performs; and
the claim-time owner probe cannot be made to miss deterministically, so the
boundary's own P0501 refusal is reproduced by a trap on the hotel insert that
raises it, with the colliding owner really present. One finding did not
reproduce as a test on the base because the code it names did not exist — the
worker's consumer startup had no function to call — so its reproduction is the
control flow: `main.ts` registered the sweeps after `startWorker` returned,
with no failure path between.

### What changed, by finding

- **1 — invoices and quotes.** The idempotency claim is consulted before
  eligibility, after authorization: a completed onboarding invoice or upgrade
  quote replays after payment. A quote or invoice is **prepared** on its row
  before the provider is called, with the complete priced snapshot
  (`quoted_snapshot`) and no invoice, and a retry under the same key recovers
  that row at that price; finalization compares the stored snapshot with the
  row as it is now, and a stale quote is **abandoned** with the provider's
  invoice recorded on it, the refusal stored against the key, both committed,
  and only then thrown. The payment callback takes the subscription row before
  the intent, the order the finalization uses; the onboarding callback takes
  the application before the attempt. A deterministic regression holds the
  subscription row from outside and proves the callback waits without holding
  the intent.
- **2 — ownership proofs.** A pending proof that was never challenged, or whose
  challenge expired, is settled and a fresh challenge is opened; a collision
  found inside provisioning binds the owner the identifier names, found by the
  probe; the challenge always goes to that owner's stored verified contact; the
  passed proof releases the application to provisioning on its original
  payment. Expiry and refusal transitions commit before their errors are
  thrown.
- **3 — provisioning.** `provision_paid_hotel` takes the claim token and refuses
  unless the row is claimed by exactly that token with an unexpired lease; a
  stale worker cannot build and cannot settle the replacement's claim. A claim
  that is not the operator's is refused as `deferred` until the persisted
  backoff has elapsed, for a signal exactly as for the sweep. The sweep
  discovers a PROVISIONING row whose lease expired at the attempt cap and
  settles it as exhausted without a sixth attempt. The worker opens its
  consumers and registers its sweeps through one function that closes every
  consumer it opened, and the runtime, when any step fails.
- **4 — receipts.** Delivery is its own job on the issuance row: attempts,
  availability, claim and lease. A crash after the issuance commit, a
  notification outage and a lost acknowledgement are all recovered by the
  drain under the stable delivery id `ebarimt-<issuanceId>`; the receipt is
  never reissued to resend the mail.
- **5 — authorization.** The quote's final mutation re-runs the scope gate and
  the catalogued permission against the row as it is now; a principal revoked
  during the provider call is refused, the prepared quote is abandoned with the
  provider's invoice, and the existing live intent is untouched. Reconciliation
  closure and the eBarimt retry authorize and mutate in one Operation-realm
  transaction, under a realm policy the two tables now carry.
- **6 — fee facts.** A fee the provider did not state is NULL on the attempt,
  the intent and the payment, and no net amount is derived from it; a stated
  zero is zero. The simulator no longer invents a zero.
- **7 — simulators.** A malformed callback amount is a typed `MISMATCH`, never a
  throw; the eBarimt simulator refuses the same key with a different buyer,
  buyer type, VAT amount or VAT rate.

### Migration path

`0005_onboarding_remediation2.sql`, forward-only, on top of `0004`.
`0000`–`0004` are untouched and checksum-pinned. `GATE-MIGR` runs the fresh
install, both upgrade paths (an accepted Phase 03 database and an accepted
Phase 04 database reaching head, the latter through three Phase 05
migrations), a repeat that applies nothing, and fresh/upgrade schema equality,
with the declaration and snapshot aligned.

### Changed file groups

- **Database:** the migration and journal, `schema.ts`, `schema-snapshot.ts`,
  `ownership-manifest.ts`, `test-support/tenant-rows.ts`, the migration,
  regression and scheduler tests.
- **API:** `modules/onboarding/` — the onboarding, subscription, provisioning
  and eBarimt services; the two repositories; the new remediation-2 suite; the
  suites whose assertions the prepared-row and fee contracts changed; the
  harness (worker-login pool exposed for boundary probes); the package's test
  scripts.
- **Worker:** `jobs/onboarding.ts` (`startOnboardingConsumers`), `main.ts`, the
  jobs suite.
- **Ports:** `payment-gateway.port.ts`, `ebarimt.port.ts`, the conformance suite.
- **Governance:** `tools/programme-state.mjs` (the governed Phase 05 evidence is
  now remediation 2), this document, traceability, assumptions, the port
  catalog, the manifest.

### DEC coverage

No status changes: the 26 Phase 05 decisions stay `COVERED`; the code and test
columns of `ONB-DEC-006`, `ONB-DEC-007`, `ONB-DEC-008`, `SUB-DEC-004`,
`SUB-DEC-005`, `SUB-DEC-007`, `SUB-DEC-008`, `LIFE-DEC-006`, `LIFE-DEC-007`
and `OPS-DEC-007` gain migration `0005` and the remediation-2 suite.

### Remaining blockers

- `EXT-03`, `EXT-04`, `EXT-11` — BLOCKED; canonical ports and simulators,
  conformance-gated; production adapters are Phase 20.
- `INT-OTP-01`, `INT-MAIL-01` — unchanged.
- The offline ownership-verification HTTP surface — Phase 19; not reachable and
  not claimed.
- 17 P1 items, `DSR-01`, and the `GATE-SEC` required-check selection — unchanged.

### Evidence — historical measurement

Historical: the remediation 2 battery as measured on the tree of
`15cb672627541cd0d57c76b17844725518f14e1e`, the four remediation-2 commits. It
is superseded as the governed Phase 05 evidence by remediation 3 below and is
kept here unchanged. Every command exited 0.

| Command | Status | Result |
| --- | --- | --- |
| `node tools/validate-governance.mjs` | PASS | 16 of 16 |
| `node tools/validate-governance.fixtures.mjs` | PASS | 132 of 132 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | PASS | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | PASS | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | PASS | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | PASS | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | PASS | 12 of 12 |
| `node tools/scan-secrets.mjs` | PASS | 442 indexed files, 0 findings |
| `pnpm run format:check` | PASS | clean |
| `pnpm run lint` | PASS | 17 of 17 projects |
| `pnpm run typecheck` | PASS | 28 of 28 graphs |
| `pnpm run test:unit` | PASS | 1,329 across 11 projects |
| `pnpm run test:migrations` | PASS | 144: fresh, both upgrade paths, repeat and schema equality |
| `pnpm run test:integration` | PASS | 264: db 41, outbox 5, api 216, worker 2 |
| `pnpm run test:concurrency` | PASS | 35 each run: db 16, api 19 |
| `pnpm run test:regression` | PASS | 51, every reproduced Phase 03 defect |
| `pnpm run test:security` | PASS | 19 of 19 sub-gates, 841, each run |
| `pnpm run test:e2e` | PASS | 15 passed |
| `pnpm run audit:prod` | PASS | no known vulnerabilities |
| `pnpm run audit:tree` | PASS | none at high or critical; one moderate, DSR-01 |
| `pnpm run build` | PASS | 17 of 17 projects |
| `pnpm run openapi` | PASS | document generated |
| `pnpm run compose:config` | PASS | valid |
| `git diff --check` | PASS | clean |

Phase 05 remained `AWAITING_CUSTOMER_ACCEPTANCE` at the end of remediation 2.

---

## Phase 05 remediation 3

Phase 05 is still **not accepted**. A third, closeout pass was performed on top
of `68be0fa0ec6e6eb520777c49ffa7411667d60c21`, the remediation 2 evidence
commit, against the four findings of the customer's review. Phase 05 stays
`DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`; Phase 06 has **not** started. No
acceptance is claimed by this record.

### Method

Each finding was reproduced on the base before it was fixed, in
`onboarding.remediation2.test.ts` under `apps/api`. Finding 1 reproduced on
both paths exactly as described: after a provider `REJECTED`, abandoning the
prepared row with no invoice violated `0005`'s invoice-once-live check
(SQLSTATE 23514), the stored refusal rolled back with it, the caller saw the
constraint error, and a retry called the provider again. Finding 2 reproduced:
the payments reader threw "Cannot convert null to a BigInt" on a payment whose
fee the provider had not stated. Finding 3's corrected fixture reaches the SQL
boundary and passed on the base unchanged — the recovery logic remediation 2
shipped was correct; the earlier fixture had let the claim-time probe answer
first — so no business logic was changed for it. Finding 4 is evidence, not
code.

### What changed, by finding

- **1 — provider refusal persistence.** `0006_onboarding_remediation3` adds a
  terminal `REFUSED` state to billing intents and payment attempts: reached
  only from `PREPARING`, it is the one state besides `PREPARING` that may hold
  no provider invoice, and it must hold none; every live, paid, stale,
  abandoned or reconciled row still requires its invoice. Both services now
  record a `REJECTED` or `MISMATCH` answer as `REFUSED` in the transaction that
  stores the refusal against the key. A same-key retry replays the refusal with
  no provider call and no second row; a fresh key opens a live invoice.
- **2 — nullable payment reader.** `SubscriptionRepository.payments()` types
  the fee and the net amount as nullable and maps NULL through. Proved on a
  real onboarding payment with no stated fee, and with zero and nonzero
  controls read through the same reader.
- **3 — boundary-collision regression.** The colliding owner now appears inside
  the transaction that claims the row — an AFTER INSERT trigger on the claim's
  own `provisioning_started` event, running as the database owner, inserts an
  owner carrying the application's identifier and its own stored contact — so
  the claim-time probe has already answered "nobody" when the boundary meets
  the collision. The test asserts the boundary's refusal (the
  `PROVISIONING → PROVISIONING_FAILED` event with reason
  `existing_owner_detected`, the recorded error, and no owner link), then the
  binding to that owner, the challenge delivered to its stored contact and not
  the application's phone, the passed proof, and provisioning on the original
  attempt with the hotel linked to that owner and exactly one owner for the
  identifier.
- **4 — CI evidence.** The ledger is a persisted artifact of its own,
  [phase-05-ci-ledger.md](phase-05-ci-ledger.md); it is not reproduced here. It
  follows the workflow's 41 run steps one by one, with the compose and gate-sec
  jobs each on a disposable Compose project — a unique project name, free ports
  and fresh volumes — so every cleanup step runs, against those projects only.
  It was executed at the accepted commit `35314ba`, and it records what it does
  not prove: all five jobs ran in **one** clone and shared one install and one
  Turborepo cache, so it is not five independently pristine workspaces. Its two
  deviations from the workflow — the gate-sec port-conflict retry and the
  `REDIS_URL_TEST` override on the six database-backed steps — are recorded
  there per step.

### Migration path

`0006_onboarding_remediation3.sql`, forward-only, on top of `0005`.
`0000`–`0005` are untouched and checksum-pinned. `GATE-MIGR` runs the fresh
install, both upgrade paths (four Phase 05 migrations on an accepted Phase 04
database), a repeat that applies nothing, and fresh/upgrade schema equality.

### Changed file groups

- **Database:** the migration and journal, `schema.ts`, `schema-snapshot.ts`,
  the migration and regression tests.
- **API:** the two repositories (`refuseAttempt`, `refuseIntent`, the nullable
  reader), the refusal branches of the onboarding and subscription services,
  the remediation suite.
- **Governance:** `tools/programme-state.mjs` (the governed Phase 05 evidence is
  now remediation 3), this document, traceability, assumptions, the manifest.

### DEC coverage

No status changes. `ONB-DEC-008`, `SUB-DEC-004`, `SUB-DEC-007` and
`LIFE-DEC-006` gain migration `0006` in their evidence columns.

### Remaining blockers

Unchanged from remediation 2: `EXT-03`, `EXT-04`, `EXT-11` BLOCKED with
conformance-gated simulators; `INT-OTP-01`, `INT-MAIL-01`; the Phase 19 offline
verification surface; 17 P1 items; `DSR-01`; the `GATE-SEC` required-check
selection.

### Evidence

<!-- phase-05-evidence:begin -->

Measured at implementation commit 0c67eca1fc687b443199d3ff11114d68285d9f60, the tree of the
remediation-3 commits. The record itself — the manifest and this table — is
the commit after it; the governance validator and its fixtures were run again
on that final tree and are what the two governance rows report. Every command
exited 0. This is the fresh run; the remediation-1 and remediation-2 tables
above are historical.

| Command | Status | Result |
| --- | --- | --- |
| `node tools/validate-governance.mjs` | PASS | 16 of 16 |
| `node tools/validate-governance.fixtures.mjs` | PASS | 132 of 132 drift fixtures caught |
| `node tools/validate-secret-scan.fixtures.mjs` | PASS | 72 of 72 correct |
| `node tools/validate-workspace.mjs` | PASS | 15 of 15 |
| `node tools/validate-regression-coverage.mjs` | PASS | 724 of 724 |
| `node tools/validate-regression-coverage.fixtures.mjs` | PASS | 76 of 76 bypasses caught |
| `node tools/validate-pool-error-fixture.mjs` | PASS | 12 of 12 |
| `node tools/scan-secrets.mjs` | PASS | 443 indexed files, 0 findings |
| `pnpm run format:check` | PASS | clean |
| `pnpm run lint` | PASS | 17 of 17 projects |
| `pnpm run typecheck` | PASS | 28 of 28 graphs |
| `pnpm run test:unit` | PASS | 1,329 across 11 projects |
| `pnpm run test:migrations` | PASS | 144: fresh, both upgrade paths, repeat and schema equality |
| `pnpm run test:integration` | PASS | 267: db 41, outbox 5, api 219, worker 2 |
| `pnpm run test:concurrency` | PASS | 35 each run: db 16, api 19 |
| `pnpm run test:regression` | PASS | 51, every reproduced Phase 03 defect |
| `pnpm run test:security` | PASS | 19 of 19 sub-gates, 841, each run |
| `pnpm run test:e2e` | PASS | 15 passed |
| `pnpm run audit:prod` | PASS | no known vulnerabilities |
| `pnpm run audit:tree` | PASS | none at high or critical; one moderate, DSR-01 |
| `pnpm run build` | PASS | 17 of 17 projects |
| `pnpm run openapi` | PASS | document generated |
| `pnpm run compose:config` | PASS | valid |
| `git diff --check` | PASS | clean |

<!-- phase-05-evidence:end -->

Phase 05 was `AWAITING_CUSTOMER_ACCEPTANCE` at the end of remediation 3 and has
since been accepted at this record's own commit; see
[Phase 05 acceptance](#phase-05-acceptance). Phase 06 has **not** started and
requires a further explicit authorization.
