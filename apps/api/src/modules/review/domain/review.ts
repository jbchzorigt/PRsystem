/**
 * The arithmetic and the rules of a verified-stay review (doc 10).
 *
 * Pure, and deliberately so: every predicate below is a sentence from doc 10
 * that a service re-evaluates *inside* the transaction that writes the row, and
 * a unit test can put each one beside the sentence it implements.
 *
 * Two of them are also database constraints — the rating range and the comment
 * length — and that duplication is intended. The function gives the caller a
 * sentence; the constraint makes the rule true of every row however it was
 * written (CLAUDE.md §10).
 */

export type ReviewStatus = 'PUBLISHED' | 'HIDDEN' | 'DELETED';
export type ReportReason = 'PERSONAL_DATA' | 'ABUSE_ILLEGAL' | 'SPAM_FRAUD' | 'OTHER';
export type ReportState = 'OPEN' | 'RESOLVED';
export type ReportResolution = 'UPHELD' | 'DISMISSED';
export type ReplyState = 'ACTIVE' | 'DELETED';

/** `RV-DEC-003`: thirty days from the booking's *actual* checkout. */
export const REVIEW_WINDOW_DAYS = 30;
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const COMMENT_MIN = 10;
export const COMMENT_MAX = 1000;
export const REPLY_MIN = 10;
export const REPLY_MAX = 1000;
export const REPORT_NOTE_MIN = 10;
export const REPORT_NOTE_MAX = 500;

const DAY_MS = 86_400_000;

/**
 * The deadline a review is written under, snapshotted at creation.
 *
 * Taken from the checkout the stay actually recorded, never from a planned one:
 * doc 10 §5 says `actual_checkout_at` in as many words, and a stay that ran
 * over gives its guest thirty days from when they really left.
 */
export function reviewDeadline(actualCheckoutAt: Date): Date {
  return new Date(actualCheckoutAt.getTime() + REVIEW_WINDOW_DAYS * DAY_MS);
}

/** doc 10 §5: the deadline is re-checked at the instant of submission. */
export function withinWindow(now: Date, deadline: Date): boolean {
  return now.getTime() < deadline.getTime();
}

