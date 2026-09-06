import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import { isPaymentProvider } from '@prsystem/ports';
import type { RawCallback } from '@prsystem/ports';
import type { FastifyRequest } from 'fastify';
import { body } from '../../iam/http/validation';
import { newRestaurantRequest } from '../services/restaurant-context';
import { RestaurantOrderService } from '../services/order.service';

/**
 * The restaurant merchant's payment callback (doc 08 §11, `REST-DEC-005`).
 *
 * Separate from the booking callback because the merchant is: doc 08 §13 sends
 * food money to the restaurant's own account, and nothing that arrives here
 * ever reaches a folio, a deposit, a drawer or a shift.
 *
 * Trusted for nothing. The signature is verified, the provider event is
 * deduplicated, the provider's own status is re-queried, and the amount and
 * reference are matched before any state moves. A capture that lands after the
 * invoice window closed does not resurrect the order — it creates the mandatory
 * refund obligation `REST-DEC-005` requires.
 *
 * Every failure answers the same `rejected`, so the endpoint cannot be used to
 * discover which references are real.
 */
@ApiTags('restaurant-payment-callbacks')
@Controller('restaurant/payments/callbacks')
export class RestaurantCallbackController {
  constructor(@Inject(RestaurantOrderService) private readonly orders: RestaurantOrderService) {}

  @Post(':provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'A restaurant payment callback, verified server-side before use' })
  @ApiResponse({ status: 200, description: 'Accepted, rejected, duplicate or unverified' })
  async callback(
    @Param('provider') providerParam: string,
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ outcome: string }> {
    const provider = providerParam.toUpperCase();
    if (!isPaymentProvider(provider)) {
      throw new ApiError('VALIDATION_FAILED', 'unknown payment provider');
    }
    const payload = body(request);
    const raw: RawCallback = {
      provider,
      providerInvoiceId: text(payload['providerInvoiceId'], 'providerInvoiceId'),
      ...optional('providerPaymentId', payload),
      ...optional('merchantRef', payload),
      ...optional('amountMnt', payload),
      ...optional('currency', payload),
      ...optional('signature', payload),
      ...optional('status', payload),
    };
    const outcome = await this.orders.handleCallback(raw, newRestaurantRequest());
    // The order id is not returned: a caller that could not already name the
    // invoice learns nothing here.
    return { outcome: outcome.outcome };
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a short string`);
  }
  return value;
}

function optional(
  field: 'providerPaymentId' | 'merchantRef' | 'amountMnt' | 'currency' | 'signature' | 'status',
  payload: Record<string, unknown>,
): Record<string, string> {
  const value = payload[field];
  if (value === undefined || value === null) return {};
  return { [field]: text(value, field) };
}
