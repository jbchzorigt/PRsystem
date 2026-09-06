import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { newRestaurantRequest } from '../services/restaurant-context';
import { RestaurantAdminService } from '../services/restaurant.service';
import {
  optionalNote,
  optionalReason,
  optionalSortOrder,
  rejectServerOwnedFields,
  requireBoolean,
  requireContactPhone,
  requireLinkState,
  requireLocalDate,
  requireMicro,
  requirePriceMnt,
  requireWallTime,
  requireWeek,
} from './restaurant-validation';

/**
 * Registering a restaurant, and running its hours and menu (doc 08 §§3–6).
 *
 * Two different permissions live here and are not interchangeable:
 * `hotel.restaurant.register` is Manager Plus's, and `restaurant.menu_manage`
 * is the Restaurant Manager's. Both are granted only on the 30,000₮ package, so
 * a hotel on a smaller one is refused by the Phase 04 pipeline before any row
 * of this module is read — there is no second copy of that rule here.
 */
@ApiTags('restaurants')
@Controller('hotels/:hotelId/restaurants')
export class RestaurantAdminController {
  constructor(
    @Inject(RestaurantAdminService) private readonly restaurants: RestaurantAdminService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Register a restaurant and link it to the hotel, active' })
  @ApiResponse({ status: 403, description: 'The package or the permission refuses it' })
  async register(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const description = optionalNote(payload['description']);
    const registered = await this.restaurants.register(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        displayName: requireString(payload['displayName'], 'displayName', 200),
        cuisineKind: requireString(payload['cuisineKind'], 'cuisineKind', 60),
        ...(description === undefined ? {} : { description }),
        addressLine: requireString(payload['addressLine'], 'addressLine', 300),
        latitudeMicro: requireMicro(payload['latitudeMicro'], 'latitudeMicro'),
        longitudeMicro: requireMicro(payload['longitudeMicro'], 'longitudeMicro'),
        contactPhone: requireContactPhone(payload['contactPhone']),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      this.context(request),
    );
    return { ...registered };
  }

  @Post(':restaurantId/link')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Switch the hotel link on or off; confirmed orders still finish' })
  async link(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    return {
      ...(await this.restaurants.setLinkState(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          linkState: requireLinkState(payload['linkState']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/schedule')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The week’s ordering hours, in hotel-local wall time' })
  async schedule(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    return {
      ...(await this.restaurants.setSchedule(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          days: requireWeek(payload['days']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/schedule/overrides')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A holiday or a temporary closure, outranking the weekly row' })
  async override(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const closed = requireBoolean(payload['closed'], 'closed');
    const reason = optionalReason(payload['reason']);
    return {
      ...(await this.restaurants.addScheduleOverride(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          localDate: requireLocalDate(payload['localDate'], 'localDate'),
          closed,
          ...(closed
            ? {}
            : {
                opensAt: requireWallTime(payload['opensAt'], 'opensAt'),
                closesAt: requireWallTime(payload['closesAt'], 'closesAt'),
              }),
          ...(reason === undefined ? {} : { reason }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/menu/categories')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A menu category' })
  async category(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const sortOrder = optionalSortOrder(payload['sortOrder']);
    return {
      ...(await this.restaurants.addCategory(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          name: requireString(payload['name'], 'name', 120),
          ...(sortOrder === undefined ? {} : { sortOrder }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/menu/items')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A menu item and its price in whole tögrög' })
  async item(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const description = optionalNote(payload['description']);
    return {
      ...(await this.restaurants.addItem(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          menuCategoryId: requireUuid(payload['menuCategoryId'], 'menuCategoryId'),
          name: requireString(payload['name'], 'name', 200),
          ...(description === undefined ? {} : { description }),
          priceMnt: requirePriceMnt(payload['priceMnt']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/menu/items/:itemId/availability')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Sold out for today, or off the menu entirely (doc 08 §6)' })
  async availability(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Param('itemId') itemIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const available =
      payload['available'] === undefined
        ? undefined
        : requireBoolean(payload['available'], 'available');
    const state = payload['state'] === undefined ? undefined : requireLinkState(payload['state']);
    return {
      ...(await this.restaurants.setItemAvailability(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          itemId: requireUuid(itemIdParam, 'itemId'),
          ...(available === undefined ? {} : { available }),
          ...(state === undefined ? {} : { state }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post(':restaurantId/contact-phone')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The number a guest of an open order may call (RC-DEC-025)' })
  async phone(
    @Param('hotelId') hotelIdParam: string,
    @Param('restaurantId') restaurantIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    return {
      ...(await this.restaurants.setContactPhone(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          restaurantId: requireUuid(restaurantIdParam, 'restaurantId'),
          contactPhone: requireContactPhone(payload['contactPhone']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newRestaurantRequest> {
    return newRestaurantRequest(principalOf(request).accountId);
  }
}
