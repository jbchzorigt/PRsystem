# Phase 17 governed battery — execution log

The per-command record of the governed battery measured for the Phase 17 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-17-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `e2b7bf8f4dc637d6c214ca9a59caf872a0927549`, the Phase 17
  implementation commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 15s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the repository's own Compose stack, project `prsystem` (PostgreSQL
  127.0.0.1:55442, Redis 56379); scratch databases `prsystem_test_*` and `prsystem_migration_*`,
  created and dropped by their suites.
- **One cluster, deliberately.** `docker-compose.yml` fixes the project name, and the migration
  suite's schema dump resolves its container through `docker compose ps -q postgres` from the
  checkout root. Turborepo passes only `DATABASE_URL` to a task, so an override naming a different
  container never reaches the test process: the cluster the suites create databases in and the
  cluster the dump reads from have to be the same one.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit e2b7bf8f4dc637d6c214ca9a59caf872a0927549 started 2026-09-06T13:25:21Z; finished
  2026-09-06T13:36:20Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 38s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 12s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 4s |
| `pnpm run lint` | 1 | 0 | 5s |
| `pnpm run typecheck` | 1 | 0 | 10s |
| `pnpm run test:unit` | 1 | 0 | 9s |
| `pnpm run test:migrations` | 1 | 0 | 39s |
| `pnpm run test:integration` | 1 | 0 | 40s |
| `pnpm run test:concurrency` | 1 | 0 | 20s |
| `pnpm run test:concurrency` | 2 | 0 | 20s |
| `pnpm run test:concurrency` | 3 | 0 | 19s |
| `pnpm run test:regression` | 1 | 0 | 19s |
| `pnpm run test:security` | 1 | 0 | 126s |
| `pnpm run test:security` | 2 | 0 | 125s |
| `pnpm run test:security` | 3 | 0 | 125s |
| `pnpm run test:e2e` | 1 | 0 | 12s |
| `pnpm run audit:prod` | 1 | 0 | 0s |
| `pnpm run audit:tree` | 1 | 0 | 2s |
| `pnpm run build` | 1 | 0 | 8s |
| `pnpm run openapi` | 1 | 0 | 2s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0, each on its first attempt. The result counts are in
[phase-17-evidence.json](phase-17-evidence.json) and restated in the evidence table of the Phase 17
record; the two governance rows there are from the final tree, which carries the record and the twelve
new drift-fixture results that govern it.
