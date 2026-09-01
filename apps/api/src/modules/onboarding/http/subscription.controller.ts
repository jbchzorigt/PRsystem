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
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { SubscriptionService } from '../services/subscription.service';
import { EBarimtService } from '../services/ebarimt.service';
import { newOnboardingRequest } from '../services/onboarding-context';
import { isPaymentProvider } from '../contracts/payment-gateway.port';

/**
 * The subscription surface (docs 16 and 17).
 *
 * Notice what is **not** here. There is no downgrade route, no refund route and
 * no partial-refund route — `LIFE-DEC-001` and `SUB-DEC-009` do not merely
 * forbid those actions, they leave the platform with no verb for them, and an
 * endpoint that existed and refused would be a surface to argue with.
 *
 * There is also no route that writes an eBarimt receipt field. `SUB-DEC-008`
 * gives an operator exactly one power — ask the issuer again — and the retry
 * route below takes no receipt parameters at all.
 */
@ApiTags('subscription')
@Controller('hotels/:hotelId/subscription')
export class SubscriptionController {
  constructor(
    @Inject(SubscriptionService) private readonly subscriptions: SubscriptionService,
    @Inject(EBarimtService) private readonly ebarimt: EBarimtService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The authoritative subscription state' })
  async status(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const hotelId = requireUuid(hotelIdParam, 'hotelId');
    const found = await this.subscriptions.status(
      hotelId,
      newOnboardingRequest(request.principal?.accountId),
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
  @ApiOperation({ summary: 'Quote and invoice a renewal' })
  @ApiResponse({ status: 412, description: 'The package is below the renewal floor' })
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
      newOnboardingRequest(request.principal?.accountId),
    );
    reply.status(201);
    return { ...created };
  }

  @Post('upgrades')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Quote and invoice a package upgrade' })
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
      newOnboardingRequest(request.principal?.accountId),
    );
    reply.status(201);
    return { ...created };
  }

  @Post('payments/:provider/callback')
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

  @Get('ebarimt')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The eBarimt issuances awaiting manual resolution' })
  async manualQueue(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const items = await this.ebarimt.manualQueue(
      requireUuid(hotelIdParam, 'hotelId'),
      newOnboardingRequest(request.principal?.accountId),
    );
    return { items: items.map((item) => ({ ...item })) };
  }
}
