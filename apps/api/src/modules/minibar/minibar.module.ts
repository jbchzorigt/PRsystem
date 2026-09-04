import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import { LifecycleService } from '../catalog/services/lifecycle.service';
import { ConfigurationController } from './http/configuration.controller';
import { ProductController } from './http/product.controller';
import { RolloutController } from './http/rollout.controller';
import { TaskController } from './http/task.controller';
import { TemplateVersionController } from './http/template.controller';
import { MINIBAR_POOL } from './minibar.tokens';
import { ConfigurationService } from './services/configuration.service';
import type { MinibarDependencies } from './services/minibar-context';
import { ProductService } from './services/product.service';
import { RolloutService } from './services/rollout.service';
import { VersionService } from './services/version.service';

/**
 * Minibar inventory and templates (Phase 07).
 *
 * Two in-process dependencies and no external one: the authoritative
 * subscription-state port, from the IAM module's export, and the catalog's
 * lifecycle-resolution contract, from the catalog module's export — the
 * instance whose `finalizeIfClear` the minibar calls when it applies a
 * configuration that may have cleared a room's, a template's or a product's
 * last blocker.
 *
 * `ConfigurationService` is exported for Phase 08: `checkInBlockers` and
 * `advanceScheduled` are the contracts a check-in and a checkout call.
 */
export interface MinibarModuleOptions {
  readonly config?: { readonly databaseUrl: string };
  readonly iam?: DynamicModule;
  readonly catalog?: DynamicModule;
  readonly pool?: Pool;
}

class MinibarLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class MinibarModule {
  static forRoot(options: MinibarModuleOptions = {}): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString: (() => {
          if (options.config === undefined) {
            throw new Error('MinibarModule needs either a configuration or a pool');
          }
          return options.config.databaseUrl;
        })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const deps = (
      subscription: SubscriptionStatePort,
      lifecycle: LifecycleService,
    ): MinibarDependencies => ({ pool, subscription, lifecycle });

    return {
      module: MinibarModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.catalog === undefined ? [] : [options.catalog]),
      ],
      controllers: [
        ProductController,
        TemplateVersionController,
        ConfigurationController,
        TaskController,
        RolloutController,
      ],
      providers: [
        { provide: MINIBAR_POOL, useValue: pool },
        { provide: MinibarLifecycle, useValue: new MinibarLifecycle(pool, ownsPool) },
        {
          provide: ProductService,
          useFactory: (subscription: SubscriptionStatePort, lifecycle: LifecycleService) =>
            new ProductService(deps(subscription, lifecycle)),
          inject: [SUBSCRIPTION_STATE, LifecycleService],
        },
        {
          provide: VersionService,
          useFactory: (subscription: SubscriptionStatePort, lifecycle: LifecycleService) =>
            new VersionService(deps(subscription, lifecycle)),
          inject: [SUBSCRIPTION_STATE, LifecycleService],
        },
        {
          provide: ConfigurationService,
          useFactory: (subscription: SubscriptionStatePort, lifecycle: LifecycleService) =>
            new ConfigurationService(deps(subscription, lifecycle)),
          inject: [SUBSCRIPTION_STATE, LifecycleService],
        },
        {
          provide: RolloutService,
          useFactory: (
            subscription: SubscriptionStatePort,
            lifecycle: LifecycleService,
            configurations: ConfigurationService,
          ) => new RolloutService(deps(subscription, lifecycle), configurations),
          inject: [SUBSCRIPTION_STATE, LifecycleService, ConfigurationService],
        },
      ],
      exports: [ProductService, VersionService, ConfigurationService, RolloutService, MINIBAR_POOL],
    };
  }
}
