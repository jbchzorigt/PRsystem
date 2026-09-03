import type { Pool } from 'pg';
import type { HotelRole, PackageCode } from '@prsystem/authz';
import type { TestDatabase } from '@prsystem/testing';
import type { CommandActor } from '../../iam/services/iam-context';
import type { IamHarness, SeededMembership } from '../../iam/test-support/iam-harness';
import {
  actorFor,
  attachIamHarness,
  provisionIamDatabase,
} from '../../iam/test-support/iam-harness';
import type { SimulatedSubscriptionState } from '../../iam/contracts/subscription-state.port';
import type { CatalogDependencies, RequestContext } from '../services/catalog-context';
import { newCatalogRequest } from '../services/catalog-context';
import { CatalogService } from '../services/catalog.service';
import { LifecycleService } from '../services/lifecycle.service';
import { TariffService } from '../services/tariff.service';

/**
 * The catalog services on a real database, through the restricted `prsystem_api`
 * login, with the Phase 04 harness underneath for hotels, memberships and
 * sessions.
 *
 * The subscription port is the IAM harness's simulator, which `createHotel`
 * already seeds — so the package gate the catalog evaluates is the one the
 * rest of the Hotel realm evaluates, and a hotel on 20,000₮ is refused the
 * minibar here for the same reason it is refused everywhere else.
 */

export interface CatalogHarness {
  readonly db: TestDatabase;
  /** Superuser connection. Seeding and verification only, never an assertion's subject. */
  readonly admin: Pool;
  /** The restricted runtime login every command runs as. */
  readonly api: Pool;
  readonly iam: IamHarness;
  readonly deps: CatalogDependencies;
  readonly catalog: CatalogService;
  readonly lifecycle: LifecycleService;
  readonly tariffs: TariffService;
  readonly subscription: SimulatedSubscriptionState;
  /** A hotel with a Manager, signed in and authenticated the way the guard does it. */
  hotelWithManager(
    name: string,
    packageCode: PackageCode,
    roles?: readonly HotelRole[],
  ): Promise<{ hotelId: string; manager: SeededMembership; actor: CommandActor }>;
  actorFor(member: SeededMembership): Promise<CommandActor>;
  close(): Promise<void>;
}

export function attachCatalogHarness(
  db: TestDatabase,
  suite: string,
  options: { readonly iam?: IamHarness } = {},
): CatalogHarness {
  const iam = options.iam ?? attachIamHarness(db, suite);
  const deps: CatalogDependencies = { pool: iam.api, subscription: iam.subscription };
  const lifecycle = new LifecycleService(deps);
  let sequence = 0;

  return {
    db,
    admin: db.pool,
    api: iam.api,
    iam,
    deps,
    catalog: new CatalogService(deps, lifecycle),
    lifecycle,
    tariffs: new TariffService(deps),
    subscription: iam.subscription,

    async hotelWithManager(name, packageCode, roles = ['MANAGER']) {
      sequence += 1;
      const hotelId = await iam.createHotel(name, packageCode);
      const manager = await iam.seedMembership({
        hotelId,
        email: `manager-${String(sequence).padStart(3, '0')}-${suite}@catalog.test`,
        roles,
      });
      return { hotelId, manager, actor: await actorFor(iam, manager) };
    },

    actorFor(member) {
      return actorFor(iam, member);
    },

    async close() {
      if (options.iam === undefined) await iam.close();
    },
  };
}

export async function createCatalogHarness(suite: string): Promise<CatalogHarness> {
  const db = await provisionIamDatabase(suite);
  return attachCatalogHarness(db, suite);
}

let keySequence = 0;

/** A fresh client idempotency key. */
export function key(prefix = 'catalog'): string {
  keySequence += 1;
  return `${prefix}-${String(keySequence).padStart(5, '0')}-${String(Date.now())}`;
}

export function request(actor?: CommandActor): RequestContext {
  return newCatalogRequest(actor?.principal.accountId);
}

/** Row counts an assertion reads on the administrative connection. */
export async function countRows(
  admin: Pool,
  sql: string,
  values: readonly unknown[] = [],
): Promise<number> {
  const result = await admin.query<{ n: string }>(sql, values as unknown[]);
  return Number(result.rows[0]?.n ?? '0');
}
