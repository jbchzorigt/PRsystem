# Phase 22 governed battery — execution log

The per-command record of the governed battery measured for the Phase 22 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-22-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand. The battery ran twice: the first run, on the implementation commit, was not
green and is recorded first; the second, on the correction commit, is the measured evidence.

## Where and how it ran

- **Trees:** a detached `git worktree` of `4bf8629a1a326deb1cc2a37b096736cd13beba4f`, the Phase 22
  implementation commit, and then of `4575f8d37ec5cc5bbe6d93e29ef5828248688313`, the correction commit
  that sits directly on it; each with a fresh `pnpm install --frozen-lockfile` and no working-tree
  changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command of each run, as
  a CI job's install-and-build step, because a fresh checkout has no `dist` and the db fixtures
  resolve workspace packages from it (first run exit=0 21s; second run exit=0 19s). Every
  gate below ran after it and rebuilt under force.
- **Infrastructure:** the repository's own Compose stack, project `prsystem` (PostgreSQL
  127.0.0.1:55442, Redis 56379, MinIO 59000); scratch databases `prsystem_test_*` and
  `prsystem_migration_*`, the e2e server's `prsystem_test_e2e`, and the S3 test's own bucket, created
  and dropped by their suites. The e2e run started the real API on 127.0.0.1:53200 with its loopback
  console on 53201, the worker's consumers in-process on the real Redis under a run-scoped queue
  prefix, and the five portals as production builds on 53100–53104, all bound and released by
  Playwright's web-server hook; the Chromium build came from the user's Playwright cache. The
  recovery rehearsal and the load measurement are Phase 22 tools, not battery commands; their
  reports are committed beside this log.
- **One cluster, deliberately.** `docker-compose.yml` fixes the project name, and the migration
  suite's schema dump resolves its container through `docker compose ps -q postgres` from the
  checkout root. Turborepo passes only `DATABASE_URL` to a task, so an override naming a different
  container never reaches the test process: the cluster the suites create databases in and the
  cluster the dump reads from have to be the same one.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** first run, commit 4bf8629a1a326deb1cc2a37b096736cd13beba4f started 2026-09-10T01:11:06Z, finished
  2026-09-10T01:27:20Z; second run, commit 4575f8d37ec5cc5bbe6d93e29ef5828248688313 started 2026-09-10T01:28:46Z, finished
  2026-09-10T01:44:48Z.

## First run — implementation commit `4bf8629`, not green

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 71s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 14s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 7s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 0s |
| `pnpm run format:check` | 1 | 0 | 6s |
| `pnpm run lint` | 1 | 0 | 6s |
| `pnpm run typecheck` | 1 | 0 | 11s |
| `pnpm run test:unit` | 1 | 0 | 11s |
| `pnpm run test:migrations` | 1 | 0 | 47s |
| `pnpm run test:integration` | 1 | 0 | 51s |
| `pnpm run test:concurrency` | 1 | 0 | 29s |
| `pnpm run test:concurrency` | 2 | 0 | 29s |
| `pnpm run test:concurrency` | 3 | 0 | 28s |
| `pnpm run test:regression` | 1 | 1 | 24s |
| `pnpm run test:security` | 1 | 1 | 177s |
| `pnpm run test:security` | 2 | 1 | 178s |
| `pnpm run test:security` | 3 | 1 | 183s |
| `pnpm run test:e2e` | 1 | 0 | 61s |
| `pnpm run audit:prod` | 1 | 0 | 1s |
| `pnpm run audit:tree` | 1 | 0 | 1s |
| `pnpm run build` | 1 | 0 | 13s |
| `pnpm run openapi` | 1 | 0 | 1s |
| `pnpm run compose:config` | 1 | 0 | 1s |
| `git diff --check` | 1 | 0 | 0s |

