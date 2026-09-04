import { Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { CheckoutService } from '../services/checkout.service';
import { newStayRequest } from '../services/stay-context';
import type { CheckoutView } from '../services/checkout-views';

/**
 * `Check-out эхлүүлэх` and calling it off (doc 21 §2, doc 04 §8). Neither
 * closes the stay: the actual checkout stays where Phase 08 put it.
 */
@ApiTags('stay-checkout')
@Controller('hotels/:hotelId/stays')
export class CheckoutController {
  constructor(@Inject(CheckoutService) private readonly checkouts: CheckoutService) {}

  @Post(':stayId/checkout/start')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Start the checkout and open the minibar report (checkout_record)' })
  @ApiResponse({
    status: 412,
    description: 'CHECKOUT_REFUSED: CORRECTION_PENDING, REFILL_TASK_OPEN',
  })
  async start(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CheckoutView> {
    const payload = body(request);
    return this.checkouts.start(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':stayId/checkout/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Call the checkout off; the report becomes cancelled history' })
  @ApiResponse({ status: 412, description: 'PAYMENT_LOCKED' })
  async cancel(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CheckoutView> {
    const payload = body(request);
    return this.checkouts.cancel(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
