import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import { isPaymentProvider } from '@prsystem/ports';
import type { RawCallback } from '@prsystem/ports';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { CallbackSourceGuard } from '../../../security/callback-source';
import { body } from '../../iam/http/validation';
import { newBookingRequest } from '../services/booking-context';
import { BookingService } from '../services/booking.service';

/**
 * The provider's callback (`PAY-DEC-005`, doc 11 §4.6).
 *
 * Unauthenticated by necessity — a payment gateway holds no session — and
 * therefore trusted for nothing. Authenticity is the signature, checked by the
 * adapter before anything is looked up; the hotel is resolved on the server
 * from the invoice; the payment is confirmed by a server-to-server status
 * query, not by this body. What arrives here is a *hint that something
 * happened*, and every outcome below is the platform's own conclusion.
 *
 * The answer is deliberately uninformative. A forged callback, one naming an
 * invoice that does not exist, and one whose signature is wrong all receive the
 * same `rejected`, so the endpoint cannot be used to discover which references
 * are real.
 */
@ApiTags('payment-callbacks')
@Controller('payments/callbacks')
export class PaymentCallbackController {
  constructor(@Inject(BookingService) private readonly bookings: BookingService) {}

  @Post(':provider')
  @UseGuards(CallbackSourceGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'A provider payment callback, verified server-side before use' })
  @ApiResponse({ status: 200, description: 'Accepted, rejected, duplicate or unverified' })
  async callback(
    @Param('provider') providerParam: string,
    @Req() request: AuthenticatedRequest,
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
    const outcome = await this.bookings.handleCallback(raw, newBookingRequest());
    // The booking id is not returned: a caller that could not already name the
    // invoice learns nothing from this endpoint.
    return { outcome: outcome.outcome };
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a short string`);
  }
  return value;
}

/** An optional field, kept as untrusted text and never coerced to a number. */
function optional(
  field: 'providerPaymentId' | 'merchantRef' | 'amountMnt' | 'currency' | 'signature' | 'status',
  payload: Record<string, unknown>,
): Record<string, string> {
  const value = payload[field];
  if (value === undefined || value === null) return {};
  return { [field]: text(value, field) };
}
