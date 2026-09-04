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
import type { CatalogModuleOptions } from './modules/catalog/catalog.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import type { MinibarModuleOptions } from './modules/minibar/minibar.module';
import { MinibarModule } from './modules/minibar/minibar.module';
import type { StayModuleOptions } from './modules/stay/stay.module';
import { StayModule } from './modules/stay/stay.module';
import type { BillingModuleOptions } from './modules/billing/billing.module';
import { BillingModule } from './modules/billing/billing.module';
import type { FinanceModuleOptions } from './modules/finance/finance.module';
import { FinanceModule } from './modules/finance/finance.module';
import { BillingDeposits } from './modules/billing/contracts/stay-deposits';
import { LedgerCashLedger } from './modules/finance/contracts/cash-ledger';
import { LedgerCashPostings } from './modules/finance/contracts/billing-cash';
import { RepositoryShiftLookup } from './modules/stay/contracts/shift-lookup';

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
   * The Phase 06 catalog. Its subscription-state port is not an option: the
   * module reads the IAM module's export, so there is exactly one entitlement
   * gate in the process.
   */
  readonly catalog: CatalogModuleOptions;
  /** The Phase 07 minibar. It takes the catalog's lifecycle contract from the catalog module. */
  readonly minibar: MinibarModuleOptions;
  /**
   * The Phase 08 stay. It takes the tariff and lifecycle contracts from the
   * catalog module and the check-in contracts from the minibar module.
   */
  readonly stay: StayModuleOptions;
  /**
   * The Phase 10 folio, deposit and payment. It reads the stay's own billing
   * facts and the settled minibar charge through the stay module's contracts,
   * and the stay module's check-in opens the folio through this module's
   * `BillingDeposits` — which takes nothing from it, so the two stay one-way.
   */
  readonly billing: BillingModuleOptions;
  /**
   * The Phase 11 shift cash, drawer ledger and hotel expenses. It reads which
   * shift is accountable for a drawer through the stay module's contract, and
   * the billing module mirrors its cash payments into this module's ledger.
   */
  readonly finance: FinanceModuleOptions;
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
    // The catalog is constructed once too: the minibar module imports the same
    // object, so the lifecycle contract it resolves is the catalog's instance.
    const catalog = CatalogModule.forRoot({ ...options.catalog, iam });
    // And the minibar: the stay module imports the same object for its
    // check-in contracts.
    const minibar = MinibarModule.forRoot({ ...options.minibar, iam, catalog });
    // The stay module is constructed once as well: the billing module imports
    // the same object, and the check-in opens the folio through the deposit
    // contract this module supplies.
    const stay = StayModule.forRoot({
      ...options.stay,
      iam,
      catalog,
      minibar,
      deposits: options.stay.deposits ?? new BillingDeposits(),
      cash: options.stay.cash ?? new LedgerCashLedger(),
    });
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
        catalog,
        minibar,
        stay,
        BillingModule.forRoot({
          cash: new LedgerCashPostings(new RepositoryShiftLookup()),
          ...options.billing,
          iam,
          stay,
        }),
        FinanceModule.forRoot({ ...options.finance, iam, stay }),
      ],
    };
  }
}
