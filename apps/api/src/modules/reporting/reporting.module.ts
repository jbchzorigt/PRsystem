import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { ObjectStoragePort } from '@prsystem/ports';
import { selectObjectStorage } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { RegistryFactsPort } from './contracts/registry-facts';
import { UnprovisionedRegistryFacts } from './contracts/registry-facts';
import type {
  ExpenseFactsPort,
  MinibarFactsPort,
  SalesFactsPort,
} from './contracts/financial-facts';
import {
  UnprovisionedExpenseFacts,
  UnprovisionedMinibarFacts,
  UnprovisionedSalesFacts,
} from './contracts/financial-facts';
import type { ReportingDependencies } from './services/reporting-context';
import { GuestRegistryService } from './services/registry.service';
import { FinancialDashboardService } from './services/dashboard.service';
import { ReportExportService } from './services/export.service';
import { RetentionService } from './services/retention.service';
import { ExpenseCategoryService } from './services/category.service';
import { GuestRegistryController } from './http/registry.controller';
import { FinanceReportingController } from './http/finance.controller';
import { REPORTING_POOL, REPORTING_STORAGE } from './reporting.tokens';

/**
 * The guest registry, its exports, retention, and the Hotel Admin financial
 * dashboard (Phase 17).
 *
 * The module owns five tables and no facts. Everything it *reports on* belongs
 * to the stay, billing, minibar and finance modules and reaches it through four
 * read contracts — so a report cannot read another module's storage, and the
 * columns a registry row may carry are decided by the query that builds it
 * rather than by a filter applied afterwards.
 *
 * The object storage a completed export lives in is a registered production
 * gate. Its production adapter answers `DISABLED` and writes nothing; local, CI
 * and test run against the deterministic simulator.
 */
export interface ReportingModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
}

export interface ReportingModuleOptions {
  readonly config?: ReportingModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly registry?: RegistryFactsPort;
  readonly sales?: SalesFactsPort;
  readonly minibar?: MinibarFactsPort;
  readonly expenses?: ExpenseFactsPort;
  readonly storage?: ObjectStoragePort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class ReportingLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class ReportingModule {
  static forRoot(options: ReportingModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('ReportingModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const storage = options.storage ?? selectObjectStorage(options.config?.appEnv ?? 'production');
    const registry = options.registry ?? new UnprovisionedRegistryFacts();
    const sales = options.sales ?? new UnprovisionedSalesFacts();
    const minibar = options.minibar ?? new UnprovisionedMinibarFacts();
    const expenses = options.expenses ?? new UnprovisionedExpenseFacts();
    const clock = options.clock;

    const deps = (subscription: SubscriptionStatePort): ReportingDependencies => ({
      pool,
      subscription,
      registry,
      sales,
      minibar,
      expenses,
      storage,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];

    return {
      module: ReportingModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [GuestRegistryController, FinanceReportingController],
      providers: [
        { provide: REPORTING_POOL, useValue: pool },
        { provide: REPORTING_STORAGE, useValue: storage },
        { provide: ReportingLifecycle, useValue: new ReportingLifecycle(pool, ownsPool) },
        {
          provide: GuestRegistryService,
          useFactory: (s: SubscriptionStatePort) => new GuestRegistryService(deps(s)),
          inject,
        },
        {
          provide: FinancialDashboardService,
          useFactory: (s: SubscriptionStatePort) => new FinancialDashboardService(deps(s)),
          inject,
        },
        {
          provide: ReportExportService,
          useFactory: (s: SubscriptionStatePort) => new ReportExportService(deps(s)),
          inject,
        },
        {
          provide: RetentionService,
          useFactory: (s: SubscriptionStatePort) => new RetentionService(deps(s)),
          inject,
        },
        {
          provide: ExpenseCategoryService,
          useFactory: (s: SubscriptionStatePort) => new ExpenseCategoryService(deps(s)),
          inject,
        },
      ],
      exports: [
        GuestRegistryService,
        FinancialDashboardService,
        ReportExportService,
        RetentionService,
        ExpenseCategoryService,
        REPORTING_POOL,
        REPORTING_STORAGE,
      ],
    };
  }
}
