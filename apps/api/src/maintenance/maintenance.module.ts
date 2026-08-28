import { Global, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import type { SchedulerConfig } from '@prsystem/config';
import { MaintenanceSchedulerService } from './scheduler.service';

/** Injection token for the application-owned scheduler pool. */
export const SCHEDULER_POOL = Symbol('SCHEDULER_POOL');

/**
 * Owns the scheduler connection pool for the life of the application.
 *
 * The startup guard used to create a pool, verify it, and immediately close it,
 * so the credential was checked and then nothing held it: the capability existed
 * on paper and had no connection to run on. The pool registered here is the one
 * the service actually uses, it is the one the startup guard validates, and Nest
 * closes it through the shutdown lifecycle.
 */
@Injectable()
export class SchedulerPoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SCHEDULER_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The D-09 scheduler capability, as a module that either exists or does not.
 *
 * Configuration is injected, never read from `process.env` here. The provider
 * used to read the raw variable, which made `SCHEDULER_ENABLED` decorative: a
 * deployment could declare the capability off and still have the credential
 * opened, held and usable. Whether the capability exists is decided once, during
 * validation, and this module is handed the answer.
 *
 * When it is disabled there is no pool, no lifecycle hook and no service —
 * nothing to resolve and nothing holding a privileged connection.
 */
@Global()
@Module({})
export class MaintenanceModule {
  static forRoot(scheduler: SchedulerConfig): DynamicModule {
    if (!scheduler.enabled) {
      return { module: MaintenanceModule, providers: [], exports: [] };
    }

    const databaseUrl = scheduler.databaseUrl;
    return {
      module: MaintenanceModule,
      providers: [
        {
          provide: SCHEDULER_POOL,
          useFactory: (): Pool => new Pool({ connectionString: databaseUrl, max: 4 }),
        },
        SchedulerPoolLifecycle,
        {
          provide: MaintenanceSchedulerService,
          useFactory: (pool: Pool): MaintenanceSchedulerService =>
            new MaintenanceSchedulerService(pool),
          inject: [SCHEDULER_POOL],
        },
      ],
      exports: [SCHEDULER_POOL, MaintenanceSchedulerService],
    };
  }
}
