# Phase 23 governed battery — execution log

The per-command record of the governed battery measured for the Phase 23 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-23-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `4d42ab49bbf6d6a078c924bc93b09ecfe88b0432`, the Phase 23
  implementation commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit=0 21s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the repository's own Compose stack, project `prsystem` (PostgreSQL
  127.0.0.1:55442, Redis 56379, MinIO 59000); scratch databases `prsystem_test_*` and
  `prsystem_migration_*`, the e2e server's `prsystem_test_e2e`, and the S3 test's own bucket, created
  and dropped by their suites. The e2e run started the real API on 127.0.0.1:53200 with its loopback
  console on 53201, the worker's consumers in-process on the real Redis under a run-scoped queue
  prefix, and the five portals as production builds on 53100–53104, all bound and released by
  Playwright's web-server hook; the Chromium build came from the user's Playwright cache.
- **One cluster, deliberately.** `docker-compose.yml` fixes the project name, and the migration
  suite's schema dump resolves its container through `docker compose ps -q postgres` from the
  checkout root. Turborepo passes only `DATABASE_URL` to a task, so an override naming a different
  container never reaches the test process: the cluster the suites create databases in and the
  cluster the dump reads from have to be the same one.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 4d42ab49bbf6d6a078c924bc93b09ecfe88b0432 started 2026-09-10T02:23:06Z; finished
  2026-09-10T02:40:49Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 81s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 15s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 6s |
| `pnpm run lint` | 1 | 0 | 8s |
| `pnpm run typecheck` | 1 | 0 | 11s |
| `pnpm run test:unit` | 1 | 0 | 12s |
| `pnpm run test:migrations` | 1 | 0 | 47s |
| `pnpm run test:integration` | 1 | 0 | 58s |
| `pnpm run test:concurrency` | 1 | 0 | 28s |
| `pnpm run test:concurrency` | 2 | 0 | 29s |
| `pnpm run test:concurrency` | 3 | 0 | 29s |
| `pnpm run test:regression` | 1 | 0 | 27s |
| `pnpm run test:security` | 1 | 0 | 193s |
| `pnpm run test:security` | 2 | 0 | 193s |
| `pnpm run test:security` | 3 | 0 | 197s |
| `pnpm run test:e2e` | 1 | 0 | 81s |
| `pnpm run audit:prod` | 1 | 0 | 1s |
| `pnpm run audit:tree` | 1 | 0 | 1s |
| `pnpm run build` | 1 | 0 | 14s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 1s |

All 28 executions exited 0. The result counts are in
[phase-23-evidence.json](phase-23-evidence.json) and restated in the evidence table of the Phase 23
record; the two governance rows there are from the final tree, which carries the record and the
new drift-fixture results that govern it.

`pnpm run audit:tree` reported the same three moderate advisories Phase 20 recorded — `DSR-01` and
`DSR-02` in [dependency-security-register.md](dependency-security-register.md), reviewed in
Phase 22 and still `OPEN — contained`. The gate's threshold is high-and-above, and
`pnpm run audit:prod` is clean; Phase 23 added no dependency.

## What the suites measured, and why the counts did not move

Phase 23 changes no product code: it adds the release candidate audit, the release notes, the
runbook and the rollback plan, and revises the registers. Every suite therefore measures exactly
what Phase 22 measured on `4575f8d` — unit 1,699 across 12 projects, migrations 148, integration
621, concurrency 97 each run, regression 51, `GATE-SEC` 20 of 20 each run, e2e 130 with the leakage
scan at 0 findings — and passes at the same counts. `node tools/scan-secrets.mjs` indexes the three
new documents and reports (1,019 files rather than 1,014) with 0 findings; the governance validator's link check
resolves the new documents; and the drift fixtures on the final tree include the twelve that govern
this phase's own manifest and the rewritten current-phase fixtures for the programme's terminal
state.
