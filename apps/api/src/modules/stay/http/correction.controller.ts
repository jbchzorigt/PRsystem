import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { CorrectionService } from '../services/correction.service';
import { newStayRequest } from '../services/stay-context';
import type { CorrectionView } from '../services/stay-views';
import { optionalString, requireInstant } from './stay-validation';

/**
 * `STAY-DEC-010`: a Reception submits, a Manager decides. No route edits the
 * original time; the effective time is derived from the approved row.
 */
@ApiTags('stay-corrections')
@Controller('hotels/:hotelId/stays')
export class CorrectionController {
  constructor(@Inject(CorrectionService) private readonly corrections: CorrectionService) {}

  @Get(':stayId/time-corrections')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Every correction request of a stay, oldest first' })
  async history(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ corrections: readonly CorrectionView[] }> {
    const corrections = await this.corrections.history(
      { hotelId: requireUuid(hotelIdParam, 'hotelId'), stayId: requireUuid(stayIdParam, 'stayId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { corrections };
  }

  @Post(':stayId/time-corrections')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Submit a corrected arrival with a reason (actual_time_correction_submit)',
  })
  @ApiResponse({ status: 412, description: 'CORRECTION_OUT_OF_BOUND' })
  @ApiResponse({ status: 409, description: 'CORRECTION_PENDING, CHECKOUT_STARTED' })
  async submit(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CorrectionView> {
    const payload = body(request);
    const correction = await this.corrections.submit(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        correctedActualCheckInAt: requireInstant(
          payload['correctedActualCheckInAt'],
          'correctedActualCheckInAt',
        ),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return correction;
  }

  @Post(':stayId/time-corrections/:correctionId/approve')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Approve (actual_time_correction_decide); self-approval is audited' })
  async approve(
    @Param('hotelId') hotelIdParam: string,
    @Param('correctionId') correctionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CorrectionView> {
    const payload = body(request);
    const decisionReason = optionalString(payload['decisionReason'], 'decisionReason', 300);
    return this.corrections.approve(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        correctionId: requireUuid(correctionIdParam, 'correctionId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...(decisionReason === undefined ? {} : { decisionReason }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':stayId/time-corrections/:correctionId/reject')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reject (actual_time_correction_decide)' })
  async reject(
    @Param('hotelId') hotelIdParam: string,
    @Param('correctionId') correctionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CorrectionView> {
    const payload = body(request);
    const decisionReason = optionalString(payload['decisionReason'], 'decisionReason', 300);
    return this.corrections.reject(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        correctionId: requireUuid(correctionIdParam, 'correctionId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...(decisionReason === undefined ? {} : { decisionReason }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
