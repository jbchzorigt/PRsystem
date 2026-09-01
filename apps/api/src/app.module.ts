import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import type { SchedulerConfig } from '@prsystem/config';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import type { IamModuleOptions } from './modules/iam/iam.module';
import { IamModule } from './modules/iam/iam.module';
import type { OnboardingModuleOptions } from './modules/onboarding/onboarding.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';

export interface AppModuleOptions {
  /**
   * Whether this application holds the D-09 scheduler capability, and its
   * credential when it does. Required rather than defaulted: every construction
   * site — the API, the OpenAPI generator, a test — states its answer, so none
   * of them can acquire a privileged pool by omission.
   */
  readonly scheduler: SchedulerConfig;
  /**
   * Overrides for the IAM module's ports.
   *
   * Tests supply deterministic simulators here; production supplies nothing and
   * the module selects the fail-closed adapters for the environment.
   */
  readonly iam: IamModuleOptions;
  /**
   * Overrides for the Phase 05 ports.
   *
   * The subscription-state contract is supplied through `iam.subscription`, not
   * here: Phase 05 owns the authoritative row and Phase 04's authorization
   * pipeline reads it, so the adapter is constructed where the pool that backs
   * it lives and handed to the module that consumes it (ADR-0019 §4).
   */
  readonly onboarding: OnboardingModuleOptions;
  /**
   * A pool the application should close on shutdown.
   *
   * The subscription-state adapter is constructed before the container exists —
   * the IAM module needs it as a value — so nothing in the container owns its
   * pool. Handing it here gives it an owner: without one, a shut-down process
   * keeps idle backends open and a dropped database reports them as unexpected
   * client errors, which is the exact failure the IAM module's own lifecycle
   * provider was added to fix.
   */
  readonly ownedPools?: readonly Pool[];
}

/** Closes the pools the application was handed. */
class AppPoolLifecycle implements OnModuleDestroy {
  constructor(private readonly pools: readonly Pool[]) {}

  async onModuleDestroy(): Promise<void> {
    for (const pool of this.pools) await pool.end().catch(() => undefined);
  }
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    // Constructed once and imported twice, by reference. The onboarding module's
    // guarded routes need the Phase 04 session in scope, and Nest keys a dynamic
    // module by its metadata — so the same object yields one module instance,
    // one pool and one `SessionService`, never a parallel session model.
    const iam = IamModule.forRoot(options.iam);
    return {
      module: AppModule,
      providers: [
        { provide: AppPoolLifecycle, useValue: new AppPoolLifecycle(options.ownedPools ?? []) },
      ],
      // MaintenanceModule owns the D-09 scheduler pool and service when the
      // capability is enabled. It exposes no controller: the capability is
      // internal to the control plane in Phase 03.
      imports: [
        HealthModule,
        MaintenanceModule.forRoot(options.scheduler),
        iam,
        OnboardingModule.forRoot({ ...options.onboarding, iam }),
      ],
    };
  }
}
