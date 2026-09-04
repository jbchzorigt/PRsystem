# Phase 08 governed battery — execution log

The per-command record of the governed battery measured for the Phase 08 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-08-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `5b3603ab6bf5b2baa1099f4d239e5a0b397f5ec1`, the Phase 08 correction
  commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes. The
  implementation commit `621e17db9d40523c545e35c0d72b2b814508a874` was measured first and **failed**:
  its second `pnpm run test:concurrency` execution let a walk-in and an assignment both take one
  room, because a booking commitment was read as its start instant rather than as an interval.
  That run is not evidence, none of its counts are used anywhere, and the correction is what is
  measured here.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 15s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the disposable Compose project `prsystem-p06` (PostgreSQL 127.0.0.1:55742,
  Redis 56679); scratch databases `prsystem_test_*`, created and dropped by their suites. The shared
  `prsystem` project was not used.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 5b3603ab6bf5b2baa1099f4d239e5a0b397f5ec1 started 2026-09-04T06:46:49Z; finished 2026-09-04T06:58:29Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 7s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 11s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 3s |
| `pnpm run lint` | 1 | 0 | 4s |
| `pnpm run typecheck` | 1 | 0 | 9s |
| `pnpm run test:unit` | 1 | 0 | 8s |
| `pnpm run test:migrations` | 1 | 0 | 30s |
| `pnpm run test:integration` | 1 | 0 | 22s |
| `pnpm run test:concurrency` | 1 | 0 | 13s |
| `pnpm run test:concurrency` | 2 | 0 | 12s |
| `pnpm run test:concurrency` | 3 | 0 | 13s |
| `pnpm run test:regression` | 1 | 0 | 15s |
| `pnpm run test:security` | 1 | 0 | 85s |
| `pnpm run test:security` | 2 | 0 | 85s |
| `pnpm run test:security` | 3 | 0 | 83s |
| `pnpm run test:e2e` | 1 | 0 | 12s |
| `pnpm run audit:prod` | 1 | 1 | 251s |
| `pnpm run audit:tree` | 1 | 0 | 2s |
| `pnpm run build` | 1 | 0 | 9s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 1s |
| `pnpm run audit:prod` | 2 | 0 | 104s |

28 of 29 executions exited 0. The 1 that did not — earlier attempts of the
dependency audits — did not run an audit at all: the request to the npm registry's audit endpoint
timed out (`ERR_SOCKET_TIMEOUT`, after pnpm's own retries) or was answered `503 Service
Unavailable`. Each was executed again in the same tree, against the same lockfile, until the
registry answered; those last executions are the ones the manifest records, and it says so. The
result counts are in [phase-08-evidence.json](phase-08-evidence.json) and restated in the evidence
table of the Phase 08 record; the two governance rows there are from the final tree, which carries
the record and the fixtures that govern it.
