import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { ConfigurationService } from '../services/configuration.service';
import type { ChangeView, TaskView } from '../services/configuration.service';
import { newMinibarRequest } from '../services/minibar-context';
import { requireStockLines } from './minibar-validation';

/**
 * The Cleaner's reconciliation and rollback tasks (doc 04 §5.3, doc 26 §21).
 * Server-bounded: the task says which products move, in which direction, up
 * to what quantity; the Cleaner confirms the count and what actually moved.
 * `config_reconciliation_execute`, scoped to the Cleaner's own task.
 */
@ApiTags('minibar-tasks')
@Controller('hotels/:hotelId/minibar/tasks')
export class TaskController {
  constructor(
    @Inject(ConfigurationService) private readonly configurations: ConfigurationService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open tasks, and the ones assigned to the caller' })
  async mine(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<readonly TaskView[]> {
    return this.configurations.myTasks(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':taskId/claim')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Claim an open task atomically' })
  @ApiResponse({ status: 409, description: 'Already claimed by someone else' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TaskView> {
    const payload = body(request);
    return this.configurations.claimTask(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':taskId/complete')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Confirm the count and the transfers made, each within its bound' })
  @ApiResponse({ status: 400, description: 'OUT_OF_BOUNDS' })
  @ApiResponse({ status: 409, description: 'INSUFFICIENT_STOCK' })
  async complete(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ readonly task: TaskView; readonly change: ChangeView }> {
    const payload = body(request);
    return this.configurations.completeTask(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        counted: requireStockLines(payload['counted'] ?? [], 'counted', 0),
        transfers: requireStockLines(payload['transfers'] ?? [], 'transfers', 1),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }
}
