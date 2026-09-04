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
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { CheckInService } from '../services/check-in.service';
import type { QuoteView } from '../services/check-in.service';
import { StayService } from '../services/stay.service';
import type { RoomCard } from '../services/stay.service';
import { newStayRequest } from '../services/stay-context';
import type { StayView } from '../services/stay-views';
import {
  optionalInstant,
  optionalPositiveInteger,
  optionalString,
  requireGuest,
  requireSource,
  requireStayType,
} from './stay-validation';

/**
 * doc 18 §3: `Check-in` and `actual time сонгох` are Reception's; the Hotel
 * Admin, Manager and Manager Plus need the Reception role for them. There is
 * no route that edits `actual_check_in_at` or `planned_checkout_at` — those
 * rows of the matrix are held by nobody (`STAY-DEC-009`, `-011`, `-012`).
 */
@ApiTags('stay')
@Controller('hotels/:hotelId')
export class StayController {
  constructor(
    @Inject(CheckInService) private readonly checkIns: CheckInService,
    @Inject(StayService) private readonly stays: StayService,
  ) {}

  @Get('rooms/board')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'The room board: every axis of every room, derived on read (doc 06 §2)',
  })
  async board(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ rooms: readonly RoomCard[] }> {
    const rooms = await this.stays.board(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { rooms };
  }

  @Post('stays/quote')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Planned end, charge, source and blockers for a check-in; writes nothing',
  })
  async quote(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<QuoteView> {
    const payload = body(request);
    const halfHourUnits = optionalPositiveInteger(payload['halfHourUnits'], 'halfHourUnits', 2880);
    const nightCount = optionalPositiveInteger(payload['nightCount'], 'nightCount', 365);
    const actualCheckInAt = optionalInstant(payload['actualCheckInAt'], 'actualCheckInAt');
    return this.checkIns.quote(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        roomId: requireUuid(payload['roomId'], 'roomId'),
        stayType: requireStayType(payload['stayType']),
        ...(halfHourUnits === undefined ? {} : { halfHourUnits }),
        ...(nightCount === undefined ? {} : { nightCount }),
        ...(actualCheckInAt === undefined ? {} : { actualCheckInAt }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post('stays')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Check-in: one transaction confirms the stay, the guest, the snapshot and the price book',
  })
  @ApiResponse({
    status: 412,
    description: 'ROOM_NOT_READY, BACKDATE_OUT_OF_BOUND, HISTORICAL_READINESS_UNPROVEN, …',
  })
  @ApiResponse({ status: 409, description: 'ROOM_OCCUPIED' })
  async checkIn(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StayView> {
    const payload = body(request);
    const halfHourUnits = optionalPositiveInteger(payload['halfHourUnits'], 'halfHourUnits', 2880);
    const nightCount = optionalPositiveInteger(payload['nightCount'], 'nightCount', 365);
    const actualCheckInAt = optionalInstant(payload['actualCheckInAt'], 'actualCheckInAt');
    const backdateReasonCode = optionalString(
      payload['backdateReasonCode'],
      'backdateReasonCode',
      60,
    );
    const backdateNote = optionalString(payload['backdateNote'], 'backdateNote', 500);
    const bookingRef = optionalUuid(payload['bookingRef'], 'bookingRef');
    const stay = await this.checkIns.checkIn(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        roomId: requireUuid(payload['roomId'], 'roomId'),
        source: requireSource(payload['source']),
        ...(bookingRef === undefined ? {} : { bookingRef }),
        stayType: requireStayType(payload['stayType']),
        ...(halfHourUnits === undefined ? {} : { halfHourUnits }),
        ...(nightCount === undefined ? {} : { nightCount }),
        ...(actualCheckInAt === undefined ? {} : { actualCheckInAt }),
        ...(backdateReasonCode === undefined ? {} : { backdateReasonCode }),
        ...(backdateNote === undefined ? {} : { backdateNote }),
        guest: requireGuest(payload['guest']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return stay;
  }

  @Get('stays/:stayId')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'A stay with its guest (never the identifier), price book and corrections',
  })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StayView> {
    return this.stays.view(
      { hotelId: requireUuid(hotelIdParam, 'hotelId'), stayId: requireUuid(stayIdParam, 'stayId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post('stays/:stayId/checkout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Record the actual checkout; the planned end is untouched (STAY-DEC-012)',
  })
  @ApiResponse({ status: 412, description: 'CORRECTION_PENDING, CHECKOUT_OBLIGATION_OPEN' })
  async checkout(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StayView> {
    const payload = body(request);
    return this.stays.recordActualCheckout(
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
}
