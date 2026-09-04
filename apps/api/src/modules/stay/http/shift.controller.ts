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
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { optionalString, requireMnt, requireRevision } from '../../catalog/http/catalog-validation';
import { newStayRequest } from '../services/stay-context';
import { ShiftService } from '../services/shift.service';
import type { ShiftView } from '../services/shift.service';

function requireDecision(value: unknown): 'ACCEPT' | 'REJECT' {
  if (value === 'ACCEPT' || value === 'REJECT') return value;
  throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
    { field: 'decision', issue: 'must be ACCEPT or REJECT' },
  ]);
}

@ApiTags('reception-shift')
@Controller('hotels/:hotelId/shifts')
export class ShiftController {
  constructor(@Inject(ShiftService) private readonly shifts: ShiftService) {}

  @Get('current')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The open Reception shift, or null (doc 05 §19.1)' })
  async current(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ shift: ShiftView | null }> {
    const shift = await this.shifts.current(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { shift };
  }

  @Get(':shiftId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'One shift with its cash and review state (doc 03 §6)' })
  async byId(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ shift: ShiftView }> {
    const shift = await this.shifts.byId(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        shiftId: requireUuid(shiftIdParam, 'shiftId'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { shift };
  }

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open the Reception shift over a drawer (open_close_handover)' })
  @ApiResponse({ status: 409, description: 'SHIFT_ALREADY_OPEN' })
  async open(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ShiftView> {
    const payload = body(request);
    const locationId = optionalUuid(payload['locationId'], 'locationId');
    const shift = await this.shifts.open(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        openingCountedMnt: requireMnt(payload['openingCountedMnt'], 'openingCountedMnt'),
        ...(locationId === undefined ? {} : { locationId }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return shift;
  }

  @Post(':shiftId/count')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Count the drawer and start the close (hotel.cash.count)' })
  @ApiResponse({ status: 412, description: 'PENDING_TRANSFER' })
  async count(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    return this.shifts.startClose(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        countedCashMnt: requireMnt(payload['countedCashMnt'], 'countedCashMnt'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/handover')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Hand the counted drawer to the incoming Reception' })
  async handOver(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    return this.shifts.handOver(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        toAccountId: requireUuid(payload['toAccountId'], 'toAccountId'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/recount')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The incoming Reception asks for a recount (SHIFT-DEC-007)' })
  async recount(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    return this.shifts.requestRecount(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: optionalString(payload['reason'], 'reason', 300) ?? '',
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/accept-cash')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The incoming Reception accepts the cash it counted (SHIFT-DEC-002)' })
  async acceptCash(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return this.shifts.acceptCash(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        incomingCountedMnt: requireMnt(payload['incomingCountedMnt'], 'incomingCountedMnt'),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/close')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close the accepted shift and start its financial review' })
  async close(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    return this.shifts.close(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/self-close')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close one’s own shift on one’s own count (SHIFT-DEC-003)' })
  async selfClose(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return this.shifts.selfClose(
      {
        ...this.target(hotelIdParam, shiftIdParam, request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        countedCashMnt: requireMnt(payload['countedCashMnt'], 'countedCashMnt'),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/review')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The Manager’s financial review of a handover close (doc 03 §6.2)' })
  async review(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    return this.shifts.review(
      this.reviewInput(hotelIdParam, shiftIdParam, request),
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':shiftId/admin-review')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The Hotel Admin’s variance, dispute and self-review (SHIFT-DEC-004)' })
  async adminReview(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    return this.shifts.adminReview(
      this.reviewInput(hotelIdParam, shiftIdParam, request),
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  private target(
    hotelIdParam: string,
    shiftIdParam: string,
    request: AuthenticatedRequest,
  ): { hotelId: string; shiftId: string; idempotencyKey: string } {
    return {
      hotelId: requireUuid(hotelIdParam, 'hotelId'),
      shiftId: requireUuid(shiftIdParam, 'shiftId'),
      idempotencyKey: idempotencyKey(request),
    };
  }

  private reviewInput(
    hotelIdParam: string,
    shiftIdParam: string,
    request: AuthenticatedRequest,
  ): {
    hotelId: string;
    shiftId: string;
    idempotencyKey: string;
    expectedRevision: number;
    decision: 'ACCEPT' | 'REJECT';
    reason?: string;
  } {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return {
      ...this.target(hotelIdParam, shiftIdParam, request),
      expectedRevision: requireRevision(payload['expectedRevision']),
      decision: requireDecision(payload['decision']),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
