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
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { optionalString } from '../../catalog/http/catalog-validation';
import { newMinibarRequest } from '../services/minibar-context';
import { RolloutService } from '../services/rollout.service';
import type { BatchView, PreviewRow } from '../services/rollout.service';
import { requireUuidList } from './minibar-validation';

/**
 * Multi-room Rollout (doc 26 §36). Preview is read-only; Confirm is idempotent
 * and partially successful; Cancel remaining and Retry are the only two
 * follow-ups. `rollout_batch` writes; `rollout_batch_view` reads, Reception
 * as `.read`.
 */
@ApiTags('minibar-rollout')
@Controller('hotels/:hotelId/minibar/rollouts')
export class RolloutController {
  constructor(@Inject(RolloutService) private readonly rollouts: RolloutService) {}

  @Post('preview')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Classify every selected room: READY_NOW, SCHEDULE_AFTER_STAY or INELIGIBLE',
  })
  async preview(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<readonly PreviewRow[]> {
    const payload = body(request);
    return this.rollouts.preview(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        templateId: requireUuid(payload['templateId'], 'templateId'),
        targetVersionId: requireUuid(payload['targetVersionId'], 'targetVersionId'),
        roomIds: requireUuidList(payload['roomIds'], 'roomIds'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Confirm a batch with partial success; retryOfBatchId links a retry' })
  @ApiResponse({ status: 409, description: 'RETRY_BLOCKED: the source batch is not terminal' })
  async confirm(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BatchView> {
    const payload = body(request);
    const retryOfBatchId = optionalUuid(payload['retryOfBatchId'], 'retryOfBatchId');
    const batch = await this.rollouts.confirm(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        templateId: requireUuid(payload['templateId'], 'templateId'),
        targetVersionId: requireUuid(payload['targetVersionId'], 'targetVersionId'),
        roomIds: requireUuidList(payload['roomIds'], 'roomIds'),
        idempotencyKey: idempotencyKey(request),
        ...(retryOfBatchId === undefined ? {} : { retryOfBatchId }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return batch;
  }

  @Get(':batchId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The batch, its derived state, counts and every room result' })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('batchId') batchIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<BatchView> {
    return this.rollouts.view(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        batchId: requireUuid(batchIdParam, 'batchId'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':batchId/cancel-remaining')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Cancel every child without movement; roll back the ones with movement',
  })
  async cancelRemaining(
    @Param('hotelId') hotelIdParam: string,
    @Param('batchId') batchIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<BatchView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return this.rollouts.cancelRemaining(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        batchId: requireUuid(batchIdParam, 'batchId'),
        idempotencyKey: idempotencyKey(request),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }
}
