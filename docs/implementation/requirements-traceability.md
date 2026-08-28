# PRsystem — Requirements Traceability

**Version:** 1.9 (Phase 03 sixth security repair — credential-bound D-09, exact ownership, full typecheck)
**Total canonical decisions:** 279 across 22 families.
**Phase namespace:** 01–23 as fixed in [build-plan.md](build-plan.md) §3.

Every decision is assigned to **exactly one** owning phase. Where a later phase consumes a decision,
that consumption is expressed as a sequencing constraint in [build-plan.md](build-plan.md) §6, not as
a second owner.

Status legend: `PENDING` (not implemented) · `PARTIAL` · `COVERED` (implemented and gated) ·
`DEFERRED` (explicitly out of MVP, reason recorded).

`Code` and `Tests` evidence is appended by the owning phase. At Phase 00 every row is `PENDING`.

---

## 0. Source document coverage

All 27 immutable requirement documents were read in full during Phase 00 (10 212 lines). Seven files
exceeded the single-read cap and were read across multiple paginated reads: `02`, `05`, `09`, `13`,
`18`, `22`, `26`.

| # | Source document | Decision family | Owning phases |
| --- | --- | --- | --- |
| 00 | [00-mvp-open-decisions.md](../00-mvp-open-decisions.md) | precedence root, EXT + P1 registers | 01, 20, 23 |
| 01 | [01-project-charter.md](../01-project-charter.md) | none (charter) | 01 |
| 02 | [02-reception-system-scope.md](../02-reception-system-scope.md) | `RC-DEC` | 06–11, 13, 15, 17, 18 |
| 03 | [03-reception-shift-handover.md](../03-reception-shift-handover.md) | `SHIFT-DEC` | 11 |
| 04 | [04-cleaner-dashboard.md](../04-cleaner-dashboard.md) | none (resolves to `CHK`/`INV`/`RML`) | 09 |
| 05 | [05-room-stay-and-time-status.md](../05-room-stay-and-time-status.md) | `STAY-DEC` | 06, 08 |
| 06 | [06-room-status-model.md](../06-room-status-model.md) | none (resolves to `STAY`/`RML`) | 08 |
| 07 | [07-manager-room-minibar.md](../07-manager-room-minibar.md) | none (resolves to `INV`/`RML`/`STAY`) | 06, 07 |
| 08 | [08-restaurant-ordering.md](../08-restaurant-ordering.md) | `REST-DEC` | 15 |
| 09 | [09-online-booking-system.md](../09-online-booking-system.md) | `BK-DEC` | 12, 13, 14, 16 |
| 10 | [10-hotel-ratings-reviews.md](../10-hotel-ratings-reviews.md) | `RV-DEC` | 16 |
| 11 | [11-booking-payment-policy.md](../11-booking-payment-policy.md) | `PAY-DEC` | 13, 14 |
| 12 | [12-hotel-guest-registry-report.md](../12-hotel-guest-registry-report.md) | `GUEST-DEC` | 17 |
| 13 | [13-police-monitoring-system.md](../13-police-monitoring-system.md) | `POL-DEC` | 18 |
| 14 | [14-operation-dashboard.md](../14-operation-dashboard.md) | `OPS-DEC` | 05, 19 |
| 15 | [15-hotel-onboarding-account-activation.md](../15-hotel-onboarding-account-activation.md) | `ONB-DEC` | 05 |
| 16 | [16-subscription-pricing-and-payment.md](../16-subscription-pricing-and-payment.md) | `SUB-DEC` | 05 |
| 17 | [17-subscription-lifecycle.md](../17-subscription-lifecycle.md) | `LIFE-DEC` | 05 |
| 18 | [18-action-level-permission-matrix.md](../18-action-level-permission-matrix.md) | `RBAC-DEC` | 04 |
| 19 | [19-staff-account-lifecycle.md](../19-staff-account-lifecycle.md) | `STAFF-DEC` | 04 |
| 20 | [20-deposit-and-payment-correction.md](../20-deposit-and-payment-correction.md) | `DEP-DEC` | 10 |
| 21 | [21-cleaner-checkout-exception-and-dispute.md](../21-cleaner-checkout-exception-and-dispute.md) | `CHK-DEC` | 09 |
| 22 | [22-minibar-stock-inventory.md](../22-minibar-stock-inventory.md) | `INV-DEC` | 07 |
| 23 | [23-admin-financial-reporting.md](../23-admin-financial-reporting.md) | `FIN-DEC` | 11, 17 |
| 24 | [24-cash-drawer-ledger.md](../24-cash-drawer-ledger.md) | `CASH-DEC` | 11 |
| 25 | [25-minibar-selling-price-snapshot.md](../25-minibar-selling-price-snapshot.md) | `PRICE-DEC` | 08, 09 |
| 26 | [26-room-minibar-lifecycle.md](../26-room-minibar-lifecycle.md) | `RML-DEC` | 06, 07 |

Documents 01, 04, 06 and 07 carry no own decision prefix. They are normative descriptive documents
whose rules resolve into the families above and are read by the phases listed.

---

## 1. Family index

| Family | Source doc | IDs | Count | Owning phases |
| --- | --- | --- | ---: | --- |
| `RC-DEC` | 02 | 001–044 | 44 | 06, 07, 08, 09, 10, 11, 13, 15, 17, 18 |
| `SHIFT-DEC` | 03 | 001–007 | 7 | 11 |
| `STAY-DEC` | 05 | 001–014 | 14 | 06, 08 |
| `REST-DEC` | 08 | 001–006 | 6 | 15 |
| `BK-DEC` | 09 | 001–014 | 14 | 12, 13, 14, 16 |
| `RV-DEC` | 10 | 001–007 | 7 | 16 |
| `PAY-DEC` | 11 | 001–009 | 9 | 13, 14 |
| `GUEST-DEC` | 12 | 001–008 | 8 | 17 |
| `POL-DEC` | 13 | 001–022 | 22 | 18 |
| `OPS-DEC` | 14 | 001–018 | 18 | 05, 19 |
| `ONB-DEC` | 15 | 001–008 | 8 | 05 |
| `SUB-DEC` | 16 | 001–009 | 9 | 05 |
| `LIFE-DEC` | 17 | 001–007 | 7 | 05 |
| `RBAC-DEC` | 18 | 001–017 | 17 | 04 |
| `STAFF-DEC` | 19 | 001–009 | 9 | 04 |
| `DEP-DEC` | 20 | 001–010 | 10 | 10 |
| `CHK-DEC` | 21 | 001–006 | 6 | 09 |
| `INV-DEC` | 22 | 001–008 | 8 | 07 |
| `FIN-DEC` | 23 | 001–010 | 10 | 11, 17 |
| `CASH-DEC` | 24 | 001–010 | 10 | 11 |
| `PRICE-DEC` | 25 | 001–008 | 8 | 08, 09 |
| `RML-DEC` | 26 | 001–028 | 28 | 06, 07 |

