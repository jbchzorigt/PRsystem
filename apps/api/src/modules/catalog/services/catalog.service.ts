import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import { authorizeCommand } from '../../iam/services/authorization.service';
import type { EntityState } from '../domain/lifecycle';
import { isCreatableState } from '../domain/lifecycle';
import type { CatalogRepository, CategoryRow, RoomRow } from '../repositories/catalog.repository';
import { CatalogRepository as Repository } from '../repositories/catalog.repository';
import type {
  CatalogDependencies,
  CommandActor,
  HotelGate,
  RequestContext,
} from './catalog-context';
import { CatalogServiceBase } from './catalog-context';
import { LifecycleService } from './lifecycle.service';

/**
 * Room categories, physical rooms, minibar entities and the tariffs that hang
 * off them (docs 07 §§2–3, 05 §13; `STAY-DEC-004`, `STAY-DEC-005`,
 * `STAY-DEC-006`, `RML-DEC-001`).
 *
 * Every command here runs the same way, and the order is the point:
 *
 *  1. claim the idempotency key, so a retry can never produce a second effect;
 *  2. take the row locks in the module's fixed order —
 *     `hotel_stay_configuration` → `room_category` → `room` → minibar entity —
 *     so a lifecycle transition and an assignment that touch the same rows
 *     serialise instead of racing;
 *  3. evaluate the Phase 04 pipeline against the named permission, on the state
 *     just locked;
 *  4. apply the change as a compare-and-set on the revision that was read,
 *     append the catalog event, write the audit record and the outbox event;
 *  5. store the response against the key.
 *
 * A tariff write additionally advances the hotel's `config_version`, which is
 * what a captured snapshot records. Nothing in this file reprices anything: a
 * snapshot is written once, by `TariffService`, and no statement here can reach
 * it.
 */

const ROOM_MANAGE = 'hotel.catalog.room_manage';
const TARIFF_MANAGE = 'hotel.tariff.config_manage';
const MINIBAR_MANAGE = 'hotel.minibar.product_manage';

/** `undefined` leaves the value alone; `null` clears it back to inherited. */
export type Assignable<T> = T | null | undefined;

export interface ConfigureStayInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly hourlyRateMnt?: Assignable<bigint>;
  readonly nightlyRateMnt?: Assignable<bigint>;
  readonly fixedCheckoutMinute?: Assignable<number>;
  readonly cleaningBufferMinutes?: Assignable<number>;
}

export interface CreateCategoryInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly description?: string;
  readonly state: EntityState;
  readonly hourlyRateMnt?: bigint;
  readonly nightlyRateMnt?: bigint;
  readonly cleaningBufferMinutes?: number;
}

export interface UpdateCategoryInput {
  readonly hotelId: string;
  readonly categoryId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly description?: Assignable<string>;
  readonly hourlyRateMnt?: Assignable<bigint>;
  readonly nightlyRateMnt?: Assignable<bigint>;
  readonly cleaningBufferMinutes?: Assignable<number>;
}

export interface CreateRoomInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly roomNumber: string;
  readonly floorLabel?: string;
  readonly categoryId: string;
  readonly state: EntityState;
  readonly hourlyRateMnt?: bigint;
  readonly nightlyRateMnt?: bigint;
}

export interface UpdateRoomInput {
  readonly hotelId: string;
  readonly roomId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly roomNumber?: string;
  readonly floorLabel?: Assignable<string>;
  readonly categoryId?: string;
  readonly hourlyRateMnt?: Assignable<bigint>;
  readonly nightlyRateMnt?: Assignable<bigint>;
}

export interface CreateMinibarEntityInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly kind: 'MINIBAR_PRODUCT' | 'MINIBAR_TEMPLATE';
  readonly name: string;
  readonly state: EntityState;
}

export interface CategoryView {
  readonly categoryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: EntityState;
  readonly hourlyRateMnt: string | null;
  readonly nightlyRateMnt: string | null;
  readonly cleaningBufferMinutes: number | null;
  readonly revision: number;
}

export interface RoomView {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly floorLabel: string | null;
  readonly categoryId: string;
  readonly state: EntityState;
  readonly hourlyRateMnt: string | null;
  readonly nightlyRateMnt: string | null;
  readonly revision: number;
}

export interface ConfigurationView {
  readonly hourlyRateMnt: string | null;
  readonly nightlyRateMnt: string | null;
  readonly fixedCheckoutMinute: number | null;
  readonly cleaningBufferMinutes: number | null;
  readonly configVersion: number;
  readonly revision: number;
}

