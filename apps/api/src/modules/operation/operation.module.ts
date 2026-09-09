import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { KeyManagementPort, SmsPort, StaffNotificationPort } from '@prsystem/ports';
import { selectSms, selectStaffNotification } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { OperationAccountPort } from './contracts/operation-accounts';
import { UnprovisionedOperationAccounts } from './contracts/operation-accounts';
import type { OperationParameters } from './contracts/operation-parameters';
import type { OperationDependencies } from './services/operation-context';
import { OperationAuthService } from './services/auth.service';
import { OperationAccessService } from './services/access.service';
import { OperationDashboardService } from './services/dashboard.service';
import { OperationSubscriptionService } from './services/subscription.service';
import { OperationRecoveryService } from './services/recovery.service';
import { SubscriptionContactService } from './services/contact.service';
import { OperationSmsService } from './services/sms.service';
import {
  PlatformOperationController,
  SubscriptionContactController,
} from './http/operation.controller';
import { OPERATION_ACCOUNTS, OPERATION_POOL, OPERATION_SMS } from './operation.tokens';

/**
 * Platform Operation (Phase 19).
 *
 * The module owns eleven tables and no business facts: what it reports on
 * belongs to onboarding and to IAM, and reaches it through resolvers that mask
 * before they answer. The account kernel reaches it through a port, so a
 * deployment that did not wire one creates no Operation account rather than
 * creating one through a second path.
 *
 * The SMS provider is a registered production gate (`EXT-05`). Its production
 * adapter answers `DISABLED` and sends nothing; local, CI and test run the
 * deterministic simulator. That is why a Phase 19 deployment in production has
 * a working dashboard, a working suspension and no reminders — which is the
 * correct shape for an uncontracted provider.
 */
export interface OperationModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
}

export interface OperationModuleOptions {
  readonly config?: OperationModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly accounts?: OperationAccountPort;
  /**
   * Required, never defaulted. A module that selected its own key port from an
   * environment string could acquire the simulator by omission; every
   * construction site states its answer instead (the Phase 18 rule).
   */
  readonly keys: KeyManagementPort;
  readonly sms?: SmsPort;
  readonly notifications?: StaffNotificationPort;
  readonly parameters?: OperationParameters;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class OperationLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class OperationModule {
  static forRoot(options: OperationModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('OperationModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const appEnv = options.config?.appEnv ?? 'production';
    const keys = options.keys;
    const sms = options.sms ?? selectSms(appEnv);
    const notifications = options.notifications ?? selectStaffNotification(appEnv);
    const accounts = options.accounts ?? new UnprovisionedOperationAccounts();
    const parameters = options.parameters;
    const clock = options.clock;

    const deps = (subscription: SubscriptionStatePort): OperationDependencies => ({
      pool,
      accounts,
      subscription,
      keys,
      sms,
      notifications,
      ...(parameters === undefined ? {} : { parameters }),
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];

    return {
      module: OperationModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [PlatformOperationController, SubscriptionContactController],
      providers: [
        { provide: OPERATION_POOL, useValue: pool },
        { provide: OPERATION_SMS, useValue: sms },
        { provide: OPERATION_ACCOUNTS, useValue: accounts },
        { provide: OperationLifecycle, useValue: new OperationLifecycle(pool, ownsPool) },
        {
          provide: OperationAuthService,
          useFactory: (s: SubscriptionStatePort) => new OperationAuthService(deps(s)),
          inject,
        },
        {
          provide: OperationAccessService,
          useFactory: (s: SubscriptionStatePort) => new OperationAccessService(deps(s)),
          inject,
        },
        {
          provide: OperationDashboardService,
          useFactory: (s: SubscriptionStatePort) => new OperationDashboardService(deps(s)),
          inject,
        },
        {
          provide: OperationSubscriptionService,
          useFactory: (s: SubscriptionStatePort) => new OperationSubscriptionService(deps(s)),
          inject,
        },
        {
          provide: OperationRecoveryService,
          useFactory: (s: SubscriptionStatePort) => new OperationRecoveryService(deps(s)),
          inject,
        },
        {
          provide: SubscriptionContactService,
          useFactory: (s: SubscriptionStatePort) => new SubscriptionContactService(deps(s)),
          inject,
        },
        {
          provide: OperationSmsService,
          useFactory: (s: SubscriptionStatePort) => new OperationSmsService(deps(s)),
          inject,
        },
      ],
      exports: [
        OperationAuthService,
        OperationAccessService,
        OperationDashboardService,
        OperationSubscriptionService,
        OperationRecoveryService,
        SubscriptionContactService,
        OperationSmsService,
        OPERATION_POOL,
        OPERATION_SMS,
        OPERATION_ACCOUNTS,
      ],
    };
  }
}
