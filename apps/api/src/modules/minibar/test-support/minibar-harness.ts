import type { Pool } from 'pg';
import type { HotelRole, PackageCode } from '@prsystem/authz';
import type { TestDatabase } from '@prsystem/testing';
import type { CommandActor } from '../../iam/services/iam-context';
import type { SeededMembership } from '../../iam/test-support/iam-harness';
import { provisionIamDatabase } from '../../iam/test-support/iam-harness';
import type { CatalogHarness } from '../../catalog/test-support/catalog-harness';
import { attachCatalogHarness, key, request } from '../../catalog/test-support/catalog-harness';
import { ConfigurationService } from '../services/configuration.service';
import type { MinibarDependencies } from '../services/minibar-context';
import { ProductService } from '../services/product.service';
import { RolloutService } from '../services/rollout.service';
import { VersionService } from '../services/version.service';

/**
 * The minibar services on a real database, through the restricted API login,
 * on top of the catalog harness — which seeds hotels, memberships, categories,
 * rooms and the minibar entities the minibar extends. The catalog's own
 * `LifecycleService` is the lifecycle contract, so a configuration applied
 * here completes a retirement exactly as production would.
 */

export interface MinibarHotel {
  readonly hotelId: string;
  readonly manager: CommandActor;
  readonly managerMember: SeededMembership;
  readonly cleaner: CommandActor;
  readonly cleanerMember: SeededMembership;
  readonly categoryId: string;
  /** A helper that creates an ACTIVE room in the seeded category. */
  room(): Promise<string>;
  /** A helper that creates an ACTIVE template entity. */
  template(name?: string): Promise<string>;
}

export interface MinibarHarness {
  readonly db: TestDatabase;
  readonly admin: Pool;
  readonly api: Pool;
  readonly catalog: CatalogHarness;
  readonly deps: MinibarDependencies;
  readonly products: ProductService;
  readonly versions: VersionService;
  readonly configurations: ConfigurationService;
  readonly rollouts: RolloutService;
  hotel(name: string, packageCode?: PackageCode): Promise<MinibarHotel>;
  actorFor(member: SeededMembership): Promise<CommandActor>;
  seed(hotelId: string, email: string, roles: readonly HotelRole[]): Promise<SeededMembership>;
  close(): Promise<void>;
}

export function attachMinibarHarness(db: TestDatabase, suite: string): MinibarHarness {
  const catalog = attachCatalogHarness(db, suite);
  const deps: MinibarDependencies = {
    pool: catalog.api,
    subscription: catalog.subscription,
    lifecycle: catalog.lifecycle,
  };
  const configurations = new ConfigurationService(deps);
  let roomSequence = 700;
  let hotelSequence = 0;

  return {
    db,
    admin: db.pool,
    api: catalog.api,
    catalog,
    deps,
    products: new ProductService(deps),
    versions: new VersionService(deps),
    configurations,
    rollouts: new RolloutService(deps, configurations),

    async hotel(name, packageCode = 'P25') {
      hotelSequence += 1;
      const seeded = await catalog.hotelWithManager(name, packageCode);
      const cleanerMember = await catalog.iam.seedMembership({
        hotelId: seeded.hotelId,
        email: `cleaner-${String(hotelSequence)}-${suite}@minibar.test`,
        roles: ['CLEANER'],
      });
      const cleaner = await catalog.actorFor(cleanerMember);
      await catalog.catalog.configureStay(
        {
          hotelId: seeded.hotelId,
          idempotencyKey: key('mb'),
          hourlyRateMnt: 20_000n,
          nightlyRateMnt: 100_000n,
          fixedCheckoutMinute: 720,
          cleaningBufferMinutes: 30,
        },
        seeded.actor,
        request(seeded.actor),
      );
      const category = await catalog.catalog.createCategory(
        { hotelId: seeded.hotelId, idempotencyKey: key('mb'), name: 'Standard', state: 'ACTIVE' },
        seeded.actor,
        request(seeded.actor),
      );
      const hotelId = seeded.hotelId;
      const manager = seeded.actor;
      return {
        hotelId,
        manager,
        managerMember: seeded.manager,
        cleaner,
        cleanerMember,
        categoryId: category.categoryId,
        async room() {
          roomSequence += 1;
          const created = await catalog.catalog.createRoom(
            {
              hotelId,
              idempotencyKey: key('mb'),
              roomNumber: String(roomSequence),
              categoryId: category.categoryId,
              state: 'ACTIVE',
            },
            manager,
            request(manager),
          );
          return created.roomId;
        },
        async template(name = 'Standard Minibar') {
          const created = await catalog.catalog.createMinibarEntity(
            { hotelId, idempotencyKey: key('mb'), kind: 'MINIBAR_TEMPLATE', name, state: 'ACTIVE' },
            manager,
            request(manager),
          );
          return created.entityId;
        },
      };
    },

    actorFor(member) {
      return catalog.actorFor(member);
    },

    seed(hotelId, email, roles) {
      return catalog.iam.seedMembership({ hotelId, email, roles });
    },

    async close() {
      await catalog.close();
    },
  };
}

export async function createMinibarHarness(suite: string): Promise<MinibarHarness> {
  const db = await provisionIamDatabase(suite);
  return attachMinibarHarness(db, suite);
}

export { key, request };
