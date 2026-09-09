import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf, sessionIdOf } from '../../iam/http/session.guard';
import { OperationAccessService } from '../services/access.service';
import { OperationAuthService } from '../services/auth.service';
import { OperationDashboardService } from '../services/dashboard.service';
import { OperationRecoveryService } from '../services/recovery.service';
import { OperationSmsService } from '../services/sms.service';
import { OperationSubscriptionService } from '../services/subscription.service';
import { SubscriptionContactService } from '../services/contact.service';
import { newOperationRequest } from '../services/operation-context';
import { CONTACT_OTP_DIGITS, TOTP_DIGITS } from '../domain/operation';
import {
  bodyOf,
  fail,
  idempotencyKeyOf,
  optionalDate,
  optionalInteger,
  optionalText,
  refuseServerOwned,
  requireBoolean,
  requireChallenge,
  requireCode,
  requireDecision,
  requirePermissions,
  requirePhone,
  requireReasonCode,
  requireRole,
  requireSmsBody,
  requireText,
  requireUuidValue,
} from './operation-validation';

/**
 * The Platform Operation surface (doc 14, doc 18 §5).
 *
 * Two shapes of route, and the difference between them is the whole security
 * model of the phase.
 *
 * `/operation/**` is the Operation realm. `SessionGuard` authenticates and
 * nothing more; the named permission, the realm, the realm role and a step-up
 * no older than ten minutes are the pipeline's decision, evaluated inside the
 * transaction that applies the effect. A Hotel-realm session reaching any of
 * them gets the same opaque `NOT_FOUND` a stranger gets.
 *
 * `/hotels/:hotelId/subscription-contact/**` is the Hotel realm, and it is
 * here rather than in the onboarding module because this module owns the
 * tables. doc 14 §2.3 gives the change to the *Primary Hotel Admin*, so it runs
 * under doc 18 §3's owner-and-profile row in the hotel's own scope. An
 * Operation account cannot reach it.
 *
 * What is deliberately absent: any route that writes an email address, any
 * route that returns a token, a password, a one-time code or an unmasked
 * registered address, and any inbound SMS surface at all (`OPS-DEC-004`,
 * `OPS-DEC-009`).
 */
@ApiTags('operation')
@Controller('operation')
export class PlatformOperationController {
  constructor(
    @Inject(OperationAuthService) private readonly auth: OperationAuthService,
    @Inject(OperationAccessService) private readonly access: OperationAccessService,
    @Inject(OperationDashboardService) private readonly dashboard: OperationDashboardService,
    @Inject(OperationSubscriptionService)
    private readonly subscriptions: OperationSubscriptionService,
    @Inject(OperationRecoveryService) private readonly recovery: OperationRecoveryService,
    @Inject(SubscriptionContactService) private readonly contacts: SubscriptionContactService,
    @Inject(OperationSmsService) private readonly sms: OperationSmsService,
  ) {}

  // ------------------------------------------------------------------- auth

  @Post('auth/sign-in')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in to the Operation portal with a password and a TOTP code' })
  @ApiResponse({ status: 401, description: 'The credentials are incorrect' })
  async signIn(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const result = await this.auth.signIn(
      {
        email: requireText(payload['email'], 'email', { min: 3, max: 320 }),
        password: requireText(payload['password'], 'password', { min: 1, max: 400 }),
        code: requireCode(payload['code'], 'code', TOTP_DIGITS),
      },
      newOperationRequest(),
    );
    return { token: result.token, accountId: result.accountId };
  }

