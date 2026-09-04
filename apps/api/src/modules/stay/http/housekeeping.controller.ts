import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { HousekeepingService } from '../services/housekeeping.service';
import type { CleaningView } from '../services/housekeeping.service';
import { newStayRequest } from '../services/stay-context';
import { requireCleaningTarget } from './stay-validation';

@ApiTags('housekeeping')
@Controller('hotels/:hotelId/rooms/:roomId/cleaning')
export class HousekeepingController {
  constructor(@Inject(HousekeepingService) private readonly housekeeping: HousekeepingService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The cleaning state of a room and its history (doc 06 §4)' })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CleaningView> {
    return this.housekeeping.view(
      { hotelId: requireUuid(hotelIdParam, 'hotelId'), roomId: requireUuid(roomIdParam, 'roomId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Set the cleaning state: the Cleaner on 25,000₮/30,000₮, the Manager on 20,000₮',
  })
  async set(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CleaningView> {
    const payload = body(request);
    return this.housekeeping.setState(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        roomId: requireUuid(roomIdParam, 'roomId'),
        idempotencyKey: idempotencyKey(request),
        toState: requireCleaningTarget(payload['toState']),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
