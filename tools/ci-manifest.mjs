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
// `if: always()`, so a teardown still runs after a failure. `beforeInstall`
// marks a step that must run before `pnpm install --frozen-lockfile`: a
// dependency lifecycle script runs arbitrary code with the checkout in place,
// so the first look at HEAD and the index has to happen while nothing from the
// dependency tree has executed.

/**
 * The exact environment the workflow may declare, per level.
 *
 * A deny-list of dangerous variables is endless and was wrong: with
 * `NODE_OPTIONS: --require=./tools/bypass-scan.cjs` on the scan step, a preload
 * called `process.exit(0)` and a repository with a committed credential went
 * from exit 1 to exit 0 with no output, while coverage validation still reported
 * 657 of 657. Process startup, module resolution and executable resolution are
 * all reachable through the environment, so what may be set is listed instead of
 * what may not.
 *
 * Job level is empty on purpose: a job-level variable reaches every step in it,
 * including the scan.
 */
export const ALLOWED_ENV = {
  workflow: ['NODE_VERSION', 'PNPM_VERSION'],
  job: [],
  /** Steps that talk to PostgreSQL carry its URL and nothing else. */
  step: ['DATABASE_URL'],
  /** The pre-install scan carries nothing at all. */
  scanStep: [],
};

export const REQUIRED_JOBS = [
  {
    job: 'governance',
    steps: [
      { run: 'node tools/scan-secrets.mjs', beforeInstall: true },
      { run: 'node tools/validate-governance.mjs' },
      { run: 'node tools/validate-workspace.mjs' },
      { run: 'pnpm run validate:regression-coverage' },
      { run: 'pnpm run validate:ci-bypass-fixtures' },
      { run: 'pnpm run validate:governance-fixtures' },
      { run: 'pnpm run validate:secret-scan-fixtures' },
      { run: 'node tools/scan-secrets.mjs' },
    ],
  },
  {
    job: 'verify',
    steps: [
      { run: 'node tools/scan-secrets.mjs', beforeInstall: true },
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
      { run: 'node tools/scan-secrets.mjs', beforeInstall: true },
      { run: 'pnpm exec playwright install --with-deps chromium' },
      { run: 'pnpm run test:e2e' },
    ],
  },
  {
    job: 'compose',
    steps: [
      { run: 'node tools/scan-secrets.mjs', beforeInstall: true },
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
      { run: 'node tools/scan-secrets.mjs', beforeInstall: true },
      { run: 'docker compose up -d --wait' },
      { run: 'pnpm run build' },
      { run: 'pnpm run test:security', needsDatabase: true },
      { run: 'docker compose down -v', cleanup: true },
    ],
  },
];

/** Job names that must exist and must not be disabled by a job-level condition. */
export const REQUIRED_JOB_NAMES = REQUIRED_JOBS.map((entry) => entry.job);
