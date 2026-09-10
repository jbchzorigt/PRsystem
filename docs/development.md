# Local development

Scaffold-level guide for the PRsystem monorepo. Requirement documents live in
`docs/00-*.md` … `docs/26-*.md`; engineering rules live in `CLAUDE.md`.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.17.0 | pinned in `.nvmrc`, enforced by `engines` |
| pnpm | 9.15.9 | pinned by `packageManager`; enable with `corepack enable pnpm` |
| Docker | any recent | supplies PostgreSQL, Redis, MinIO and Mailpit |

If `corepack enable pnpm` cannot write to `/usr/local/bin`, install into a user
directory instead and put it on `PATH`:

```bash
corepack enable --install-directory ~/.local/bin pnpm
```

## First run

```bash
pnpm install --frozen-lockfile && cp .env.example .env && pnpm run compose:up
```

Then apply the migration journal:

```bash
pnpm run migrate
```

## Backing services

`docker-compose.yml` declares the compose project `prsystem` and binds every
service to `127.0.0.1` on a PRsystem-only host port, so the stack cannot collide
with another project already using 5432, 6379, 9000 or 3000. It never touches a
container outside its own project.

| Service | Host port | Purpose |
| --- | --- | --- |
| PostgreSQL 17.6 | 55442 | authoritative database |
| Redis 7.4.2 | 56379 | jobs and queues only — never a source of truth or a lock |
| MinIO | 59000 (console 59001) | S3-compatible private object storage |
| Mailpit | 51025 (UI 58025) | local SMTP sink |

Override any of them in `.env`. `.env` is git-ignored and must never hold a real
credential; `.env.example` carries local placeholders only.

## Applications

One API deployment, one worker deployment and five portals — a modular monolith,
not microservices.

| Project | Port | |
| --- | --- | --- |
| `apps/api` | 53000 | NestJS on Fastify; `/health/live`, `/health/ready`, `/docs-json` |
| `apps/worker` | — | BullMQ consumers |
| `apps/web-public` | 53100 | Public and Guest |
| `apps/web-hotel` | 53101 | Hotel Operations |
| `apps/web-restaurant` | 53102 | Restaurant |
| `apps/web-police` | 53103 | Police |
| `apps/web-operation` | 53104 | Platform Operation |

Portal ports above are the ones the E2E harness binds; `pnpm run dev` uses each
framework's own default. A portal reads two variables of its own: `PRSYSTEM_API_URL`, the API it
calls from its server side, and `PRSYSTEM_PORTAL_ORIGIN`, its public origin (an https origin marks
the session cookie `Secure`). The E2E harness sets both; `.env.example` documents them.

## Commands

| Command | What it actually does |
| --- | --- |
| `pnpm run dev` | every app in watch mode |
| `pnpm run lint` | ESLint per project, including the module-boundary rule |
| `pnpm run typecheck` | `tsc --noEmit` per project plus the E2E sources |
| `pnpm run test:unit` | Vitest across apps and packages |
| `pnpm run test:migrations` | applies the journal to real PostgreSQL, twice |
| `pnpm run test:e2e` | builds the API and the portals, starts the real API on a scratch database with the worker's consumers in-process on the compose Redis (`e2e/api-server.mjs`, seeded with synthetic people), and the five portals as production builds, then runs the Playwright flows, the four full journeys, the security-header check and the axe scan at phone, tablet and desktop viewports, and last the secret-leakage scan over the run's own log, tables and queue |
| `pnpm run build` | compiles all seven applications |
| `pnpm run openapi` | writes `apps/api/openapi.json` (build artefact, not committed) |
| `pnpm run migrate` | applies pending migrations to `DATABASE_URL` |
| `pnpm run verify` | the full local gate set, in order |
| `node tools/validate-concurrency-coverage.mjs` | every idempotent command raced by a `GATE-CONC` suite or explained (Phase 22; also run under `test:unit`) |
| `node tools/recovery-rehearsal.mjs --out <report.json>` | the backup, restore and disaster-recovery rehearsal on a dedicated PostgreSQL with WAL archiving — measures RPO and RTO (Phase 22; needs Docker) |
| `node tools/load-test.mjs --out <report.json>` | the latency and throughput measurement per class of doc 15 §2–§3 against the seeded e2e API (Phase 22; needs the compose stack) |
| `pnpm run compose:up` / `compose:down` | start / destroy the backing services |

Governance checks — `validate:workspace`, `validate:governance`, `scan:secrets` —
also run standalone and are the first thing CI executes.

Deploying a build is [docs/implementation/release-runbook.md](implementation/release-runbook.md)
(Phase 23), which also carries the rollback plan.

`pnpm run test:migrations` and `pnpm run test:e2e` need the compose stack, and the latter
also the Playwright browser:

```bash
pnpm exec playwright install chromium
```

## Migrations

Versioned SQL only. `drizzle-kit` generates files; it is never used to push a
schema at a database, and there are no down-migrations (ADR-0004). A mistake is
corrected by a new migration.

The Phase 02 baseline creates no table. Platform, IAM, audit, outbox,
idempotency and business tables arrive in Phase 03, and `test:migrations`
asserts that emptiness so the boundary cannot erode silently.

## Conventions that the tooling enforces

- Dependency versions are exact — no `^`, `~` or other floating range.
- Every workspace project extends `tsconfig.base.json` and its four required
  strict flags.
- Cross-module repository, schema and entity imports fail lint; a fixture in
  `tools/lint-fixtures/` proves the rule fires.
- Logs are redacted by field name and by value shape before they are written.
- Only synthetic identities appear in tests, seeds and fixtures.