  @Post('auth/enrolments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem an enrolment link: set the password and receive the factor' })
  async enrol(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    refuseServerOwned(payload, ['accountId', 'secret', 'state']);
    const result = await this.auth.completeEnrolment(
      {
        token: requireText(payload['token'], 'token', { min: 20, max: 400 }),
        password: requireText(payload['password'], 'password', { min: 1, max: 400 }),
      },
      newOperationRequest(),
    );
    return { ...result };
  }

  @Post('auth/step-up')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Re-prove the second factor on this session' })
  async stepUp(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const result = await this.auth.stepUp(
      {
        accountId: principalOf(request).accountId,
        sessionId: sessionIdOf(request),
        code: requireCode(payload['code'], 'code', TOTP_DIGITS),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  // -------------------------------------------------------------- dashboard

  @Get('dashboard/kpi')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The mutually exclusive KPI partition over provisioned hotels' })
  @ApiResponse({ status: 404, description: 'Not an Operation account holding the permission' })
  @ApiResponse({ status: 412, description: 'A recent step-up authentication is required' })
  async kpi(
    @Req() request: AuthenticatedRequest,
    @Query('asOf') asOf?: string,
  ): Promise<Record<string, unknown>> {
    const at = optionalDate(asOf, 'asOf');
    const view = await this.dashboard.kpi(
      actorOf(request),
      newOperationRequest(principalOf(request).accountId),
      at,
    );
    return { ...view, asOf: view.asOf.toISOString() };
  }

  @Get('subscriptions')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The subscription list, filtered and paginated on the server' })
  async subscriptionList(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const page = await this.dashboard.subscriptions(
      actorOf(request),
      {
        filters: {
          ...optional('name', optionalText(query['name'], 'name', 200)),
          ...optional(
            'phone',
            query['phone'] === undefined ? undefined : requirePhone(query['phone'], 'phone'),
          ),
          ...optional('email', optionalText(query['email'], 'email', 320)?.toLowerCase()),
          ...optional('ownerType', optionalText(query['ownerType'], 'ownerType', 20)),
          ...optional('district', optionalText(query['district'], 'district', 80)),
          ...optional('package', optionalText(query['package'], 'package', 8)),
          ...optional(
            'termMonths',
            optionalInteger(query['termMonths'], 'termMonths', { min: 1, max: 12 }),
          ),
          ...optional('status', optionalText(query['status'], 'status', 20)),
          ...optional('expiresFrom', optionalDate(query['expiresFrom'], 'expiresFrom')),
          ...optional('expiresTo', optionalDate(query['expiresTo'], 'expiresTo')),
        },
        ...optional('limit', optionalInteger(query['limit'], 'limit', { min: 1, max: 100 })),
        ...optional(
          'offset',
          optionalInteger(query['offset'], 'offset', { min: 0, max: 1_000_000 }),
        ),
        ...optional('asOf', optionalDate(query['asOf'], 'asOf')),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      items: page.items.map((item) => ({
        ...item,
        startsAt: item.startsAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        suspendedAt: item.suspendedAt?.toISOString() ?? null,
      })),
    };
  }

  @Get('onboarding/queue')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The onboarding applications that are not hotels yet' })
  async applications(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const group = optionalText(query['group'], 'group', 20);
    if (group !== undefined && group !== 'UNPAID' && group !== 'INACTIVE') {
      throw errorFor('group');
    }
    const page = await this.dashboard.applications(
      actorOf(request),
      {
        ...optional('group', group as 'UNPAID' | 'INACTIVE' | undefined),
        ...optional('limit', optionalInteger(query['limit'], 'limit', { min: 1, max: 100 })),
        ...optional(
          'offset',
          optionalInteger(query['offset'], 'offset', { min: 0, max: 1_000_000 }),
        ),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      items: page.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        stateChangedAt: item.stateChangedAt?.toISOString() ?? null,
      })),
    };
  }

  // ---------------------------------------------------------- subscriptions

  @Post('subscriptions/:hotelId/password-reset')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Queue a reset link to the subscription account’s registered address' })
  async initiateReset(
    @Param('hotelId') hotelId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    // No body is read: there is no address, destination or token field an
    // operator may supply (`OPS-DEC-008`).
    const result = await this.subscriptions.initialisePasswordReset(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  @Post('subscriptions/:hotelId/suspension')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Suspend or reactivate a provisioned subscription' })
  async setSuspension(
    @Param('hotelId') hotelId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    refuseServerOwned(payload, ['expiresAt', 'startsAt', 'package', 'termMonths']);
    const result = await this.subscriptions.setSuspension(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        suspend: requireBoolean(payload['suspend'], 'suspend'),
        reasonCode: requireReasonCode(payload['reasonCode'], 'reasonCode'),
        note: requireText(payload['note'], 'note', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      ...result,
      startsAt: result.startsAt.toISOString(),
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Get('subscriptions/:hotelId/suspension-history')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The append-only suspend/reactivate history of one hotel' })
  async suspensionHistory(
    @Param('hotelId') hotelId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const items = await this.subscriptions.suspensionHistory(
      actorOf(request),
      requireUuidValue(hotelId, 'hotelId'),
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      items: items.map((item) => ({
        ...item,
        occurredAt: item.occurredAt.toISOString(),
        startsAtSnapshot: item.startsAtSnapshot.toISOString(),
        expiresAtSnapshot: item.expiresAtSnapshot.toISOString(),
      })),
    };
  }

  @Get('reconciliations')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The paid records that did not apply themselves' })
  async reconciliations(
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const items = await this.subscriptions.reconciliationQueue(
      actorOf(request),
      newOperationRequest(principalOf(request).accountId),
      optionalInteger(limit, 'limit', { min: 1, max: 200 }) ?? 50,
    );
    return {
      items: items.map((item) => ({
        ...item,
        confirmedAt: item.confirmedAt?.toISOString() ?? null,
      })),
    };
  }

  // -------------------------------------------------------------- recovery

  @Post('recovery-requests')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Hand an inaccessible-email case to the Platform Super Admin' })
  async escalateRecovery(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    // `OPS-DEC-009`: there is no new-address field, and naming one is refused
    // rather than ignored.
    refuseServerOwned(payload, ['email', 'newEmail', 'accountId', 'state']);
    const result = await this.recovery.escalate(
      actorOf(request),
      {
        hotelId: requireUuidValue(payload['hotelId'], 'hotelId'),
        caseReference: requireText(payload['caseReference'], 'caseReference', { min: 3, max: 120 }),
        note: requireText(payload['note'], 'note', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  @Get('recovery-requests')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The open ownership-recovery escalations' })
  async pendingRecovery(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const items = await this.recovery.pending(
      actorOf(request),
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      items: items.map((item) => ({
        ...item,
        requestedAt: item.requestedAt.toISOString(),
        decidedAt: item.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  @Post('recovery-requests/:requestId/decision')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Record the offline recovery decision' })
  async decideRecovery(
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const result = await this.recovery.decide(
      actorOf(request),
      {
        requestId: requireUuidValue(requestId, 'requestId'),
        decision: requireDecision(payload['decision'], 'decision'),
        reason: requireText(payload['reason'], 'reason', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  // ---------------------------------------------------------------- access

  @Post('accounts')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a named Operation account and send its enrolment link' })
  async createAccount(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    refuseServerOwned(payload, ['accountId', 'state', 'password', 'token']);
    const result = await this.access.createAccount(
      actorOf(request),
      {
        email: requireText(payload['email'], 'email', { min: 3, max: 320 }),
        role: requireRole(payload['role'], 'role'),
        permissions: requirePermissions(payload['permissions'] ?? [], 'permissions'),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result, expiresAt: result.expiresAt.toISOString() };
  }

  @Post('accounts/:accountId/state')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Suspend or reactivate an Operation account' })
  async setAccountState(
    @Param('accountId') accountId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const state = requireText(payload['state'], 'state', { min: 6, max: 12 });
    if (state !== 'ACTIVE' && state !== 'SUSPENDED') throw errorFor('state');
    const result = await this.access.setAccountState(
      actorOf(request),
      {
        accountId: requireUuidValue(accountId, 'accountId'),
        state,
        reason: requireText(payload['reason'], 'reason', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  @Post('accounts/:accountId/permissions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Grant or revoke one named Operation permission' })
  async setPermission(
    @Param('accountId') accountId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const [permission] = requirePermissions([payload['permission']], 'permission');
    const result = await this.access.setPermission(
      actorOf(request),
      {
        accountId: requireUuidValue(accountId, 'accountId'),
        permission: permission as string,
        granted: requireBoolean(payload['granted'], 'granted'),
        reason: requireText(payload['reason'], 'reason', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  // --------------------------------------------------------------- contact

  @Post('contact-changes/:requestId/exception')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Waive the old number’s challenge on a contact change' })
  async approveContactException(
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    // There is no `newPhone` here: the number was chosen by the Hotel Admin and
    // an Operation account may not set one (`OPS-DEC-015`).
    refuseServerOwned(payload, ['newPhone', 'oldPhone', 'code']);
    const result = await this.contacts.approveException(
      actorOf(request),
      {
        requestId: requireUuidValue(requestId, 'requestId'),
        reference: requireText(payload['reference'], 'reference', { min: 3, max: 120 }),
        reason: requireText(payload['reason'], 'reason', { min: 10, max: 1000 }),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  // ------------------------------------------------------------------- SMS

  @Post('sms/previews')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Compute a reminder preview: recipients, segments and estimate' })
  async preview(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const filters = (payload['filters'] ?? {}) as Record<string, unknown>;
    const hotelIds = filters['hotelIds'];
    const view = await this.sms.preview(
      actorOf(request),
      {
        body: requireSmsBody(payload['body'], 'body'),
        filters: {
          ...optional(
            'hotelIds',
            Array.isArray(hotelIds)
              ? hotelIds.map((id, index) =>
                  requireUuidValue(id, `filters.hotelIds[${String(index)}]`),
                )
              : undefined,
          ),
          ...optional('package', optionalText(filters['package'], 'filters.package', 8)),
          ...optional('status', optionalText(filters['status'], 'filters.status', 20)),
          ...optional('expiresFrom', optionalDate(filters['expiresFrom'], 'filters.expiresFrom')),
          ...optional('expiresTo', optionalDate(filters['expiresTo'], 'filters.expiresTo')),
        },
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...view, expiresAt: view.expiresAt.toISOString() };
  }

  @Post('sms/jobs')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Confirm a preview: the only thing that sends a reminder' })
  async confirm(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    refuseServerOwned(payload, ['recipients', 'body', 'jobId']);
    const result = await this.sms.confirm(
      actorOf(request),
      {
        previewId: requireUuidValue(payload['previewId'], 'previewId'),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  @Get('sms/jobs')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The send history, server-paginated' })
  async smsHistory(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const page = await this.sms.history(
      actorOf(request),
      {
        ...optional('limit', optionalInteger(query['limit'], 'limit', { min: 1, max: 100 })),
        ...optional(
          'offset',
          optionalInteger(query['offset'], 'offset', { min: 0, max: 1_000_000 }),
        ),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return {
      total: page.total,
      items: page.items.map((item) => ({
        ...item,
        confirmedAt: (item['confirmedAt'] as Date).toISOString(),
        dispatchedAt: (item['dispatchedAt'] as Date | null)?.toISOString() ?? null,
      })),
    };
  }

  @Post('sms/deliveries/refresh')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask the provider about messages it has accepted' })
  async refreshDeliveries(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    // A query, never a callback: `EXT-05` has approved no callback signature,
    // so this module mounts no inbound route to verify one on (`OPS-DEC-004`).
    const result = await this.sms.refreshDeliveryStatus(
      actorOf(request),
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }
}

/**
 * The Hotel Admin's half of the subscription contact change (doc 14 §2.3).
 *
 * A separate controller because it is a separate realm: these routes run the
 * hotel pipeline against `hotel.profile.manage`, in the hotel's own tenant
 * scope, and an Operation session reaching them is refused by the same gate
 * that refuses any other stranger.
 */
@ApiTags('subscription-contact')
@Controller('hotels/:hotelId/subscription-contact')
export class SubscriptionContactController {
  constructor(
    @Inject(SubscriptionContactService) private readonly contacts: SubscriptionContactService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The masked contact number, and any change in progress' })
  async current(
    @Param('hotelId') hotelId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const view = await this.contacts.current(
      actorOf(request),
      requireUuidValue(hotelId, 'hotelId'),
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...view, open: view.open ?? null };
  }

  @Post('changes')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open a contact change and challenge the old number' })
  async open(
    @Param('hotelId') hotelId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    refuseServerOwned(payload, ['requestId', 'state', 'oldPhone']);
    const view = await this.contacts.open(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        newPhone: requirePhone(payload['newPhone'], 'newPhone'),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...view };
  }

  @Post('changes/:requestId/codes')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Re-send the outstanding code' })
  async resend(
    @Param('hotelId') hotelId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const result = await this.contacts.resend(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        requestId: requireUuidValue(requestId, 'requestId'),
        challenge: requireChallenge(payload['challenge'], 'challenge'),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }

  @Post('changes/:requestId/verifications')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Redeem a code; the new number’s completes the change' })
  async verify(
    @Param('hotelId') hotelId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const view = await this.contacts.verify(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        requestId: requireUuidValue(requestId, 'requestId'),
        challenge: requireChallenge(payload['challenge'], 'challenge'),
        code: requireCode(payload['code'], 'code', CONTACT_OTP_DIGITS),
        idempotencyKey: idempotencyKeyOf(request),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...view };
  }

  @Post('changes/:requestId/cancellation')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'End an open contact change without applying it' })
  async cancel(
    @Param('hotelId') hotelId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const payload = bodyOf(request);
    const result = await this.contacts.cancel(
      actorOf(request),
      {
        hotelId: requireUuidValue(hotelId, 'hotelId'),
        requestId: requireUuidValue(requestId, 'requestId'),
        reason: requireText(payload['reason'], 'reason', { min: 3, max: 500 }),
      },
      newOperationRequest(principalOf(request).accountId),
    );
    return { ...result };
  }
}

/** `{ key: value }` when the value is present, `{}` when it is not. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function errorFor(field: string): never {
  return fail(field, 'is not one of the approved values');
}