---

## 2. Phase load

| Phase | Title | DECs |
| --- | --- | ---: |
| 01 | Architecture and threat model | 0 |
| 02 | Monorepo scaffold | 0 |
| 03 | Platform kernel | 0 |
| 04 | IAM, tenancy, RBAC, and staff lifecycle | 26 |
| 05 | Hotel onboarding and subscription | 26 |
| 06 | Hotel, room, category, and tariffs | 11 |
| 07 | Minibar inventory and templates | 36 |
| 08 | Availability, guest identity, reception, and stay | 19 |
| 09 | Cleaner and checkout coordination | 18 |
| 10 | Folio, deposit, payment, and correction | 15 |
| 11 | Shift, cash drawer, expense, and hotel finance | 20 |
| 12 | Public discovery and Guest authentication | 2 |
| 13 | Online booking and inventory hold | 7 |
| 14 | Online payment, refund, commission, and settlement | 11 |
| 15 | Restaurant | 19 |
| 16 | Verified reviews | 11 |
| 17 | Guest registry, exports, and Hotel Admin reports | 19 |
| 18 | Police monitoring | 23 |
| 19 | Platform Operation | 16 |
| 20 | External adapters | 0 |
| 21 | Responsive UI and accessibility | 0 |
| 22 | Security, concurrency, recovery, and full E2E | 0 |
| 23 | Release candidate audit | 0 |
| — | **Total** | **279** |

### 2.1 Phases owning zero decisions

Phases 01, 02, 03, 20, 21, 22 and 23 own no DEC ID. They are not exempt from traceability — each one
carries infrastructure or verification obligations that later DEC coverage depends on, so the
artefacts below are the traceable output.

| Phase | Obligation | Artefact | Gate |
| --- | --- | --- | --- |
| 02 | Strict TypeScript workspace with pinned dependencies | `tsconfig.base.json`, `pnpm-lock.yaml` | `validate-workspace` 5, 6, 9 |
| 02 | Module-boundary enforcement (CLAUDE.md §3, [ADR-0013](../architecture/adr/ADR-0013-module-boundary-enforcement.md)) | `eslint.config.mjs`, `tools/lint-fixtures/` | `packages/testing/src/eslint-boundary.test.ts` |
| 02 | Versioned migration runner, business-table-free baseline ([ADR-0004](../architecture/adr/ADR-0004-versioned-migrations-only.md)) | `packages/db/` | `pnpm run test:migrations` |
| 02 | Fail-closed validated configuration, no secret in an error | `packages/config/` | `pnpm run test:unit` |
| 02 | Log redaction by field name and value shape (CLAUDE.md §8) | `packages/telemetry/` | `pnpm run test:unit` |
| 02 | Synthetic-identity-only test data (CLAUDE.md §8) | `packages/testing/` | `pnpm run test:unit` |
| 02 | Seven deployable applications and the E2E harness | `apps/`, `e2e/` | `pnpm run build`, `pnpm run test:e2e` |
| 02 | Production dependency tree clean at moderate and above; dev-only tooling contained ([DSR-01](dependency-security-register.md)) | `package.json`, `.github/workflows/ci.yml` | `pnpm run audit:prod`, `validate-workspace` 12–15 |
| 20 | Re-review `DSR-01` when external adapters are wired | [dependency-security-register.md](dependency-security-register.md) | `pnpm run audit:prod` |
| 22 | Re-review `DSR-01` in the security pass; close it if a compatible stable Drizzle Kit has landed | [dependency-security-register.md](dependency-security-register.md) | `pnpm run audit:prod`, `pnpm run audit:tree` |

