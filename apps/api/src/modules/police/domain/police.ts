/**
 * The Police rules that are arithmetic and vocabulary rather than storage
 * (doc 13). Everything here is pure, so the parts of the phase that are easiest
 * to get wrong — which state may follow which, who may decide what, what a
 * Match SMS is allowed to contain — can be read and tested without a database.
 */

/** doc 13 §7. `FOUND` is not among them: it is a match outcome, never a case state. */
export const CASE_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
  'CANCELLED',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** doc 13 §9. Workflow and outcome are separate fields and separate questions. */
export const MATCH_WORKFLOW = ['NEW', 'ACKNOWLEDGED', 'UNDER_REVIEW', 'RESOLVED'] as const;
export type MatchWorkflow = (typeof MATCH_WORKFLOW)[number];

export const MATCH_OUTCOMES = ['NONE', 'FOUND', 'FALSE_MATCH', 'LOCATION_STALE'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export const FALSE_MATCH_REASONS = [
  'WRONG_NUMBER_ENTERED',
  'IDENTIFIER_USED_BY_ANOTHER',
  'IDENTITY_DISPROVED',
  'OTHER_VERIFIED_REASON',
] as const;
export type FalseMatchReason = (typeof FALSE_MATCH_REASONS)[number];

/**
 * `DRAFT → PENDING_APPROVAL → ACTIVE ↔ SUSPENDED → CLOSED/CANCELLED`
 * (doc 13 §7, `POL-DEC-018`). `CLOSED` and `CANCELLED` are terminal, which is
 * why nothing leads out of them.
 */
const CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'ACTIVE', 'CANCELLED'],
  PENDING_APPROVAL: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['SUSPENDED', 'CLOSED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export function caseTransitionAllowed(from: CaseState, to: CaseState): boolean {
  return (CASE_TRANSITIONS[from] ?? []).includes(to);
}

/** A case that is terminal never moves again, and never matches again. */
export function isTerminalCase(state: CaseState): boolean {
  return state === 'CLOSED' || state === 'CANCELLED';
}

/** Only an `ACTIVE` case takes part in matching (doc 13 §7). */
export function participatesInMatching(state: CaseState): boolean {
  return state === 'ACTIVE';
}

/**
 * doc 13 §9: the workflow a match may move to.
 *
 * Acknowledgement is the only way out of `NEW`, review follows acknowledgement,
 * and `RESOLVED` is reached by an outcome rather than by a state change of its
 * own — which is why nothing here leads to it.
 */
const WORKFLOW_TRANSITIONS: Readonly<Record<MatchWorkflow, readonly MatchWorkflow[]>> = {
  NEW: ['ACKNOWLEDGED'],
  ACKNOWLEDGED: ['UNDER_REVIEW'],
  UNDER_REVIEW: [],
  RESOLVED: [],
};

export function workflowTransitionAllowed(from: MatchWorkflow, to: MatchWorkflow): boolean {
  return (WORKFLOW_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * `POL-DEC-019`: a False Match cannot be approved over a Found.
 *
 * The Found has to be corrected first, by its own two-person workflow, and the
 * match has to be back where it was before it — otherwise a single approval
 * would quietly undo somebody's confirmed identification.
 */
export function falseMatchApprovable(outcome: MatchOutcome): boolean {
  return outcome !== 'FOUND';
}

/**
 * `POL-DEC-015`, `POL-DEC-019`, `POL-DEC-018`: two people, compared on
 * immutable account ids.
 *
 * It fails closed on an unknown counterpart: an approver whose requester could
 * not be loaded is not thereby a different person.
 */
export function separateAccounts(requester: string | undefined, approver: string): boolean {
  return requester !== undefined && requester.length > 0 && requester !== approver;
}

/** The state a match returns to when a Found is corrected away (doc 13 §9.2). */
export function workflowAfterFoundCorrection(): MatchWorkflow {
  return 'UNDER_REVIEW';
}

/**
 * doc 13 §10.2: what a Match SMS may say.
 *
 * The full registration number and nothing else that identifies: no name, no
 * case, no hotel, no room, no address, no map. The body is fixed so that what
 * crosses to the provider is a template and one value, and a future caller
 * cannot widen it by passing a longer string.
 */
export function matchSmsBody(registrationNumber: string): string {
  return [
    `Шинэ Match alert. РД: ${registrationNumber}.`,
    'Police portal-д нэвтэрч шалгана уу.',
  ].join('\n');
}

/**
 * The mask a delivery row and an audit payload may keep (doc 13 §10.2).
 *
 * Four digits at most, and never the whole number: enough for an operator to
 * tell two alerts apart, not enough to be the identifier.
 */
export function maskRegistrationNumber(registrationNumber: string): string {
  const digits = registrationNumber.replace(/\D/gu, '');
  const tail = digits.slice(-4);
  return `${'*'.repeat(Math.max(4, registrationNumber.length - tail.length))}${tail}`;
}

/** doc 13 §12.2: the default export masks the number; two permissions unmask it. */
export function exportIdentifier(registrationNumber: string, full: boolean): string {
  return full ? registrationNumber : maskRegistrationNumber(registrationNumber);
}

/**
 * doc 13 §4.1: a historical check-in search is at most 31 days, and both bounds
 * and a reason are mandatory. A window that is inverted, empty or longer is
 * refused rather than clamped — clamping would answer a question nobody asked.
 */
export const MAX_HISTORICAL_WINDOW_DAYS = 31;

export type WindowRefusal = 'RANGE_REQUIRED' | 'RANGE_INVERTED' | 'RANGE_TOO_LONG';

export function refuseHistoricalWindow(
  from: Date | undefined,
  to: Date | undefined,
): WindowRefusal | undefined {
  if (from === undefined || to === undefined) return 'RANGE_REQUIRED';
  if (to.getTime() <= from.getTime()) return 'RANGE_INVERTED';
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_HISTORICAL_WINDOW_DAYS) return 'RANGE_TOO_LONG';
  return undefined;
}

/** doc 13 §5.3: the four-digit bootstrap code's fixed compensating controls. */
export const CODE_TTL_MINUTES = 5;
export const CODE_MAX_ATTEMPTS = 3;
export const CODE_LOCK_MINUTES = 30;
export const CODE_RESEND_SECONDS = 60;
export const CODE_ISSUES_PER_15_MINUTES = 3;
export const CODE_ISSUES_PER_DAY = 5;

export function codeExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + CODE_TTL_MINUTES * 60_000);
}

