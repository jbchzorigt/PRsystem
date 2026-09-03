// The programme's governed state, in one neutral module.
//
// Which phase is accepted, which is implemented and awaiting the customer, and
// which is current are facts about the programme, not about Phase 03 — yet they
// used to live in `phase-03-battery.mjs`, so every later phase extended the
// evidence owner of a closed phase. They live here now. `phase-03-battery.mjs`
// keeps only what Phase 03 owns: its required battery and its manifest shape.
//
// Nothing in this module is derived from a document. A document may restate
// what is declared here and may not contradict it; changing the programme's
// state is a change to this module, made on explicit authorization.

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

/**
 * The Phase 05 remediation evidence contract.
 *
 * Phase 05 is implemented and not accepted. Its evidence is a machine-readable
 * manifest of the standing battery as measured on one named implementation
 * commit, validated by governance check 16 the way Phase 03's is by check 15:
 * the manifest declares what was measured, the required battery says what must
 * be, and the document may only restate the manifest. The commit it names is
 * the implementation tree the customer reviews, so it is required to be a full
 * object name and to differ from every accepted commit.
 */
export const PHASE_05_EVIDENCE = {
  /** The bounded region in `phase-status.md`: `<!-- phase-05-evidence:begin/end -->`. */
  region: 'phase-05-evidence',
  /** The H2 under which the region must sit. */
  heading: 'Phase 05 remediation 3',
  /** The remediation this evidence measures; the manifest must agree. */
  remediationNumber: 3,
  /** The manifest's exact key set. */
  manifestKeys: [
    'phase',
    'phaseState',
    'acceptance',
    'remediationNumber',
    'measuredAtCommit',
    'battery',
  ],
};