| 03 | Cluster role bootstrap separated from application migrations; restricted migration principal ([runbook](database-bootstrap-runbook.md)) | `packages/db/bootstrap/`, `packages/db/src/bootstrap.ts`, `packages/db/src/principal-guard.ts` | `GATE-SEC` / `SEC-ROLE` |
| 03 | Tenant isolation: forced RLS, eleven group roles and seven canonical login principals, transaction-scoped server-derived context ([ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md)) | `packages/db/migrations/0001_kernel.sql`, `packages/db/src/unit-of-work.ts` | `GATE-SEC` / `SEC-RLS`, `pnpm run test:concurrency` |
| 03 | Machine-checked database classification: GLOBAL / TENANT_RLS / PLATFORM_AUDIT / POLICE_ISOLATED | `packages/db/src/classification.ts`, `classification-check.ts` | `GATE-SEC` / `SEC-RLS` |
| 03 | Append-only monthly-partitioned audit; runtimes append through a SECURITY DEFINER wrapper and hold no table privilege ([ADR-0018](../architecture/adr/ADR-0018-audit-partitioning.md)) | `audit.append_platform_audit_event`, `police_audit.append_police_security_event` | `GATE-SEC` / `SEC-AUDIT` |
| 03 | Partition renewal without DDL rights; allow-listed, bounded, advisory-locked | `platform.ensure_month_partitions` | `GATE-SEC` / `SEC-PARTITION` |
| 03 | Police realm reachable by no principal that also reaches Hotel data | `police`, `police_audit` schemas and grants | `GATE-SEC` / `SEC-POLICE-ISOLATION` |
| 03 | EXT-01…EXT-11 seeded to the canonical mapping in [docs/00](../00-mvp-open-decisions.md) §4; POS, email and key management are internal controls | `platform.external_gate`, `platform.internal_gate` | `GATE-SEC` / `SEC-SECRETS` |
| 03 | Transactional outbox with at-least-once relay and idempotent inbox ([ADR-0010](../architecture/adr/ADR-0010-transactional-outbox.md), [ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md)) | `packages/db/src/kernel/outbox.ts`, `packages/db/src/kernel/inbox.ts`, `packages/outbox/` | `pnpm run test:integration`, `pnpm run test:concurrency` |
| 03 | Idempotency and provider-event deduplication — a retry never creates a second effect (CLAUDE.md §§6–7) | `packages/db/src/kernel/idempotency.ts`, `platform.provider_event` | `pnpm run test:concurrency` |
| 03 | Integer MNT, basis points, single `ROUND_HALF_UP` ([ADR-0007](../architecture/adr/ADR-0007-integer-money-basis-points.md)) | `packages/money/` | `pnpm run test:unit` |
| 03 | UTC storage, hotel-local derivation, `[start,end)`, end-of-month clamping ([ADR-0008](../architecture/adr/ADR-0008-utc-storage-hotel-local-dates.md)) | `packages/time/` | `pnpm run test:unit` |
| 03 | `KeyManagementPort`, envelope encryption, versioned keyed-HMAC lookup, fail-closed adapter selection ([ADR-0020](../architecture/adr/ADR-0020-key-management.md)) | `packages/ports/` | `GATE-SEC` / `SEC-KMS` |
| 03 | API primitives: `/api/v1`, canonical error envelope, pagination, correlation | `packages/contracts/`, `apps/api/src/observability/` | `pnpm run test:unit` |
| 03 | Projection checkpoint, `as_of` and lag; critical commands never read a projection ([ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md)) | `platform.projection_checkpoint`, `packages/db/src/kernel/projections.ts` | `pnpm run test:integration` |
| 03 | No secret, key, identifier or provider payload in any durable record, at any nesting depth (CLAUDE.md §8) | `platform.contains_denied_key`, `packages/telemetry/` | `GATE-SEC` / `SEC-PII-LEAK` |
| 03 | Startup refuses before a listener is bound and before Redis or BullMQ is reached: the API principal and key-management guards run first, and worker startup is an injectable orchestration boundary | `apps/api/src/bootstrap.ts`, `apps/worker/src/startup.ts` | `GATE-SEC` / `SEC-STARTUP` (`apps/api/src/security/startup-order.test.ts`), `GATE-SEC` / `SEC-STARTUP-WORKER` (`apps/worker/src/startup.test.ts`) |
| 03 | Fresh migration and upgrade migration reach an equivalent schema, compared over a fingerprint sensitive to function bodies, view definitions and grants (CLAUDE.md §10) | `packages/db/migrations/`, `packages/db/src/test-support/frozen-baseline/` | `pnpm run test:migrations` (`schemaFingerprint`, `schema fingerprint sensitivity`) |
| 03 | Cross-tenant maintenance runs as a `SECURITY DEFINER` function owned by `prsystem_maintenance_fn`; the break-glass role owns nothing and holds no standing grant ([ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md) §§4–5, 7) | `platform.maintenance_expire_idempotency_keys`, `packages/db/bootstrap/cluster-roles.sql` | `GATE-SEC` / `SEC-MAINTENANCE`, `GATE-SEC` / `SEC-OWNERSHIP` |
| 03 | Exact PostgreSQL 17 role membership: MEMBER, USAGE, SET and ADMIN modelled separately, every approved edge normalised to `ADMIN FALSE, INHERIT TRUE, SET TRUE`, and a migration refused while any runtime principal can reach an owner role | `packages/db/src/principal-guard.ts`, `packages/db/src/bootstrap.ts` | `GATE-SEC` / `SEC-REGRESSION` (`phase03-repair3.test.ts`), `GATE-SEC` / `SEC-ROLE` |
| 03 | Job rows are not editable by the principal they authorise: identity columns immutable, terminal states terminal, worker holds `SELECT` only and transitions through `platform.finish_worker_job` | `platform.job_run_transition_guard`, `platform.finish_worker_job`, `packages/db/migrations/0001_kernel.sql` | `GATE-SEC` / `SEC-MAINTENANCE`, `GATE-SEC` / `SEC-ACL-MATRIX` |
| 03 | Every gate builds the checked-out source before consuming generated JavaScript, and no security regression suite can be omitted from GATE-SEC | `turbo.json`, `package.json`, `tools/gate-sec-config.mjs`, `tools/regression-manifest.mjs` | `pnpm run validate:regression-coverage`, clean-checkout CI-equivalent run |
| 03 | D-09: a dedicated scheduler issues privileged maintenance jobs through one narrow SECURITY DEFINER function; the worker executes but cannot issue, and holds no `INSERT` on `job_run` | `platform.schedule_maintenance_job`, `platform.begin_worker_job`, `job_run_privileged_has_issuer` | `GATE-SEC` / `SEC-SCHEDULER` |
| 03 | Group-only, partial and IaC-managed login bootstrap: absent principals are never created, omitted existing ones never re-passworded but validated, unsafe drift fails closed | `packages/db/src/bootstrap.ts`, `packages/db/src/bootstrap-cli.ts` | `GATE-SEC` / `SEC-BOOTSTRAP` |
| 03 | Containment covers runtime, reader and scheduler principals alike, by MEMBER, USAGE, SET and ADMIN, in both the TypeScript runner and the migration SQL | `packages/db/src/principal-guard.ts`, `packages/db/migrations/0001_kernel.sql` | `GATE-SEC` / `SEC-REGRESSION` (`phase03-repair4.test.ts`) |
| 03 | Lock contention is observed, not inferred: `pg_locks` and `pg_blocking_pids` identify the holder before it is released | `packages/db/src/concurrency/kernel.test.ts`, `packages/db/src/security/sec-maintenance.test.ts` | `GATE-CONC`, `GATE-SEC` / `SEC-MAINTENANCE` |
| 03 | Migration determinism by declared Drizzle schema plus byte-identical normalized `pg_dump --schema-only` from the pinned PostgreSQL 17 image | `packages/db/src/schema.ts`, `packages/db/src/test-support/schema-dump.ts` | `pnpm run test:migrations` |
| 03 | Exact database and schema ACLs cover every grantee, not only PUBLIC and named project roles | `packages/db/src/bootstrap.ts` (`strayGrantees`) | `GATE-SEC` / `SEC-BOOTSTRAP` |
| 03 | D-09 issuance is an API control-plane capability on its own credential, pool and startup guard; the worker never receives it and no route is exposed in Phase 03 | `apps/api/src/maintenance/scheduler.service.ts`, `apps/api/src/security/scheduler-guard.ts`, `SCHEDULER_DATABASE_URL` | `GATE-SEC` / `SEC-STARTUP` (`scheduler-boundary.test.ts`) |
| 03 | Issuer and executor identity come from `session_user`; caller-writable custom GUCs are metadata only | `platform.schedule_maintenance_job`, `platform.maintenance_expire_idempotency_keys` | `GATE-SEC` / `SEC-SCHEDULER` |
| 03 | Terminal jobs and their evidence are frozen, and job text fields are bounded | `platform.job_run_transition_guard`, `job_run` CHECK constraints | `GATE-SEC` / `SEC-SCHEDULER` |
| 03 | Test and test-support sources are type-checked by the blocking gate | `packages/*/tsconfig.test.json` | `pnpm run typecheck` |
| 03 | The test harness suppresses only expected teardown terminations and fails on any other idle-client error | `packages/testing/src/pg-harness.ts` | `GATE-SEC` / `SEC-POOL-ERRORS` |
| 03 | Ownership of the target database and `public` is an explicit approved-operator contract, and owner roles reach exactly what the design says | `packages/db/src/bootstrap.ts`, `packages/db/migrations/0001_kernel.sql` | `GATE-SEC` / `SEC-BOOTSTRAP`, `SEC-REGRESSION` |
| 03 | CI gate commands are matched exactly and cannot discard their exit status | `tools/validate-regression-coverage.mjs`, `tools/validate-regression-coverage.fixtures.mjs` | `pnpm run validate:ci-bypass-fixtures` |

