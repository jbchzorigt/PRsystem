import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newReviewRequest } from '../services/review-context';
import { ReviewService } from '../services/review.service';
import type { ReviewView } from '../services/review.service';
import { ReviewReportService } from '../services/report.service';
import {
  optionalNote,
  rejectServerOwnedFields,
  requireComment,
  requireRating,
  requireReportReason,
} from './review-validation';

/**
 * The Guest's own reviews and reports (doc 10 §§4, 7.1, 7.2).
 *
 * Every route is authenticated and every one of them binds the reviewer from
 * the session. A review id that belongs to somebody else answers `NOT_FOUND`,
 * exactly as one that does not exist does, so the surface cannot be used to
 * discover another guest's review.
 *
 * The hotel appears in no request: it is resolved on the server from the
 * booking, which is resolved from the account.
 */
@ApiTags('guest-reviews')
@Controller('guest/reviews')
export class ReviewController {
  constructor(
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Inject(ReviewReportService) private readonly reports: ReviewReportService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Write the review a completed booking earns (RV-DEC-002)' })
  @ApiResponse({ status: 409, description: 'REVIEW_EXISTS: this booking already has one' })
  @ApiResponse({ status: 412, description: 'NOT_A_COMPLETED_STAY or REVIEW_WINDOW_CLOSED' })
  async write(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.reviews.write(
        {
          bookingId: requireUuid(payload['bookingId'], 'bookingId'),
          rating: requireRating(payload['rating']),
          comment: requireComment(payload['comment']),
          idempotencyKey: idempotencyKey(request),
        },
        this.asGuest(request),
      ),
    );
  }

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The reviews this guest wrote, and only those' })
  async mine(@Req() request: AuthenticatedRequest): Promise<{ reviews: unknown[] }> {
    const reviews = await this.reviews.mine(this.asGuest(request));
    return { reviews: reviews.map((row) => view(row)) };
  }

  @Post(':reviewId/revisions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Edit own review, until the 30-day window closes (RV-DEC-004)' })
  @ApiResponse({ status: 412, description: 'REVIEW_WINDOW_CLOSED or REVIEW_NOT_EDITABLE' })
  async edit(
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.reviews.edit(
        {
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          rating: requireRating(payload['rating']),
          comment: requireComment(payload['comment']),
          idempotencyKey: idempotencyKey(request),
        },
        this.asGuest(request),
      ),
    );
  }

  @Post(':reviewId/deletion')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Withdraw own review; the booking never yields another' })
  async remove(
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return view(
      await this.reviews.softDelete(
        {
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          idempotencyKey: idempotencyKey(request),
        },
        this.asGuest(request),
      ),
    );
  }

  @Post(':reviewId/reports')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Report a published review; it hides nothing (RV-DEC-005)' })
  @ApiResponse({ status: 409, description: 'The review is not published, or is the caller’s own' })
  async report(
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const note = optionalNote(payload['note']);
    const reported = await this.reports.report(
      {
        reviewId: requireUuid(reviewIdParam, 'reviewId'),
        reason: requireReportReason(payload['reason']),
        ...(note === undefined ? {} : { note }),
        idempotencyKey: idempotencyKey(request),
      },
      this.asGuest(request),
    );
    return {
      reportId: reported.reportId,
      reviewId: reported.reviewId,
      reason: reported.reason,
      state: reported.state,
      createdAt: reported.createdAt.toISOString(),
    };
  }

  /**
   * The Guest the session resolved to.
   *
   * A Hotel, Operation or Police principal reaching this surface is refused:
   * realms never merge, and a review belongs to the Guest realm alone.
   */
  private asGuest(request: AuthenticatedRequest): ReturnType<typeof newReviewRequest> {
    const principal = principalOf(request);
    if (principal.realm !== 'guest') {
      throw new ApiError('FORBIDDEN', 'a review belongs to the Guest realm');
    }
    return newReviewRequest(principal.accountId);
  }
}

export function view(row: ReviewView): Record<string, unknown> {
  return {
    reviewId: row.reviewId,
    hotelId: row.hotelId,
    bookingId: row.bookingId,
    rating: row.rating,
    comment: row.comment,
    displayName: row.displayName,
    status: row.status,
    edited: row.edited,
    reviewDeadlineAt: row.reviewDeadlineAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  };
}