export interface CatalogListing {
  readonly configuration: ConfigurationView | null;
  readonly categories: readonly CategoryView[];
  readonly rooms: readonly RoomView[];
}

export interface MinibarEntityView {
  readonly entityId: string;
  readonly name: string;
  readonly state: EntityState;
  readonly revision: number;
}

function categoryView(row: CategoryRow): CategoryView {
  return {
    categoryId: row.categoryId,
    name: row.name,
    description: row.description,
    state: row.state,
    hourlyRateMnt: row.hourlyRateMnt === null ? null : row.hourlyRateMnt.toString(),
    nightlyRateMnt: row.nightlyRateMnt === null ? null : row.nightlyRateMnt.toString(),
    cleaningBufferMinutes: row.cleaningBufferMinutes,
    revision: row.revision,
  };
}

function roomView(row: RoomRow): RoomView {
  return {
    roomId: row.roomId,
    roomNumber: row.roomNumber,
    floorLabel: row.floorLabel,
    categoryId: row.categoryId,
    state: row.state,
    hourlyRateMnt: row.hourlyRateMnt === null ? null : row.hourlyRateMnt.toString(),
    nightlyRateMnt: row.nightlyRateMnt === null ? null : row.nightlyRateMnt.toString(),
    revision: row.revision,
  };
}

/** Whether a payload asks to write any tariff or configuration value. */
function touchesTariff(input: {
  hourlyRateMnt?: unknown;
  nightlyRateMnt?: unknown;
  fixedCheckoutMinute?: unknown;
  cleaningBufferMinutes?: unknown;
}): boolean {
  return (
    input.hourlyRateMnt !== undefined ||
    input.nightlyRateMnt !== undefined ||
    input.fixedCheckoutMinute !== undefined ||
    input.cleaningBufferMinutes !== undefined
  );
}

export class CatalogService extends CatalogServiceBase {
  private readonly lifecycle: LifecycleService;

  constructor(deps: CatalogDependencies, lifecycle?: LifecycleService) {
    super(deps);
    this.lifecycle = lifecycle ?? new LifecycleService(deps);
  }

