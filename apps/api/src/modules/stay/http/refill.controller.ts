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
import { RefillService } from '../services/refill.service';
import { newStayRequest } from '../services/stay-context';
import type { RefillTaskView } from '../services/checkout-views';
import { requirePositiveInteger } from './stay-validation';

/**
 * The active-stay refill (doc 04 §5.1): Reception or a Manager asks, a Cleaner
 * confirms what was actually put in the room. No route carries a price.
 */
@ApiTags('stay-minibar-refills')
@Controller('hotels/:hotelId/minibar-refills')
export class RefillController {
  constructor(@Inject(RefillService) private readonly refills: RefillService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: "The Cleaner's open refill tasks" })
  async queue(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ tasks: readonly RefillTaskView[] }> {
    const tasks = await this.refills.queue(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { tasks };
  }

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask for a product to be topped up during the stay (refill_request)' })
  @ApiResponse({ status: 400, description: 'PRODUCT_NOT_IN_PRICE_BOOK' })
  @ApiResponse({ status: 409, description: 'STAY_NOT_ACTIVE, REFILL_TASK_OPEN' })
  async request(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RefillTaskView> {
    const payload = body(request);
    const task = await this.refills.request(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(payload['stayId'], 'stayId'),
        idempotencyKey: idempotencyKey(request),
        productId: requireUuid(payload['productId'], 'productId'),
        quantity: requirePositiveInteger(payload['quantity'], 'quantity', 999),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return task;
  }

  @Post(':taskId/claim')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A Cleaner takes the task (task_claim)' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RefillTaskView> {
    const payload = body(request);
    return this.refills.claimTask(
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
  @ApiOperation({ summary: 'Confirm what was actually refilled (refill_execute)' })
  async complete(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RefillTaskView> {
    const payload = body(request);
    return this.refills.complete(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        confirmedQuantity: requirePositiveInteger(
          payload['confirmedQuantity'],
          'confirmedQuantity',
          999,
        ),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':taskId/impossible')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The Cleaner cannot do it, with a reason and no movement' })
  async impossible(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RefillTaskView> {
    const payload = body(request);
    return this.refills.markImpossible(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':taskId/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reception or a Manager calls the request off (refill_request)' })
  async cancel(
    @Param('hotelId') hotelIdParam: string,
    @Param('taskId') taskIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RefillTaskView> {
    const payload = body(request);
    return this.refills.cancel(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        taskId: requireUuid(taskIdParam, 'taskId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
