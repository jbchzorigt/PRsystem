# Phase 07 governed battery — execution log

The per-command record of the governed battery measured for the Phase 07 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-07-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `0b408205cd337aec26c70c7607a8e68b3aedbac2`, the Phase 07
  implementation tree (the implementation commit and its registry fix), with a fresh
  `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 13s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the disposable Compose project `prsystem-p06` (PostgreSQL 127.0.0.1:55742,
  Redis 56679); scratch databases `prsystem_test_*`, created and dropped by their suites. The shared
  `prsystem` project was not used.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 0b408205cd337aec26c70c7607a8e68b3aedbac2 started 2026-09-04T01:33:37Z; finished 2026-09-04T01:48:42Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 5s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 10s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 5s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 3s |
| `pnpm run lint` | 1 | 0 | 3s |
| `pnpm run typecheck` | 1 | 0 | 7s |
| `pnpm run test:unit` | 1 | 0 | 7s |
| `pnpm run test:migrations` | 1 | 0 | 28s |
| `pnpm run test:integration` | 1 | 0 | 21s |
| `pnpm run test:concurrency` | 1 | 0 | 10s |
| `pnpm run test:concurrency` | 2 | 0 | 11s |
| `pnpm run test:concurrency` | 3 | 0 | 11s |
| `pnpm run test:regression` | 1 | 0 | 14s |
| `pnpm run test:security` | 1 | 0 | 77s |
| `pnpm run test:security` | 2 | 0 | 76s |
| `pnpm run test:security` | 3 | 0 | 76s |
| `pnpm run test:e2e` | 1 | 0 | 12s |
| `pnpm run audit:prod` | 1 | 1 | 250s |
| `pnpm run audit:tree` | 1 | 1 | 251s |
| `pnpm run build` | 1 | 0 | 9s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 1s |
| `git diff --check` | 1 | 0 | 0s |
| `pnpm run audit:prod` | 2 | 0 | 48s |
| `pnpm run audit:tree` | 2 | 1 | 251s |
| `pnpm run audit:tree` | 3 | 1 | 251s |
| `pnpm run audit:tree` | 4 | 1 | 251s |
| `pnpm run audit:tree` | 5 | 1 | 251s |
| `pnpm run audit:tree` | 6 | 1 | 250s |
| `pnpm run audit:tree` | 7 | 1 | 251s |
| `pnpm run audit:tree` | 8 | 1 | 250s |
| `pnpm run audit:tree` | 9 | 1 | 251s |
| `pnpm run audit:tree` | 10 | 1 | 251s |
| `pnpm run audit:tree` | 11 | 1 | 250s |
| `pnpm run audit:tree` | 12 | 0 | 17s |

28 of 40 executions exited 0. The 12 that did not — earlier attempts of
`pnpm run audit:prod` and `pnpm run audit:tree` — failed before any audit ran: the request to the npm
registry's audit endpoint timed out (`ERR_SOCKET_TIMEOUT`, after pnpm's own retries) or was answered
`503 Service Unavailable`. Each was executed again in the same tree, against the same lockfile — from
the fourth `audit:tree` attempt with `npm_config_fetch_timeout=540000` and
`npm_config_fetch_retries=1`, noted at the top of those logs — until the registry answered; those
last executions are the ones the manifest records, and it says so. The result counts each produced are in
[phase-07-evidence.json](phase-07-evidence.json) and restated in the evidence table of the Phase 07
record; the two governance rows there are from the final tree, which carries the record and the
fixtures that govern it.