Phases 02 and 03 introduce no DEC coverage; every one of the 279 decisions remains `PENDING` after
them. Phase 04 is the first phase to move a decision to `COVERED`.

---

## 3. RC-DEC — Reception system scope (doc 02, 44)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RC-DEC-001 | One consolidated bill per stay | 10 | PENDING |
| RC-DEC-002 | Deposit amount 50 000–100 000₮, hotel/category configuration | 10 | PENDING |
| RC-DEC-003 | Deposit driven by booking source | 10 | PENDING |
| RC-DEC-004 | Deposit channels and deduction without extra approval | 10 | PENDING |
| RC-DEC-005 | Online booking source is the platform's own registry | 13 | PENDING |
| RC-DEC-006 | Manual POS versus integrated gateway card payment | 10 | PENDING |
| RC-DEC-007 | XYP unavailable, manual entry with provenance | 08 | PENDING |
| RC-DEC-008 | Cleaning status authority by package | 09 | PENDING |
| RC-DEC-009 | Shift close authority | 11 | PENDING |
| RC-DEC-010 | Cleaner dashboard and minibar report | 09 | PENDING |
| RC-DEC-011 | Cleaner and minibar restricted to 25 000/30 000₮ | 07 | PENDING |
| RC-DEC-012 | Hourly versus nightly stay model | 08 | PENDING |
| RC-DEC-013 | No automatic overdue fee | 08 | PENDING |
| RC-DEC-014 | Cleaning buffer between bookings | 08 | PENDING |
| RC-DEC-015 | Separate room state axes and badges | 08 | PENDING |
| RC-DEC-016 | Cleaner minibar refill from warehouse | 09 | PENDING |
| RC-DEC-017 | Room readiness conditions | 08 | PENDING |
| RC-DEC-018 | Minibar optional per room, template required when ON | 07 | PENDING |
| RC-DEC-019 | Restaurant registration and access | 15 | PENDING |
| RC-DEC-020 | Food order confirmed only on QPay success | 15 | PENDING |
| RC-DEC-021 | Restaurant's own QPay merchant | 15 | PENDING |
| RC-DEC-022 | Restaurant ordering schedule | 15 | PENDING |
| RC-DEC-023 | Invoice validity versus closing time, late payment refund | 15 | PENDING |
| RC-DEC-024 | Restaurant-initiated refund authority | 15 | PENDING |
| RC-DEC-025 | Restaurant contact number visibility | 15 | PENDING |
| RC-DEC-026 | Room QR and one-time guest access code | 15 | PENDING |
| RC-DEC-027 | At most five concurrent guest sessions per stay | 15 | PENDING |
| RC-DEC-028 | Checkout with an unfinished restaurant order | 15 | PENDING |
| RC-DEC-029 | Checkout handoff option per order | 15 | PENDING |
| RC-DEC-030 | Restaurant acceptance 5/10-minute SLA | 15 | PENDING |
| RC-DEC-031 | Refund request resolution SLA | 15 | PENDING |
| RC-DEC-032 | Guest list and Excel export columns | 17 | PENDING |
| RC-DEC-033 | One primary guest per stay | 08 | PENDING |
| RC-DEC-034 | Primary guest Police match boundary | 18 | PENDING |
| RC-DEC-035 | Cleaner checkout exception and minibar dispute | 09 | PENDING |
| RC-DEC-036 | Minibar stock, cost and shortage override | 07 | PENDING |
| RC-DEC-037 | Hotel Admin financial reporting | 17 | PENDING |
| RC-DEC-038 | Cash drawer and physical cash ledger | 11 | PENDING |
| RC-DEC-039 | Minibar selling price snapshot | 09 | PENDING |
| RC-DEC-040 | Room and minibar entity lifecycle | 06 | PENDING |
| RC-DEC-041 | Room minibar configuration change | 07 | PENDING |
| RC-DEC-042 | Explicit exact-version Rollout | 07 | PENDING |
| RC-DEC-043 | Multi-room Rollout batch | 07 | PENDING |
| RC-DEC-044 | Mongolian, foreign and no-document primary guest identity | 08 | PENDING |

## 4. SHIFT-DEC — Reception shift handover (doc 03, 7)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| SHIFT-DEC-001 | Operational and financial review states separate | 11 | PENDING |
| SHIFT-DEC-002 | Opening balance from actual counted cash | 11 | PENDING |
| SHIFT-DEC-003 | Self-close is an operational terminal state | 11 | PENDING |
| SHIFT-DEC-004 | Hotel Admin self-review fallback | 11 | PENDING |
| SHIFT-DEC-005 | Rejection never reopens a closed shift | 11 | PENDING |
| SHIFT-DEC-006 | Immutable opening balance and linked correction | 11 | PENDING |
| SHIFT-DEC-007 | Shift audit requirements | 11 | PENDING |

