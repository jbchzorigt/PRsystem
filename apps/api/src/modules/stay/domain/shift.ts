/**
 * The rules of closing a Reception shift, as pure functions (doc 03 §6).
 *
 * Which review a close needs, and what a rejection can still do once the next
 * shift has started, are stated here once so the service reads as the workflow
 * and the rule is tested on its own (`SHIFT-DEC-003`, `-004`, `-005`).
 */

export type ShiftReviewState =
  'NOT_REQUIRED' | 'PENDING_MANAGER' | 'PENDING_HOTEL_ADMIN' | 'DISPUTED' | 'RESOLVED';

/**
 * `SHIFT-DEC-003`: a self-close with no variance needs no review at all; one
 * with a variance waits for a Hotel Admin while the next shift starts anyway.
 * An ordinary handover goes to a Manager, and one the reviewing Reception
 * worked itself falls back to the Hotel Admin (`SHIFT-DEC-004`).
 */
export function reviewAfterClose(input: {
  readonly selfClose: boolean;
  readonly varianceMnt: bigint;
  readonly reviewerIsTheReception: boolean;
}): ShiftReviewState {
  if (input.selfClose) {
    return input.varianceMnt === 0n ? 'NOT_REQUIRED' : 'PENDING_HOTEL_ADMIN';
  }
  return input.reviewerIsTheReception ? 'PENDING_HOTEL_ADMIN' : 'PENDING_MANAGER';
}

/**
 * `SHIFT-DEC-005`: once the shift has closed and the next one has started, a
 * rejection cannot reopen it; the disagreement becomes a dispute, settled by
 * accepting the variance or by a cash correction.
 */
export function rejectionOutcome(closedOrSucceeded: boolean): 'RECOUNT_REQUIRED' | 'DISPUTED' {
  return closedOrSucceeded ? 'DISPUTED' : 'RECOUNT_REQUIRED';
}
