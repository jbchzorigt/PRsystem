import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newRestaurantRequest } from '../services/restaurant-context';
import { RestaurantOrderService } from '../services/order.service';
import { RestaurantRefundService } from '../services/refund.service';
import { view } from './guest-order.controller';
import {
  optionalReason,
  optionalRejectReason,
  rejectServerOwnedFields,
  requireDecision,
  requireEta,
  requireFulfillmentTarget,
  requireHandoff,
} from './restaurant-validation';

/**
 * The restaurant's and Reception's side of an order (doc 08 §§19–22).
 *
 * `restaurant.order_process` is the named permission for everything the
 * restaurant does; the refund request Reception raises on a guest's behalf is
 * gated by Reception's own checkout permission instead, because it is a
 * front-desk act and not a kitchen one.
 *
 * The acceptance race (`REST-DEC-002`) is not resolved here. Whichever
 * transaction takes the order's row lock first decides, and the loser re-reads
 * and receives a different, still-correct answer — the HTTP layer contributes
 * no ordering of its own.
 */
@ApiTags('restaurant-orders')
@Controller('hotels/:hotelId/restaurant-orders')
export class RestaurantOrderController {
  constructor(
    @Inject(RestaurantOrderService) private readonly orders: RestaurantOrderService,
    @Inject(RestaurantRefundService) private readonly refunds: RestaurantRefundService,
  ) {}

  @Post(':orderId/acceptance')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Accept with one of the four ETAs (doc 08 §22)' })
  @ApiResponse({ status: 409, description: 'A refund request took the row first' })
  async accept(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.orders.accept(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          etaMinutes: requireEta(payload['etaMinutes']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/fulfillment')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Move the order forward one step; fulfillment never runs backwards' })
  async advance(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.orders.advance(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          to: requireFulfillmentTarget(payload['to']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/cancellation')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The restaurant cancels a paid order; the refund is mandatory' })
  async cancel(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const reason = optionalReason(payload['reason']);
    return view(
      await this.orders.cancelByRestaurant(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          ...(reason === undefined ? {} : { reason }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/refund-request/decision')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Approve or reject the guest’s refund request (doc 08 §21)' })
  @ApiResponse({ status: 400, description: 'A rejection states which stage it rests on' })
  async decide(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const rejectReason = optionalRejectReason(payload['rejectReason']);
    return view(
      await this.orders.decideRequest(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          decision: requireDecision(payload['decision']),
          ...(rejectReason === undefined ? {} : { rejectReason }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/handoff')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Record how the food reached the guest (doc 08 §20)' })
  async handoff(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return view(
      await this.orders.recordHandoff(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          mode: requireHandoff(payload['mode']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/refund-request')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reception raises the request for a guest at the desk' })
  async raise(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return view(
      await this.orders.requestRefundAsReception(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post(':orderId/refund')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Execute the approved refund against the restaurant’s merchant' })
  @ApiResponse({
    status: 412,
    description: 'PAYMENT_UNAVAILABLE: the gateway refused or is disabled',
  })
  async refund(
    @Param('hotelId') hotelIdParam: string,
    @Param('orderId') orderIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.refunds.execute(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          orderId: requireUuid(orderIdParam, 'orderId'),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newRestaurantRequest> {
    return newRestaurantRequest(principalOf(request).accountId);
  }
}
