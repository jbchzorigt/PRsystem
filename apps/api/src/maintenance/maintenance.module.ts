import { Global, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { env } from '@prsystem/config';
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
  constructor(@Inject(SCHEDULER_POOL) private readonly pool: Pool | undefined) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SCHEDULER_POOL,
      useFactory: (): Pool | undefined => {
        const url = env().SCHEDULER_DATABASE_URL;
        // Undefined when the deployment has no scheduler capability. The API
        // that is meant to have it fails startup earlier, in the guard.
        return url === undefined ? undefined : new Pool({ connectionString: url, max: 4 });
      },
    },
    SchedulerPoolLifecycle,
    {
      provide: MaintenanceSchedulerService,
      useFactory: (pool: Pool | undefined): MaintenanceSchedulerService | undefined =>
        pool === undefined ? undefined : new MaintenanceSchedulerService(pool),
      inject: [SCHEDULER_POOL],
    },
  ],
  exports: [SCHEDULER_POOL, MaintenanceSchedulerService],
})
export class MaintenanceModule {}
