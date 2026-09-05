import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { body } from '../../iam/http/validation';
import { newGuestRequest } from '../services/guest-context';
import { GuestRegistrationService } from '../services/registration.service';
import { GuestEMongoliaService } from '../services/emongolia.service';
import {
  callerIp,
  optionalPhone,
  requireCode,
  requireOpaque,
  requirePassword,
  requirePhone,
  requirePurpose,
  requireRedirectUri,
} from './guest-validation';

/**
 * The Guest realm's front door (doc 09 §6).
 *
 * Every endpoint here is unauthenticated: these are the calls a person makes
 * *to become* a session. They carry no hotel in their path and reach no hotel's
 * rows, and none of them accepts an account id — the account is derived from
 * the number that was proven, the provider identity that was proven, or the
 * session that is issued.
 *
 * The responses are deliberately uninformative about who exists. Requesting a
 * code answers the same for a known and an unknown number, and a failed sign-in
 * has one message (doc 09 §6.3).
 */
@ApiTags('guest')
@Controller('guest')
export class GuestController {
  constructor(
    @Inject(GuestRegistrationService) private readonly registrations: GuestRegistrationService,
    @Inject(GuestEMongoliaService) private readonly providers: GuestEMongoliaService,
  ) {}

  @Post('phone-verifications')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a one-time code to a phone number' })
  @ApiResponse({ status: 202, description: 'The same answer for a known and an unknown number' })
  async requestCode(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ requested: true; expiresAt: string }> {
    const payload = body(request);
    const ip = callerIp(request);
    const issued = await this.registrations.requestCode(
      {
        phone: requirePhone(payload['phone']),
        purpose: requirePurpose(payload['purpose']),
        ...(ip === undefined ? {} : { requestIp: ip }),
      },
      newGuestRequest(),
    );
    return { requested: true, expiresAt: issued.expiresAt.toISOString() };
  }

  @Post('accounts')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register by phone, with a password of the guest’s choosing' })
  async register(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ token: string; sessionId: string; accountId: string }> {
    const payload = body(request);
    return this.registrations.register(
      {
        phone: requirePhone(payload['phone']),
        code: requireCode(payload['code']),
        password: requirePassword(payload['password']),
      },
      newGuestRequest(),
    );
  }

  @Post('sessions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Sign in with a phone number and a password' })
  @ApiResponse({ status: 401, description: 'One message for every failure (doc 09 §6.3)' })
  async signIn(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ token: string; sessionId: string; accountId: string }> {
    const payload = body(request);
    return this.registrations.signIn(
      { phone: requirePhone(payload['phone']), password: requirePassword(payload['password']) },
      newGuestRequest(),
    );
  }

  @Post('password-resets')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password against a fresh code' })
  async resetPassword(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ reset: true }> {
    const payload = body(request);
    return this.registrations.resetPassword(
      {
        phone: requirePhone(payload['phone']),
        code: requireCode(payload['code']),
        password: requirePassword(payload['password']),
      },
      newGuestRequest(),
    );
  }

  @Post('emongolia/authorizations')
  @HttpCode(201)
  @ApiOperation({ summary: 'Begin the e-Mongolia authentication flow (EXT-02)' })
  @ApiResponse({ status: 503, description: 'EXT-02 has not cleared; register by phone instead' })
  async beginProvider(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const payload = body(request);
    return this.providers.begin(
      {
        redirectUri: requireRedirectUri(payload['redirectUri']),
        state: requireOpaque(payload['state'], 'state', 128),
      },
      newGuestRequest(),
    );
  }

  @Post('emongolia/sessions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Complete the e-Mongolia flow: sign in, register, or open a link' })
  async completeProvider(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const phone = optionalPhone(payload['phone']);
    return {
      ...(await this.providers.complete(
        {
          code: requireOpaque(payload['code'], 'code', 512),
          state: requireOpaque(payload['state'], 'state', 128),
          redirectUri: requireRedirectUri(payload['redirectUri']),
          ...(phone === undefined ? {} : { phone }),
        },
        newGuestRequest(),
      )),
    };
  }

  @Post('account-links/:requestId/phone-verifications')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send the second channel’s code, to the number the account holds' })
  async requestLinkCode(@Req() request: FastifyRequest): Promise<{ requested: true }> {
    const params = request.params as Record<string, string>;
    return this.providers.requestLinkCode(
      { requestId: requireOpaque(params['requestId'], 'requestId', 64) },
      newGuestRequest(),
    );
  }

  @Post('account-links/:requestId/confirmations')
  @HttpCode(201)
  @ApiOperation({ summary: 'Confirm both channels and link the provider identity (doc 09 §6.3)' })
  async confirmLink(
    @Req() request: FastifyRequest,
    @Body() _body: unknown,
  ): Promise<{ token: string; sessionId: string; accountId: string }> {
    const payload = body(request);
    const params = request.params as Record<string, string>;
    return this.providers.confirmLink(
      {
        requestId: requireOpaque(params['requestId'], 'requestId', 64),
        code: requireCode(payload['code']),
      },
      newGuestRequest(),
    );
  }
}