## 5. STAY-DEC — Room stay and time (doc 05, 14)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| STAY-DEC-001 | Nightly stay uses the fixed hotel checkout time | 08 | PENDING |
| STAY-DEC-002 | Hourly base price formula | 06 | PENDING |
| STAY-DEC-003 | No automatic overdue charge | 08 | PENDING |
| STAY-DEC-004 | Cleaning duration configuration and actual clean state | 06 | PENDING |
| STAY-DEC-005 | Tariff precedence, snapshot and permission | 06 | PENDING |
| STAY-DEC-006 | No configurable hourly minimum, maximum or increment | 06 | PENDING |
| STAY-DEC-007 | Nightly calendar, price and early-arrival rule | 08 | PENDING |
| STAY-DEC-008 | Exclusive-end interval with planned and actual readiness | 08 | PENDING |
| STAY-DEC-009 | Initial actual check-in and the 120-minute backdate | 08 | PENDING |
| STAY-DEC-010 | Active-stay actual-time immutable correction | 08 | PENDING |
| STAY-DEC-011 | Planned-checkout direct-overwrite guard | 08 | PENDING |
| STAY-DEC-012 | No planned-checkout change in MVP | 08 | PENDING |
| STAY-DEC-013 | Overdue conflict blocker and deterministic remedy | 08 | PENDING |
| STAY-DEC-014 | Half-hour fractional hourly stay precision | 08 | PENDING |

## 6. REST-DEC — Restaurant (doc 08, 6)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| REST-DEC-001 | Separate order, fulfillment, payment, refund and handoff axes | 15 | PENDING |
| REST-DEC-002 | Acceptance versus refund-request race | 15 | PENDING |
| REST-DEC-003 | Fulfillment ETA of 15/30/45/60 minutes | 15 | PENDING |
| REST-DEC-004 | Checkout handoff terminal events | 15 | PENDING |
| REST-DEC-005 | Closing and late payment mandatory refund | 15 | PENDING |
| REST-DEC-006 | Actor boundaries and unresolved-SLA link pause | 15 | PENDING |

## 7. BK-DEC — Online booking (doc 09, 14)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| BK-DEC-001 | Public search by date, location and current position | 12 | PENDING |
| BK-DEC-002 | e-Mongolia or phone-OTP booking authentication | 12 | PENDING |
| BK-DEC-003 | Booking payment routed through the platform | 14 | PENDING |
| BK-DEC-004 | Hotel ratings and reviews on listings | 16 | PENDING |
| BK-DEC-005 | Verified-stay review eligibility | 16 | PENDING |
| BK-DEC-006 | Review input rules and the 30-day window | 16 | PENDING |
| BK-DEC-007 | Review edit and soft-delete | 16 | PENDING |
| BK-DEC-008 | Contract-specific commission rate | 14 | PENDING |
| BK-DEC-009 | Ten-minute payment hold | 13 | PENDING |
| BK-DEC-010 | Cancellation and no-show framework | 14 | PENDING |
| BK-DEC-011 | Gateway fee is a platform cost | 14 | PENDING |
| BK-DEC-012 | MVP booking shape, booker versus staying guest | 13 | PENDING |
| BK-DEC-013 | Category inventory and physical room at check-in | 13 | PENDING |
| BK-DEC-014 | Hotel-caused fulfilment failure remedies | 13 | PENDING |

## 8. RV-DEC — Ratings and reviews (doc 10, 7)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RV-DEC-001 | Authenticated-user reviews only | 16 | PENDING |
| RV-DEC-002 | Verified-stay eligibility | 16 | PENDING |
| RV-DEC-003 | Rating, comment and review window | 16 | PENDING |
| RV-DEC-004 | Review edit and soft-delete | 16 | PENDING |
| RV-DEC-005 | Authenticated report and Platform moderation | 16 | PENDING |
| RV-DEC-006 | Hidden review restore | 16 | PENDING |
| RV-DEC-007 | One official hotel reply | 16 | PENDING |

## 9. PAY-DEC — Booking payment policy (doc 11, 9)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| PAY-DEC-001 | Contract-specific commission, no 5% default | 14 | PENDING |
| PAY-DEC-002 | Ten-minute inventory and payment hold | 13 | PENDING |
| PAY-DEC-003 | Cancellation and no-show framework | 14 | PENDING |
| PAY-DEC-004 | Gateway fee borne by the platform | 14 | PENDING |
| PAY-DEC-005 | QPay and Khaan Bank gateway authority | 14 | PENDING |
| PAY-DEC-006 | Hold expiry versus late and duplicate capture | 13 | PENDING |
| PAY-DEC-007 | Cancellation and no-show numeric rules | 14 | PENDING |
| PAY-DEC-008 | Commission base and rounding | 14 | PENDING |
| PAY-DEC-009 | Settlement lifecycle and D+1 payout | 14 | PENDING |

## 10. GUEST-DEC — Guest registry (doc 12, 8)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| GUEST-DEC-001 | Admin and Manager guest registry access | 17 | PENDING |
| GUEST-DEC-002 | Six approved columns | 17 | PENDING |
| GUEST-DEC-003 | Date-of-birth derived age snapshot | 17 | PENDING |
| GUEST-DEC-004 | Primary guest only | 17 | PENDING |
| GUEST-DEC-005 | Filters and server-side pagination | 17 | PENDING |
| GUEST-DEC-006 | Ten-thousand-row background Excel job | 17 | PENDING |
| GUEST-DEC-007 | Private temporary export file | 17 | PENDING |
| GUEST-DEC-008 | 365-day retention and legal hold | 17 | PENDING |

## 11. POL-DEC — Police monitoring (doc 13, 22)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| POL-DEC-001 | Wanted record creation via XYP or manual entry | 18 | PENDING |
| POL-DEC-002 | Match information and alert | 18 | PENDING |
| POL-DEC-003 | Police dashboard and Excel | 18 | PENDING |
| POL-DEC-004 | Police account activation | 18 | PENDING |
| POL-DEC-005 | Admin versus Officer visibility | 18 | PENDING |
| POL-DEC-006 | Match versus Found distinction | 18 | PENDING |
| POL-DEC-007 | Match concealed from hotel users | 18 | PENDING |
| POL-DEC-008 | Alert recipients and district routing | 18 | PENDING |
| POL-DEC-009 | Match SMS content | 18 | PENDING |
| POL-DEC-010 | All-hotel check-in list authority | 18 | PENDING |
| POL-DEC-011 | Alert acknowledgement and escalation | 18 | PENDING |
| POL-DEC-012 | Flexible Found confirmation by own account | 18 | PENDING |
| POL-DEC-013 | Scope of a Found outcome | 18 | PENDING |
| POL-DEC-014 | Found quick form | 18 | PENDING |
| POL-DEC-015 | Erroneous Found correction | 18 | PENDING |
| POL-DEC-016 | No Match ownership transfer | 18 | PENDING |
| POL-DEC-017 | Person, Case and Match model with exact identity boundary | 18 | PENDING |
| POL-DEC-018 | Manual identity approval and case lifecycle | 18 | PENDING |
| POL-DEC-019 | False Match two-person workflow | 18 | PENDING |
| POL-DEC-020 | No-exclusive-owner responsibility model | 18 | PENDING |
| POL-DEC-021 | Police permission and export boundary | 18 | PENDING |
| POL-DEC-022 | Four-digit bootstrap code and Police authentication | 18 | PENDING |

