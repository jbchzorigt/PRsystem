import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { requireUuid } from '../../iam/http/validation';
import { PublicSearchService, newPublicRequest } from '../services/search.service';
import type { HotelDetailView, SearchView } from './public-views';
import { detailView, searchView } from './public-views';
import {
  optionalDate,
  optionalPoint,
  optionalRadius,
  optionalText,
  rejectClientDistance,
} from './public-validation';

/**
 * The public surface: search and hotel detail, with no session (doc 09 §§3–5).
 *
 * There is no `SessionGuard` here on purpose — doc 09 §6 makes both endpoints
 * public and adds no named permission for either. Everything a caller is
 * allowed to see is decided by the listing projection, not by a filter applied
 * after the rows were read.
 */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(@Inject(PublicSearchService) private readonly search: PublicSearchService) {}

  @Get('hotels')
  @ApiOperation({ summary: 'Search published hotels by dates, location and consented position' })
  @ApiResponse({ status: 400, description: 'A client-supplied distance is refused (doc 09 §4)' })
  async list(@Req() request: FastifyRequest): Promise<SearchView> {
    const query = (request.query ?? {}) as Record<string, unknown>;
    rejectClientDistance(query);
    const checkIn = optionalDate(query['checkIn'], 'checkIn');
    const checkOut = optionalDate(query['checkOut'], 'checkOut');
    const location = optionalText(query['location'], 'location');
    const origin = optionalPoint(query);
    const radiusMetres = optionalRadius(query['radiusMetres']);
    return searchView(
      await this.search.search(
        {
          ...(checkIn === undefined ? {} : { checkIn }),
          ...(checkOut === undefined ? {} : { checkOut }),
          ...(location === undefined ? {} : { location }),
          ...(origin === undefined ? {} : { origin }),
          ...(radiusMetres === undefined ? {} : { radiusMetres }),
        },
        newPublicRequest(),
      ),
    );
  }

  @Get('hotels/:hotelId')
  @ApiOperation({ summary: 'One published hotel, with the categories it can offer' })
  @ApiResponse({ status: 404, description: 'Unpublished and non-existent are the same answer' })
  async detail(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: FastifyRequest,
  ): Promise<HotelDetailView> {
    const query = (request.query ?? {}) as Record<string, unknown>;
    rejectClientDistance(query);
    const checkIn = optionalDate(query['checkIn'], 'checkIn');
    const checkOut = optionalDate(query['checkOut'], 'checkOut');
    return detailView(
      await this.search.detail(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          ...(checkIn === undefined ? {} : { checkIn }),
          ...(checkOut === undefined ? {} : { checkOut }),
        },
        newPublicRequest(),
      ),
    );
  }
}
