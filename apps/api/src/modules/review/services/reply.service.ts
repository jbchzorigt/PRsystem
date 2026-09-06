import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReviewRepository } from '../repositories/review.repository';
import type { ReplyRow } from '../repositories/review.repository';
import { canManageReply, isReplyBody, normalizeComment } from '../domain/review';
import type { RequestContext, ReviewDependencies } from './review-context';
import type { CommandActor } from './review-context';
import {
  NOT_FOUND,
  REPLY_MANAGE,
  ReviewServiceBase,
  claim,
  newReviewRequest,
} from './review-context';

/**
 * The hotel's one official reply (doc 10 §7.4, `RV-DEC-007`).
 *
 * `hotel.review.official_reply_manage` is an all-packages row for Hotel Admin
 * and Manager and a 30,000₮ row for Manager Plus — doc 18 §3 says so, and the
 * package half is in that cell rather than repeated here. Reception, Cleaner
 * and Restaurant Manager hold it in no package.
 *
 * There is exactly **one reply record per review**, enforced by a UNIQUE index
 * on `review_id`. A soft-deleted reply is therefore restored rather than
 * replaced, and a second record cannot exist however the row is written.
 *
 * A reply never touches the review. doc 10 §9 is explicit that a hotel may not
 * edit or delete a guest's words, and nothing in this service writes to
 * `hotel_review` at all.
 */

