import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type {
  KeyManagementPort,
  ObjectStoragePort,
  SmsPort,
  XypIdentityPort,
} from '@prsystem/ports';
import { selectObjectStorage, selectSms, selectXypIdentity } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import { RepositoryPoliceAccounts } from '../iam/contracts/police-accounts';
import type { PoliceAccountPort } from './contracts/police-accounts';
import type { PoliceDependencies } from './services/police-context';
import { WantedPersonService } from './services/wanted.service';
import { WantedCaseService } from './services/case.service';
import { MatchService } from './services/match.service';
import { AlertService } from './services/alert.service';
import { CheckInListService } from './services/checkin.service';
import { PoliceDashboardService } from './services/dashboard.service';
import { PoliceAccountService } from './services/account.service';
import { WantedExportService } from './services/export.service';
import { PoliceController } from './http/police.controller';
import { POLICE_POOL, POLICE_SMS, POLICE_STORAGE, POLICE_XYP } from './police.tokens';

/**
 * Police monitoring (Phase 18), as a module that either exists or does not.
 *
 * **It has its own database login.** Every service here runs as
 * `prsystem_police`, which holds no privilege on a stay, a folio or a booking —
 * so doc 13 §3's separation is a property of the connection rather than of the
 * code that uses it. A deployment that has no Police credential has no Police
 * module, exactly as a deployment with no scheduler credential has no
 * scheduler: the capability is the credential, and the absence of one is not a
 * silently degraded version of the feature.
 *
 * **Two of its ports are blocked gates.** SMS is `EXT-05` and ХУР is `EXT-01`;
 * both answer `DISABLED` in production and run deterministic simulators
 * everywhere else. An alert that cannot be sent is recorded as undelivered, and
 * an identity ХУР cannot answer falls to manual entry and a second officer's
 * approval — neither is invented.
 */
export interface PoliceModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
}

export interface PoliceModuleOptions {
  readonly config?: PoliceModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly keys: KeyManagementPort;
  readonly accounts?: PoliceAccountPort;
  readonly sms?: SmsPort;
  readonly xyp?: XypIdentityPort;
  readonly storage?: ObjectStoragePort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class PoliceLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class PoliceModule {
  static forRoot(options: PoliceModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('PoliceModule needs either a configuration or a pool');
          })(),
        max: 6,
        application_name: 'prsystem_api_police',
      });
    const ownsPool = options.pool === undefined;
    const appEnv = options.config?.appEnv ?? 'production';
    const sms = options.sms ?? selectSms(appEnv);
    const xyp = options.xyp ?? selectXypIdentity(appEnv);
    const storage = options.storage ?? selectObjectStorage(appEnv);
    const accounts = options.accounts ?? new RepositoryPoliceAccounts();
    const clock = options.clock;

    const deps = (subscription: SubscriptionStatePort): PoliceDependencies => ({
      pool,
      subscription,
      keys: options.keys,
      sms,
      xyp,
      storage,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];

    return {
      module: PoliceModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [PoliceController],
      providers: [
        { provide: POLICE_POOL, useValue: pool },
        { provide: POLICE_SMS, useValue: sms },
        { provide: POLICE_XYP, useValue: xyp },
        { provide: POLICE_STORAGE, useValue: storage },
        { provide: PoliceLifecycle, useValue: new PoliceLifecycle(pool, ownsPool) },
        {
          provide: WantedPersonService,
          useFactory: (s: SubscriptionStatePort) => new WantedPersonService(deps(s)),
          inject,
        },
        {
          provide: WantedCaseService,
          useFactory: (s: SubscriptionStatePort) => new WantedCaseService(deps(s)),
          inject,
        },
        {
          provide: MatchService,
          useFactory: (s: SubscriptionStatePort) => new MatchService(deps(s)),
          inject,
        },
        {
          provide: AlertService,
          useFactory: (s: SubscriptionStatePort) => new AlertService(deps(s)),
          inject,
        },
        {
          provide: CheckInListService,
          useFactory: (s: SubscriptionStatePort) => new CheckInListService(deps(s)),
          inject,
        },
        {
          provide: PoliceDashboardService,
          useFactory: (s: SubscriptionStatePort) => new PoliceDashboardService(deps(s)),
          inject,
        },
        {
          provide: PoliceAccountService,
          useFactory: (s: SubscriptionStatePort) => new PoliceAccountService(deps(s), accounts),
          inject,
        },
        {
          provide: WantedExportService,
          useFactory: (s: SubscriptionStatePort) => new WantedExportService(deps(s)),
          inject,
        },
      ],
      exports: [
        WantedPersonService,
        WantedCaseService,
        MatchService,
        AlertService,
        CheckInListService,
        PoliceDashboardService,
        PoliceAccountService,
        WantedExportService,
        POLICE_POOL,
        POLICE_SMS,
      ],
    };
  }
}
