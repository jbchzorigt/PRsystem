# Phase 21 governed battery — execution log

The per-command record of the governed battery measured for the Phase 21 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-21-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `357df68be65a55126d135a46059a3f3eb9aebb43`, the Phase 21
  implementation commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit=0 13s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the repository's own Compose stack, project `prsystem` (PostgreSQL
  127.0.0.1:55442, Redis 56379, MinIO 59000); scratch databases `prsystem_test_*` and
  `prsystem_migration_*`, the e2e server's `prsystem_test_e2e`, and the S3 test's own bucket, created
  and dropped by their suites. The e2e run started the real API on 127.0.0.1:53200 with its loopback
  console on 53201 and the five portals as production builds on 53100–53104, all bound and released
  by Playwright's web-server hook; the Chromium build came from the user's Playwright cache.
- **One cluster, deliberately.** `docker-compose.yml` fixes the project name, and the migration
  suite's schema dump resolves its container through `docker compose ps -q postgres` from the
  checkout root. Turborepo passes only `DATABASE_URL` to a task, so an override naming a different
  container never reaches the test process: the cluster the suites create databases in and the
  cluster the dump reads from have to be the same one.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 357df68be65a55126d135a46059a3f3eb9aebb43 started 2026-09-09T11:23:16Z; finished
  2026-09-09T11:37:59Z.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 1s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 60s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 13s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 3s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 5s |
| `pnpm run lint` | 1 | 0 | 6s |
| `pnpm run typecheck` | 1 | 0 | 10s |
| `pnpm run test:unit` | 1 | 0 | 11s |
| `pnpm run test:migrations` | 1 | 0 | 44s |
| `pnpm run test:integration` | 1 | 0 | 47s |
| `pnpm run test:concurrency` | 1 | 0 | 26s |
| `pnpm run test:concurrency` | 2 | 0 | 26s |
| `pnpm run test:concurrency` | 3 | 0 | 26s |
| `pnpm run test:regression` | 1 | 0 | 22s |
| `pnpm run test:security` | 1 | 0 | 157s |
| `pnpm run test:security` | 2 | 0 | 168s |
| `pnpm run test:security` | 3 | 0 | 162s |
| `pnpm run test:e2e` | 1 | 0 | 54s |
| `pnpm run audit:prod` | 1 | 0 | 1s |
| `pnpm run audit:tree` | 1 | 0 | 0s |
| `pnpm run build` | 1 | 0 | 20s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0. The result counts are in
[phase-21-evidence.json](phase-21-evidence.json) and restated in the evidence table of the Phase 21
record; the two governance rows there are from the final tree, which carries the record and the
new drift-fixture results that govern it.

`pnpm run audit:tree` reported the same three moderate advisories Phase 20 recorded — `DSR-01` and
`DSR-02` in [dependency-security-register.md](dependency-security-register.md), both due for review
in Phase 22. The gate's threshold is high-and-above, and `pnpm run audit:prod` is clean; the one
dependency this phase added, `@axe-core/playwright`, is a root development dependency and carries no
advisory.

## What the suites measured, and why the counts moved

`pnpm run test:unit` is 1,694 across 12 projects rather than Phase 20's 1,671 across 11:
`@prsystem/web-kit` is new with 16 (the HTTP client over a fake transport — prefix, query, bearer
and idempotency headers, the error envelope, a non-JSON failure, an empty success, a transport
failure that names no URL, the timeout — the form helpers and the formatters), and
`@prsystem/testing` adds 7 (the web boundary: every web import scanned, the kit's dependency list,
the lint rule firing on four crossings and staying quiet on the allowed two). `pnpm run test:e2e`
is 99 rather than 15: the Phase 02 shell smoke tests are replaced by 33 flows — the shell identity
of each portal, the Hotel, Guest, Restaurant, Police and Operation journeys, and the axe scan of
every primary screen — each run at a phone, a tablet and a desktop profile against the real API.
`pnpm run lint` and `pnpm run build` count 18 projects and `pnpm run typecheck` 30 graphs, one more
each for the kit. Migrations, integration, concurrency, regression and `GATE-SEC` are unchanged in
count; the API's two additions — the session projection and the case revision — are covered by the
existing iam and police suites, which pass at their previous counts.