## 12. OPS-DEC — Operation dashboard (doc 14, 18)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| OPS-DEC-001 | Dashboard purpose | 19 | PENDING |
| OPS-DEC-002 | SMS reminder tab | 19 | PENDING |
| OPS-DEC-003 | CallPro as SMS provider | 19 | PENDING |
| OPS-DEC-004 | One-way SMS | 19 | PENDING |
| OPS-DEC-005 | Seven-day expiring-soon threshold | 19 | PENDING |
| OPS-DEC-006 | Subscription start and expiry computation | 05 | PENDING |
| OPS-DEC-007 | Renewal period computation with grace | 05 | PENDING |
| OPS-DEC-008 | Operation-initiated password reset | 19 | PENDING |
| OPS-DEC-009 | Inaccessible-email recovery boundary | 19 | PENDING |
| OPS-DEC-010 | Manual-only SMS sending | 19 | PENDING |
| OPS-DEC-011 | Subscription list columns and default order | 19 | PENDING |
| OPS-DEC-012 | Subscription list filters and search | 19 | PENDING |
| OPS-DEC-013 | Application versus Hotel KPI boundary | 19 | PENDING |
| OPS-DEC-014 | KPI formulas and card filters | 19 | PENDING |
| OPS-DEC-015 | Operation security and contact change | 19 | PENDING |
| OPS-DEC-016 | Subscription state and suspension | 19 | PENDING |
| OPS-DEC-017 | Paid reconciliation permission and outcomes | 19 | PENDING |
| OPS-DEC-018 | Provisioning retry and recovery permissions | 19 | PENDING |

## 13. ONB-DEC — Onboarding (doc 15, 8)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| ONB-DEC-001 | Payment-gated activation | 05 | PENDING |
| ONB-DEC-002 | Citizen versus organization registration type | 05 | PENDING |
| ONB-DEC-003 | Initial Hotel Admin activation link | 05 | PENDING |
| ONB-DEC-004 | Mandatory registration fields | 05 | PENDING |
| ONB-DEC-005 | Ownership and duplication rules | 05 | PENDING |
| ONB-DEC-006 | Durable idempotent provisioning | 05 | PENDING |
| ONB-DEC-007 | Existing account and owner proof, canonical state | 05 | PENDING |
| ONB-DEC-008 | Payment retry, late and duplicate success | 05 | PENDING |

## 14. SUB-DEC — Subscription pricing (doc 16, 9)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| SUB-DEC-001 | Monthly base price | 05 | PENDING |
| SUB-DEC-002 | Term total equals monthly price times months | 05 | PENDING |
| SUB-DEC-003 | No MVP discounts | 05 | PENDING |
| SUB-DEC-004 | QPay and Khaan Bank subscription gateways | 05 | PENDING |
| SUB-DEC-005 | eBarimt per confirmed payment | 05 | PENDING |
| SUB-DEC-006 | VAT-inclusive final price | 05 | PENDING |
| SUB-DEC-007 | Gateway provider fee borne by the platform | 05 | PENDING |
| SUB-DEC-008 | Operator flow when eBarimt fails | 05 | PENDING |
| SUB-DEC-009 | Subscription payments are non-refundable | 05 | PENDING |

## 15. LIFE-DEC — Subscription lifecycle (doc 17, 7)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| LIFE-DEC-001 | Upgrade only, no downgrade | 05 | PENDING |
| LIFE-DEC-002 | Upgrade price and effective moment | 05 | PENDING |
| LIFE-DEC-003 | Expiry hard lock after the 48-hour grace | 05 | PENDING |
| LIFE-DEC-004 | Public listing hidden after grace | 05 | PENDING |
| LIFE-DEC-005 | Renewal inside the grace period | 05 | PENDING |
| LIFE-DEC-006 | Paid pending upgrade and renewal serialization | 05 | PENDING |
| LIFE-DEC-007 | Higher renewal, boundary race, reconciliation owner | 05 | PENDING |

## 16. RBAC-DEC — Permission matrix (doc 18, 17)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RBAC-DEC-001 | Multi-role and explicit operational role | 04 | PENDING |
| RBAC-DEC-002 | Hotel action matrix | 04 | PENDING |
| RBAC-DEC-003 | Package entitlement gate | 04 | PENDING |
| RBAC-DEC-004 | Platform and Operation separation | 04 | PENDING |
| RBAC-DEC-005 | Police base matrix | 04 | PENDING |
| RBAC-DEC-006 | Server-side enforcement | 04 | PENDING |
| RBAC-DEC-007 | Full financial report for Hotel Admin only | 04 | PENDING |
| RBAC-DEC-008 | Cleaner checkout exception permissions | 04 | PENDING |
| RBAC-DEC-009 | Minibar inventory and shortage override permissions | 04 | PENDING |
| RBAC-DEC-010 | Expense lifecycle and financial report permissions | 04 | PENDING |
| RBAC-DEC-011 | Shift self-close and review permissions | 04 | PENDING |
| RBAC-DEC-012 | Cash drawer, transfer and payout permissions | 04 | PENDING |
| RBAC-DEC-013 | Deposit configuration and correction permissions | 04 | PENDING |
| RBAC-DEC-014 | Post-suspension unfinished work | 04 | PENDING |
| RBAC-DEC-015 | Review and guest registry permissions | 04 | PENDING |
| RBAC-DEC-016 | Online cancellation, no-show and overbooking permissions | 04 | PENDING |
| RBAC-DEC-017 | Explicit Operation permissions and takeover scope | 04 | PENDING |

