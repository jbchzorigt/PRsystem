import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReviewRepository } from '../repositories/review.repository';
import {
  aggregateWith,
  canHide,
  canRestore,
  isReportNote,
  isReportReason,
  normalizeComment,
} from '../domain/review';
import type { Aggregate, ReportResolution } from '../domain/review';
import type { ReviewView } from './review.service';
import { reviewView } from './review.service';
import type { CommandActor, RequestContext, ReviewDependencies } from './review-context';
import { NOT_FOUND, ReviewServiceBase, claim, newReviewRequest } from './review-context';

/**
 * Platform moderation (doc 10 §7.3, `RV-DEC-005`, `RV-DEC-006`).
 *
 * One sentence governs everything here: *`Operation Admin` or `Platform Super
 * Admin` as a name grants nothing.* What opens these three commands is the
 * explicitly granted `REVIEW_MODERATE` permission on the acting account, and
 * the Phase 04 pipeline re-reads that grant inside each command's own
 * transaction — so a grant revoked a moment earlier refuses the command that
 * was authorised a moment before it.
 *
 * The moderator's power is also deliberately small. They may hide a published
 * review and restore a hidden one, with a stated reason and a mandatory note.
 * They may not hard-delete, they may not touch the owner's rating or comment,
 * and they may not restore what the owner deleted — the last of which is a
 * database trigger, not a check here.
 */

export interface QueueEntry {
  readonly reportId: string;
  readonly reviewId: string;
  readonly hotelId: string;
  readonly createdAt: Date;
}

export class ReviewModerationService extends ReviewServiceBase {
  constructor(deps: ReviewDependencies) {
    super(deps);
  }

