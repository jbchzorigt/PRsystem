import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newReviewRequest } from '../services/review-context';
import { ReviewReplyService } from '../services/reply.service';
import type { ReplyView } from '../services/reply.service';
import {
  optionalLimit,
  rejectServerOwnedFields,
  requireReplyBody,
  requireReplyState,
} from './review-validation';

/**
 * The hotel's one official reply (doc 10 §7.4, `RV-DEC-007`).
 *
 * `hotel.review.official_reply_manage` is the named permission, and the package
 * half — all packages for Hotel Admin and Manager, 30,000₮ for Manager Plus —
 * lives in doc 18 §3's cell rather than in this file. Nothing here writes to a
 * review: a hotel answers, and never edits.
 */
@ApiTags('hotel-review-replies')
@Controller('hotels/:hotelId/reviews')
export class ReviewReplyController {
  constructor(@Inject(ReviewReplyService) private readonly replies: ReviewReplyService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The hotel’s published reviews and its replies to them' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<{ reviews: unknown[] }> {
    const rows = await this.replies.reviewsOf(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      optionalLimit(limit, 50, 200),
      this.context(request),
    );
    return { reviews: [...rows] };
  }

  @Post(':reviewId/reply')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Write the one official reply to a published review' })
  @ApiResponse({ status: 409, description: 'REPLY_EXISTS, REPLY_DELETED or REVIEW_NOT_PUBLIC' })
  async reply(
    @Param('hotelId') hotelIdParam: string,
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return replyBody(
      await this.replies.reply(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          body: requireReplyBody(payload['body']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':reviewId/reply/revisions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Edit the reply; it is marked as edited' })
  async edit(
    @Param('hotelId') hotelIdParam: string,
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return replyBody(
      await this.replies.editReply(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          body: requireReplyBody(payload['body']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':reviewId/reply/state')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Soft-delete the reply, or restore the same record' })
  async state(
    @Param('hotelId') hotelIdParam: string,
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return replyBody(
      await this.replies.setReplyState(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          state: requireReplyState(payload['state']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newReviewRequest> {
    return newReviewRequest(principalOf(request).accountId);
  }
}

function replyBody(row: ReplyView): Record<string, unknown> {
  return {
    replyId: row.replyId,
    reviewId: row.reviewId,
    body: row.body,
    state: row.state,
    edited: row.edited,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  };
}