Four of the 28 executions exited 1, all for the same cause: migration `0021_stay_booking_ref_text`
retyped `booking_ref` on `platform.stay` and `platform.booking_fulfillment_conflict` to text with a
shape check and lengthened the journal to 22, and two test fixtures had not followed.
`pnpm run test:regression` failed `R2` and `E3` of the Phase 03 regression suite, which asserted a
21-entry journal (`2 failed | 49 passed (51)`). The three `pnpm run test:security` runs reported
`17/20 sub-gates passed, 3 FAILED`: `SEC-REGRESSION` for the same two tests, and `SEC-RLS` (379
skipped) and `SEC-ACL-MATRIX` (1910 skipped) because the tenant-row seed for
`booking_fulfillment_conflict` wrote `gen_random_uuid()` into `booking_ref`, the new check refused
the row, the suites' `beforeAll` threw, and `tools/gate-sec.mjs` counts a skipped suite as a failure.
Every other execution — including `pnpm run test:e2e` at 130 passed and the migration suite at 148,
which applies `0021` on the fresh and upgrade paths — exited 0. The correction commit changes the two
fixtures and nothing else; no gate, threshold or configuration was touched.

## Second run — correction commit `4575f8d`, the measured evidence

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 69s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 15s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 6s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 1s |
| `pnpm run format:check` | 1 | 0 | 6s |
| `pnpm run lint` | 1 | 0 | 6s |
| `pnpm run typecheck` | 1 | 0 | 11s |
| `pnpm run test:unit` | 1 | 0 | 12s |
| `pnpm run test:migrations` | 1 | 0 | 49s |
| `pnpm run test:integration` | 1 | 0 | 53s |
| `pnpm run test:concurrency` | 1 | 0 | 28s |
| `pnpm run test:concurrency` | 2 | 0 | 30s |
| `pnpm run test:concurrency` | 3 | 0 | 32s |
| `pnpm run test:regression` | 1 | 0 | 28s |
| `pnpm run test:security` | 1 | 0 | 173s |
| `pnpm run test:security` | 2 | 0 | 171s |
| `pnpm run test:security` | 3 | 0 | 172s |
| `pnpm run test:e2e` | 1 | 0 | 61s |
| `pnpm run audit:prod` | 1 | 0 | 0s |
| `pnpm run audit:tree` | 1 | 0 | 2s |
| `pnpm run build` | 1 | 0 | 13s |
| `pnpm run openapi` | 1 | 0 | 2s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0. The result counts are in
[phase-22-evidence.json](phase-22-evidence.json) and restated in the evidence table of the Phase 22
record; the two governance rows there are from the final tree, which carries the record and the
new drift-fixture results that govern it.

`pnpm run audit:tree` reported the same three moderate advisories Phase 20 recorded — `DSR-01` and
`DSR-02` in [dependency-security-register.md](dependency-security-register.md), reviewed this phase
and still `OPEN — contained`. The gate's threshold is high-and-above, and `pnpm run audit:prod` is
clean; Phase 22 added no dependency.

## What the suites measured, and why the counts moved

`pnpm run test:unit` is 1,699 across 12 projects rather than Phase 21's 1,694: `@prsystem/testing`
adds the five concurrency-coverage tests (every idempotent command discovered from the route table
is raced by a named suite or excused for a recorded reason; an unlisted command, a stale entry and a
suite that names no such test each fail). `pnpm run test:integration` is 621 rather than 613: the
api project adds the five degraded-mode injections (Redis, provider, ХУР, SMS, object storage) and
three billing and checkout tests for the folio-backed payment attempts and the zero-amount lock.
`pnpm run test:e2e` is 130 rather than 99: 43 flows at each of the three profiles — the 33 Phase 21
flows, the four full journeys (booking to settlement, check-in to Police alert, the subscription
lanes, onboarding to the shift count) and the security-header checks of the API and the five portals
— plus the one leakage project that scans the run's own database, API log and Redis for 81 canaries
after the three profiles finish. `pnpm run test:migrations` stays at 148 with `0021` on every path.
`node tools/scan-secrets.mjs` indexes 1,014 files rather than 990, the new tools, suites and reports.
Lint, build, typecheck, concurrency (97 each run), regression (51) and `GATE-SEC` (20 of 20 each
run) are unchanged in count.
