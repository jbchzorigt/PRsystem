import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { newReportingRequest } from '../services/reporting-context';
import { GuestRegistryService } from '../services/registry.service';
import type { RegistryResult } from '../services/registry.service';
import { RetentionService } from '../services/retention.service';
import {
  optionalLocalDate,
  optionalPage,
  optionalPageSize,
  optionalSearch,
  optionalStayState,
  rejectServerOwnedFields,
  requireAuthorityReference,
  requireHoldReason,
} from './reporting-validation';

/**
 * The guest registry (doc 12).
 *
 * `POST` rather than `GET` for the list, deliberately: doc 12 §8 keeps the raw
 * name search out of URLs, analytics and ordinary application logs, and a query
 * string is precisely where a URL-shaped read would put it. Everything else
 * about the route is a read — it writes only its own audit row.
 *
 * The hotel is a path parameter and is a *request target*: pipeline stage 4
 * compares it against the actor's own memberships, so a Manager of one hotel
 * naming another gets the same answer a hotel that does not exist gets.
 */
@ApiTags('guest-registry')
@Controller('hotels/:hotelId/registry')
export class GuestRegistryController {
  constructor(
    @Inject(GuestRegistryService) private readonly registry: GuestRegistryService,
    @Inject(RetentionService) private readonly retention: RetentionService,
  ) {}

  @Post('queries')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The registry page: six columns, server-side (GUEST-DEC-002, -005)' })
  @ApiResponse({ status: 400, description: 'RANGE_TOO_LONG, or a page size outside 20/50/100' })
  @ApiResponse({ status: 404, description: 'A hotel the caller has no membership in' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const from = optionalLocalDate(payload['from'], 'from');
    const to = optionalLocalDate(payload['to'], 'to');
    const stayState = optionalStayState(payload['stayState']);
    const roomId = optionalUuid(payload['roomId'], 'roomId');
    const nameSearch = optionalSearch(payload['nameSearch']);
    const page = optionalPage(payload['page']);
    const pageSize = optionalPageSize(payload['pageSize']);
    return view(
      await this.registry.list(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(stayState === undefined ? {} : { stayState }),
          ...(roomId === undefined ? {} : { roomId }),
          ...(nameSearch === undefined ? {} : { nameSearch }),
          ...(page === undefined ? {} : { page }),
          ...(pageSize === undefined ? {} : { pageSize }),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post('legal-holds')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Suspend the retention purge for a stay or the hotel (GUEST-DEC-008)' })
  async hold(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const stayId = optionalUuid(payload['stayId'], 'stayId');
    const placed = await this.retention.placeHold(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        ...(stayId === undefined ? {} : { stayId }),
        reason: requireHoldReason(payload['reason']),
        authorityReference: requireAuthorityReference(payload['authorityReference']),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      this.context(request),
    );
    return {
      holdId: placed.holdId,
      stayId: placed.stayId,
      authorityReference: placed.authorityReference,
      startsAt: placed.startsAt.toISOString(),
      endsAt: placed.endsAt?.toISOString() ?? null,
    };
  }

  @Post('legal-holds/:holdId/release')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Release a hold; the stay returns to the purge sweep' })
  async release(
    @Param('hotelId') hotelIdParam: string,
    @Param('holdId') holdIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    return {
      ...(await this.retention.releaseHold(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          holdId: requireUuid(holdIdParam, 'holdId'),
          reason: requireHoldReason(payload['reason']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newReportingRequest> {
    return newReportingRequest(principalOf(request).accountId);
  }
}

/**
 * The wire shape of a registry page.
 *
 * The six approved columns and the paging facts, and nothing else. `GUEST-DEC-002`
 * fixes the columns and their order; there is no stay id, no account, no room
 * id and no identity field, because doc 12 §5 does not list one.
 */
function view(result: RegistryResult): Record<string, unknown> {
  return {
    rows: result.rows.map((row) => ({
      rowNumber: row.rowNumber,
      familyName: row.familyName,
      givenName: row.givenName,
      age: row.age,
      roomNumber: row.roomNumber,
      periodStartAt: row.periodStartAt.toISOString(),
      periodEndAt: row.periodEndAt.toISOString(),
      stayState: row.stayState,
    })),
    totalRows: result.totalRows,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    appliedFilter: {
      from: result.appliedFilter.from.toISOString(),
      to: result.appliedFilter.to.toISOString(),
      ...(result.appliedFilter.stayState === undefined
        ? {}
        : { stayState: result.appliedFilter.stayState }),
      ...(result.appliedFilter.roomId === undefined ? {} : { roomId: result.appliedFilter.roomId }),
      // The search value is echoed so the client can show what it filtered by;
      // it is never put in a URL or a log line (doc 12 §8).
      ...(result.appliedFilter.nameSearch === undefined
        ? {}
        : { nameSearch: result.appliedFilter.nameSearch }),
    },
  };
}
