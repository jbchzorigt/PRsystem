import { describe, expect, it } from 'vitest';
import {
  REVIEW_WINDOW_DAYS,
  aggregateAfterEdit,
  aggregateWith,
  averageCenti,
  canDelete,
  canEdit,
  canHide,
  canManageReply,
  canReport,
  canRestore,
  formatAverage,
  isComment,
  isRating,
  isReplyBody,
  isReportNote,
  isReportReason,
  maskDisplayName,
  normalizeComment,
  reportNoteRequired,
  reviewDeadline,
  withinWindow,
} from './review';

const CHECKOUT = new Date('2026-03-01T04:00:00.000Z');

describe('the review window (RV-DEC-003)', () => {
  it('runs thirty days from the actual checkout', () => {
    const deadline = reviewDeadline(CHECKOUT);
    expect(deadline.toISOString()).toBe('2026-03-31T04:00:00.000Z');
    expect(deadline.getTime() - CHECKOUT.getTime()).toBe(REVIEW_WINDOW_DAYS * 86_400_000);
  });

  it('is open up to the deadline and closed at it', () => {
    const deadline = reviewDeadline(CHECKOUT);
    expect(withinWindow(new Date(deadline.getTime() - 1), deadline)).toBe(true);
    expect(withinWindow(deadline, deadline)).toBe(false);
    expect(withinWindow(new Date(deadline.getTime() + 1), deadline)).toBe(false);
  });
});

describe('the input rules (doc 10 §5)', () => {
  it('accepts whole stars one to five and nothing else', () => {
    for (const rating of [1, 2, 3, 4, 5]) expect(isRating(rating)).toBe(true);
    for (const rating of [0, 6, -1, 4.5, Number.NaN]) expect(isRating(rating)).toBe(false);
  });

  it('measures the comment after trimming, so whitespace is not length', () => {
    expect(normalizeComment('   \n\t  ')).toBe('');
    expect(isComment(normalizeComment('   \n\t  '))).toBe(false);
    expect(isComment(normalizeComment(`  ${'a'.repeat(9)}  `))).toBe(false);
    expect(isComment(normalizeComment(`  ${'a'.repeat(10)}  `))).toBe(true);
    expect(isComment('a'.repeat(1000))).toBe(true);
    expect(isComment('a'.repeat(1001))).toBe(false);
  });

  it('bounds a reply and a report note the same way', () => {
    expect(isReplyBody('a'.repeat(9))).toBe(false);
    expect(isReplyBody('a'.repeat(10))).toBe(true);
    expect(isReplyBody('a'.repeat(1001))).toBe(false);
    expect(isReportNote('a'.repeat(9))).toBe(false);
    expect(isReportNote('a'.repeat(500))).toBe(true);
    expect(isReportNote('a'.repeat(501))).toBe(false);
  });
});

describe('the masked public name (doc 10 §8)', () => {
  it('shows one character and no more', () => {
    expect(maskDisplayName('Болормаа')).toBe('Б***');
    expect(maskDisplayName('  Ganbat  ')).toBe('G***');
  });

  it('names an account with no display name without inventing one', () => {
    expect(maskDisplayName(null)).toBe('Зочин');
    expect(maskDisplayName('   ')).toBe('Зочин');
  });
});

