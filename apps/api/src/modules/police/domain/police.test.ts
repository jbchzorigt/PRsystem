import { describe, expect, it } from 'vitest';
import {
  CODE_MAX_ATTEMPTS,
  caseTransitionAllowed,
  countsFrom,
  codeExpiry,
  exportIdentifier,
  falseMatchApprovable,
  isStructurallyValidRegistrationNumber,
  isTerminalCase,
  lockUntil,
  maskRegistrationNumber,
  matchSmsBody,
  normalizeRegistrationNumber,
  participatesInMatching,
  refuseCode,
  refuseHistoricalWindow,
  refuseIssue,
  separateAccounts,
  workflowTransitionAllowed,
} from './police';

const now = new Date('2026-09-09T10:00:00.000Z');

describe('the wanted case lifecycle (POL-DEC-018)', () => {
  it('follows doc 13 §7 and lets nothing out of a terminal state', () => {
    expect(caseTransitionAllowed('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(caseTransitionAllowed('PENDING_APPROVAL', 'ACTIVE')).toBe(true);
    expect(caseTransitionAllowed('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(caseTransitionAllowed('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(caseTransitionAllowed('ACTIVE', 'CLOSED')).toBe(true);
    for (const to of ['ACTIVE', 'SUSPENDED', 'DRAFT', 'CANCELLED'] as const) {
      expect(caseTransitionAllowed('CLOSED', to)).toBe(false);
      expect(caseTransitionAllowed('CANCELLED', to)).toBe(false);
    }
    expect(isTerminalCase('CLOSED')).toBe(true);
    expect(isTerminalCase('SUSPENDED')).toBe(false);
  });

  it('lets only an ACTIVE case match', () => {
    expect(participatesInMatching('ACTIVE')).toBe(true);
    for (const state of [
      'DRAFT',
      'PENDING_APPROVAL',
      'SUSPENDED',
      'CLOSED',
      'CANCELLED',
    ] as const) {
      expect(participatesInMatching(state)).toBe(false);
    }
  });
});

describe('the match workflow and its outcomes (POL-DEC-006, POL-DEC-019)', () => {
  it('reaches review only through an acknowledgement', () => {
    expect(workflowTransitionAllowed('NEW', 'ACKNOWLEDGED')).toBe(true);
    expect(workflowTransitionAllowed('NEW', 'UNDER_REVIEW')).toBe(false);
    expect(workflowTransitionAllowed('ACKNOWLEDGED', 'UNDER_REVIEW')).toBe(true);
    expect(workflowTransitionAllowed('RESOLVED', 'ACKNOWLEDGED')).toBe(false);
  });

  it('refuses a False Match over a Found until the Found is corrected', () => {
    expect(falseMatchApprovable('FOUND')).toBe(false);
    for (const outcome of ['NONE', 'FALSE_MATCH', 'LOCATION_STALE'] as const) {
      expect(falseMatchApprovable(outcome)).toBe(true);
    }
  });
});

describe('two people, compared on account ids', () => {
  it('refuses a self-decision and an unknown requester alike', () => {
    expect(separateAccounts('a', 'b')).toBe(true);
    expect(separateAccounts('a', 'a')).toBe(false);
    expect(separateAccounts(undefined, 'a')).toBe(false);
    expect(separateAccounts('', 'a')).toBe(false);
  });
});

describe('what a Match SMS may carry (POL-DEC-009)', () => {
  it('carries the registration number and nothing else that identifies', () => {
    const body = matchSmsBody('АА90010112');
    expect(body).toContain('АА90010112');
    expect(body).toContain('Police portal');
    // doc 13 §10.2 names what may not be there.
    for (const forbidden of ['Бат', 'өрөө', 'дүүрэг', 'http']) {
      expect(body).not.toContain(forbidden);
    }
    expect(body.split('\n')).toHaveLength(2);
  });

  it('masks a number down to four digits for a log or a delivery row', () => {
    const masked = maskRegistrationNumber('АА90010112');
    expect(masked.endsWith('0112')).toBe(true);
    expect(masked).not.toContain('9001');
    expect(masked.startsWith('****')).toBe(true);
  });

  it('unmasks an export only when the caller was allowed to', () => {
    expect(exportIdentifier('АА90010112', true)).toBe('АА90010112');
    expect(exportIdentifier('АА90010112', false)).toBe(maskRegistrationNumber('АА90010112'));
  });
});

describe('the historical check-in window (POL-DEC-010)', () => {
  const from = new Date('2026-08-01T00:00:00.000Z');
  it('requires both bounds, refuses an inverted range and caps at 31 days', () => {
    expect(refuseHistoricalWindow(undefined, undefined)).toBe('RANGE_REQUIRED');
    expect(refuseHistoricalWindow(from, undefined)).toBe('RANGE_REQUIRED');
    expect(refuseHistoricalWindow(from, from)).toBe('RANGE_INVERTED');
    expect(refuseHistoricalWindow(new Date('2026-09-01T00:00:00Z'), from)).toBe('RANGE_INVERTED');
    expect(refuseHistoricalWindow(from, new Date('2026-09-02T00:00:00.001Z'))).toBe(
      'RANGE_TOO_LONG',
    );
    expect(refuseHistoricalWindow(from, new Date('2026-09-01T00:00:00.000Z'))).toBeUndefined();
  });
});

describe('the four-digit bootstrap code (POL-DEC-022)', () => {
  const live = {
    expiresAt: new Date(now.getTime() + 60_000),
    attempts: 0,
    consumedAt: null,
    invalidatedAt: null,
    lockedUntil: null,
  };

  it('lives five minutes and locks for thirty after the third failure', () => {
    expect(codeExpiry(now).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(lockUntil(now).getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it('refuses a code that is used, invalidated, locked, exhausted or expired', () => {
    expect(refuseCode(live, now)).toBeUndefined();
    expect(refuseCode({ ...live, consumedAt: now }, now)).toBe('CODE_CONSUMED');
    expect(refuseCode({ ...live, invalidatedAt: now }, now)).toBe('CODE_INVALIDATED');
    expect(refuseCode({ ...live, lockedUntil: new Date(now.getTime() + 1000) }, now)).toBe(
      'CODE_LOCKED',
    );
    expect(refuseCode({ ...live, attempts: CODE_MAX_ATTEMPTS }, now)).toBe(
      'CODE_ATTEMPTS_EXHAUSTED',
    );
    expect(refuseCode({ ...live, expiresAt: now }, now)).toBe('CODE_EXPIRED');
  });

  it('holds a resend to a minute apart, three a quarter-hour and five a day', () => {
    const ago = (seconds: number): Date => new Date(now.getTime() - seconds * 1000);
    expect(refuseIssue([], now)).toBeUndefined();
    expect(refuseIssue([ago(30)], now)).toBe('RESEND_TOO_SOON');
    expect(refuseIssue([ago(90), ago(200), ago(400)], now)).toBe('ISSUE_LIMIT_15_MINUTES');
    expect(refuseIssue([ago(90), ago(3600), ago(7200), ago(10_800), ago(14_400)], now)).toBe(
      'ISSUE_LIMIT_DAY',
    );
    expect(refuseIssue([ago(90), ago(3600)], now)).toBeUndefined();
  });
});

describe('registration numbers (doc 13 §8.1)', () => {
  it('normalizes case and spacing, and validates the encoded birth date', () => {
    expect(normalizeRegistrationNumber(' аа 90010112 ')).toBe('АА90010112');
    expect(isStructurallyValidRegistrationNumber('АА90010112')).toBe(true);
    // A month above twenty marks a birth in the 2000s.
    expect(isStructurallyValidRegistrationNumber('АА05210112')).toBe(true);
    expect(isStructurallyValidRegistrationNumber('АА90130112')).toBe(false);
    expect(isStructurallyValidRegistrationNumber('АА90013212')).toBe(false);
    expect(isStructurallyValidRegistrationNumber('A190010112')).toBe(false);
    expect(isStructurallyValidRegistrationNumber('АА9001011')).toBe(false);
  });
});

describe('the dashboard counters (POL-DEC-006, doc 13 §11.1)', () => {
  it('counts people and events separately, and leaves a false match out of both', () => {
    const counts = countsFrom({
      activeWantedPeople: 4,
      activeCases: 7,
      openMatches: 2,
      matches: [
        { personId: 'p1', outcome: 'NONE' },
        { personId: 'p1', outcome: 'FOUND' },
        { personId: 'p2', outcome: 'NONE' },
        { personId: 'p3', outcome: 'FALSE_MATCH' },
      ],
    });
    expect(counts).toEqual({
      activeWantedPeople: 4,
      activeCases: 7,
      matchedPeople: 2,
      matchEvents: 4,
      foundPeople: 1,
      falseMatches: 1,
      openMatches: 2,
    });
  });
});
