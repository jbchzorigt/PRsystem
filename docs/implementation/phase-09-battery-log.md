# Phase 09 governed battery — execution log

The per-command record of the governed battery measured for the Phase 09 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-08-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `4063ac530ee536bb2cda5c27a1cb2526d22a660a`, the Phase 09 implementation
  commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 14s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the disposable Compose project `prsystem-p06` (PostgreSQL 127.0.0.1:55742,
  Redis 56679); scratch databases `prsystem_test_*`, created and dropped by their suites. The shared
  `prsystem` project was not used.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 4063ac530ee536bb2cda5c27a1cb2526d22a660a started 2026-09-04T07:53:12Z; finished 2026-09-04T08:02:30Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 10s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 11s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 0s |
| `pnpm run format:check` | 1 | 0 | 4s |
| `pnpm run lint` | 1 | 0 | 4s |
| `pnpm run typecheck` | 1 | 0 | 8s |
| `pnpm run test:unit` | 1 | 0 | 8s |
| `pnpm run test:migrations` | 1 | 0 | 31s |
| `pnpm run test:integration` | 1 | 0 | 23s |
| `pnpm run test:concurrency` | 1 | 0 | 12s |
| `pnpm run test:concurrency` | 2 | 0 | 13s |
| `pnpm run test:concurrency` | 3 | 0 | 12s |
| `pnpm run test:regression` | 1 | 0 | 15s |
| `pnpm run test:security` | 1 | 0 | 85s |
| `pnpm run test:security` | 2 | 0 | 84s |
| `pnpm run test:security` | 3 | 0 | 90s |
| `pnpm run test:e2e` | 1 | 0 | 12s |
| `pnpm run audit:prod` | 1 | 0 | 87s |
| `pnpm run audit:tree` | 1 | 0 | 16s |
| `pnpm run build` | 1 | 0 | 9s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 1s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0, each on its first attempt. The result counts are in
[phase-09-evidence.json](phase-09-evidence.json) and restated in the evidence table of the Phase 09
record; the two governance rows there are from the final tree, which carries the record and the
fixtures that govern it.
