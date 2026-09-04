import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { ShiftLookupPort } from '../stay/contracts/shift-lookup';
import { RepositoryShiftLookup } from '../stay/contracts/shift-lookup';
import { CashController } from './http/cash.controller';
import { ExpenseController } from './http/expense.controller';
import { CashService } from './services/cash.service';
import { CashRequestService } from './services/request.service';
import { ExpenseService } from './services/expense.service';
import type { FinanceDependencies } from './services/finance-context';
import { FINANCE_CLOCK, FINANCE_POOL } from './finance.tokens';

/**
 * Shift cash, the drawer ledger, transfers, approvals and expenses (Phase 11).
 *
 * It owns the money that is physically in the hotel. What it does not own it
 * reaches through contracts: which shift is accountable for a drawer belongs to
 * the stay module (`ShiftLookupPort`), and the guest payments it mirrors belong
 * to the billing module, which calls *into* this one through
 * `CashPostingsPort`. Nothing here reads another module's tables.
 */
export interface FinanceModuleConfig {
  readonly databaseUrl: string;
}

export interface FinanceModuleOptions {
  readonly config?: FinanceModuleConfig;
  readonly iam?: DynamicModule;
  readonly stay?: DynamicModule;
  readonly pool?: Pool;
  readonly shifts?: ShiftLookupPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class FinanceLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class FinanceModule {
  static forRoot(options: FinanceModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('FinanceModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const clock = options.clock;
    const shifts = options.shifts ?? new RepositoryShiftLookup();
    const deps = (subscription: SubscriptionStatePort): FinanceDependencies => ({
      pool,
      subscription,
      shifts,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];
    const service = <T>(make: (deps: FinanceDependencies) => T) => {
      return (subscription: SubscriptionStatePort) => make(deps(subscription));
    };

    return {
      module: FinanceModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.stay === undefined ? [] : [options.stay]),
      ],
      controllers: [CashController, ExpenseController],
      providers: [
        { provide: FINANCE_POOL, useValue: pool },
        { provide: FINANCE_CLOCK, useValue: clock ?? null },
        { provide: FinanceLifecycle, useValue: new FinanceLifecycle(pool, ownsPool) },
        { provide: CashService, useFactory: service((d) => new CashService(d)), inject },
        {
          provide: CashRequestService,
          useFactory: service((d) => new CashRequestService(d)),
          inject,
        },
        { provide: ExpenseService, useFactory: service((d) => new ExpenseService(d)), inject },
      ],
      exports: [CashService, CashRequestService, ExpenseService, FINANCE_POOL],
    };
  }
}