describe('the aggregate (doc 10 §6)', () => {
  it('rounds the average half-up, in integer hundredths', () => {
    expect(averageCenti(0n, 0)).toBe(0);
    expect(averageCenti(5n, 1)).toBe(500);
    expect(averageCenti(13n, 3)).toBe(433);
    // 4.5 exactly: half-up gives 450, and never 449.
    expect(averageCenti(9n, 2)).toBe(450);
    // 3.335 → 334 rather than 333.
    expect(averageCenti(2001n, 600)).toBe(334);
  });

  it('adds and removes a review, and keeps the three fields consistent', () => {
    const empty = { publishedCount: 0, ratingSum: 0n };
    const one = aggregateWith(empty, { added: 5 });
    expect(one).toEqual({ publishedCount: 1, ratingSum: 5n, averageRatingCenti: 500 });
    const two = aggregateWith(one, { added: 4 });
    expect(two).toEqual({ publishedCount: 2, ratingSum: 9n, averageRatingCenti: 450 });
    const back = aggregateWith(two, { removed: 5 });
    expect(back).toEqual({ publishedCount: 1, ratingSum: 4n, averageRatingCenti: 400 });
    expect(aggregateWith(back, { removed: 4 })).toEqual({
      publishedCount: 0,
      ratingSum: 0n,
      averageRatingCenti: 0,
    });
  });

  it('moves only the sum when an edit changes a rating', () => {
    const before = { publishedCount: 3, ratingSum: 12n };
    expect(aggregateAfterEdit(before, 5, 2)).toEqual({
      publishedCount: 3,
      ratingSum: 9n,
      averageRatingCenti: 300,
    });
  });

  it('refuses to go negative rather than clamping to zero', () => {
    expect(() => aggregateWith({ publishedCount: 0, ratingSum: 0n }, { removed: 5 })).toThrow(
      /negative/,
    );
  });

  it('formats what the server stores, without recomputing it', () => {
    expect(formatAverage(0)).toBe('0.00');
    expect(formatAverage(433)).toBe('4.33');
    expect(formatAverage(500)).toBe('5.00');
    expect(formatAverage(405)).toBe('4.05');
  });
});

describe('who may do what', () => {
  const published = {
    status: 'PUBLISHED' as const,
    accountId: 'owner',
    reviewDeadlineAt: reviewDeadline(CHECKOUT),
  };
  const inside = new Date(published.reviewDeadlineAt.getTime() - 1);
  const outside = new Date(published.reviewDeadlineAt.getTime() + 1);

  it('lets the owner edit inside the window and nobody else ever', () => {
    expect(canEdit(published, 'owner', inside)).toBe(true);
    expect(canEdit(published, 'owner', outside)).toBe(false);
    expect(canEdit(published, 'stranger', inside)).toBe(false);
    expect(canEdit({ ...published, status: 'HIDDEN' }, 'owner', inside)).toBe(false);
  });

  it('lets the owner delete at any time, and only the owner', () => {
    expect(canDelete(published, 'owner')).toBe(true);
    expect(canDelete({ ...published, status: 'HIDDEN' }, 'owner')).toBe(true);
    expect(canDelete({ ...published, status: 'DELETED' }, 'owner')).toBe(false);
    expect(canDelete(published, 'stranger')).toBe(false);
  });

  it('lets any other guest report a published review, and the owner report none', () => {
    expect(canReport(published, 'stranger')).toBe(true);
    expect(canReport(published, 'owner')).toBe(false);
    expect(canReport({ ...published, status: 'HIDDEN' }, 'stranger')).toBe(false);
    expect(canReport({ ...published, status: 'DELETED' }, 'stranger')).toBe(false);
  });

  it('hides only a published review and restores only a hidden one (RV-DEC-006)', () => {
    expect(canHide('PUBLISHED')).toBe(true);
    expect(canHide('HIDDEN')).toBe(false);
    expect(canHide('DELETED')).toBe(false);
    expect(canRestore('HIDDEN')).toBe(true);
    expect(canRestore('PUBLISHED')).toBe(false);
    // The owner's delete is final: a moderator does not undo it.
    expect(canRestore('DELETED')).toBe(false);
  });

  it('manages a reply only while its review is public (doc 10 §7.4)', () => {
    expect(canManageReply('PUBLISHED')).toBe(true);
    expect(canManageReply('HIDDEN')).toBe(false);
    expect(canManageReply('DELETED')).toBe(false);
  });
});

describe('report reasons (doc 10 §7.2)', () => {
  it('knows the four and refuses anything else', () => {
    for (const reason of ['PERSONAL_DATA', 'ABUSE_ILLEGAL', 'SPAM_FRAUD', 'OTHER']) {
      expect(isReportReason(reason)).toBe(true);
    }
    expect(isReportReason('BAD_RATING')).toBe(false);
    expect(isReportReason('')).toBe(false);
  });

  it('requires a note for OTHER alone', () => {
    expect(reportNoteRequired('OTHER')).toBe(true);
    expect(reportNoteRequired('SPAM_FRAUD')).toBe(false);
  });
});