  /**
   * doc 10 §7.3: the open report queue, across every hotel.
   *
   * Identifiers only. The review's words, its author and the reporter's note
   * are read afterwards, in the hotel's own scope and under the moderator's own
   * permission — a queue that carried the content would be a way to read every
   * hotel's reviews without ever exercising the permission on one.
   */
  async queue(
    actor: CommandActor,
    limit = 50,
    request: RequestContext = newReviewRequest(actor.principal.accountId),
  ): Promise<readonly QueueEntry[]> {
    // The permission is checked against one arbitrary tenant scope; the
    // Operation realm has no per-hotel scope, so the decision is the same for
    // every row the queue returns.
    await this.assertModerator(actor, request);
    const result = await this.deps.pool.query<{
      report_id: string;
      review_id: string;
      hotel_id: string;
      created_at: Date;
    }>(`SELECT report_id, review_id, hotel_id, created_at FROM platform.open_review_reports($1)`, [
      limit,
    ]);
    return result.rows.map((row) => ({
      reportId: row.report_id,
      reviewId: row.review_id,
      hotelId: row.hotel_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * `RV-DEC-005`: hide a published review, with an approved reason and a note.
   *
   * A negative rating is not a reason — the reason has to be one of the four
   * doc 10 §7.2 approves, and the note is not optional. The aggregate loses the
   * rating in this same transaction, so the average a visitor sees never
   * includes a review they cannot.
   */
  async hide(
    input: {
      reviewId: string;
      reason: string;
      note: string;
      reportId?: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReviewView> {
    const reason = this.requireApprovedReason(input.reason);
    const note = this.requireNote(input.note);
    const hotelId = await this.hotelOfReview(input.reviewId);

    return this.runModeratorCommand(actor, hotelId, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'review.moderation_hide', input.idempotencyKey, {
        reviewId: input.reviewId,
        reason,
      });
      if (claimed.kind === 'replay') return claimed.body as ReviewView;
      await authorize();

      const repository = new ReviewRepository(uow);
      const aggregate = await repository.lockAggregate(hotelId);
      const review = await repository.lockReview(input.reviewId);
      if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
      if (!canHide(review.status)) {
        throw new ApiError(
          'CONFLICT',
          review.status === 'HIDDEN'
            ? 'that review is already hidden'
            : 'a review the owner deleted is not hidden',
        );
      }
      const now = this.now(uow);
      const moved = await repository.updateReview({
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        status: 'HIDDEN',
        hiddenAt: now,
        hiddenByAccountId: actor.principal.accountId,
        at: now,
      });
      if (!moved) throw new ApiError('CONFLICT', 'that review changed under this command');
      await this.writeAggregate(
        uow,
        aggregate,
        aggregateWith(aggregate, { removed: review.rating }),
        now,
      );
      await repository.recordModeration({
        hotelId,
        reviewId: review.reviewId,
        reportId: input.reportId ?? null,
        action: 'HIDE',
        actorAccountId: actor.principal.accountId,
        reason,
        note,
        fromStatus: 'PUBLISHED',
        toStatus: 'HIDDEN',
      });
      await recordPlatformAudit(uow, {
        action: 'review.hidden',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: review.reviewId,
        payload: { reason, permission: 'REVIEW_MODERATE' },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'hotel_review',
        aggregateId: review.reviewId,
        eventType: 'review.hidden',
        payload: { reviewId: review.reviewId, hotelId, reason },
      });
      return this.rereadAndComplete(uow, claimed.idempotencyId, review.reviewId);
    });
  }

  /**
   * `RV-DEC-006`: restore a hidden review, with a mandatory reason.
   *
   * Only a hidden one. A review the owner soft-deleted stays deleted — checked
   * here for the sentence, and refused by the review guard's trigger whatever
   * writes the row.
   */
  async restore(
    input: { reviewId: string; note: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReviewView> {
    const note = this.requireNote(input.note);
    const hotelId = await this.hotelOfReview(input.reviewId);

    return this.runModeratorCommand(actor, hotelId, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'review.moderation_restore', input.idempotencyKey, {
        reviewId: input.reviewId,
      });
      if (claimed.kind === 'replay') return claimed.body as ReviewView;
      await authorize();

      const repository = new ReviewRepository(uow);
      const aggregate = await repository.lockAggregate(hotelId);
      const review = await repository.lockReview(input.reviewId);
      if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
      if (!canRestore(review.status)) {
        throw new ApiError(
          'CONFLICT',
          review.status === 'DELETED'
            ? 'a review the owner deleted is not restored'
            : 'that review is not hidden',
        );
      }
      const now = this.now(uow);
      const moved = await repository.updateReview({
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        status: 'PUBLISHED',
        // The hide is history, not a live mark: the row keeps who hid it and
        // when, so a restore does not erase the moderation that preceded it.
        at: now,
      });
      if (!moved) throw new ApiError('CONFLICT', 'that review changed under this command');
      await this.writeAggregate(
        uow,
        aggregate,
        aggregateWith(aggregate, { added: review.rating }),
        now,
      );
      await repository.recordModeration({
        hotelId,
        reviewId: review.reviewId,
        reportId: null,
        action: 'RESTORE',
        actorAccountId: actor.principal.accountId,
        reason: 'RESTORED',
        note,
        fromStatus: 'HIDDEN',
        toStatus: 'PUBLISHED',
      });
      await recordPlatformAudit(uow, {
        action: 'review.restored',
        outcome: 'allowed',
        targetType: 'hotel_review',
        targetRef: review.reviewId,
        payload: { permission: 'REVIEW_MODERATE' },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'hotel_review',
        aggregateId: review.reviewId,
        eventType: 'review.restored',
        payload: { reviewId: review.reviewId, hotelId },
      });
      return this.rereadAndComplete(uow, claimed.idempotencyId, review.reviewId);
    });
  }

  /**
   * doc 10 §7.2: the report is decided, upheld or dismissed, with a note.
   *
   * Resolving a report changes no review: hiding is its own command, taken
   * deliberately. A report upheld without a hide is a decision the moderator is
   * allowed to record — for example when the same review was already hidden on
   * an earlier report.
   */
  async resolveReport(
    input: {
      reportId: string;
      resolution: ReportResolution;
      note: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ reportId: string; state: string; resolution: ReportResolution }> {
    const note = this.requireNote(input.note);
    if (input.resolution !== 'UPHELD' && input.resolution !== 'DISMISSED') {
      throw new ApiError('VALIDATION_FAILED', 'resolution must be UPHELD or DISMISSED');
    }
    const located = await this.deps.pool.query<{ hotel_id: string; review_id: string }>(
      `SELECT hotel_id, review_id FROM platform.open_review_reports(200)
        WHERE report_id = $1::uuid`,
      [input.reportId],
    );
    const found = located.rows[0];
    if (found === undefined) throw new ApiError('NOT_FOUND', 'no such open report');

    return this.runModeratorCommand(actor, found.hotel_id, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'review.report_resolve', input.idempotencyKey, {
        reportId: input.reportId,
        resolution: input.resolution,
      });
      if (claimed.kind === 'replay') {
        return claimed.body as { reportId: string; state: string; resolution: ReportResolution };
      }
      await authorize();

      const repository = new ReviewRepository(uow);
      const report = await repository.lockReport(input.reportId);
      if (report === undefined) throw new ApiError('NOT_FOUND', 'no such open report');
      if (report.state !== 'OPEN') throw new ApiError('CONFLICT', 'that report is already decided');
      const now = this.now(uow);
      const resolved = await repository.resolveReport({
        reportId: report.reportId,
        expectedRevision: report.revision,
        resolution: input.resolution,
        resolvedByAccountId: actor.principal.accountId,
        resolutionNote: note,
        at: now,
      });
      if (!resolved) throw new ApiError('CONFLICT', 'that report changed under this command');
      await repository.recordModeration({
        hotelId: found.hotel_id,
        reviewId: report.reviewId,
        reportId: report.reportId,
        action: 'REPORT_RESOLVE',
        actorAccountId: actor.principal.accountId,
        reason: input.resolution,
        note,
        fromStatus: null,
        toStatus: null,
      });
      await recordPlatformAudit(uow, {
        action: 'review.report_resolved',
        outcome: 'allowed',
        targetType: 'review_report',
        targetRef: report.reportId,
        payload: { resolution: input.resolution, permission: 'REVIEW_MODERATE' },
      });
      const view = {
        reportId: report.reportId,
        state: 'RESOLVED',
        resolution: input.resolution,
      };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  // ------------------------------------------------------------------ helpers

  /** doc 10 §7.3: the four approved report reasons, and nothing else. */
  private requireApprovedReason(reason: string): string {
    if (!isReportReason(reason)) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'a hide states one of PERSONAL_DATA, ABUSE_ILLEGAL, SPAM_FRAUD or OTHER',
      );
    }
    return reason;
  }

  private requireNote(note: string): string {
    const trimmed = normalizeComment(note);
    if (!isReportNote(trimmed)) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'a moderation note is mandatory, 10 to 500 characters',
      );
    }
    return trimmed;
  }

  /**
   * The hotel a review belongs to, for a moderator who is a member of none.
   *
   * The moderation resolver answers for a published *or* hidden review, which
   * is exactly the pair `RV-DEC-005` and `RV-DEC-006` address — and never for
   * one the owner deleted.
   */
  private async hotelOfReview(reviewId: string): Promise<string> {
    const located = await this.deps.pool.query<{ hotel_id: string }>(
      `SELECT hotel_id FROM platform.hotel_of_moderatable_review($1::uuid)`,
      [reviewId],
    );
    const hotelId = located.rows[0]?.hotel_id;
    // A review the owner deleted resolves to nothing here, which is why the
    // restore of one answers NOT_FOUND rather than reaching the row and being
    // refused by the trigger — both are correct, and this is the cheaper one.
    if (hotelId === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
    return hotelId;
  }

  /**
   * The permission, on its own, before a read that has no row to lock.
   *
   * The queue is not a command and locks nothing, so this is the one place the
   * pipeline runs without an effect behind it.
   */
  private async assertModerator(actor: CommandActor, request: RequestContext): Promise<void> {
    await this.runModeratorCommand(
      actor,
      // The Operation realm has no hotel scope, so any tenant serves to open a
      // transaction; the decision does not consult it.
      '00000000-0000-0000-0000-000000000000',
      request,
      async (_uow, authorize) => {
        await authorize();
      },
    );
  }

  private async rereadAndComplete(
    uow: UnitOfWork,
    idempotencyId: string,
    reviewId: string,
  ): Promise<ReviewView> {
    const reread = await new ReviewRepository(uow).reviewById(reviewId);
    if (reread === undefined) throw new Error('the review vanished under its own lock');
    const view = reviewView(reread);
    await completeIdempotencyKey(uow, idempotencyId, 200, view);
    return view;
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
    if (!written) throw new Error('the review aggregate changed under its own lock');
  }
}