export function lockUntil(failedAt: Date): Date {
  return new Date(failedAt.getTime() + CODE_LOCK_MINUTES * 60_000);
}

export type CodeRefusal =
  'CODE_EXPIRED' | 'CODE_CONSUMED' | 'CODE_INVALIDATED' | 'CODE_LOCKED' | 'CODE_ATTEMPTS_EXHAUSTED';

export interface CodeState {
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly lockedUntil: Date | null;
}

/** Whether a stored code may be tried at all, before its digest is compared. */
export function refuseCode(state: CodeState, now: Date): CodeRefusal | undefined {
  if (state.consumedAt !== null) return 'CODE_CONSUMED';
  if (state.invalidatedAt !== null) return 'CODE_INVALIDATED';
  if (state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()) {
    return 'CODE_LOCKED';
  }
  if (state.attempts >= CODE_MAX_ATTEMPTS) return 'CODE_ATTEMPTS_EXHAUSTED';
  if (state.expiresAt.getTime() <= now.getTime()) return 'CODE_EXPIRED';
  return undefined;
}

/** doc 13 §5.3: a resend is refused inside the minute, and capped per window. */
export function refuseIssue(
  issuedAt: readonly Date[],
  now: Date,
): 'RESEND_TOO_SOON' | 'ISSUE_LIMIT_15_MINUTES' | 'ISSUE_LIMIT_DAY' | undefined {
  const last = issuedAt[0];
  if (last !== undefined && now.getTime() - last.getTime() < CODE_RESEND_SECONDS * 1000) {
    return 'RESEND_TOO_SOON';
  }
  const within = (minutes: number): number =>
    issuedAt.filter((at) => now.getTime() - at.getTime() < minutes * 60_000).length;
  if (within(15) >= CODE_ISSUES_PER_15_MINUTES) return 'ISSUE_LIMIT_15_MINUTES';
  if (within(24 * 60) >= CODE_ISSUES_PER_DAY) return 'ISSUE_LIMIT_DAY';
  return undefined;
}

/**
 * A Mongolian registration number, normalized the one way the platform
 * normalizes it (doc 05 §3, doc 13 §8.1).
 *
 * The rule is restated here rather than imported from the stay module because a
 * module never reaches into another's code (CLAUDE.md §3) — and because the two
 * are the same rule for different reasons: the hotel side validates what a
 * receptionist typed, and this side validates what an officer is searching for.
 * If the national format ever changes, both change, and both have tests.
 */
const REGISTRATION_NUMBER = /^[А-ЯЁӨҮ]{2}\d{8}$/u;

export function normalizeRegistrationNumber(raw: string): string {
  return raw.replace(/\s+/gu, '').toUpperCase();
}

export function isStructurallyValidRegistrationNumber(normalized: string): boolean {
  if (!REGISTRATION_NUMBER.test(normalized)) return false;
  const yy = Number(normalized.slice(2, 4));
  const mm = Number(normalized.slice(4, 6));
  const dd = Number(normalized.slice(6, 8));
  const month = mm > 20 ? mm - 20 : mm;
  if (month < 1 || month > 12) return false;
  const year = (mm > 20 ? 2000 : 1900) + yy;
  const probe = new Date(Date.UTC(year, month - 1, dd));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === dd
  );
}

/** The namespace both lookup tokens are derived under (ADR-0020 §6). */
export const IDENTITY_NAMESPACE = 'registration_number:MN';

/** doc 13 §11.1: the seven dashboard counters, kept apart on purpose. */
export interface DashboardCounts {
  readonly activeWantedPeople: number;
  readonly activeCases: number;
  readonly matchedPeople: number;
  readonly matchEvents: number;
  readonly foundPeople: number;
  readonly falseMatches: number;
  readonly openMatches: number;
}

/**
 * One person may produce several matches, so the people count and the event
 * count are different numbers and doc 13 §11.1 says never to merge them. This
 * is the arithmetic that keeps them apart.
 */
export function countsFrom(rows: {
  readonly activeWantedPeople: number;
  readonly activeCases: number;
  readonly matches: readonly { readonly personId: string; readonly outcome: MatchOutcome }[];
  readonly openMatches: number;
}): DashboardCounts {
  const matched = new Set<string>();
  const found = new Set<string>();
  let falseMatches = 0;
  for (const match of rows.matches) {
    if (match.outcome === 'FALSE_MATCH') {
      falseMatches += 1;
      continue;
    }
    matched.add(match.personId);
    if (match.outcome === 'FOUND') found.add(match.personId);
  }
  return {
    activeWantedPeople: rows.activeWantedPeople,
    activeCases: rows.activeCases,
    matchedPeople: matched.size,
    matchEvents: rows.matches.length,
    foundPeople: found.size,
    falseMatches,
    openMatches: rows.openMatches,
  };
}
