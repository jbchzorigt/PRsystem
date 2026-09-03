import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { optionalUuid, requireUuid } from '../../iam/http/validation';
import { newCatalogRequest } from '../services/catalog-context';
import { TariffService } from '../services/tariff.service';
import type { EffectiveRate, SnapshotView } from '../services/tariff.service';
import { requireChannel, requireStayType, requireSubjectType } from './catalog-validation';

/**
 * Server-resolved rates and confirmed snapshots (doc 05 §13; `STAY-DEC-005`).
 *
 * Two reads and no write. The snapshot is captured by the transaction that
 * confirms a stay or a booking — Phases 08 and 13 — through the service's
 * transaction-bound contract, never through a route: a client that could ask
 * for a snapshot would be a client that decides when a price is fixed.
 *
 * The rate read takes the context Reception selects — room, stay type — and
 * answers with the price, its source level and entity, and the configuration
 * version, exactly what the confirmation will record. Reception holds the read
 * as `.read`; it cannot override any of it.
 */
@ApiTags('tariffs')
@Controller('hotels/:hotelId/tariffs')
export class TariffController {
  constructor(@Inject(TariffService) private readonly tariffs: TariffService) {}

  @Get('effective')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'The effective rate for a stay type and channel (tariff.snapshot_view / .read)',
  })
  @ApiResponse({ status: 409, description: 'The room or category is not active' })
  @ApiResponse({ status: 412, description: 'No rate, buffer or check-out time is configured' })
  async effective(
    @Param('hotelId') hotelIdParam: string,
    @Query('stayType') stayTypeParam: string | undefined,
    @Query('channel') channelParam: string | undefined,
    @Query('categoryId') categoryIdParam: string | undefined,
    @Query('roomId') roomIdParam: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<EffectiveRate> {
    const categoryId = optionalUuid(categoryIdParam, 'categoryId');
    const roomId = optionalUuid(roomIdParam, 'roomId');
    return this.tariffs.effectiveRate(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayType: requireStayType(stayTypeParam),
        channel: requireChannel(channelParam),
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(roomId === undefined ? {} : { roomId }),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Get('snapshots/:subjectType/:subjectRef')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'A confirmed rate snapshot by its subject (tariff.snapshot_view / .read)',
  })
  async snapshot(
    @Param('hotelId') hotelIdParam: string,
    @Param('subjectType') subjectTypeParam: string,
    @Param('subjectRef') subjectRefParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SnapshotView> {
    return this.tariffs.snapshot(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        subjectType: requireSubjectType(subjectTypeParam),
        subjectRef: requireUuid(subjectRefParam, 'subjectRef'),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }
}
