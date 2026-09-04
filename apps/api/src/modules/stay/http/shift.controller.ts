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
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { newStayRequest } from '../services/stay-context';
import { ShiftService } from '../services/shift.service';
import type { ShiftView } from '../services/shift.service';

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

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open the Reception shift (open_close_handover)' })
  @ApiResponse({ status: 409, description: 'SHIFT_ALREADY_OPEN' })
  async open(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ShiftView> {
    const shift = await this.shifts.open(
      { hotelId: requireUuid(hotelIdParam, 'hotelId'), idempotencyKey: idempotencyKey(request) },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return shift;
  }

  @Post(':shiftId/close')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close the open shift (the handover of doc 03 is Phase 11)' })
  async close(
    @Param('hotelId') hotelIdParam: string,
    @Param('shiftId') shiftIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ShiftView> {
    const payload = body(request);
    return this.shifts.close(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        shiftId: requireUuid(shiftIdParam, 'shiftId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
