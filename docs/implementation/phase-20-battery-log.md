# Phase 20 governed battery — execution log

The per-command record of the governed battery measured for the Phase 20 evidence, kept in the
repository so the manifest and the evidence table in [phase-status.md](phase-status.md#phase-20-record)
are not the only copy. Every value below was written by the runner as each command exited; nothing
was transcribed by hand.

## Where and how it ran

- **Tree:** a detached `git worktree` of `361b116b9c1e6901dd6c9506ff1050ff267926a7`, the Phase 20
  correction commit, with a fresh `pnpm install --frozen-lockfile` and no working-tree changes.
- **Execution:** every Turborepo task executed — `TURBO_CACHE_DIR` pointed at an empty directory
  and `TURBO_FORCE=true` for the whole run, so nothing was replayed from this checkout's cache or the
  main checkout's, which a git worktree would otherwise share; every Turborepo summary in the logs
  reads `0 cached`.
- **Preparation, not evidence:** a single `pnpm run build` before the first command, as a CI job's
  install-and-build step, because a fresh checkout has no `dist` and the db fixtures resolve
  workspace packages from it (exit 0, 17s). Every gate below ran after it and rebuilt under force.
- **Infrastructure:** the repository's own Compose stack, project `prsystem` (PostgreSQL
  127.0.0.1:55442, Redis 56379, MinIO 59000 — the last now exercised for real by the ports
  integration suite); scratch databases `prsystem_test_*` and `prsystem_migration_*`, and a bucket
  of the S3 test's own, created and dropped by their suites.
- **One cluster, deliberately.** `docker-compose.yml` fixes the project name, and the migration
  suite's schema dump resolves its container through `docker compose ps -q postgres` from the
  checkout root. Turborepo passes only `DATABASE_URL` to a task, so an override naming a different
  container never reaches the test process: the cluster the suites create databases in and the
  cluster the dump reads from have to be the same one.
- **Not a hosted CI run:** one local machine, one clone, sequential commands. It is a fresh local
  replay of the required battery, not the GitHub workflow.
- **Timing:** commit 361b116b9c1e6901dd6c9506ff1050ff267926a7 started 2026-09-09T06:47:27Z; finished
  2026-09-09T07:01:10Z.

## The first attempt, and why there were two

The battery was first run on the implementation commit `ccbf60272d9f1c05fb298a9c25f2ad3270f96d07`
(started 2026-09-09T06:35:08Z). Three of its 28 executions exited 1 and 25 exited 0. All three
failures were one cause: `tools/scan-secrets.mjs` reported eight findings — seven `aws-access-key`
hits on `AKIAIOSFODNN7EXAMPLE`, the access key id the S3 API Reference prints beside its published
SigV4 signatures and which the vector test must carry verbatim, and one `generic-assignment` on the
S3 unit test's canary constant. `validate-secret-scan.fixtures.mjs` failed as its control that the
repository is clean, and `pnpm run test:security` failed at that same step, before `GATE-SEC`
itself ran. The correction `361b116` allow-lists the documentation key id as an exact value — the
scanner's designed mechanism for a public fixture — and renames the canary. Nothing else changed,
the battery was re-run in full on the correction, and the table below is that run.

## Commands, in the required order

| Command | Run | Exit | Duration |
| --- | ---: | ---: | ---: |
| `node tools/validate-governance.mjs` | 1 | 0 | 0s |
| `node tools/validate-governance.fixtures.mjs` | 1 | 0 | 57s |
| `node tools/validate-secret-scan.fixtures.mjs` | 1 | 0 | 14s |
| `node tools/validate-workspace.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.mjs` | 1 | 0 | 0s |
| `node tools/validate-regression-coverage.fixtures.mjs` | 1 | 0 | 2s |
| `node tools/validate-pool-error-fixture.mjs` | 1 | 0 | 7s |
| `node tools/scan-secrets.mjs` | 1 | 0 | 0s |
| `pnpm run format:check` | 1 | 0 | 6s |
| `pnpm run lint` | 1 | 0 | 5s |
| `pnpm run typecheck` | 1 | 0 | 12s |
| `pnpm run test:unit` | 1 | 0 | 11s |
| `pnpm run test:migrations` | 1 | 0 | 44s |
| `pnpm run test:integration` | 1 | 0 | 49s |
| `pnpm run test:concurrency` | 1 | 0 | 26s |
| `pnpm run test:concurrency` | 2 | 0 | 26s |
| `pnpm run test:concurrency` | 3 | 0 | 26s |
| `pnpm run test:regression` | 1 | 0 | 22s |
| `pnpm run test:security` | 1 | 0 | 158s |
| `pnpm run test:security` | 2 | 0 | 157s |
| `pnpm run test:security` | 3 | 0 | 158s |
| `pnpm run test:e2e` | 1 | 0 | 13s |
| `pnpm run audit:prod` | 1 | 0 | 0s |
| `pnpm run audit:tree` | 1 | 0 | 1s |
| `pnpm run build` | 1 | 0 | 10s |
| `pnpm run openapi` | 1 | 0 | 2s |
| `pnpm run compose:config` | 1 | 0 | 0s |
| `git diff --check` | 1 | 0 | 0s |

All 28 executions exited 0. The result counts are in
[phase-20-evidence.json](phase-20-evidence.json) and restated in the evidence table of the Phase 20
record; the two governance rows there are from the final tree, which carries the record and the
new drift-fixture results that govern it.

`pnpm run audit:tree` reported the same three moderate advisories Phase 19 recorded — `DSR-01` and
`DSR-02` in [dependency-security-register.md](dependency-security-register.md); `DSR-01` received its
mandatory Phase 20 review and stays contained, and both are due for review in Phase 22. The gate's
threshold is high-and-above, and `pnpm run audit:prod` is clean.

## What the suites measured, and why the counts moved

`pnpm run test:unit` is 1,671 rather than Phase 19's 1,618: `@prsystem/ports` adds 37 (the gate
register against the document, the three AWS SigV4 vectors, the Secret wrapper, the CIDR allowlist,
the outbound client and its token bucket, the selector's rules and the S3 adapter over a fake
transport); `@prsystem/config` adds 11 and moves two; `@prsystem/worker` adds 5. `pnpm run
test:integration` is 613 rather than 607: `@prsystem/ports` gains a suite of 3 against MinIO — put,
presigned fetch by a plain client, delete, `NoSuchKey` and `SignatureDoesNotMatch` — and the api
gains the 3 settlement-worker runtime tests over real PostgreSQL. `pnpm run test:security` now
reports **20** sub-gates: `SEC-ADAPTERS` is new, and `SEC-STARTUP`, `SEC-STARTUP-WORKER` and
`SEC-SECRETS` grew — the callback source guard, the worker's adapter precondition, and the
document-to-database gate agreement. Concurrency, migrations, regression and e2e are unchanged.
