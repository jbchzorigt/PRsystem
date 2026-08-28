// The blocking CI contract, in one machine-readable place.
//
// The validator used to require a hand-picked subset of the workflow's commands
// — the regression suite, the two governance validators, a build — so the
// migration, integration, concurrency, E2E or audit stages could disappear
// while validation stayed green. This lists every command each required job
// must run, in the order it must run them.
//
// `run` is matched as an exact executable line. `needsDatabase` requires a
// DATABASE_URL on that step. `cleanup` marks a step that legitimately carries
// `if: always()`, so a teardown still runs after a failure.

export const REQUIRED_JOBS = [
  {
    job: 'governance',
    steps: [
      { run: 'node tools/validate-governance.mjs' },
      { run: 'node tools/validate-workspace.mjs' },
      { run: 'pnpm run validate:regression-coverage' },
      { run: 'pnpm run validate:ci-bypass-fixtures' },
      { run: 'pnpm run validate:governance-fixtures' },
      { run: 'node tools/scan-secrets.mjs' },
    ],
  },
  {
    job: 'verify',
    steps: [
      { run: 'pnpm run format:check' },
      { run: 'pnpm run lint' },
      { run: 'pnpm run typecheck' },
      { run: 'pnpm run test:unit' },
      { run: 'pnpm run build' },
      { run: 'pnpm run openapi' },
      { run: 'pnpm run audit:prod' },
      { run: 'pnpm run audit:tree' },
    ],
  },
  {
    job: 'e2e',
    steps: [
      { run: 'pnpm exec playwright install --with-deps chromium' },
      { run: 'pnpm run test:e2e' },
    ],
  },
  {
    job: 'compose',
    steps: [
      { run: 'docker compose config --quiet' },
      { run: 'docker compose up -d --wait' },
      { run: 'pnpm run build' },
      { run: 'pnpm run test:migrations', needsDatabase: true },
      { run: 'pnpm run test:integration', needsDatabase: true },
      { run: 'pnpm run test:concurrency', needsDatabase: true },
      { run: 'pnpm run test:regression', needsDatabase: true },
      { run: 'pnpm run validate:pool-error-fixture', needsDatabase: true },
      { run: 'docker compose down -v', cleanup: true },
    ],
  },
  {
    job: 'gate-sec',
    steps: [
      { run: 'docker compose up -d --wait' },
      { run: 'pnpm run build' },
      { run: 'pnpm run test:security', needsDatabase: true },
      { run: 'docker compose down -v', cleanup: true },
    ],
  },
];

/** Job names that must exist and must not be disabled by a job-level condition. */
export const REQUIRED_JOB_NAMES = REQUIRED_JOBS.map((entry) => entry.job);