export interface ReplyView {
  readonly replyId: string;
  readonly reviewId: string;
  readonly body: string;
  readonly state: string;
  readonly edited: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

function replyView(row: ReplyRow): ReplyView {
  return {
    replyId: row.replyId,
    reviewId: row.reviewId,
    body: row.body,
    state: row.state,
    edited: row.edited,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

export class ReviewReplyService extends ReviewServiceBase {
  constructor(deps: ReviewDependencies) {
    super(deps);
  }

  /** doc 10 §7.4: the reply, created once and thereafter edited or restored. */
  async reply(
    input: {
      hotelId: string;
      reviewId: string;
      body: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReplyView> {
    const body = this.requireBody(input.body);
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REPLY_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'review.reply', input.idempotencyKey, {
          reviewId: input.reviewId,
        });
        if (claimed.kind === 'replay') return claimed.body as ReplyView;
        await authorize();

        const repository = new ReviewRepository(uow);
        // The review is read in the hotel's own scope, so a review belonging to
        // another hotel is simply not there — doc 10 §7.4's "no reply to
        // another hotel's review" is the tenant policy rather than a check.
        const review = await repository.lockReview(input.reviewId);
        if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
        if (!canManageReply(review.status)) {
          throw new ApiError(
            'CONFLICT',
            'REVIEW_NOT_PUBLIC: a hidden or deleted review takes no reply',
          );
        }
        const existing = await repository.lockReplyFor(review.reviewId);
        if (existing !== undefined) {
          throw new ApiError(
            'CONFLICT',
            existing.state === 'ACTIVE'
              ? 'REPLY_EXISTS: this review already has the hotel’s reply; edit it instead'
              : 'REPLY_DELETED: restore the existing reply rather than writing a second',
          );
        }
        const created = await repository.createReply({
          hotelId: input.hotelId,
          reviewId: review.reviewId,
          body,
          createdByAccountId: gate.principal.accountId,
        });
        await repository.recordReplyEvent({
          hotelId: input.hotelId,
          replyId: created.replyId,
          reviewId: review.reviewId,
          action: 'CREATE',
          actorAccountId: gate.principal.accountId,
          fromBody: null,
          toBody: body,
          fromState: null,
          toState: 'ACTIVE',
        });
        await recordPlatformAudit(uow, {
          action: 'review.reply_created',
          outcome: 'allowed',
          targetType: 'hotel_review',
          targetRef: review.reviewId,
          payload: { replyId: created.replyId },
        });
        const view = replyView(created);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** doc 10 §7.4: an edited reply carries `Засварласан` and its own history. */
  async editReply(
    input: {
      hotelId: string;
      reviewId: string;
      body: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReplyView> {
    const body = this.requireBody(input.body);
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REPLY_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'review.reply_edit', input.idempotencyKey, {
          reviewId: input.reviewId,
        });
        if (claimed.kind === 'replay') return claimed.body as ReplyView;
        await authorize();

        const repository = new ReviewRepository(uow);
        const review = await repository.lockReview(input.reviewId);
        if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
        if (!canManageReply(review.status)) {
          throw new ApiError(
            'CONFLICT',
            'REVIEW_NOT_PUBLIC: a hidden or deleted review takes no reply',
          );
        }
        const existing = await repository.lockReplyFor(review.reviewId);
        if (existing === undefined || existing.state !== 'ACTIVE') {
          throw new ApiError('NOT_FOUND', 'this review has no live reply');
        }
        const now = this.now(uow);
        const moved = await repository.updateReply({
          replyId: existing.replyId,
          expectedRevision: existing.revision,
          body,
          edited: true,
          updatedByAccountId: gate.principal.accountId,
          at: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that reply changed under this command');
        await repository.recordReplyEvent({
          hotelId: input.hotelId,
          replyId: existing.replyId,
          reviewId: review.reviewId,
          action: 'EDIT',
          actorAccountId: gate.principal.accountId,
          fromBody: existing.body,
          toBody: body,
          fromState: existing.state,
          toState: existing.state,
        });
        await recordPlatformAudit(uow, {
          action: 'review.reply_edited',
          outcome: 'allowed',
          targetType: 'hotel_review',
          targetRef: review.reviewId,
          payload: { replyId: existing.replyId },
        });
        return this.rereadReply(uow, claimed.idempotencyId, review.reviewId);
      },
    );
  }

  /** doc 10 §7.4: soft-delete, and the restore that brings the same record back. */
  async setReplyState(
    input: {
      hotelId: string;
      reviewId: string;
      state: 'ACTIVE' | 'DELETED';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReplyView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REPLY_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'review.reply_state', input.idempotencyKey, {
          reviewId: input.reviewId,
          state: input.state,
        });
        if (claimed.kind === 'replay') return claimed.body as ReplyView;
        await authorize();

        const repository = new ReviewRepository(uow);
        const review = await repository.lockReview(input.reviewId);
        if (review === undefined) throw new ApiError('NOT_FOUND', NOT_FOUND);
        // A restore needs the review public again; a delete does not, because a
        // hotel must be able to withdraw a reply whatever happened to the
        // review it answers.
        if (input.state === 'ACTIVE' && !canManageReply(review.status)) {
          throw new ApiError(
            'CONFLICT',
            'REVIEW_NOT_PUBLIC: a hidden or deleted review takes no reply',
          );
        }
        const existing = await repository.lockReplyFor(review.reviewId);
        if (existing === undefined) throw new ApiError('NOT_FOUND', 'this review has no reply');
        if (existing.state === input.state) {
          throw new ApiError('CONFLICT', `that reply is already ${input.state.toLowerCase()}`);
        }
        const now = this.now(uow);
        const moved = await repository.updateReply({
          replyId: existing.replyId,
          expectedRevision: existing.revision,
          state: input.state,
          deletedAt: input.state === 'DELETED' ? now : null,
          updatedByAccountId: gate.principal.accountId,
          at: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that reply changed under this command');
        await repository.recordReplyEvent({
          hotelId: input.hotelId,
          replyId: existing.replyId,
          reviewId: review.reviewId,
          action: input.state === 'DELETED' ? 'DELETE' : 'RESTORE',
          actorAccountId: gate.principal.accountId,
          fromBody: existing.body,
          toBody: existing.body,
          fromState: existing.state,
          toState: input.state,
        });
        await recordPlatformAudit(uow, {
          action: input.state === 'DELETED' ? 'review.reply_deleted' : 'review.reply_restored',
          outcome: 'allowed',
          targetType: 'hotel_review',
          targetRef: review.reviewId,
          payload: { replyId: existing.replyId },
        });
        return this.rereadReply(uow, claimed.idempotencyId, review.reviewId);
      },
    );
  }

  /** The hotel's published reviews and its replies, for the staff screen. */
  async reviewsOf(
    hotelId: string,
    actor: CommandActor,
    limit = 50,
    request: RequestContext = newReviewRequest(actor.principal.accountId),
  ): Promise<readonly { review: unknown; reply: ReplyView | null }[]> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId },
      REPLY_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new ReviewRepository(uow);
        const reviews = await repository.reviewsForHotel(hotelId, limit);
        const out = [];
        for (const review of reviews) {
          const reply = await repository.replyFor(review.reviewId);
          out.push({
            review: {
              reviewId: review.reviewId,
              rating: review.rating,
              comment: review.comment,
              displayName: review.displayNameSnapshot,
              edited: review.edited,
              createdAt: review.createdAt,
            },
            reply: reply === undefined ? null : replyView(reply),
          });
        }
        return out;
      },
    );
  }

  private requireBody(raw: string): string {
    const body = normalizeComment(raw);
    if (!isReplyBody(body)) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'an official reply is 10 to 1000 characters once trimmed',
      );
    }
    return body;
  }

  private async rereadReply(
    uow: UnitOfWork,
    idempotencyId: string,
    reviewId: string,
  ): Promise<ReplyView> {
    const reread = await new ReviewRepository(uow).replyFor(reviewId);
    if (reread === undefined) throw new Error('the reply vanished under its own lock');
    const view = replyView(reread);
    await completeIdempotencyKey(uow, idempotencyId, 200, view);
    return view;
  }
}
