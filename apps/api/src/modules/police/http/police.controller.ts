import {
  Body,
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
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newPoliceRequest } from '../services/police-context';
import { AUTH_SECURITY_PARAMETERS } from '../../iam/contracts/security-parameters';
import { SessionService } from '../../iam/services/session.service';
import { WantedPersonService } from '../services/wanted.service';
import { WantedCaseService } from '../services/case.service';
import { MatchService } from '../services/match.service';
import { CheckInListService } from '../services/checkin.service';
import { PoliceDashboardService } from '../services/dashboard.service';
import { WantedExportService } from '../services/export.service';
import {
  optionalInstant,
  optionalText,
  rejectServerOwnedFields,
  requireCaseState,
  requireFalseMatchReason,
  requireLocationKind,
  requireRegistrationNumber,
  requireRevision,
  requireText,
} from './police-validation';

/**
 * The Police portal's surface (doc 13).
 *
 * Everything here is `/police/...` and nothing here is reachable from a hotel
 * route, which is the shape doc 13 §3's isolation takes at the edge: a Hotel,
 * Guest or Operation token authenticates and is then refused by the pipeline,
 * because a Police action's cells are indexed by a Police column that no other
 * realm's account has.
 *
 * The check-in list is a `GET` with no identifier in its path and no export of
 * any kind — doc 13 §4.1 closes bulk download to both Police roles, and there
 * is no route here that would produce a file from it.
 */
