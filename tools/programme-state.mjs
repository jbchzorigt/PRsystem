// The programme's governed state, in one neutral module.
//
// Which phases are accepted, which is implemented most recently, and which is
// current are facts about the programme, not about Phase 03 — yet they
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
 * authorization: Phase 05 being `ACCEPTED` says nothing about Phase 06, which
 * stays `NOT STARTED` until it is separately authorized, exactly as Phase 04's
 * acceptance said nothing about Phase 05.
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
   * Phase 05 was authorized, implemented, gated and remediated three times, and
   * the customer has now accepted it. The two facts stay separate and are
   * recorded separately, exactly as Phase 04's are: `DONE` says the work is
   * finished and measured, and the acceptance says the customer has taken it.
   * Only a customer decision — a change to this module — can say either, and the
   * documents that restate them can no more withdraw the acceptance than they
   * could have granted it.
   */
  implementedPhase: '05 — Hotel onboarding and subscription',
  implementedPhaseState: 'DONE',
  implementedPhaseAcceptance: 'ACCEPTED',
  /**
   * The one tree Phase 05's acceptance was given at: the commit that records
   * remediation 3 and its measured evidence. Governed separately from Phase 03's
   * and Phase 04's, and required to differ from both — a copied SHA would let
   * one acceptance stand in for another, and an acceptance with no tree behind
   * it reads as covering whatever HEAD happens to be.
   */
  implementedPhaseAcceptedAtCommit: '35314ba210f609269863f0b528bbe827e6a5d3ce',
  currentPhase: '16 — Verified reviews',
  currentPhaseState: 'NOT STARTED',
};

/**
 * The standing implementation authorization for Phases 06 to 23.
 *
 * On 2026-09-03 the customer authorized the remaining approved phases to be
 * implemented sequentially, each continuing to the next once its blocking
 * gates pass, without a further per-phase "may I proceed". It is recorded here
 * because it changes what `currentPhaseState: 'NOT STARTED'` means: the
 * current phase is authorized to begin, and the commit that completes it is
 * what advances this module. What it does **not** change is written down just
 * as plainly — it is implementation authorization only. No phase it covers is
 * accepted by it, no gate is weakened by it, and no phase is skipped or
 * narrowed under it.
 */
export const PROGRESSION_AUTHORIZATION = {
  grantedOn: '2026-09-03',
  grantedBy: 'customer',
  scope: 'implementation authorization for Phases 06–23, sequential',
  firstPhase: '06',
  lastPhase: '23',
  isCustomerAcceptance: false,
  isReleaseApproval: false,
};

/**
 * The phases completed under that authorization, in order.
 *
 * Each is `DONE` — implemented and measured — and `AWAITING_CUSTOMER_ACCEPTANCE`
 * until the customer accepts it, which would be a change to this entry. Its
 * evidence manifest declares what was measured and on which implementation
 * commit; governance check 17 holds the manifest, the governed state and the
 * `phase-status.md` record to one another the way check 16 holds Phase 05's.
 */
export const PROGRESSED_PHASES = [
  {
    number: '06',
    name: '06 — Hotel, room, category, and tariffs',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-06-evidence.json',
      region: 'phase-06-evidence',
      heading: 'Phase 06 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '07',
    name: '07 — Minibar inventory and templates',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-07-evidence.json',
      region: 'phase-07-evidence',
      heading: 'Phase 07 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '08',
    name: '08 — Availability, guest identity, reception, and stay',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-08-evidence.json',
      region: 'phase-08-evidence',
      heading: 'Phase 08 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '09',
    name: '09 — Cleaner and checkout coordination',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-09-evidence.json',
      region: 'phase-09-evidence',
      heading: 'Phase 09 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '10',
    name: '10 — Folio, deposit, payment, and correction',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-10-evidence.json',
      region: 'phase-10-evidence',
      heading: 'Phase 10 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '11',
    name: '11 — Shift, cash drawer, expense, and hotel finance',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-11-evidence.json',
      region: 'phase-11-evidence',
      heading: 'Phase 11 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '12',
    name: '12 — Public discovery and Guest authentication',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-12-evidence.json',
      region: 'phase-12-evidence',
      heading: 'Phase 12 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '13',
    name: '13 — Online booking and inventory hold',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-13-evidence.json',
      region: 'phase-13-evidence',
      heading: 'Phase 13 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '14',
    name: '14 — Online payment, refund, commission, and settlement',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-14-evidence.json',
      region: 'phase-14-evidence',
      heading: 'Phase 14 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
  {
    number: '15',
    name: '15 — Restaurant',
    state: 'DONE',
    acceptance: 'AWAITING_CUSTOMER_ACCEPTANCE',
    evidence: {
      manifest: 'phase-15-evidence.json',
      region: 'phase-15-evidence',
      heading: 'Phase 15 record',
      manifestKeys: ['phase', 'phaseState', 'acceptance', 'measuredAtCommit', 'battery'],
    },
  },
];

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
  ...PROGRESSED_PHASES.map((phase) => ({
    number: phase.number,
    name: phase.name,
    state: phase.state,
  })),
  { number: '16', name: GOVERNED_STATE.currentPhase, state: GOVERNED_STATE.currentPhaseState },
];

/**
 * The Phase 05 remediation evidence contract.
 *
 * Phase 05 is implemented and, since the closeout, accepted. Its evidence is a
 * machine-readable manifest of the standing battery as measured on one named
 * implementation commit, validated by governance check 16 the way Phase 03's is
 * by check 15: the manifest declares what was measured, the required battery
 * says what must be, and the document may only restate the manifest. The commit
 * it names is the implementation tree the customer reviewed, so it is required
 * to be a full object name and to differ from the Phase 03 and Phase 04
 * acceptance commits. The acceptance itself is `implementedPhaseAcceptance`
 * above, restated by the manifest and never declared by it.
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
