import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReviewRepository } from '../repositories/review.repository';
import type { ReviewRow } from '../repositories/review.repository';
import {
  aggregateAfterEdit,
  aggregateWith,
  canDelete,
  canEdit,
  isComment,
  isRating,
  maskDisplayName,
  normalizeComment,
  reviewDeadline,
  withinWindow,
} from '../domain/review';
import type { Aggregate, ReviewStatus } from '../domain/review';
import type { RequestContext, ReviewDependencies } from './review-context';
import { NOT_FOUND, ReviewServiceBase, claim, newReviewRequest } from './review-context';

/**
 * The reviewer's own three commands: write, edit, delete (doc 10 §§4, 5, 7.1).
 *
 * Three rules shape them.
 *
 * **Eligibility is the server's, and it is re-read every time.** doc 10 §3 says
 * so in as many words: the booking status a request carries decides nothing.
 * The account, the booking's state and the stay's actual checkout all come from
 * the booking module's contract, inside the transaction that writes the row.
 *
 * **One review per completed booking is a UNIQUE constraint.** The service
 * checks first so the caller gets a sentence, and the constraint is what makes
 * it true — including for a booking whose review the owner has soft-deleted,
 * because that row still occupies the booking.
 *
 * **The aggregate moves with the review, never afterwards.** Every transition
 * that changes what the public can see locks the hotel's aggregate row and
 * writes it in the same transaction, so a published average is never a
 * recomputation somebody has to remember to schedule.
 */

