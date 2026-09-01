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

/**
 * The state the programme is in, and the only state this document may claim.
 *
 * Phase 03 was accepted by the customer at the review-19 evidence snapshot, so
 * the accepted phase, its state and its acceptance are recorded here — outside
 * the document and outside the manifest that reports them. An acceptance is a
 * customer decision; it is a change to this module, never something a document
 * can declare about itself.
 *
 * `governedReviewNumber` is the final Phase 03 security review. Every mutable
 * pointer to it — the customer review number, the latest repair number, the
 * measured-on label — had to agree only with each other, so rolling all of them
 * back together, or deleting the newest record and rolling every pointer back
 * with it, left nothing to disagree with. It is frozen with the acceptance.
 *
 * `repairRecordState` is the state every repair record was written under. The
 * records are history and keep saying what was true when they were made.
 *
 * `completedPhase` is the most recent phase to have finished; `currentPhase` is
 * the one after it, which has not started. Beginning a phase requires a further
 * explicit authorization and a change to this module — the document cannot
 * advance the programme by editing a cell. An acceptance is not that
 * authorization: Phase 04 being `ACCEPTED` says nothing about Phase 05, which
 * stays `NOT STARTED` until it is separately authorized.
 */
export const GOVERNED_STATE = {
  acceptedPhase: '03 — Platform kernel',
  acceptedPhaseState: 'DONE',
  customerAcceptance: 'ACCEPTED',
  acceptedAtCommit: '3ac74a6244a7c350b7489be05778884a9fe65c3c',
  repairRecordState: 'SECURITY_REPAIR_REQUIRED',
  governedReviewNumber: 19,
  completedPhase: '04 — IAM, tenancy, RBAC, and staff lifecycle',
  completedPhaseState: 'DONE',
  /**
   * Phase 04 is accepted, at the commit named below.
   *
   * `DONE` above says the work is finished and measured; this says the customer
   * has taken it. They remain separate facts recorded separately, and the
   * acceptance — like Phase 03's — is a change to this module and never
   * something a document can declare about itself. `phase-status.md` may
   * restate it and may not withdraw it, move it to another commit, or read it
   * as authorization to begin Phase 05.
   */
  completedPhaseAcceptance: 'ACCEPTED',
  /**
   * The one tree Phase 04's acceptance was given at: the fourth-remediation
   * commit whose battery is recorded in the Phase 04 remediation 4 section.
   * Governed separately from Phase 03's, and required to differ from it — a
   * copied SHA would have made one acceptance stand in for the other.
   */
  completedPhaseAcceptedAtCommit: 'e5fcf19c4164c72106b6d2408f460751ad30685f',
  /**
   * The phase implemented most recently, and its own acceptance.
   *
   * Phase 05 was authorized, implemented and gated; it has **not** been
   * accepted. The two facts stay separate and are recorded separately, exactly
   * as Phase 04's were: `DONE` says the work is finished and measured, and only
   * a customer decision — a change to this module — can say more than that.
   */
  implementedPhase: '05 — Hotel onboarding and subscription',
  implementedPhaseState: 'DONE',
  implementedPhaseAcceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
  currentPhase: '06 — Hotel, room, category, and tariffs',
  currentPhaseState: 'NOT STARTED',
};

/**
 * Every phase whose ledger row and position cell are governed, in ledger order.
 *
 * Derived, so adding a phase to the governed state is one edit rather than
 * three: the phase number is the leading two digits of the name, which is the
 * form the ledger's first column uses.
 */
export const GOVERNED_PHASES = [
  { number: '03', name: GOVERNED_STATE.acceptedPhase, state: GOVERNED_STATE.acceptedPhaseState },
  { number: '04', name: GOVERNED_STATE.completedPhase, state: GOVERNED_STATE.completedPhaseState },
  {
    number: '05',
    name: GOVERNED_STATE.implementedPhase,
    state: GOVERNED_STATE.implementedPhaseState,
  },
  { number: '06', name: GOVERNED_STATE.currentPhase, state: GOVERNED_STATE.currentPhaseState },
];

/** The manifest's exact key set. Anything else is an unreviewed addition. */
export const MANIFEST_KEYS = [
  'acceptedPhase',
  'acceptedPhaseState',
  'customerAcceptance',
  'acceptedAtCommit',
  'customerReviewNumber',
  'latestRepairNumber',
  'measuredOnRepairNumber',
  'repairHistory',
  'battery',
];

/** A battery entry's exact key set. */
export const BATTERY_ENTRY_KEYS = ['command', 'executions', 'exits', 'result'];
