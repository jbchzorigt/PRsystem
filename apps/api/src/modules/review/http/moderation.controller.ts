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
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { newReviewRequest } from '../services/review-context';
import { ReviewModerationService } from '../services/moderation.service';
import { view } from './review.controller';
import {
  optionalLimit,
  rejectServerOwnedFields,
  requireNote,
  requireReportReason,
  requireResolution,
} from './review-validation';

/**
 * Platform moderation (doc 10 §7.3, `RV-DEC-005`, `RV-DEC-006`).
 *
 * The guard authenticates; it does not authorize. Whether this caller may act
 * is decided by the Phase 04 pipeline inside each command's transaction,
 * against the explicitly granted `REVIEW_MODERATE` permission and the step-up
 * recency the action carries — never against the name of a Platform role.
 */
@ApiTags('review-moderation')
@Controller('operation/reviews')
export class ReviewModerationController {
  constructor(
    @Inject(ReviewModerationService) private readonly moderation: ReviewModerationService,
  ) {}

  @Get('reports')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The open report queue, identifiers only' })
  @ApiResponse({ status: 403, description: 'STEP_UP_REQUIRED, or no REVIEW_MODERATE grant' })
  async queue(
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<{ reports: unknown[] }> {
    const entries = await this.moderation.queue(
      actorOf(request),
      optionalLimit(limit, 50, 200),
      this.asOperation(request),
    );
    return {
      reports: entries.map((entry) => ({
        reportId: entry.reportId,
        reviewId: entry.reviewId,
        hotelId: entry.hotelId,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  @Post(':reviewId/hide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Hide a published review, with an approved reason and a note' })
  @ApiResponse({
    status: 409,
    description: 'The review is already hidden, or was deleted by its owner',
  })
  async hide(
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const reportId = optionalUuid(payload['reportId'], 'reportId');
    return view(
      await this.moderation.hide(
        {
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          reason: requireReportReason(payload['reason']),
          note: requireNote(payload['note']),
          ...(reportId === undefined ? {} : { reportId }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.asOperation(request),
      ),
    );
  }

  @Post(':reviewId/restore')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Restore a hidden review; a deleted one is never restored' })
  @ApiResponse({ status: 409, description: 'The review is not hidden' })
  async restore(
    @Param('reviewId') reviewIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.moderation.restore(
        {
          reviewId: requireUuid(reviewIdParam, 'reviewId'),
          note: requireNote(payload['note']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.asOperation(request),
      ),
    );
  }

  @Post('reports/:reportId/resolution')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Decide a report: upheld or dismissed, with a note' })
  async resolve(
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.moderation.resolveReport(
        {
          reportId: requireUuid(reportIdParam, 'reportId'),
          resolution: requireResolution(payload['resolution']),
          note: requireNote(payload['note']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.asOperation(request),
      )),
    };
  }

  /**
   * The Operation principal this session resolved to.
   *
   * A Guest, Hotel or Police token is refused at the edge; whether *this*
   * Operation account may moderate is still the pipeline's decision, not this
   * check's.
   */
  private asOperation(request: AuthenticatedRequest): ReturnType<typeof newReviewRequest> {
    const principal = principalOf(request);
    if (principal.realm !== 'operation') {
      throw new ApiError('FORBIDDEN', 'review moderation belongs to the Platform realm');
    }
    return newReviewRequest(principal.accountId);
  }
}