## 17. STAFF-DEC — Staff lifecycle (doc 19, 9)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| STAFF-DEC-001 | Email invitation with user-created password | 04 | PENDING |
| STAFF-DEC-002 | Account versus membership | 04 | PENDING |
| STAFF-DEC-003 | Password reset and session revocation | 04 | PENDING |
| STAFF-DEC-004 | Role change and suspension effect | 04 | PENDING |
| STAFF-DEC-005 | No hard delete of staff history | 04 | PENDING |
| STAFF-DEC-006 | Single Primary Hotel Admin | 04 | PENDING |
| STAFF-DEC-007 | Post-suspension takeover and reassignment | 04 | PENDING |
| STAFF-DEC-008 | Membership revision, reactivation, takeover terminalization | 04 | PENDING |
| STAFF-DEC-009 | Invitation concurrency and the one-membership invariant | 04 | PENDING |

## 18. DEP-DEC — Deposit and payment correction (doc 20, 10)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| DEP-DEC-001 | Deposit source and amount | 10 | PENDING |
| DEP-DEC-002 | Normal deduction without extra approval | 10 | PENDING |
| DEP-DEC-003 | Original-channel refund | 10 | PENDING |
| DEP-DEC-004 | Alternate-channel refund exception | 10 | PENDING |
| DEP-DEC-005 | POS reference capture | 10 | PENDING |
| DEP-DEC-006 | Immutable financial correction | 10 | PENDING |
| DEP-DEC-007 | Reserved balance, concurrency and idempotency | 10 | PENDING |
| DEP-DEC-008 | Deposit permissions and immutable configuration snapshot | 10 | PENDING |
| DEP-DEC-009 | Refund release and late-success race | 10 | PENDING |
| DEP-DEC-010 | Late refund reconciliation owner and terminal posting | 10 | PENDING |

## 19. CHK-DEC — Cleaner checkout exception (doc 21, 6)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| CHK-DEC-001 | Cleaner report mandatory | 09 | PENDING |
| CHK-DEC-002 | Manager exception report | 09 | PENDING |
| CHK-DEC-003 | Pre-payment versioned correction | 09 | PENDING |
| CHK-DEC-004 | Payment lock and reconciliation | 09 | PENDING |
| CHK-DEC-005 | Post-payment immutable adjustment | 09 | PENDING |
| CHK-DEC-006 | Guest minibar dispute | 09 | PENDING |

## 20. INV-DEC — Minibar inventory (doc 22, 8)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| INV-DEC-001 | Manager quantity is warehouse stock | 07 | PENDING |
| INV-DEC-002 | Warehouse and room balances separate | 07 | PENDING |
| INV-DEC-003 | Immutable inventory ledger | 07 | PENDING |
| INV-DEC-004 | Purchase cost and weighted average | 07 | PENDING |
| INV-DEC-005 | Negative stock prohibition | 07 | PENDING |
| INV-DEC-006 | Controlled shortage override | 07 | PENDING |
| INV-DEC-007 | Minibar optional per room | 07 | PENDING |
| INV-DEC-008 | Inventory action permissions | 07 | PENDING |

## 21. FIN-DEC — Financial reporting (doc 23, 10)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| FIN-DEC-001 | Sales and received money kept separate | 17 | PENDING |
| FIN-DEC-002 | Deposit and Restaurant exclusion | 17 | PENDING |
| FIN-DEC-003 | Minibar weighted-average COGS | 17 | PENDING |
| FIN-DEC-004 | No double deduction of inventory purchase | 17 | PENDING |
| FIN-DEC-005 | Expense submission, approval and payment execution | 11 | PENDING |
| FIN-DEC-006 | Seven-day, month and custom ranges | 17 | PENDING |
| FIN-DEC-007 | Top-five rooms | 17 | PENDING |
| FIN-DEC-008 | Four financial Excel exports | 17 | PENDING |
| FIN-DEC-009 | Effective-date correction | 17 | PENDING |
| FIN-DEC-010 | Full financial access for Hotel Admin only | 17 | PENDING |

## 22. CASH-DEC — Cash drawer ledger (doc 24, 10)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| CASH-DEC-001 | Default and multiple drawers | 11 | PENDING |
| CASH-DEC-002 | Optional safe | 11 | PENDING |
| CASH-DEC-003 | Actual initial opening balance | 11 | PENDING |
| CASH-DEC-004 | Typed immutable ledger | 11 | PENDING |
| CASH-DEC-005 | Paid expense execution | 11 | PENDING |
| CASH-DEC-006 | Drawer and safe transfers | 11 | PENDING |
| CASH-DEC-007 | Bank deposit and owner withdrawal | 11 | PENDING |
| CASH-DEC-008 | Cash top-up | 11 | PENDING |
| CASH-DEC-009 | Effective-date correction | 11 | PENDING |
| CASH-DEC-010 | Cash permissions and reporting | 11 | PENDING |

## 23. PRICE-DEC — Selling price snapshot (doc 25, 8)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| PRICE-DEC-001 | Check-in stay price book | 08 | PENDING |
| PRICE-DEC-002 | Active-stay price isolation | 09 | PENDING |
| PRICE-DEC-003 | Normal and exception report pricing | 09 | PENDING |
| PRICE-DEC-004 | Report version and correction pricing | 09 | PENDING |
| PRICE-DEC-005 | Zero opening quantity and refill | 09 | PENDING |
| PRICE-DEC-006 | Products absent from the snapshot | 09 | PENDING |
| PRICE-DEC-007 | Server-authoritative price | 09 | PENDING |
| PRICE-DEC-008 | Selling price and cost kept separate | 09 | PENDING |