export function isRating(value: number): boolean {
  return Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * doc 10 §5: a comment is what is left after trimming, and a comment of only
 * whitespace is empty rather than short.
 */
export function normalizeComment(raw: string): string {
  return raw.trim();
}

export function isComment(trimmed: string): boolean {
  return trimmed.length >= COMMENT_MIN && trimmed.length <= COMMENT_MAX;
}

export function isReplyBody(trimmed: string): boolean {
  return trimmed.length >= REPLY_MIN && trimmed.length <= REPLY_MAX;
}

export function isReportNote(trimmed: string): boolean {
  return trimmed.length >= REPORT_NOTE_MIN && trimmed.length <= REPORT_NOTE_MAX;
}

/**
 * doc 10 §8: what a stranger is shown instead of a name.
 *
 * The first character and nothing else, so two reviewers with the same initial
 * are indistinguishable — which is the point. An account with no display name
 * at all becomes `Зочин`, because a review still has to be attributable to
 * *somebody* on the page without naming them.
 */
export function maskDisplayName(displayName: string | null): string {
  const trimmed = (displayName ?? '').trim();
  if (trimmed.length === 0) return 'Зочин';
  return `${[...trimmed][0] ?? ''}***`;
}

/** doc 10 §6: the average in integer hundredths, rounded half-up. */
export function averageCenti(ratingSum: bigint, publishedCount: number): number {
  if (publishedCount <= 0) return 0;
  const count = BigInt(publishedCount);
  return Number((ratingSum * 200n + count) / (count * 2n));
}

export interface Aggregate {
  readonly publishedCount: number;
  readonly ratingSum: bigint;
  readonly averageRatingCenti: number;
}

/**
 * The aggregate after a review enters or leaves the published set.
 *
 * The three fields move together and the average is derived from the other two,
 * so no caller can produce a count and a sum the average does not summarise —
 * the same thing the table's CHECK says, computed once here.
 */
export function aggregateWith(
  current: Pick<Aggregate, 'publishedCount' | 'ratingSum'>,
  change: { readonly added?: number; readonly removed?: number },
): Aggregate {
  const added = change.added ?? 0;
  const removed = change.removed ?? 0;
  const publishedCount = current.publishedCount + (added === 0 ? 0 : 1) - (removed === 0 ? 0 : 1);
  const ratingSum = current.ratingSum + BigInt(added) - BigInt(removed);
  if (publishedCount < 0 || ratingSum < 0n) {
    // Unreachable through the services, which only ever remove a review the
    // aggregate counted. Loud rather than silently clamped: a negative count is
    // a lost transition, and clamping it would hide the bug and publish a wrong
    // average forever.
    throw new Error('the review aggregate would go negative');
  }
  return { publishedCount, ratingSum, averageRatingCenti: averageCenti(ratingSum, publishedCount) };
}

/** The published-set delta an edit makes: out at the old rating, in at the new. */
export function aggregateAfterEdit(
  current: Pick<Aggregate, 'publishedCount' | 'ratingSum'>,
  fromRating: number,
  toRating: number,
): Aggregate {
  const ratingSum = current.ratingSum - BigInt(fromRating) + BigInt(toRating);
  return {
    publishedCount: current.publishedCount,
    ratingSum,
    averageRatingCenti: averageCenti(ratingSum, current.publishedCount),
  };
}

export interface ReviewFacts {
  readonly status: ReviewStatus;
  readonly accountId: string;
  readonly reviewDeadlineAt: Date;
}

/**
 * `RV-DEC-004`: the owner edits until the window closes, and not after.
 *
 * A hidden review is not editable either. doc 10 §7.3 keeps the owner's words
 * intact while a moderator has them hidden, and letting the owner rewrite a
 * hidden review would be a way to launder one back into the queue.
 */
export function canEdit(review: ReviewFacts, accountId: string, now: Date): boolean {
  if (review.accountId !== accountId) return false;
  if (review.status !== 'PUBLISHED') return false;
  return withinWindow(now, review.reviewDeadlineAt);
}

/** `RV-DEC-004`: the owner deletes whenever they like — the window is irrelevant. */
export function canDelete(review: ReviewFacts, accountId: string): boolean {
  return review.accountId === accountId && review.status !== 'DELETED';
}

/**
 * `RV-DEC-005`: any authenticated Guest may report a **published** review.
 *
 * No completed stay, no hotel role, no package — and not their own review,
 * because the owner has a delete and a report would be a way of asking a
 * moderator to do what they can already do themselves.
 */
export function canReport(review: ReviewFacts, accountId: string): boolean {
  return review.status === 'PUBLISHED' && review.accountId !== accountId;
}

/** `RV-DEC-005`: a moderator hides a published review, and only a published one. */
export function canHide(status: ReviewStatus): boolean {
  return status === 'PUBLISHED';
}

/**
 * `RV-DEC-006`: a moderator restores a hidden review, and never a deleted one.
 *
 * The database says the same thing — the review guard refuses any transition
 * out of `DELETED` — so this is the sentence and that is the guarantee.
 */
export function canRestore(status: ReviewStatus): boolean {
  return status === 'HIDDEN';
}

/**
 * doc 10 §7.4: a reply exists only alongside a review the public can see.
 *
 * Creating, editing and restoring one all require the review published; a
 * hidden or deleted review keeps its reply row and shows neither.
 */
export function canManageReply(status: ReviewStatus): boolean {
  return status === 'PUBLISHED';
}

export function isReportReason(value: string): value is ReportReason {
  return (
    value === 'PERSONAL_DATA' ||
    value === 'ABUSE_ILLEGAL' ||
    value === 'SPAM_FRAUD' ||
    value === 'OTHER'
  );
}

/** doc 10 §7.2: `OTHER` explains itself; the other three do not carry a note. */
export function reportNoteRequired(reason: ReportReason): boolean {
  return reason === 'OTHER';
}

/** The average as a display string, from the integer the server stores. */
export function formatAverage(centi: number): string {
  const whole = Math.trunc(centi / 100);
  const fraction = Math.abs(centi % 100);
  return `${String(whole)}.${String(fraction).padStart(2, '0')}`;
}
