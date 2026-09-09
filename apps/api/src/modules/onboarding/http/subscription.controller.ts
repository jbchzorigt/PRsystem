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
import { ApiError } from '@prsystem/contracts';
import { isPaymentProvider } from '@prsystem/ports';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { CallbackSourceGuard } from '../../../security/callback-source';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { SubscriptionService } from '../services/subscription.service';
import { newOnboardingRequest } from '../services/onboarding-context';

/**
 * The subscription surface (docs 16 and 17).
 *
 * `hotelId` is in the path because a request has to name its target; it grants
 * nothing. `SessionGuard` authenticates and nothing more: every handler hands
 * the actor — principal *and* session — to a command that resolves the live
 * membership and scope grant for that hotel before the hotel is bound, and then
 * evaluates the Phase 04 pipeline against the canonical action inside the
 * transaction. Only a Hotel Admin holds `hotel.subscription.pay`; everyone else,
 * every foreign hotel and every unknown id is the same `NOT_FOUND`.
 *
 * Notice what is **not** here. There is no downgrade route, no refund route and
 * no partial-refund route — `LIFE-DEC-001` and `SUB-DEC-009` do not merely
 * forbid those actions, they leave the platform with no verb for them. And the
 * eBarimt manual queue is not here: it is an Operation surface, and a Hotel
 * session has no route to it.
 */
@ApiTags('subscription')
@Controller('hotels/:hotelId/subscription')
export class SubscriptionController {
  constructor(@Inject(SubscriptionService) private readonly subscriptions: SubscriptionService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The authoritative subscription state' })
  @ApiResponse({ status: 404, description: 'No live membership in this hotel' })
  async status(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const hotelId = requireUuid(hotelIdParam, 'hotelId');
    const found = await this.subscriptions.status(
      hotelId,
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    if (found === undefined) throw new ApiError('NOT_FOUND', 'not found');
    return {
      ...found,
      startsAt: found.startsAt.toISOString(),
      expiresAt: found.expiresAt.toISOString(),
      graceExpiresAt: found.graceExpiresAt.toISOString(),
      pendingUpgradeEffectiveAt: found.pendingUpgradeEffectiveAt?.toISOString() ?? null,
    };
  }

  @Post('renewals')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Quote and invoice a renewal (Hotel Admin, hotel.subscription.pay)' })
  @ApiResponse({ status: 412, description: 'Below the floor, or above a paid pending upgrade' })
  async renew(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const created = await this.subscriptions.quoteRenewal(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        targetPackage: requireString(payload['targetPackage'], 'targetPackage', 8),
        termMonths: Number(payload['termMonths']),
        provider: requireString(payload['provider'], 'provider', 8),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return { ...created };
  }

  @Post('upgrades')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Quote and invoice a package upgrade (Hotel Admin, hotel.subscription.pay)',
  })
  @ApiResponse({ status: 412, description: 'Not an upgrade, or no whole service months remain' })
  async upgrade(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const created = await this.subscriptions.quoteUpgrade(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        targetPackage: requireString(payload['targetPackage'], 'targetPackage', 8),
        provider: requireString(payload['provider'], 'provider', 8),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return { ...created };
  }

  /**
   * The provider callback. Unauthenticated in the session sense and
   * authenticated in the only sense that matters: the gateway verifies the
   * signature, the provider's own status is re-queried, and every field is
   * matched against the stored intent.
   */
  @Post('payments/:provider/callback')
  @UseGuards(CallbackSourceGuard)
  @HttpCode(202)
  @ApiOperation({ summary: 'Renewal or upgrade payment callback' })
  async callback(
    @Param('hotelId') hotelIdParam: string,
    @Param('provider') providerParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ accepted: true }> {
    const provider = providerParam.toUpperCase();
    if (!isPaymentProvider(provider)) {
      throw new ApiError('VALIDATION_FAILED', 'unknown provider');
    }
    const payload = body(request);
    await this.subscriptions.applyBillingCallback(
      requireUuid(hotelIdParam, 'hotelId'),
      {
        provider,
        providerInvoiceId: requireString(payload['providerInvoiceId'], 'providerInvoiceId', 200),
        ...(payload['providerPaymentId'] === undefined
          ? {}
          : {
              providerPaymentId: requireString(
                payload['providerPaymentId'],
                'providerPaymentId',
                200,
              ),
            }),
        ...(payload['signature'] === undefined
          ? {}
          : { signature: requireString(payload['signature'], 'signature', 512) }),
      },
      newOnboardingRequest(),
    );
    return { accepted: true };
  }
}
