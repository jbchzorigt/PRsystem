import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '@prsystem/contracts';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { OnboardingService } from '../services/onboarding.service';
import { ProvisioningService } from '../services/provisioning.service';
import { ActivationService } from '../services/activation.service';
import { newOnboardingRequest } from '../services/onboarding-context';
import { isPaymentProvider } from '../contracts/payment-gateway.port';

/**
 * The public onboarding surface (doc 15).
 *
 * Every route here is reached **without a session**, because the whole point of
 * the flow is that the applicant does not have one yet. Authority comes from the
 * bearer reference their own draft was minted with, presented in the
 * `X-Onboarding-Token` header and resolved server-side; a path parameter alone
 * reaches nothing.
 *
 * The one exception is the provider callback, which carries no applicant secret
 * at all — its authority is the gateway's own signature verification, and the
 * invoice reference it names.
 */
const APPLICANT_HEADER = 'x-onboarding-token';

function applicantToken(request: FastifyRequest): string {
  const header = request.headers[APPLICANT_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('UNAUTHENTICATED', 'an onboarding reference is required');
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
      { field, issue: 'must be an integer' },
    ]);
  }
  return value;
}

@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(ActivationService) private readonly activation: ActivationService,
  ) {}

  @Post('applications')
  @ApiOperation({ summary: 'Create a pre-payment hotel registration request' })
  @ApiResponse({ status: 201, description: 'An application exists; no hotel or subscription does' })
  async create(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const created = await this.onboarding.createApplication(
      {
        ownerType: payload['ownerType'] as 'CITIZEN' | 'ORGANIZATION',
        ownerDisplayName: requireString(payload['ownerDisplayName'], 'ownerDisplayName', 200),
        ...(payload['representativeName'] === undefined
          ? {}
          : {
              representativeName: requireString(
                payload['representativeName'],
                'representativeName',
                200,
              ),
            }),
        ...(payload['representativePosition'] === undefined
          ? {}
          : {
              representativePosition: requireString(
                payload['representativePosition'],
                'representativePosition',
                200,
              ),
            }),
        registrationNumber: requireString(payload['registrationNumber'], 'registrationNumber', 32),
        ...(payload['countryCode'] === undefined
          ? {}
          : { countryCode: requireString(payload['countryCode'], 'countryCode', 2) }),
        contactPhone: requireString(payload['contactPhone'], 'contactPhone', 20),
        subscriptionContactPhone: requireString(
          payload['subscriptionContactPhone'],
          'subscriptionContactPhone',
          20,
        ),
        adminEmail: requireString(payload['adminEmail'], 'adminEmail'),
        hotelDisplayName: requireString(payload['hotelDisplayName'], 'hotelDisplayName', 200),
        hotelPublicPhone: requireString(payload['hotelPublicPhone'], 'hotelPublicPhone', 20),
        district: requireString(payload['district'], 'district', 100),
        khoroo: requireString(payload['khoroo'], 'khoroo', 100),
        addressLine: requireString(payload['addressLine'], 'addressLine', 300),
        latitudeMicro: requireInteger(payload['latitudeMicro'], 'latitudeMicro'),
        longitudeMicro: requireInteger(payload['longitudeMicro'], 'longitudeMicro'),
        packageCode: requireString(payload['packageCode'], 'packageCode', 8),
        termMonths: requireInteger(payload['termMonths'], 'termMonths'),
      },
      newOnboardingRequest(),
    );
    reply.status(201);
    return { ...created };
  }

  @Post('applications/owner-resolution')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve the subscription owner behind an application' })
  async resolveOwner(@Req() request: FastifyRequest): Promise<Record<string, unknown>> {
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    return { ...(await this.onboarding.resolveOwner(applicationId, context)) };
  }

  @Post('applications/phone-verification')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send the onboarding phone one-time code' })
  @ApiResponse({ status: 503, description: 'No OTP provider is configured (INT-OTP-01)' })
  async requestPhone(@Req() request: FastifyRequest): Promise<{ deliveryId: string }> {
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    return this.onboarding.requestPhoneVerification(applicationId, context);
  }

  @Post('applications/phone-verification/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem the onboarding phone one-time code' })
  async confirmPhone(@Req() request: FastifyRequest): Promise<{ verified: boolean }> {
    const payload = body(request);
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    return this.onboarding.confirmPhoneVerification(
      applicationId,
      requireString(payload['code'], 'code', 10),
      context,
    );
  }

  @Post('applications/ownership-proof')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem an existing-owner challenge' })
  async proveOwnership(@Req() request: FastifyRequest): Promise<Record<string, unknown>> {
    const payload = body(request);
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    return {
      ...(await this.onboarding.proveOwnership(
        applicationId,
        requireString(payload['challengeToken'], 'challengeToken'),
        context,
      )),
    };
  }

  @Post('applications/invoice')
  @ApiOperation({ summary: 'Create the subscription payment invoice' })
  @ApiResponse({ status: 412, description: 'The phone is unverified or a proof is outstanding' })
  @ApiResponse({ status: 503, description: 'No payment adapter is configured (EXT-03/EXT-04)' })
  async invoice(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    const provider = requireString(payload['provider'], 'provider', 8);
    if (!isPaymentProvider(provider)) {
      throw new ApiError('VALIDATION_FAILED', 'the gateway must be QPay or Khaan Bank');
    }
    const created = await this.onboarding.openInvoice(
      { applicationId, provider, idempotencyKey: idempotencyKey(request) },
      context,
    );
    reply.status(201);
    return { ...created };
  }

  /**
   * The provider callback.
   *
   * Unauthenticated in the session sense and authenticated in the only sense
   * that matters here: the gateway verifies the signature, the provider's own
   * status is re-queried, and every field is matched against the stored attempt.
   * A callback that fails any of those gets the same neutral 202 a duplicate
   * gets — a provider learns nothing about our state from the response.
   */
  @Post('payments/:provider/callback')
  @HttpCode(202)
  @ApiOperation({ summary: 'Provider payment callback' })
  async callback(
    @Param('provider') providerParam: string,
    @Req() request: FastifyRequest,
  ): Promise<{ accepted: true }> {
    const provider = providerParam.toUpperCase();
    if (!isPaymentProvider(provider)) {
      throw new ApiError('VALIDATION_FAILED', 'unknown provider');
    }
    const payload = body(request);
    await this.provisioning.applyCallback(
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

  @Get('applications/state')
  @ApiOperation({ summary: 'The canonical application state' })
  async state(@Req() request: FastifyRequest): Promise<{ applicationId: string }> {
    const context = newOnboardingRequest();
    const applicationId = await this.onboarding.resolveApplicant(applicantToken(request), context);
    return { applicationId };
  }

  /**
   * `ONB-DEC-003`: the first Hotel Admin sets their own password.
   *
   * The token is the only gate, and the response says nothing beyond that it
   * worked: no account id a caller did not already have, no membership detail.
   */
  @Post('hotels/:hotelId/activation')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem the first Hotel Admin activation link' })
  @ApiResponse({ status: 404, description: 'Unknown, spent or expired link' })
  async activate(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: FastifyRequest,
  ): Promise<{ activated: true }> {
    const payload = body(request);
    await this.activation.activate(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        token: requireString(payload['token'], 'token'),
        password: requireString(payload['password'], 'password'),
      },
      newOnboardingRequest(),
    );
    return { activated: true };
  }
}
