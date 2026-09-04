import { describe, expect, it } from 'vitest';
import { rejectionOutcome, reviewAfterClose } from './shift';

describe('doc 03 §6.2 — which review a close needs', () => {
  it('a self-close with no variance needs none, and one with a variance needs the Hotel Admin', () => {
    expect(
      reviewAfterClose({ selfClose: true, varianceMnt: 0n, reviewerIsTheReception: false }),
    ).toBe('NOT_REQUIRED');
    expect(
      reviewAfterClose({ selfClose: true, varianceMnt: -10_000n, reviewerIsTheReception: false }),
    ).toBe('PENDING_HOTEL_ADMIN');
  });

  it('an ordinary handover goes to a Manager, unless the Manager worked the shift', () => {
    expect(
      reviewAfterClose({ selfClose: false, varianceMnt: 0n, reviewerIsTheReception: false }),
    ).toBe('PENDING_MANAGER');
    expect(
      reviewAfterClose({ selfClose: false, varianceMnt: 0n, reviewerIsTheReception: true }),
    ).toBe('PENDING_HOTEL_ADMIN');
  });

  it('SHIFT-DEC-005: once the next shift has started, a rejection is a dispute', () => {
    expect(rejectionOutcome(false)).toBe('RECOUNT_REQUIRED');
    expect(rejectionOutcome(true)).toBe('DISPUTED');
  });
});
