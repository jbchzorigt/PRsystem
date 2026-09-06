import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReviewRepository } from '../repositories/review.repository';
import type { ReportRow } from '../repositories/review.repository';
import { canReport, isReportNote, normalizeComment, reportNoteRequired } from '../domain/review';
import type { ReportReason } from '../domain/review';
import type { RequestContext, ReviewDependencies } from './review-context';
import { NOT_FOUND, ReviewServiceBase, claim } from './review-context';

/**
 * The Guest's report (doc 10 §7.2, `RV-DEC-005`).
 *
 * The permission row is `review.report_published` and it allows **everyone** in
 * the Guest realm: no completed stay, no hotel membership, no role and no
 * package. That is not an omission — doc 18 §8 states it, and a hotel staff
 * member who wants to report a review does it from their own Guest account by
 * this same route.
 *
 * A report hides nothing. It does not touch the review's status, it does not
 * move the aggregate, and it is not a vote: doc 10 §7.2 makes it a request for
 * a moderator's attention and nothing more.
 */

export interface ReportView {
  readonly reportId: string;
  readonly reviewId: string;
  readonly reason: ReportReason;
  readonly state: string;
  readonly createdAt: Date;
}

function reportView(row: ReportRow): ReportView {
  return {
    reportId: row.reportId,
    reviewId: row.reviewId,
    reason: row.reason,
    state: row.state,
    createdAt: row.createdAt,
  };
}

export class ReviewReportService extends ReviewServiceBase {
  constructor(deps: ReviewDependencies) {
    super(deps);
  }

  /**
   * doc 10 §7.2: one open report per account and review.
   *
   * The partial unique index is what enforces it; the service catches the
   * refusal and answers with the existing report rather than an error, because
   * doc 10 says a repeat submission must not create a duplicate — it does not
   * say the guest should be told off for retrying.
   */
  async report(
    input: {
      reviewId: string;
      reason: ReportReason;
      note?: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<ReportView> {
    const accountId = request.accountId;
    if (accountId === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a report needs a signed-in guest');
    }
    const note = input.note === undefined ? null : normalizeComment(input.note);
    if (reportNoteRequired(input.reason)) {
      if (note === null || !isReportNote(note)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'a report of OTHER explains itself in 10 to 500 characters',
        );
      }
    } else if (note !== null && note.length > 0) {
      // A stated reason carries no free text: doc 10 §7.2 gives four reasons
      // and one note, and letting a note ride along with the other three would
      // be a way of reporting something the list does not include.
      throw new ApiError('VALIDATION_FAILED', 'only a report of OTHER carries a note');
    }

    // The hotel comes from the review, which a reporter reaches through the
    // public projection — so the request names no tenant.
    const hotelId = await this.hotelOfPublishedReview(input.reviewId);

    return this.inHotelScope(hotelId, request, async (uow) => {
      const claimed = await claim(uow, 'review.report', input.idempotencyKey, {
        reviewId: input.reviewId,
        reason: input.reason,
      });
      if (claimed.kind === 'replay') return claimed.body as ReportView;

      const repository = new ReviewRepository(uow);
      const review = await repository.lockReview(input.reviewId);
      if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
      // Re-judged under the lock: a review hidden a moment ago is no longer
      // reportable, and the owner never reports their own.
      if (!canReport(review, accountId)) {
        throw new ApiError(
          'CONFLICT',
          review.accountId === accountId
            ? 'a reviewer does not report their own review'
            : 'that review is not published',
        );
      }

      // doc 10 §7.2: a repeat submission answers with the report the account
      // already holds rather than creating a second. Checked under the review's
      // own row lock, which is what orders two concurrent reports of the same
      // review — the partial unique index remains the backstop, and a race that
      // reached it would abort the transaction rather than be papered over.
      const held = await repository.openReportBy(review.reviewId, accountId);
      if (held !== undefined) {
        const replayed = reportView(held);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, replayed);
        return replayed;
      }
      const created = await repository.createReport({
        hotelId,
        reviewId: review.reviewId,
        accountId,
        reason: input.reason,
        note,
      });
      await recordPlatformAudit(uow, {
        action: 'review.reported',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: review.reviewId,
        // The reason is recorded; the reporter's own note is not, because it is
        // free text a guest wrote about somebody else.
        payload: { reportId: created.reportId, reason: input.reason },
      });
      const view = reportView(created);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
      return view;
    });
  }

  /**
   * The hotel a published review belongs to.
   *
   * Read through the public projection, because a reporter has no relationship
   * with the hotel at all: they saw the review on a public page, and that page
   * is the only thing that put the id in their hands.
   */
  private async hotelOfPublishedReview(reviewId: string): Promise<string> {
    const result = await this.deps.pool.query<{ hotel_id: string }>(
      `SELECT hotel_id FROM platform.hotel_of_published_review($1::uuid)`,
      [reviewId],
    );
    const hotelId = result.rows[0]?.hotel_id;
    if (hotelId === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
    return hotelId;
  }
}