  /**
   * The hotel's own defaults: the two fallback tariffs, the fixed check-out time
   * and the cleaning minimum (`STAY-DEC-004`, `STAY-DEC-007`).
   *
   * There is deliberately no minimum, maximum or increment for an hourly stay:
   * `STAY-DEC-006` refused that configuration, and the surface has no field for
   * it to arrive through.
   */
  async configureStay(
    input: ConfigureStayInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ConfigurationView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      TARIFF_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.configure_stay', input.idempotencyKey, {
          hourlyRateMnt: input.hourlyRateMnt?.toString() ?? null,
          nightlyRateMnt: input.nightlyRateMnt?.toString() ?? null,
          fixedCheckoutMinute: input.fixedCheckoutMinute ?? null,
          cleaningBufferMinutes: input.cleaningBufferMinutes ?? null,
        });
        if (claim.kind === 'replay') return claim.body as ConfigurationView;

        const catalog = new Repository(uow);
        const current = await catalog.ensureConfiguration();
        await authorize();

        const written = await catalog.writeConfiguration({
          expectedRevision: current.revision,
          ...(input.hourlyRateMnt === undefined ? {} : { hourlyRateMnt: input.hourlyRateMnt }),
          ...(input.nightlyRateMnt === undefined ? {} : { nightlyRateMnt: input.nightlyRateMnt }),
          ...(input.fixedCheckoutMinute === undefined
            ? {}
            : { fixedCheckoutMinute: input.fixedCheckoutMinute }),
          ...(input.cleaningBufferMinutes === undefined
            ? {}
            : { cleaningBufferMinutes: input.cleaningBufferMinutes }),
        });
        if (written === undefined) throw new ApiError('CONFLICT', 'the configuration moved');

        await catalog.appendEvent({
          entityType: 'HOTEL_STAY_CONFIGURATION',
          entityId: input.hotelId,
          eventType: 'CONFIGURATION_SET',
          configVersion: written.configVersion,
          payload: {
            hourlySet: input.hourlyRateMnt !== undefined,
            nightlySet: input.nightlyRateMnt !== undefined,
            checkoutSet: input.fixedCheckoutMinute !== undefined,
            bufferSet: input.cleaningBufferMinutes !== undefined,
          },
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'catalog.stay_configuration.set',
          outcome: 'allowed',
          targetType: 'hotel_stay_configuration',
          targetRef: input.hotelId,
          payload: { configVersion: written.configVersion },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'hotel_stay_configuration',
          aggregateId: input.hotelId,
          eventType: 'catalog.stay_configuration.changed',
          payload: { configVersion: written.configVersion },
        });

        const view: ConfigurationView = {
          hourlyRateMnt: written.hourlyRateMnt === null ? null : written.hourlyRateMnt.toString(),
          nightlyRateMnt:
            written.nightlyRateMnt === null ? null : written.nightlyRateMnt.toString(),
          fixedCheckoutMinute: written.fixedCheckoutMinute,
          cleaningBufferMinutes: written.cleaningBufferMinutes,
          configVersion: written.configVersion,
          revision: written.revision,
        };
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, view);
        return view;
      },
    );
  }

  async createCategory(
    input: CreateCategoryInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CategoryView> {
    if (!isCreatableState(input.state)) {
      throw new ApiError('VALIDATION_FAILED', 'a category is created ACTIVE or INACTIVE');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      ROOM_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.create_category', input.idempotencyKey, {
          name: input.name,
          state: input.state,
        });
        if (claim.kind === 'replay') return claim.body as CategoryView;

        const catalog = new Repository(uow);
        // The configuration row is the tariff lock, taken first and only when a
        // tariff value is actually being written.
        const configuration = touchesTariff(input)
          ? await catalog.ensureConfiguration()
          : undefined;
        await authorize();
        if (configuration !== undefined) {
          await this.authorizeTariffWrite(uow, gate, input.hotelId);
        }

        const created = await catalog.createCategory({
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          state: input.state,
          ...(input.hourlyRateMnt === undefined ? {} : { hourlyRateMnt: input.hourlyRateMnt }),
          ...(input.nightlyRateMnt === undefined ? {} : { nightlyRateMnt: input.nightlyRateMnt }),
          ...(input.cleaningBufferMinutes === undefined
            ? {}
            : { cleaningBufferMinutes: input.cleaningBufferMinutes }),
        });
        const version =
          configuration === undefined
            ? undefined
            : await this.bump(catalog, configuration.revision);

        await catalog.appendEvent({
          entityType: 'ROOM_CATEGORY',
          entityId: created.categoryId,
          eventType: 'CREATED',
          toState: created.state,
          ...(version === undefined ? {} : { configVersion: version }),
          payload: {
            hasHourlyOverride: created.hourlyRateMnt !== null,
            hasNightlyOverride: created.nightlyRateMnt !== null,
          },
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'catalog.category.create',
          outcome: 'allowed',
          targetType: 'room_category',
          targetRef: created.categoryId,
          payload: { state: created.state },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room_category',
          aggregateId: created.categoryId,
          eventType: 'catalog.category.created',
          payload: { state: created.state },
        });

        const view = categoryView(created);
        await completeIdempotencyKey(uow, claim.idempotencyId, 201, view);
        return view;
      },
    );
  }

  async updateCategory(
    input: UpdateCategoryInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CategoryView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      ROOM_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.update_category', input.idempotencyKey, {
          categoryId: input.categoryId,
          expectedRevision: input.expectedRevision,
        });
        if (claim.kind === 'replay') return claim.body as CategoryView;

        const catalog = new Repository(uow);
        const configuration = touchesTariff(input)
          ? await catalog.ensureConfiguration()
          : undefined;
        const existing = await catalog.lockCategory(input.categoryId);
        await authorize();
        if (configuration !== undefined) {
          await this.authorizeTariffWrite(uow, gate, input.hotelId);
        }
        if (existing === undefined) throw new ApiError('NOT_FOUND', 'not found');

        const updated = await catalog.updateCategory({
          categoryId: input.categoryId,
          expectedRevision: input.expectedRevision,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.hourlyRateMnt === undefined ? {} : { hourlyRateMnt: input.hourlyRateMnt }),
          ...(input.nightlyRateMnt === undefined ? {} : { nightlyRateMnt: input.nightlyRateMnt }),
          ...(input.cleaningBufferMinutes === undefined
            ? {}
            : { cleaningBufferMinutes: input.cleaningBufferMinutes }),
        });
        if (updated === undefined) {
          throw new ApiError('CONFLICT', 'the category moved; re-read it and retry');
        }
        const version =
          configuration === undefined
            ? undefined
            : await this.bump(catalog, configuration.revision);

        const cleared: string[] = [];
        if (input.hourlyRateMnt === null) cleared.push('HOURLY');
        if (input.nightlyRateMnt === null) cleared.push('NIGHTLY');
        await catalog.appendEvent({
          entityType: 'ROOM_CATEGORY',
          entityId: updated.categoryId,
          eventType:
            cleared.length > 0 ? 'TARIFF_CLEARED' : touchesTariff(input) ? 'TARIFF_SET' : 'UPDATED',
          ...(version === undefined ? {} : { configVersion: version }),
          payload: {
            cleared,
            hasHourlyOverride: updated.hourlyRateMnt !== null,
            hasNightlyOverride: updated.nightlyRateMnt !== null,
          },
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: touchesTariff(input) ? 'catalog.category.tariff' : 'catalog.category.update',
          outcome: 'allowed',
          targetType: 'room_category',
          targetRef: updated.categoryId,
          ...(version === undefined ? {} : { payload: { configVersion: version } }),
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room_category',
          aggregateId: updated.categoryId,
          eventType: touchesTariff(input) ? 'catalog.tariff.changed' : 'catalog.category.updated',
          payload: {
            level: 'CATEGORY',
            ...(version === undefined ? {} : { configVersion: version }),
          },
        });

        const view = categoryView(updated);
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, view);
        return view;
      },
    );
  }

  async createRoom(
    input: CreateRoomInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RoomView> {
    if (!isCreatableState(input.state)) {
      throw new ApiError('VALIDATION_FAILED', 'a room is created ACTIVE or INACTIVE');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      ROOM_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.create_room', input.idempotencyKey, {
          roomNumber: input.roomNumber,
          categoryId: input.categoryId,
          state: input.state,
        });
        if (claim.kind === 'replay') return claim.body as RoomView;

        const catalog = new Repository(uow);
        const configuration = touchesTariff(input)
          ? await catalog.ensureConfiguration()
          : undefined;
        // The category is locked before the room is created, so a deactivation
        // that is deciding whether the category still has live children and this
        // assignment cannot both believe they won.
        const category = await catalog.lockCategory(input.categoryId);
        await authorize();
        if (configuration !== undefined) {
          await this.authorizeTariffWrite(uow, gate, input.hotelId);
        }
        if (category === undefined) {
          throw new ApiError('VALIDATION_FAILED', 'the category does not exist in this hotel');
        }
        if (category.state !== 'ACTIVE' && input.state === 'ACTIVE') {
          // doc 26 §3: a retiring or inactive category takes no new assignment.
          throw new ApiError('CONFLICT', 'ENTITY_NOT_ACTIVE: the category is not active');
        }

        const created = await this.uniqueRoomNumber(() =>
          catalog.createRoom({
            roomNumber: input.roomNumber,
            ...(input.floorLabel === undefined ? {} : { floorLabel: input.floorLabel }),
            categoryId: input.categoryId,
            state: input.state,
            ...(input.hourlyRateMnt === undefined ? {} : { hourlyRateMnt: input.hourlyRateMnt }),
            ...(input.nightlyRateMnt === undefined ? {} : { nightlyRateMnt: input.nightlyRateMnt }),
          }),
        );
        const version =
          configuration === undefined
            ? undefined
            : await this.bump(catalog, configuration.revision);

        await catalog.appendEvent({
          entityType: 'ROOM',
          entityId: created.roomId,
          eventType: 'CREATED',
          toState: created.state,
          ...(version === undefined ? {} : { configVersion: version }),
          payload: { categoryId: created.categoryId },
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'catalog.room.create',
          outcome: 'allowed',
          targetType: 'room',
          targetRef: created.roomId,
          payload: { state: created.state },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room',
          aggregateId: created.roomId,
          eventType: 'catalog.room.created',
          payload: { state: created.state, categoryId: created.categoryId },
        });

        const view = roomView(created);
        await completeIdempotencyKey(uow, claim.idempotencyId, 201, view);
        return view;
      },
    );
  }

  async updateRoom(
    input: UpdateRoomInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RoomView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      ROOM_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.update_room', input.idempotencyKey, {
          roomId: input.roomId,
          expectedRevision: input.expectedRevision,
        });
        if (claim.kind === 'replay') return claim.body as RoomView;

        const catalog = new Repository(uow);
        const configuration = touchesTariff(input)
          ? await catalog.ensureConfiguration()
          : undefined;
        const category =
          input.categoryId === undefined ? undefined : await catalog.lockCategory(input.categoryId);
        const existing = await catalog.lockRoom(input.roomId);
        await authorize();
        if (configuration !== undefined) {
          await this.authorizeTariffWrite(uow, gate, input.hotelId);
        }
        if (existing === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (input.categoryId !== undefined) {
          if (category === undefined) {
            throw new ApiError('VALIDATION_FAILED', 'the category does not exist in this hotel');
          }
          if (category.state !== 'ACTIVE' && existing.state === 'ACTIVE') {
            throw new ApiError('CONFLICT', 'ENTITY_NOT_ACTIVE: the category is not active');
          }
        }

        const updated = await this.uniqueRoomNumber(() =>
          catalog.updateRoom({
            roomId: input.roomId,
            expectedRevision: input.expectedRevision,
            ...(input.roomNumber === undefined ? {} : { roomNumber: input.roomNumber }),
            ...(input.floorLabel === undefined ? {} : { floorLabel: input.floorLabel }),
            ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
            ...(input.hourlyRateMnt === undefined ? {} : { hourlyRateMnt: input.hourlyRateMnt }),
            ...(input.nightlyRateMnt === undefined ? {} : { nightlyRateMnt: input.nightlyRateMnt }),
          }),
        );
        if (updated === undefined) {
          throw new ApiError('CONFLICT', 'the room moved; re-read it and retry');
        }
        // Moving the room out may have resolved the last blocker on a retiring
        // category (doc 26 §5). The old category is locked here, after the new
        // one and the room, which keeps the module's lock order.
        if (input.categoryId !== undefined && input.categoryId !== existing.categoryId) {
          await this.lifecycle.finalizeIfClear(uow, 'ROOM_CATEGORY', existing.categoryId, {
            source: 'catalog.room.category_changed',
            actorAccountId: gate.principal.accountId,
          });
        }
        const version =
          configuration === undefined
            ? undefined
            : await this.bump(catalog, configuration.revision);

        const cleared: string[] = [];
        if (input.hourlyRateMnt === null) cleared.push('HOURLY');
        if (input.nightlyRateMnt === null) cleared.push('NIGHTLY');
        await catalog.appendEvent({
          entityType: 'ROOM',
          entityId: updated.roomId,
          eventType:
            cleared.length > 0 ? 'TARIFF_CLEARED' : touchesTariff(input) ? 'TARIFF_SET' : 'UPDATED',
          ...(version === undefined ? {} : { configVersion: version }),
          payload: { cleared, categoryId: updated.categoryId },
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: touchesTariff(input) ? 'catalog.room.tariff' : 'catalog.room.update',
          outcome: 'allowed',
          targetType: 'room',
          targetRef: updated.roomId,
          ...(version === undefined ? {} : { payload: { configVersion: version } }),
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room',
          aggregateId: updated.roomId,
          eventType: touchesTariff(input) ? 'catalog.tariff.changed' : 'catalog.room.updated',
          payload: { level: 'ROOM', ...(version === undefined ? {} : { configVersion: version }) },
        });

        const view = roomView(updated);
        await completeIdempotencyKey(uow, claim.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /**
   * The minibar entities, created with identity and lifecycle only.
   *
   * Phase 07 owns the selling price, the purchase cost, the stock and the
   * template versions, and adds them to these rows (`RML-DEC-015`). The
   * entitlement gate is the package: the action exists on 25,000₮ and 30,000₮
   * only, and the pipeline refuses it on 20,000₮ whatever role the caller holds.
   */
  async createMinibarEntity(
    input: CreateMinibarEntityInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MinibarEntityView> {
    if (!isCreatableState(input.state)) {
      throw new ApiError('VALIDATION_FAILED', 'an entity is created ACTIVE or INACTIVE');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      MINIBAR_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claim = await this.claim(uow, 'catalog.create_minibar_entity', input.idempotencyKey, {
          kind: input.kind,
          name: input.name,
          state: input.state,
        });
        if (claim.kind === 'replay') return claim.body as MinibarEntityView;

        await authorize();
        const catalog = new Repository(uow);
        const created = await catalog.createMinibarEntity(input.kind, {
          name: input.name,
          state: input.state,
        });

        await catalog.appendEvent({
          entityType: input.kind,
          entityId: created.entityId,
          eventType: 'CREATED',
          toState: created.state,
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'catalog.minibar_entity.create',
          outcome: 'allowed',
          targetType: input.kind.toLowerCase(),
          targetRef: created.entityId,
          payload: { state: created.state },
        });
        await appendOutboxEvent(uow, {
          aggregateType: input.kind.toLowerCase(),
          aggregateId: created.entityId,
          eventType: 'catalog.minibar_entity.created',
          payload: { state: created.state },
        });

        const view = {
          entityId: created.entityId,
          name: created.name,
          state: created.state,
          revision: created.revision,
        };
        await completeIdempotencyKey(uow, claim.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** The catalog as an operator reads it. */
  async listCatalog(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CatalogListing> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId },
      ['hotel.catalog.lifecycle_view', 'hotel.catalog.lifecycle_view.read'],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const catalog = new Repository(uow);
        const configuration = await catalog.configuration();
        const categories = await catalog.categories();
        const rooms = await catalog.rooms();
        return {
          configuration:
            configuration === undefined
              ? null
              : {
                  hourlyRateMnt:
                    configuration.hourlyRateMnt === null
                      ? null
                      : configuration.hourlyRateMnt.toString(),
                  nightlyRateMnt:
                    configuration.nightlyRateMnt === null
                      ? null
                      : configuration.nightlyRateMnt.toString(),
                  fixedCheckoutMinute: configuration.fixedCheckoutMinute,
                  cleaningBufferMinutes: configuration.cleaningBufferMinutes,
                  configVersion: configuration.configVersion,
                  revision: configuration.revision,
                },
          categories: categories.map((row) => categoryView(row)),
          rooms: rooms.map((row) => roomView(row)),
        };
      },
    );
  }

  /**
   * The second permission a tariff-carrying payload needs.
   *
   * doc 18 §3 states the catalog and the tariff as two rows, so writing a rate
   * while creating a room is two named actions and both are checked. Neither
   * stands in for the other.
   */
  private async authorizeTariffWrite(
    uow: UnitOfWork,
    gate: HotelGate,
    hotelId: string,
  ): Promise<void> {
    await authorizeCommand({
      uow,
      endpointRealm: 'hotel',
      permission: TARIFF_MANAGE,
      principal: gate.principal,
      target: { hotelId },
      subscription: this.deps.subscription,
      sessionId: gate.sessionId,
      ...(gate.principal.stepUpAt === undefined ? {} : { stepUpAt: gate.principal.stepUpAt }),
      targetType: 'hotel',
      targetRef: hotelId,
    });
  }

  /** `room_number_unique_per_hotel` (doc 07 §3), reported as a conflict rather than a crash. */
  private async uniqueRoomNumber<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === '23505' &&
        (error as { constraint?: unknown }).constraint === 'room_number_unique_per_hotel'
      ) {
        throw new ApiError('CONFLICT', 'ROOM_NUMBER_TAKEN: the room number exists in this hotel');
      }
      throw error;
    }
  }

  /** Advances the configuration version an override edit belongs to. */
  private async bump(catalog: CatalogRepository, expectedRevision: number): Promise<number> {
    const advanced = await catalog.advanceConfigVersion(expectedRevision);
    if (advanced === undefined) {
      throw new ApiError('CONFLICT', 'the configuration moved; re-read it and retry');
    }
    return advanced.configVersion;
  }

  /** Claims the key, or replays what the first attempt stored. */
  private async claim(
    uow: UnitOfWork,
    operation: string,
    key: string,
    payload: Record<string, unknown>,
  ): Promise<
    | { readonly kind: 'claimed'; readonly idempotencyId: string }
    | { readonly kind: 'replay'; readonly body: unknown }
  > {
    const outcome = await claimIdempotencyKey(uow, {
      operation,
      key,
      clientRef: uow.context.actorRef,
      payload,
    });
    switch (outcome.kind) {
      case 'claimed':
        return { kind: 'claimed', idempotencyId: outcome.idempotencyId };
      case 'replay':
        if (outcome.status >= 400) {
          throw new ApiError('CONFLICT', 'the original request was refused');
        }
        return { kind: 'replay', body: outcome.body };
      case 'in_progress':
        throw new ApiError('CONFLICT', 'the same request is already in progress');
      case 'key_reused_with_different_payload':
        throw new ApiError('CONFLICT', 'the idempotency key was reused with a different request');
    }
  }
}