## 24. RML-DEC — Room and minibar lifecycle (doc 26, 28)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RML-DEC-001 | Unified ACTIVE, RETIRING, INACTIVE lifecycle | 06 | PENDING |
| RML-DEC-002 | Active stay and future booking protection | 06 | PENDING |
| RML-DEC-003 | Entity-specific deactivation blockers | 06 | PENDING |
| RML-DEC-004 | Historical snapshot protection | 06 | PENDING |
| RML-DEC-005 | Hard-delete limits | 06 | PENDING |
| RML-DEC-006 | Reactivation, permission and audit | 06 | PENDING |
| RML-DEC-007 | Current configuration and one pending change | 07 | PENDING |
| RML-DEC-008 | Active stay safe point | 07 | PENDING |
| RML-DEC-009 | ON to OFF reconciliation | 07 | PENDING |
| RML-DEC-010 | OFF to ON and shortage | 07 | PENDING |
| RML-DEC-011 | Template A to B delta reconciliation | 07 | PENDING |
| RML-DEC-012 | Future booking and effective configuration | 07 | PENDING |
| RML-DEC-013 | Action permission and task boundary | 07 | PENDING |
| RML-DEC-014 | Cancel, rollback, atomic apply and audit | 07 | PENDING |
| RML-DEC-015 | Entity, version and room configuration separate | 07 | PENDING |
| RML-DEC-016 | Draft, immutable Published and Archived history | 07 | PENDING |
| RML-DEC-017 | Multiple Published, Default and exact binding | 07 | PENDING |
| RML-DEC-018 | Publish validation | 07 | PENDING |
| RML-DEC-019 | First and subsequent Default | 07 | PENDING |
| RML-DEC-020 | Publish and Default isolation, entitlement, Rollout separation | 07 | PENDING |
| RML-DEC-021 | Version Archive blockers, history and permission | 07 | PENDING |
| RML-DEC-022 | Rollout target and eligible room | 07 | PENDING |
| RML-DEC-023 | Pending, blocker and safe-point task trigger | 07 | PENDING |
| RML-DEC-024 | Rollout isolation, apply, permission and batch boundary | 07 | PENDING |
| RML-DEC-025 | Batch parent, exact target and read-only preview | 07 | PENDING |
| RML-DEC-026 | Partial success, independent child and derived progress | 07 | PENDING |
| RML-DEC-027 | Cancel remaining, rollback and linked retry | 07 | PENDING |
| RML-DEC-028 | Target and Archive, concurrency, permission and audit | 07 | PENDING |

---

## 25. Cross-cutting invariant register

These invariants span families. The phase that first establishes each mechanism is named; every later
phase touching the invariant must re-assert it in its own gates.

| Invariant | Sources | Established in | Enforced by |
| --- | --- | --- | --- |
| MNT stored as bigint, rates as basis points, single `ROUND_HALF_UP` | PAY-DEC-008, STAY-DEC-014 | 03 | `packages/money`, DB column types |
| Occupancy interval `[start_at, end_at)` | STAY-DEC-008 | 03 | `packages/time`, exclusion constraint |
| Confirmation snapshots are never repriced | STAY-DEC-005, STAY-DEC-007, PRICE-DEC-001, PRICE-DEC-002 | 06 | immutable snapshot tables |
| Append-only financial and lifecycle history | DEP-DEC-006, CASH-DEC-004, INV-DEC-003, FIN-DEC-009 | 03 | DB rules/triggers plus repository policy |
| One non-terminal pending per scope | RML-DEC-007, DEP-DEC-007, STAY-DEC-010, STAFF-DEC-009 | 04 | partial unique indexes |
| Idempotency on every money or lifecycle command | ONB-DEC-006, ONB-DEC-008, PAY-DEC-005, REST-DEC-001 | 03 | `packages/outbox` idempotency store |
| Row lock or revision CAS where concurrency matters | LIFE-DEC-006, LIFE-DEC-007, STAFF-DEC-008, RML-DEC-028 | 03 | `SELECT … FOR UPDATE`, `expected_revision` |
| Provider result is the only payment and refund authority | PAY-DEC-005, REST-DEC-001, DEP-DEC-003 | 03 | `packages/ports` |
| A late callback never reopens a terminal entity | PAY-DEC-006, REST-DEC-005, LIFE-DEC-006 | 05 | reconciliation queues |
| Package entitlement gates above role permission | RBAC-DEC-003, INV-DEC-008, RML-DEC-020 | 03 | `packages/authz` |
| Hotel Admin never inherits operational roles | RBAC-DEC-001 | 04 | `packages/authz` |
| Realm isolation across Hotel, Guest, Operation and Police | RBAC-DEC-004, POL-DEC-007 | 03 | realm guards, separate schemas |
| No plaintext secrets in logs, audit, outbox or fixtures | POL-DEC-022, STAFF-DEC-001, OPS-DEC-008 | 02 | telemetry redaction plus the Phase 22 scanner |
| Exact-RD-only Police matching, no fuzzy matching | POL-DEC-017, RC-DEC-044 | 18 | matching service |
| Restaurant money never enters hotel ledgers | RC-DEC-020, FIN-DEC-002, CASH-DEC-004 | 15 | ledger boundary tests |
| Forced RLS on transaction-scoped server-derived tenant context | RBAC-DEC-006, POL-DEC-007 | 03 | `CTL-DATA-11`; policies in migrations, `SET LOCAL` context, five DB roles ([ADR-0017](../architecture/adr/ADR-0017-tenant-isolation-rls.md)) |
| Audit partitioned and fail-closed for high-risk actions | RBAC-DEC-006, POL-DEC-011 | 03 | `CTL-DATA-12`; monthly partitions, pre-creation job, same-transaction audit ([ADR-0018](../architecture/adr/ADR-0018-audit-partitioning.md)) |
| Critical commands never read an eventually consistent projection | BK-DEC-013, DEP-DEC-007 | 03 | `CTL-BOUND-03`; authoritative row reads under lock ([ADR-0019](../architecture/adr/ADR-0019-projection-consistency.md)) |
| Identifiers under envelope encryption with keyed lookup and per-realm key scopes | RC-DEC-044, POL-DEC-017 | 03 | `CTL-SEC-04`; `KeyManagementPort`, versioned DEKs, keyed HMAC ([ADR-0020](../architecture/adr/ADR-0020-key-management.md)) |

---

## 26. Control and gate mapping

Every decision in this register is additionally mapped to the architectural controls that enforce it
and the test gates that prove it, in
[docs/architecture/17-dec-control-mapping.md](../architecture/17-dec-control-mapping.md)
(established in Phase 01).

- Control catalog: that document, §2 — 37 controls.
- Gate catalog: [docs/architecture/14-test-strategy-and-gates.md](../architecture/14-test-strategy-and-gates.md) §2 — 8 gates.

A decision moves to `COVERED` only when its owning phase has implemented the mapped controls **and**
the mapped gates have executed against them.

---

## 27. Validation

Machine validation of this document, [build-plan.md](build-plan.md), [phase-status.md](phase-status.md),
[external-integration-gates.md](external-integration-gates.md) and the Phase 01 architecture set:

```bash
node tools/validate-governance.mjs
```

The validator asserts source-document coverage, DEC uniqueness and count, single-phase assignment,
phase-namespace agreement across documents, EXT uniqueness, markdown link resolution, architecture and
ADR index integrity, invariant enforcement mechanisms, EXT port-surface coverage, and complete
DEC → control → gate mapping. It is a standing gate for every phase
(see [build-plan.md](build-plan.md) §5).
