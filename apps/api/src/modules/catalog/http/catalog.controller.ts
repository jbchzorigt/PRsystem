import {
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { newCatalogRequest } from '../services/catalog-context';
import { CatalogService } from '../services/catalog.service';
import type {
  CatalogListing,
  CategoryView,
  ConfigurationView,
  MinibarEntityView,
  RoomView,
} from '../services/catalog.service';
import {
  assignableMinutes,
  assignableMnt,
  assignableString,
  optionalString,
  requireCreatableState,
  requireMinutes,
  requireMnt,
  requireRevision,
} from './catalog-validation';

/**
 * The hotel catalog: stay configuration, room categories, rooms and the minibar
 * entities (docs 07 §§2–3, 05 §§9–13).
 *
 * `hotelId` is in the path because a request has to name its target; it grants
 * nothing. `SessionGuard` authenticates and nothing more. Every handler hands
 * the actor to a command that resolves the live membership and scope grant for
 * the hotel before it binds the hotel, and evaluates the named action inside
 * the transaction — `hotel.catalog.room_manage` for the entities,
 * `hotel.tariff.config_manage` additionally for every tariff value, and
 * `hotel.minibar.product_manage` for the minibar entities, which is refused on
 * 20,000₮ whatever role the caller holds — as the same opaque `NOT_FOUND` every
 * other denial is, since the pipeline evaluates the named permission with the
 * effective package (doc 06 §5).
 *
 * There is no field anywhere on this surface for an hourly minimum, maximum or
 * increment: `STAY-DEC-006` refused that configuration, and a payload carrying
 * one is simply not read.
 */
@ApiTags('catalog')
@Controller('hotels/:hotelId/catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The catalog: configuration, categories and rooms (lifecycle_view)' })
  @ApiResponse({ status: 404, description: 'No live membership in this hotel' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CatalogListing> {
    return this.catalog.listCatalog(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Put('stay-configuration')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Hotel default tariffs, fixed check-out time and cleaning minimum (tariff.config_manage)',
  })
  async configure(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConfigurationView> {
    const payload = body(request);
    return this.catalog.configureStay(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        ...spread('hourlyRateMnt', assignableMnt(payload['hourlyRateMnt'], 'hourlyRateMnt')),
        ...spread('nightlyRateMnt', assignableMnt(payload['nightlyRateMnt'], 'nightlyRateMnt')),
        ...spread(
          'fixedCheckoutMinute',
          assignableMinutes(payload['fixedCheckoutMinute'], 'fixedCheckoutMinute', 1439),
        ),
        ...spread(
          'cleaningBufferMinutes',
          assignableMinutes(payload['cleaningBufferMinutes'], 'cleaningBufferMinutes', 1440),
        ),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('categories')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Create a room category (room_manage; tariff.config_manage for overrides)',
  })
  async createCategory(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CategoryView> {
    const payload = body(request);
    const created = await this.catalog.createCategory(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        name: requireString(payload['name'], 'name', 120),
        ...spread('description', optionalString(payload['description'], 'description', 500)),
        state: requireCreatableState(payload['state']),
        ...spread('hourlyRateMnt', optionalMnt(payload['hourlyRateMnt'], 'hourlyRateMnt')),
        ...spread('nightlyRateMnt', optionalMnt(payload['nightlyRateMnt'], 'nightlyRateMnt')),
        ...spread(
          'cleaningBufferMinutes',
          optionalMinutes(payload['cleaningBufferMinutes'], 'cleaningBufferMinutes', 1440),
        ),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Patch('categories/:categoryId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Edit a room category; null clears an override back to inherited' })
  @ApiResponse({ status: 409, description: 'The revision moved' })
  async updateCategory(
    @Param('hotelId') hotelIdParam: string,
    @Param('categoryId') categoryIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CategoryView> {
    const payload = body(request);
    return this.catalog.updateCategory(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        categoryId: requireUuid(categoryIdParam, 'categoryId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...spread('name', optionalString(payload['name'], 'name', 120)),
        ...spread('description', assignableString(payload['description'], 'description', 500)),
        ...spread('hourlyRateMnt', assignableMnt(payload['hourlyRateMnt'], 'hourlyRateMnt')),
        ...spread('nightlyRateMnt', assignableMnt(payload['nightlyRateMnt'], 'nightlyRateMnt')),
        ...spread(
          'cleaningBufferMinutes',
          assignableMinutes(payload['cleaningBufferMinutes'], 'cleaningBufferMinutes', 1440),
        ),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('rooms')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Create a physical room (room_manage; tariff.config_manage for overrides)',
  })
  @ApiResponse({
    status: 409,
    description: 'The room number exists, or the category is not active',
  })
  async createRoom(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RoomView> {
    const payload = body(request);
    const created = await this.catalog.createRoom(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        roomNumber: requireString(payload['roomNumber'], 'roomNumber', 20),
        ...spread('floorLabel', optionalString(payload['floorLabel'], 'floorLabel', 20)),
        categoryId: requireUuid(payload['categoryId'], 'categoryId'),
        state: requireCreatableState(payload['state']),
        ...spread('hourlyRateMnt', optionalMnt(payload['hourlyRateMnt'], 'hourlyRateMnt')),
        ...spread('nightlyRateMnt', optionalMnt(payload['nightlyRateMnt'], 'nightlyRateMnt')),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Patch('rooms/:roomId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Edit a room; null clears a walk-in override back to inherited' })
  @ApiResponse({ status: 409, description: 'The revision moved, or the room number exists' })
  async updateRoom(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RoomView> {
    const payload = body(request);
    return this.catalog.updateRoom(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        roomId: requireUuid(roomIdParam, 'roomId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...spread('roomNumber', optionalString(payload['roomNumber'], 'roomNumber', 20)),
        ...spread('floorLabel', assignableString(payload['floorLabel'], 'floorLabel', 20)),
        ...(payload['categoryId'] === undefined
          ? {}
          : { categoryId: requireUuid(payload['categoryId'], 'categoryId') }),
        ...spread('hourlyRateMnt', assignableMnt(payload['hourlyRateMnt'], 'hourlyRateMnt')),
        ...spread('nightlyRateMnt', assignableMnt(payload['nightlyRateMnt'], 'nightlyRateMnt')),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('minibar-products')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a minibar product entity (product_manage, 25/30 packages)' })
  @ApiResponse({ status: 404, description: 'Not a Manager here, or not a minibar package' })
  async createProduct(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MinibarEntityView> {
    return this.createMinibar('MINIBAR_PRODUCT', hotelIdParam, request, reply);
  }

  @Post('minibar-templates')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a minibar template entity (product_manage, 25/30 packages)' })
  @ApiResponse({ status: 404, description: 'Not a Manager here, or not a minibar package' })
  async createTemplate(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MinibarEntityView> {
    return this.createMinibar('MINIBAR_TEMPLATE', hotelIdParam, request, reply);
  }

  private async createMinibar(
    kind: 'MINIBAR_PRODUCT' | 'MINIBAR_TEMPLATE',
    hotelIdParam: string,
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<MinibarEntityView> {
    const payload = body(request);
    const created = await this.catalog.createMinibarEntity(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        kind,
        name: requireString(payload['name'], 'name', 120),
        state: requireCreatableState(payload['state']),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }
}

/** Keeps an absent value absent, so a command sees `undefined` rather than a key set to it. */
function spread<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function optionalMnt(value: unknown, field: string): bigint | undefined {
  return value === undefined || value === null ? undefined : requireMnt(value, field);
}

function optionalMinutes(value: unknown, field: string, max: number): number | undefined {
  return value === undefined || value === null ? undefined : requireMinutes(value, field, max);
}
