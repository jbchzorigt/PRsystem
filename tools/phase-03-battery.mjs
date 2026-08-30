// The Phase 03 gate battery, declared independently of any measurement.
//
// The evidence manifest records what was measured. It must not decide what has
// to be measured: manifest, gate-battery block and evidence table could all be
// edited together, and removing `pnpm run test:security` from the three — or
// reducing the battery to `git diff --check` alone — left governance reporting
// 15 of 15. A gate that can be deleted by the document that reports it is not a
// gate.
//
// This list is the requirement. `runs` is the number of times a command must be
// executed for its result to count: the concurrency and security gates are run
// three times so their counts can be compared across runs.

export const REQUIRED_BATTERY = [
  { command: 'node tools/validate-governance.mjs', runs: 1 },
  { command: 'node tools/validate-governance.fixtures.mjs', runs: 1 },
  { command: 'node tools/validate-secret-scan.fixtures.mjs', runs: 1 },
  { command: 'node tools/validate-workspace.mjs', runs: 1 },
  { command: 'node tools/validate-regression-coverage.mjs', runs: 1 },
  { command: 'node tools/validate-regression-coverage.fixtures.mjs', runs: 1 },
  { command: 'node tools/validate-pool-error-fixture.mjs', runs: 1 },
  { command: 'node tools/scan-secrets.mjs', runs: 1 },
  { command: 'pnpm run format:check', runs: 1 },
  { command: 'pnpm run lint', runs: 1 },
  { command: 'pnpm run typecheck', runs: 1 },
  { command: 'pnpm run test:unit', runs: 1 },
  { command: 'pnpm run test:migrations', runs: 1 },
  { command: 'pnpm run test:integration', runs: 1 },
  { command: 'pnpm run test:concurrency', runs: 3 },
  { command: 'pnpm run test:regression', runs: 1 },
  { command: 'pnpm run test:security', runs: 3 },
  { command: 'pnpm run test:e2e', runs: 1 },
  { command: 'pnpm run audit:prod', runs: 1 },
  { command: 'pnpm run audit:tree', runs: 1 },
  { command: 'pnpm run build', runs: 1 },
  { command: 'pnpm run openapi', runs: 1 },
  { command: 'pnpm run compose:config', runs: 1 },
  { command: 'git diff --check', runs: 1 },
];

/** The state Phase 03 is in, and the only state this document may claim. */
export const GOVERNED_STATE = {
  currentPhase: '03 — Platform kernel',
  phaseState: 'SECURITY_REPAIR_REQUIRED',
  customerAcceptance: 'NOT_ACCEPTED',
  nextPhaseState: 'NOT STARTED',
};

/** The manifest's exact key set. Anything else is an unreviewed addition. */
export const MANIFEST_KEYS = [
  'currentPhase',
  'phaseState',
  'customerAcceptance',
  'customerReviewNumber',
  'latestRepairNumber',
  'measuredOnRepairNumber',
  'repairHistory',
  'battery',
];

/** A battery entry's exact key set. */
export const BATTERY_ENTRY_KEYS = ['command', 'executions', 'exits', 'result'];
