import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { SchedulerConfig } from '@prsystem/config';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';

export interface AppModuleOptions {
  /**
   * Whether this application holds the D-09 scheduler capability, and its
   * credential when it does. Required rather than defaulted: every construction
   * site — the API, the OpenAPI generator, a test — states its answer, so none
   * of them can acquire a privileged pool by omission.
   */
  readonly scheduler: SchedulerConfig;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      // MaintenanceModule owns the D-09 scheduler pool and service when the
      // capability is enabled. It exposes no controller: the capability is
      // internal to the control plane in Phase 03.
      imports: [HealthModule, MaintenanceModule.forRoot(options.scheduler)],
    };
  }
}
