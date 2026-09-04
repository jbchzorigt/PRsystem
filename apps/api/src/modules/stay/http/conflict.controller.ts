import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { ConflictService } from '../services/conflict.service';
import type { ConflictView, DetectionOutcome } from '../services/conflict.service';
import { newStayRequest } from '../services/stay-context';

/** `STAY-DEC-013`: the overdue conflict and its four terminal outcomes (doc 18 §3.3). */
@ApiTags('fulfillment-conflicts')
@Controller('hotels/:hotelId/fulfillment-conflicts')
export class ConflictController {
  constructor(@Inject(ConflictService) private readonly conflicts: ConflictService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open overdue conflicts, as the banner Reception and the Manager see' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ conflicts: readonly ConflictView[] }> {
    const conflicts = await this.conflicts.listOpen(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { conflicts };
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Detect conflicts now; a repeat opens nothing twice' })
  async refresh(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<DetectionOutcome & { readonly open: readonly ConflictView[] }> {
    return this.conflicts.refresh(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':conflictId/reassign')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reception assigns an eligible room of the same category' })
  @ApiResponse({ status: 412, description: 'DIFFERENT_CATEGORY, ROOM_NOT_ELIGIBLE' })
  async reassign(
    @Param('hotelId') hotelIdParam: string,
    @Param('conflictId') conflictIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConflictView> {
    const payload = body(request);
    return this.conflicts.reassignSameCategory(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        conflictId: requireUuid(conflictIdParam, 'conflictId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        roomId: requireUuid(payload['roomId'], 'roomId'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':conflictId/approve-higher-category')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Manager approves a higher-category room at no extra charge' })
  async approveHigher(
    @Param('hotelId') hotelIdParam: string,
    @Param('conflictId') conflictIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConflictView> {
    const payload = body(request);
    return this.conflicts.approveHigherCategory(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        conflictId: requireUuid(conflictIdParam, 'conflictId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        roomId: requireUuid(payload['roomId'], 'roomId'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':conflictId/cancel-hotel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Manager cancels the booking as hotel-caused; the booking module owes the refund',
  })
  @ApiResponse({ status: 412, description: 'ELIGIBLE_ROOM_EXISTS' })
  async cancelHotel(
    @Param('hotelId') hotelIdParam: string,
    @Param('conflictId') conflictIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConflictView> {
    const payload = body(request);
    return this.conflicts.cancelHotel(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        conflictId: requireUuid(conflictIdParam, 'conflictId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }
}