export interface ReviewView {
  readonly reviewId: string;
  readonly hotelId: string;
  readonly bookingId: string;
  readonly rating: number;
  readonly comment: string;
  readonly displayName: string;
  readonly status: ReviewStatus;
  readonly edited: boolean;
  readonly reviewDeadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

export function reviewView(row: ReviewRow): ReviewView {
  return {
    reviewId: row.reviewId,
    hotelId: row.hotelId,
    bookingId: row.bookingId,
    rating: row.rating,
    comment: row.comment,
    displayName: row.displayNameSnapshot,
    status: row.status,
    edited: row.edited,
    reviewDeadlineAt: row.reviewDeadlineAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

export class ReviewService extends ReviewServiceBase {
  constructor(deps: ReviewDependencies) {
    super(deps);
  }

  /**
   * doc 10 §4: the review a completed booking earns.
   *
   * The hotel is never named by the request. It comes from the booking, which
   * comes from the account — so a reviewer cannot choose the tenant their
   * review lands in, any more than a booker can (`BK-DEC-012`).
   */
  async write(
    input: {
      bookingId: string;
      rating: number;
      comment: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<ReviewView> {
    const accountId = request.accountId;
    if (accountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a review needs a signed-in guest');
    }
    const comment = normalizeComment(input.comment);
    // Refused here with a sentence; refused again by the CHECK, whatever wrote
    // the row (doc 10 §5).
    if (!isRating(input.rating)) {
      throw new ApiError('VALIDATION_FAILED', 'rating must be a whole number of stars, 1 to 5');
    }
    if (!isComment(comment)) {
      throw new ApiError('VALIDATION_FAILED', 'comment must be 10 to 1000 characters once trimmed');
    }

    // The eligibility read runs in the reviewer's own scope, where the only
    // bookings visible are theirs.
    const eligible = await this.inReviewerScope(request, async (uow) => {
      const booking = await this.deps.eligibility.bookingForReviewer(
        uow,
        input.bookingId,
        accountId,
      );
      const displayName = await displayNameOf(uow, accountId);
      return { booking, displayName };
    });
    const booking = eligible.booking;
    // `RV-DEC-002`: a booking that is not theirs and one that does not exist
    // are the same answer, so the surface discloses no other guest's booking.
    if (booking === undefined) throw new ApiError('NOT_FOUND', 'no such booking');
    if (booking.state !== 'COMPLETED' || booking.actualCheckoutAt === null) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'NOT_A_COMPLETED_STAY: only a completed booking earns a review',
      );
    }
    const deadline = reviewDeadline(booking.actualCheckoutAt);

    return this.inHotelScope(booking.hotelId, request, async (uow) => {
      const claimed = await claim(uow, 'review.write', input.idempotencyKey, {
        bookingId: input.bookingId,
        rating: input.rating,
      });
      if (claimed.kind === 'replay') return claimed.body as ReviewView;

      const now = this.now(uow);
      // doc 10 §5: judged at the instant of submission, not when the form was
      // opened. A deadline that passed while the guest was typing refuses here.
      if (!withinWindow(now, deadline)) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'REVIEW_WINDOW_CLOSED: the 30 days from checkout have passed',
        );
      }
      const repository = new ReviewRepository(uow);
      const aggregate = await repository.lockAggregate(booking.hotelId);
      let created: ReviewRow;
      try {
        created = await repository.createReview({
          hotelId: booking.hotelId,
          bookingId: booking.bookingId,
          accountId,
          rating: input.rating,
          comment,
          displayNameSnapshot: maskDisplayName(eligible.displayName),
          reviewDeadlineAt: deadline,
        });
      } catch (error) {
        if (isDuplicateReview(error)) {
          throw new ApiError(
            'CONFLICT',
            'REVIEW_EXISTS: this booking already has a review, published or deleted',
          );
        }
        throw error;
      }
      await this.moveAggregate(uow, aggregate, { added: input.rating }, now);
      await recordPlatformAudit(uow, {
        action: 'review.written',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: created.reviewId,
        // The comment is the guest's public words, but the audit records the
        // act rather than the content.
        payload: { bookingId: booking.bookingId, rating: input.rating },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'hotel_review',
        aggregateId: created.reviewId,
        eventType: 'review.published',
        payload: { reviewId: created.reviewId, hotelId: booking.hotelId, rating: input.rating },
      });
      const view = reviewView(created);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
      return view;
    });
  }

  /**
   * `RV-DEC-004`: the owner's edit, inside the same 30-day window.
   *
   * The previous rating and comment are kept (doc 10 §7.1), the row is marked
   * `Засварласан`, and the aggregate's sum moves by the difference — the count
   * does not, because an edit publishes nothing new.
   */
  async edit(
    input: {
      reviewId: string;
      rating: number;
      comment: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<ReviewView> {
    const accountId = request.accountId;
    if (accountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a review needs a signed-in guest');
    }
    const comment = normalizeComment(input.comment);
    if (!isRating(input.rating)) {
      throw new ApiError('VALIDATION_FAILED', 'rating must be a whole number of stars, 1 to 5');
    }
    if (!isComment(comment)) {
      throw new ApiError('VALIDATION_FAILED', 'comment must be 10 to 1000 characters once trimmed');
    }
    const hotelId = await this.hotelOfOwnReview(input.reviewId, accountId, request);

    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimed = await claim(uow, 'review.edit', input.idempotencyKey, {
        reviewId: input.reviewId,
        rating: input.rating,
      });
      if (claimed.kind === 'replay') return claimed.body as ReviewView;

      const repository = new ReviewRepository(uow);
      const aggregate = await repository.lockAggregate(hotelId);
      const review = await repository.lockReview(input.reviewId);
      if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
      const now = this.now(uow);
      // Re-judged under the lock: the owner, the status and the deadline.
      if (review.accountId !== accountId) throw new ApiError('NOT_FOUND', NOT_FOUND);
      if (!canEdit(review, accountId, now)) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          review.status === 'PUBLISHED'
            ? 'REVIEW_WINDOW_CLOSED: the 30 days from checkout have passed'
            : 'REVIEW_NOT_EDITABLE: this review is hidden or deleted',
        );
      }

      await repository.recordEdit({
        hotelId,
        reviewId: review.reviewId,
        accountId,
        fromRating: review.rating,
        fromComment: review.comment,
        toRating: input.rating,
        toComment: comment,
      });
      const moved = await repository.updateReview({
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        rating: input.rating,
        comment,
        edited: true,
        at: now,
      });
      if (!moved) throw new ApiError('CONFLICT', 'that review changed under this command');
      await this.writeAggregate(
        uow,
        aggregate,
        aggregateAfterEdit(aggregate, review.rating, input.rating),
        now,
      );
      await recordPlatformAudit(uow, {
        action: 'review.edited',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: review.reviewId,
        payload: { fromRating: review.rating, toRating: input.rating },
      });
      const reread = await repository.reviewById(review.reviewId);
      if (reread === undefined) throw new Error('the review vanished under its own lock');
      const view = reviewView(reread);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /**
   * `RV-DEC-004`: the owner's soft-delete, at any time.
   *
   * The window is irrelevant here — doc 10 §7.1 lets an owner withdraw their
   * words whenever they like. The row keeps its booking, so the same booking
   * never yields a second review, and the aggregate loses the rating.
   */
  async softDelete(
    input: { reviewId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<ReviewView> {
    const accountId = request.accountId;
    if (accountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a review needs a signed-in guest');
    }
    const hotelId = await this.hotelOfOwnReview(input.reviewId, accountId, request);

    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimed = await claim(uow, 'review.delete', input.idempotencyKey, {
        reviewId: input.reviewId,
      });
      if (claimed.kind === 'replay') return claimed.body as ReviewView;

      const repository = new ReviewRepository(uow);
      const aggregate = await repository.lockAggregate(hotelId);
      const review = await repository.lockReview(input.reviewId);
      if (review === undefined || review.accountId !== accountId) {
        throw new ApiError('NOT_FOUND', NOT_FOUND);
      }
      if (!canDelete(review, accountId)) {
        throw new ApiError('CONFLICT', 'that review is already deleted');
      }
      const now = this.now(uow);
      const wasPublished = review.status === 'PUBLISHED';
      const moved = await repository.updateReview({
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        status: 'DELETED',
        deletedAt: now,
        at: now,
      });
      if (!moved) throw new ApiError('CONFLICT', 'that review changed under this command');
      // A hidden review is not in the aggregate, so deleting it removes nothing.
      if (wasPublished) {
        await this.moveAggregate(uow, aggregate, { removed: review.rating }, now);
      }
      await recordPlatformAudit(uow, {
        action: 'review.deleted',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: review.reviewId,
        payload: { wasPublished },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'hotel_review',
        aggregateId: review.reviewId,
        eventType: 'review.deleted',
        payload: { reviewId: review.reviewId, hotelId },
      });
      const reread = await repository.reviewById(review.reviewId);
      if (reread === undefined) throw new Error('the review vanished under its own lock');
      const view = reviewView(reread);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /** doc 10 §7.1: the reviewer's own reviews, in whatever state they are in. */
  async mine(request: RequestContext = newReviewRequest()): Promise<readonly ReviewView[]> {
    const accountId = request.accountId;
    if (accountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a review needs a signed-in guest');
    }
    return this.inReviewerScope(request, async (uow) => {
      const rows = await new ReviewRepository(uow).reviewsForAccount(accountId);
      return rows.map((row) => reviewView(row));
    });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * The hotel a review belongs to, read in the owner's own scope.
   *
   * A review that is not theirs is invisible here, so the tenant a command runs
   * in is derived from a row they own rather than from anything they sent.
   */
  private async hotelOfOwnReview(
    reviewId: string,
    accountId: string,
    request: RequestContext,
  ): Promise<string> {
    const found = await this.inReviewerScope(request, async (uow) =>
      new ReviewRepository(uow).reviewById(reviewId),
    );
    if (found === undefined || found.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', NOT_FOUND);
    }
    return found.hotelId;
  }

  private async moveAggregate(
    uow: UnitOfWork,
    current: { hotelId: string; publishedCount: number; ratingSum: bigint; revision: number },
    change: { added?: number; removed?: number },
    at: Date,
  ): Promise<void> {
    await this.writeAggregate(uow, current, aggregateWith(current, change), at);
  }

  private async writeAggregate(
    uow: UnitOfWork,
    current: { hotelId: string; revision: number },
    next: Aggregate,
    at: Date,
  ): Promise<void> {
    const written = await new ReviewRepository(uow).setAggregate({
      hotelId: current.hotelId,
      expectedRevision: current.revision,
      aggregate: next,
      at,
    });
    if (!written) {
      // Unreachable inside one transaction: the row was locked before it was
      // read. Loud rather than silent, because a lost aggregate write publishes
      // a wrong average indefinitely.
      throw new Error('the review aggregate changed under its own lock');
    }
  }
}

/** The unique index on `booking_id`, by the state PostgreSQL reports for it. */
function isDuplicateReview(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const constraint = (error as { constraint?: unknown }).constraint;
  return code === '23505' && constraint === 'hotel_review_booking_uq';
}

/** The guest's own display name, masked before it is ever stored (doc 10 §8). */
async function displayNameOf(uow: UnitOfWork, accountId: string): Promise<string | null> {
  const result = await uow.query<{ display_name: string | null }>(
    `SELECT display_name FROM platform.guest_account WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0]?.display_name ?? null;
}
