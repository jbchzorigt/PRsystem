import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { PaymentGateways } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import { MinibarReportService } from '../stay/services/report.service';
import { StayService } from '../stay/services/stay.service';
import { BillingController } from './http/billing.controller';
import { ReconciliationController } from './http/reconciliation.controller';
import { DepositService } from './services/deposit.service';
import { FinancialCorrectionService } from './services/correction.service';
import { FolioService } from './services/folio.service';
import { RefundService } from './services/refund.service';
import { ReconciliationService } from './services/reconciliation.service';
import type { BillingDependencies } from './services/billing-context';
import { BILLING_CLOCK, BILLING_GATEWAY, BILLING_POOL } from './billing.tokens';

/**
 * Folio, deposit, payment, and correction (Phase 10).
 *
 * Its in-process dependencies are contracts of earlier phases: the stay's own
 * billing facts (Phase 08) and the settled minibar charge (Phase 09). Its
 * external one is the payment gateway port, whose production adapters stay
 * disabled outside local, CI and test — a QPay or card movement is confirmed
 * against the provider before it is recorded (doc 20 §2).
 *
 * `BillingDeposits` is exported so the stay module's check-in can open the
 * folio and the deposit aggregate in the confirmation's own transaction; it
 * takes nothing from this module at construction, so the two modules stay
 * one-way (CLAUDE.md §3).
 */
export interface BillingModuleConfig {
  readonly databaseUrl: string;
}

import type { CashPostingsPort } from './contracts/cash-postings';
import { UnprovisionedCashPostings } from './contracts/cash-postings';

export interface BillingModuleOptions {
  readonly config?: BillingModuleConfig;
  readonly iam?: DynamicModule;
  readonly stay?: DynamicModule;
  readonly pool?: Pool;
  readonly gateways: PaymentGateways;
  /** The drawer side of a cash transaction (Phase 11); unprovisioned by default. */
  readonly cash?: CashPostingsPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class BillingLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class BillingModule {
  static forRoot(options: BillingModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('BillingModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const clock = options.clock;
    const cash = options.cash ?? new UnprovisionedCashPostings();
    const deps = (
      subscription: SubscriptionStatePort,
      stays: StayService,
      reports: MinibarReportService,
    ): BillingDependencies => ({
      pool,
      subscription,
      stays,
      reports,
      gateways: options.gateways,
      cash,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE, StayService, MinibarReportService];
    const service = <T>(make: (deps: BillingDependencies) => T) => {
      return (
        subscription: SubscriptionStatePort,
        stays: StayService,
        reports: MinibarReportService,
      ) => make(deps(subscription, stays, reports));
    };

    return {
      module: BillingModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.stay === undefined ? [] : [options.stay]),
      ],
      controllers: [BillingController, ReconciliationController],
      providers: [
        { provide: BILLING_POOL, useValue: pool },
        { provide: BILLING_GATEWAY, useValue: options.gateways },
        { provide: BILLING_CLOCK, useValue: clock ?? null },
        { provide: BillingLifecycle, useValue: new BillingLifecycle(pool, ownsPool) },
        { provide: FolioService, useFactory: service((d) => new FolioService(d)), inject },
        { provide: DepositService, useFactory: service((d) => new DepositService(d)), inject },
        { provide: RefundService, useFactory: service((d) => new RefundService(d)), inject },
        {
          provide: FinancialCorrectionService,
          useFactory: service((d) => new FinancialCorrectionService(d)),
          inject,
        },
        {
          provide: ReconciliationService,
          useFactory: service((d) => new ReconciliationService(d)),
          inject,
        },
      ],
      exports: [
        FolioService,
        DepositService,
        RefundService,
        FinancialCorrectionService,
        ReconciliationService,
        BILLING_POOL,
        BILLING_GATEWAY,
      ],
    };
  }
}
