import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import { CATALOG_POOL } from './catalog.tokens';
import { CatalogController } from './http/catalog.controller';
import { LifecycleController } from './http/lifecycle.controller';
import { TariffController } from './http/tariff.controller';
import type { CatalogDependencies } from './services/catalog-context';
import { CatalogService } from './services/catalog.service';
import { LifecycleService } from './services/lifecycle.service';
import { TariffService } from './services/tariff.service';

/**
 * Hotel, room, category and tariffs (Phase 06).
 *
 * The module has one external dependency and it is internal to the process:
 * the authoritative subscription-state port, resolved from the IAM module's
 * own export so that the package gate the catalog evaluates is the instance
 * every other Hotel-realm command evaluates. No provider, no queue, no signal:
 * the catalog is PostgreSQL and the Phase 04 pipeline, nothing else.
 *
 * `TariffService` is exported. Its `captureRateSnapshot` is the contract the
 * confirmation transactions of Phases 08 and 13 call; `LifecycleService` is
 * exported for `finalizeIfClear`, the contract a later phase calls when it
 * resolves a blocker of its own.
 */
export interface CatalogModuleConfig {
  readonly databaseUrl: string;
}

export interface CatalogModuleOptions {
  readonly config?: CatalogModuleConfig;
  /**
   * The already-constructed IAM module, imported rather than rebuilt so the
   * session guard and the subscription-state port resolve to one instance.
   */
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
}

class CatalogLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class CatalogModule {
  static forRoot(options: CatalogModuleOptions = {}): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString: (() => {
          if (options.config === undefined) {
            throw new Error('CatalogModule needs either a configuration or a pool');
          }
          return options.config.databaseUrl;
        })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const deps = (subscription: SubscriptionStatePort): CatalogDependencies => ({
      pool,
      subscription,
    });

    return {
      module: CatalogModule,
      imports: options.iam === undefined ? [] : [options.iam],
      controllers: [CatalogController, LifecycleController, TariffController],
      providers: [
        { provide: CATALOG_POOL, useValue: pool },
        { provide: CatalogLifecycle, useValue: new CatalogLifecycle(pool, ownsPool) },
        {
          provide: LifecycleService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new LifecycleService(deps(subscription)),
          inject: [SUBSCRIPTION_STATE],
        },
        {
          provide: CatalogService,
          useFactory: (subscription: SubscriptionStatePort, lifecycle: LifecycleService) =>
            new CatalogService(deps(subscription), lifecycle),
          inject: [SUBSCRIPTION_STATE, LifecycleService],
        },
        {
          provide: TariffService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new TariffService(deps(subscription)),
          inject: [SUBSCRIPTION_STATE],
        },
      ],
      exports: [CatalogService, LifecycleService, TariffService, CATALOG_POOL],
    };
  }
}
