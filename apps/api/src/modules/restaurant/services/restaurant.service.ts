import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import type { DaySchedule } from '../domain/restaurant';
import type { CommandActor, RequestContext, RestaurantDependencies } from './restaurant-context';
import { RestaurantServiceBase, claim } from './restaurant-context';

/**
 * Registering a restaurant, linking it to a hotel, and its menu and hours
 * (doc 08 §§3–6, `RC-DEC-019`, `RC-DEC-022`).
 *
 * The 30,000₮ entitlement is not checked here. It is in the permission's own
 * cell — `hotel.restaurant.register` and `restaurant.menu_manage` are granted
 * only on that package — so a hotel on a smaller one is refused by the Phase 04
 * pipeline before any row of this module is read, and there is no second copy
 * of the rule to drift.
 */

const REGISTER = 'hotel.restaurant.register';
const MENU_MANAGE = 'restaurant.menu_manage';

export interface RegisteredRestaurant {
  readonly restaurantId: string;
  readonly linkId: string;
  readonly displayName: string;
}

export class RestaurantAdminService extends RestaurantServiceBase {
  constructor(deps: RestaurantDependencies) {
    super(deps);
  }

  /**
   * doc 08 §3: Manager Plus registers the restaurant and links it, active.
   *
   * The Restaurant Manager's own account is **not** created here with a
   * password: doc 08 §3 requires an invitation, which is Phase 04's
   * `hotel.restaurant.manager_invite` and its existing invitation flow.
   */
  async register(
    input: {
      hotelId: string;
      displayName: string;
      cuisineKind: string;
      description?: string;
      addressLine: string;
      latitudeMicro: number;
      longitudeMicro: number;
      contactPhone: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RegisteredRestaurant> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REGISTER,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.register', input.idempotencyKey, {
          displayName: input.displayName,
        });
        if (claimed.kind === 'replay') return claimed.body as RegisteredRestaurant;
        await authorize();
        const repository = new RestaurantRepository(uow);
        const restaurant = await repository.createRestaurant({
          hotelId: input.hotelId,
          displayName: input.displayName,
          cuisineKind: input.cuisineKind,
          description: input.description ?? null,
          addressLine: input.addressLine,
          latitudeMicro: input.latitudeMicro,
          longitudeMicro: input.longitudeMicro,
          contactPhone: input.contactPhone,
        });
        // doc 08 §4: activation lives on the link, so registering creates one.
        const link = await repository.createLink({
          hotelId: input.hotelId,
          restaurantId: restaurant.restaurantId,
        });
        await recordPlatformAudit(uow, {
          action: 'restaurant.registered',
          outcome: 'allowed',
          targetType: 'restaurant',
          targetRef: restaurant.restaurantId,
          payload: { displayName: input.displayName },
        });
        const registered: RegisteredRestaurant = {
          restaurantId: restaurant.restaurantId,
          linkId: link.linkId,
          displayName: restaurant.displayName,
        };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, registered);
        return registered;
      },
    );
  }

  /**
   * doc 08 §4: Manager Plus switches the link on or off.
   *
   * Switching it off stops new orders and new invoices; it does not delete a
   * confirmed one, which the restaurant still finishes from its own list.
   */
  async setLinkState(
    input: {
      hotelId: string;
      restaurantId: string;
      linkState: 'ACTIVE' | 'INACTIVE';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ linkState: string; slaPaused: boolean }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REGISTER,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.link_state', input.idempotencyKey, {
          restaurantId: input.restaurantId,
          linkState: input.linkState,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as { linkState: string; slaPaused: boolean };
        }
        await authorize();
        const repository = new RestaurantRepository(uow);
        const link = await repository.lockLink(input.restaurantId);
        if (link === undefined) throw new ApiError('NOT_FOUND', 'no such restaurant');
        const moved = await repository.updateLink({
          linkId: link.linkId,
          expectedRevision: link.revision,
          linkState: input.linkState,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that link changed under this command');
        await recordPlatformAudit(uow, {
          action: 'restaurant.link_state_changed',
          outcome: 'allowed',
          targetType: 'restaurant',
          targetRef: input.restaurantId,
          payload: { linkState: input.linkState, by: gate.principal.accountId },
        });
        const result = { linkState: input.linkState, slaPaused: link.slaPaused };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** doc 08 §5: the week's ordering hours, set by the Restaurant Manager. */
  async setSchedule(
    input: {
      hotelId: string;
      restaurantId: string;
      days: readonly DaySchedule[];
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ days: number }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.schedule', input.idempotencyKey, {
          restaurantId: input.restaurantId,
          days: input.days.length,
        });
        if (claimed.kind === 'replay') return claimed.body as { days: number };
        await authorize();
        for (const day of input.days) {
          if (day.weekday < 0 || day.weekday > 6) {
            throw new ApiError('VALIDATION_FAILED', 'a weekday is 0 to 6');
          }
          // The database says the same thing; refusing here gives the caller a
          // sentence instead of a constraint name.
          if (day.closed !== (day.opensAt === null) || day.closed !== (day.closesAt === null)) {
            throw new ApiError(
              'VALIDATION_FAILED',
              'a day is closed and has no hours, or open and has both',
            );
          }
        }
        await new RestaurantRepository(uow).setWeek({
          hotelId: input.hotelId,
          restaurantId: input.restaurantId,
          days: input.days,
        });
        const result = { days: input.days.length };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** doc 08 §5: a holiday or a temporary closure, outranking the weekly row. */
  async addScheduleOverride(
    input: {
      hotelId: string;
      restaurantId: string;
      localDate: string;
      closed: boolean;
      opensAt?: string;
      closesAt?: string;
      reason?: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ localDate: string }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.schedule_override', input.idempotencyKey, {
          restaurantId: input.restaurantId,
          localDate: input.localDate,
        });
        if (claimed.kind === 'replay') return claimed.body as { localDate: string };
        await authorize();
        await new RestaurantRepository(uow).addOverride({
          hotelId: input.hotelId,
          restaurantId: input.restaurantId,
          localDate: input.localDate,
          closed: input.closed,
          opensAt: input.opensAt ?? null,
          closesAt: input.closesAt ?? null,
          reason: input.reason ?? null,
        });
        const result = { localDate: input.localDate };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** doc 08 §6: a menu section. */
  async addCategory(
    input: {
      hotelId: string;
      restaurantId: string;
      name: string;
      sortOrder?: number;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ menuCategoryId: string }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.menu_category', input.idempotencyKey, {
          restaurantId: input.restaurantId,
          name: input.name,
        });
        if (claimed.kind === 'replay') return claimed.body as { menuCategoryId: string };
        await authorize();
        const menuCategoryId = await new RestaurantRepository(uow).createCategory({
          hotelId: input.hotelId,
          restaurantId: input.restaurantId,
          name: input.name,
          sortOrder: input.sortOrder ?? 0,
        });
        const result = { menuCategoryId };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** doc 08 §6: a dish, its price, and whether it is in stock. */
  async addItem(
    input: {
      hotelId: string;
      restaurantId: string;
      menuCategoryId: string;
      name: string;
      description?: string;
      priceMnt: bigint;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ itemId: string }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.menu_item', input.idempotencyKey, {
          restaurantId: input.restaurantId,
          name: input.name,
        });
        if (claimed.kind === 'replay') return claimed.body as { itemId: string };
        await authorize();
        if (input.priceMnt <= 0n) {
          throw new ApiError('VALIDATION_FAILED', 'a price is a positive whole number of MNT');
        }
        const item = await new RestaurantRepository(uow).createItem({
          hotelId: input.hotelId,
          restaurantId: input.restaurantId,
          menuCategoryId: input.menuCategoryId,
          name: input.name,
          description: input.description ?? null,
          priceMnt: input.priceMnt,
        });
        const result = { itemId: item.itemId };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** doc 08 §6: in stock, out of stock, on the menu or off it. */
  async setItemAvailability(
    input: {
      hotelId: string;
      restaurantId: string;
      itemId: string;
      available?: boolean;
      state?: 'ACTIVE' | 'INACTIVE';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ itemId: string }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.item_availability', input.idempotencyKey, {
          itemId: input.itemId,
          available: input.available ?? null,
          state: input.state ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as { itemId: string };
        await authorize();
        const repository = new RestaurantRepository(uow);
        const items = await repository.lockItems([input.itemId]);
        const item = items[0];
        if (item === undefined || item.restaurantId !== input.restaurantId) {
          throw new ApiError('NOT_FOUND', 'no such item');
        }
        const moved = await repository.updateItem({
          itemId: item.itemId,
          expectedRevision: item.revision,
          ...(input.available === undefined ? {} : { available: input.available }),
          ...(input.state === undefined ? {} : { state: input.state }),
        });
        if (!moved) throw new ApiError('CONFLICT', 'that item changed under this command');
        const result = { itemId: item.itemId };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** doc 08 §3: the Restaurant Manager keeps its own order contact current. */
  async setContactPhone(
    input: {
      hotelId: string;
      restaurantId: string;
      contactPhone: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ contactPhone: string }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId: input.restaurantId },
      MENU_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.contact_phone', input.idempotencyKey, {
          restaurantId: input.restaurantId,
        });
        if (claimed.kind === 'replay') return claimed.body as { contactPhone: string };
        await authorize();
        const repository = new RestaurantRepository(uow);
        const restaurant = await repository.restaurantById(input.restaurantId);
        if (restaurant === undefined) throw new ApiError('NOT_FOUND', 'no such restaurant');
        const moved = await repository.updateContactPhone({
          restaurantId: restaurant.restaurantId,
          expectedRevision: restaurant.revision,
          contactPhone: input.contactPhone,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that restaurant changed under this command');
        // doc 08 §3: every change of the number is audited.
        await recordPlatformAudit(uow, {
          action: 'restaurant.contact_phone_changed',
          outcome: 'allowed',
          targetType: 'restaurant',
          targetRef: restaurant.restaurantId,
          payload: { by: gate.principal.accountId },
        });
        const result = { contactPhone: input.contactPhone };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }
}
