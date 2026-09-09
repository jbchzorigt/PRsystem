# Phase 19 governed battery — execution log

The per-command record of the governed battery measured for the Phase 19 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-19-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `e913a9aec886c224dacf24b25892f73bf8e3e115`, the Phase 19
  implementation commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 14s). Every gate below ran after it and rebuilt under force.
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
- **Timing:** commit e913a9aec886c224dacf24b25892f73bf8e3e115 started 2026-09-09T05:30:27Z; finished
  2026-09-09T05:42:46Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 1s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 48s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 12s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 3s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 0s |
| `pnpm run format:check` | 1 | 0 | 4s |
| `pnpm run lint` | 1 | 0 | 5s |
| `pnpm run typecheck` | 1 | 0 | 10s |
| `pnpm run test:unit` | 1 | 0 | 10s |
| `pnpm run test:migrations` | 1 | 0 | 42s |
| `pnpm run test:integration` | 1 | 0 | 45s |
| `pnpm run test:concurrency` | 1 | 0 | 24s |
| `pnpm run test:concurrency` | 2 | 0 | 24s |
| `pnpm run test:concurrency` | 3 | 0 | 23s |
| `pnpm run test:regression` | 1 | 0 | 20s |
| `pnpm run test:security` | 1 | 0 | 141s |
| `pnpm run test:security` | 2 | 0 | 140s |
| `pnpm run test:security` | 3 | 0 | 140s |
| `pnpm run test:e2e` | 1 | 0 | 12s |
| `pnpm run audit:prod` | 1 | 0 | 0s |
| `pnpm run audit:tree` | 1 | 0 | 1s |
| `pnpm run build` | 1 | 0 | 9s |
| `pnpm run openapi` | 1 | 0 | 2s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0, each on its first attempt. The result counts are in
[phase-19-evidence.json](phase-19-evidence.json) and restated in the evidence table of the Phase 19
record; the two governance rows there are from the final tree, which carries the record and the
twelve new drift-fixture results that govern it.

`pnpm run audit:tree` reported the same three moderate advisories Phase 18 recorded — `DSR-01` and
`DSR-02` in [dependency-security-register.md](dependency-security-register.md), unchanged and both
still due for review in Phase 22. The gate's threshold is high-and-above, and `pnpm run audit:prod`
is clean.

## What the api suites measured, and why the counts moved

`pnpm run test:unit` is 1,618 rather than Phase 18's 1,595: the Phase 19 domain suite adds 23 pure
tests over the time statuses, the masking, the SMS segment arithmetic, the closed vocabularies and
the RFC 6238 vectors. `pnpm run test:integration` is 607 rather than 579, all of it in the api
project — 559 rather than 531 — which is exactly the 21 Phase 19 integration tests and the 7 HTTP
tests. `pnpm run test:concurrency` is 97 rather than 91: six races over one subscription, one
preview, one code, one contact change and one recovery decision. The 15 Phase 19 security tests are
in `pnpm run test:security`, which reports sub-gates rather than a test count. The two Phase 05
reconciliation suites changed rather than grew: their closures now carry the mandatory provider
reference `OPS-DEC-017` requires.