@ApiTags('police')
@Controller('police')
export class PoliceController {
  constructor(
    @Inject(WantedPersonService) private readonly wanted: WantedPersonService,
    @Inject(WantedCaseService) private readonly cases: WantedCaseService,
    @Inject(MatchService) private readonly matches: MatchService,
    @Inject(CheckInListService) private readonly checkIns: CheckInListService,
    @Inject(PoliceDashboardService) private readonly dashboard: PoliceDashboardService,
    @Inject(WantedExportService) private readonly exports: WantedExportService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * doc 13 §5: the Police portal's own password login.
   *
   * The same audited path every other realm signs in through, asked for the
   * Police realm — so a Hotel address is not a Police account here and a Police
   * address is not a Hotel one, and the lockout, the session lifetime and the
   * revocation matrix are the ones Phase 04 already proved.
   *
   * The four-digit code is *not* this: doc 13 §5.3 makes it an activation and
   * reset bootstrap, and `POL-DEC-022` requires a production login to add TOTP
   * or an approved SSO on top of the password — which is a Phase 20 gate.
   */
  @Post('auth/sign-in')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in to the Police portal (POL-DEC-004)' })
  @ApiResponse({ status: 401, description: 'The email address or password is incorrect' })
  async signIn(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const payload = body(request);
    const result = await this.sessions.signIn(
      requireText(payload['email'], 'email', 3, 320),
      requireText(payload['password'], 'password', 1, 200),
      { correlationId: newPoliceRequest().correlationId },
      'police',
    );
    return {
      token: result.token,
      expiresInSeconds: AUTH_SECURITY_PARAMETERS.sessionAbsoluteSeconds,
    };
  }

  @Post('wanted-people')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Register a wanted identity from ХУР or by hand (POL-DEC-001)' })
  async register(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const manual = payload['manual'] as Record<string, unknown> | undefined;
    return {
      ...(await this.wanted.register(
        {
          registrationNumber: requireRegistrationNumber(payload['registrationNumber']),
          ...(manual === undefined
            ? {}
            : {
                manual: {
                  familyName: requireText(manual['familyName'], 'familyName', 1, 100),
                  parentName: requireText(manual['parentName'], 'parentName', 1, 100),
                  givenName: requireText(manual['givenName'], 'givenName', 1, 100),
                  dateOfBirth: requireText(manual['dateOfBirth'], 'dateOfBirth', 10, 10),
                  ...(optionalText(manual['homeAddress'], 'homeAddress', 1, 300) === undefined
                    ? {}
                    : { homeAddress: manual['homeAddress'] as string }),
                  ...(optionalText(manual['homeDistrict'], 'homeDistrict', 1, 100) === undefined
                    ? {}
                    : { homeDistrict: manual['homeDistrict'] as string }),
                  reason:
                    manual['reason'] === 'XYP_UNAVAILABLE' ? 'XYP_UNAVAILABLE' : 'XYP_NOT_FOUND',
                },
              }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('wanted-people/:personId/identity-decisions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A second officer approves or refuses a manual identity (POL-DEC-018)' })
  @ApiResponse({ status: 403, description: 'SEPARATION_OF_DUTIES: the approver is the creator' })
  async decideIdentity(
    @Param('personId') personIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.wanted.decideIdentity(
        {
          personId: requireUuid(personIdParam, 'personId'),
          revisionId: requireUuid(payload['revisionId'], 'revisionId'),
          approve: payload['approve'] === true,
          reason: requireText(payload['reason'], 'reason', 5, 500),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('wanted-people/:personId/cases')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open a wanted case for a person (doc 13 §6.1)' })
  async openCase(
    @Param('personId') personIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.cases.open(
        {
          personId: requireUuid(personIdParam, 'personId'),
          reasonText: requireText(payload['reasonText'], 'reasonText', 10, 2000),
          crimeCategory: requireText(payload['crimeCategory'], 'crimeCategory', 1, 120),
          owningUnitRef: requireText(payload['owningUnitRef'], 'owningUnitRef', 1, 100),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('cases/:caseId/state')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Move a case through its lifecycle with a reason (POL-DEC-018)' })
  async moveCase(
    @Param('caseId') caseIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.cases.move(
        {
          caseId: requireUuid(caseIdParam, 'caseId'),
          to: requireCaseState(payload['state']),
          reason: requireText(payload['reason'], 'reason', 5, 500),
          expectedRevision: requireRevision(payload['expectedRevision']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Get('matches/:matchId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'One match, within the caller’s own scope (POL-DEC-005)' })
  async readMatch(
    @Param('matchId') matchIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.matches.read(
        requireUuid(matchIdParam, 'matchId'),
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/acknowledgement')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Acknowledge an alert; it confers no ownership (POL-DEC-016)' })
  async acknowledge(
    @Param('matchId') matchIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.matches.acknowledge(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          expectedRevision: requireRevision(payload['expectedRevision']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/searches')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The exact search that opens an active match (POL-DEC-012)' })
  @ApiResponse({ status: 409, description: 'RATE_LIMITED: too many exact searches' })
  async search(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    // A `POST`, so a registration number never reaches a URL, an access log or
    // an analytics pipeline (doc 13 §9, §13.2).
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const matchId = payload['matchId'];
    return {
      ...(await this.matches.searchActive(
        matchId === undefined
          ? { registrationNumber: requireRegistrationNumber(payload['registrationNumber']) }
          : { matchId: requireUuid(matchId, 'matchId') },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/found')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Confirm a Found under your own account (POL-DEC-012, -014)' })
  async confirmFound(
    @Param('matchId') matchIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const locationNote = optionalText(payload['locationNote'], 'locationNote', 3, 300);
    const taskReference = optionalText(payload['taskReference'], 'taskReference', 1, 100);
    const note = optionalText(payload['note'], 'note', 1, 500);
    return {
      ...(await this.matches.confirmFound(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          expectedRevision: requireRevision(payload['expectedRevision']),
          locationKind: requireLocationKind(payload['locationKind']),
          ...(locationNote === undefined ? {} : { locationNote }),
          ...(taskReference === undefined ? {} : { taskReference }),
          ...(note === undefined ? {} : { note }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/found-corrections')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask for an erroneous Found to be undone (POL-DEC-015)' })
  async requestFoundCorrection(
    @Param('matchId') matchIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.matches.requestFoundCorrection(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          reason: requireText(payload['reason'], 'reason', 10, 500),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/found-corrections/:requestId/decision')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Decide a Found correction — never your own (POL-DEC-015)' })
  async decideFoundCorrection(
    @Param('matchId') matchIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.matches.decideFoundCorrection(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          requestId: requireUuid(requestIdParam, 'requestId'),
          approve: payload['approve'] === true,
          note: requireText(payload['note'], 'note', 5, 500),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/false-match')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask for a match to be ruled false (POL-DEC-019)' })
  async requestFalseMatch(
    @Param('matchId') matchIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.matches.requestFalseMatch(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          reasonCode: requireFalseMatchReason(payload['reasonCode']),
          reasonNote: requireText(payload['reasonNote'], 'reasonNote', 10, 500),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('matches/:matchId/false-match/:requestId/decision')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Decide a False Match — never your own (POL-DEC-019)' })
  async decideFalseMatch(
    @Param('matchId') matchIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.matches.decideFalseMatch(
        {
          matchId: requireUuid(matchIdParam, 'matchId'),
          requestId: requireUuid(requestIdParam, 'requestId'),
          approve: payload['approve'] === true,
          note: requireText(payload['note'], 'note', 5, 500),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Get('check-ins')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The all-hotel check-in list — Police Admin only (POL-DEC-010)' })
  @ApiResponse({
    status: 400,
    description: 'RANGE_TOO_LONG, or a historical search with no reason',
  })
  @ApiResponse({
    status: 412,
    description: 'RETENTION_NOT_APPROVED: historical search is disabled',
  })
  async checkInList(
    @Req() request: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('reason') reason?: string,
    @Query('page') page?: string,
  ): Promise<Record<string, unknown>> {
    const fromAt = optionalInstant(from, 'from');
    const toAt = optionalInstant(to, 'to');
    const listed = await this.checkIns.list(
      {
        ...(fromAt === undefined ? {} : { from: fromAt }),
        ...(toAt === undefined ? {} : { to: toAt }),
        ...(reason === undefined ? {} : { searchReason: reason }),
        ...(page === undefined ? {} : { page: Number(page) }),
      },
      actorOf(request),
      this.context(request),
    );
    return { ...listed };
  }

  @Get('dashboard')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The seven counters both Police columns may read (POL-DEC-003)' })
  async dashboardCounts(
    @Req() request: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<Record<string, unknown>> {
    const window = {
      from: optionalInstant(from, 'from') ?? new Date(Date.now() - 30 * 86_400_000),
      to: optionalInstant(to, 'to') ?? new Date(Date.now() + 86_400_000),
    };
    return { ...(await this.dashboard.counts(window, actorOf(request), this.context(request))) };
  }

  @Get('dashboard/charts')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The two district charts — Police Admin only (doc 13 §11.2)' })
  async dashboardCharts(
    @Req() request: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<Record<string, unknown>> {
    const window = {
      from: optionalInstant(from, 'from') ?? new Date(Date.now() - 30 * 86_400_000),
      to: optionalInstant(to, 'to') ?? new Date(Date.now() + 86_400_000),
    };
    return { ...(await this.dashboard.charts(window, actorOf(request), this.context(request))) };
  }

  @Post('exports')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The Wanted Case Excel, masked by default (POL-DEC-021)' })
  @ApiResponse({ status: 403, description: 'FULL_IDENTIFIER_NOT_GRANTED' })
  async exportCases(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const state = optionalText(payload['state'], 'state', 1, 30);
    return {
      ...(await this.exports.run(
        {
          purpose: requireText(payload['purpose'], 'purpose', 10, 500),
          taskReference: requireText(payload['taskReference'], 'taskReference', 1, 100),
          fullIdentifier: payload['fullIdentifier'] === true,
          ...(state === undefined ? {} : { state }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('exports/:jobId/download')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A five-minute link; the file’s hour is unchanged (doc 13 §12.3)' })
  async download(
    @Param('jobId') jobIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const signed = await this.exports.download(
      requireUuid(jobIdParam, 'jobId'),
      actorOf(request),
      this.context(request),
    );
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newPoliceRequest> {
    // doc 13 §13.1: an access is audited with its device or address, and the
    // correlation id ties it to the request that made it.
    return newPoliceRequest(principalOf(request).accountId, request.ip);
  }
}
