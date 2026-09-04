import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { CleaningTaskService } from '../services/cleaning-task.service';
import { newStayRequest } from '../services/stay-context';
import type { CleaningTaskView } from '../services/checkout-views';
import { requireCountedLines } from './stay-validation';

/**
 * The Cleaner's cleaning queue (doc 04 §3, §5.2). Completing a task records
 * the routine refill of the room's current configuration and marks the room
 * `Цэвэр`.
 */
@ApiTags('stay-cleaning-tasks')
@Controller('hotels/:hotelId/cleaning-tasks')
export class CleaningTaskController {
  constructor(@Inject(CleaningTaskService) private readonly tasks: CleaningTaskService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Rooms waiting to be cleaned, and the ones being cleaned' })
  async queue(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ tasks: readonly CleaningTaskView[] }> {
    const tasks = await this.tasks.queue(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { tasks };
  }

  @Post(':taskId/claim')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'One Cleaner takes the task (task_claim)' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CleaningTaskView> {
    const payload = body(request);
    return this.tasks.claimTask(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':taskId/complete')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Record the routine refill and mark the room clean' })
  @ApiResponse({ status: 412, description: 'CONFIGURATION_CHANGE_PENDING, MINIBAR_OFF' })
  @ApiResponse({ status: 400, description: 'REFILL_ABOVE_TARGET, PRODUCT_NOT_IN_CONFIGURATION' })
  async complete(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CleaningTaskView> {
    const payload = body(request);
    return this.tasks.complete(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        refilled: requireCountedLines(payload['refilled'], 'refilled'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
