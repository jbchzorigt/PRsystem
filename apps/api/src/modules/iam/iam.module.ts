import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { KeyManagementPort } from '@prsystem/ports';
import { selectKeyManagement } from '@prsystem/ports';
import { AuthController } from './http/auth.controller';
import { StaffController } from './http/staff.controller';
import { SessionGuard } from './http/session.guard';
import { SessionService } from './services/session.service';
import { StaffService } from './services/staff.service';
import { HandoffService } from './services/handoff.service';
import type { IamDependencies } from './services/iam-context';
import type { SubscriptionStatePort } from './contracts/subscription-state.port';
import { selectSubscriptionState } from './contracts/subscription-state.port';
import type { AuthSecurityParameters } from './contracts/security-parameters';
import type { StaffNotificationPort } from './contracts/staff-notification.port';
import { selectStaffNotification } from './contracts/staff-notification.port';
import type { OpenWorkPort } from './contracts/open-work.port';
import { selectOpenWork } from './contracts/open-work.port';
import type { RestaurantDirectoryPort } from './contracts/restaurant-directory.port';
import { selectRestaurantDirectory } from './contracts/restaurant-directory.port';
import { AUTH_SECURITY_PARAMETERS } from './contracts/security-parameters';
import { IamGuestAccounts } from './contracts/guest-accounts.port';
import {
  AUTH_PARAMETERS,
  GUEST_ACCOUNTS,
  IAM_POOL,
  KEY_MANAGEMENT,
  OPEN_WORK,
  RESTAURANT_DIRECTORY,
  STAFF_NOTIFICATION,
  SUBSCRIPTION_STATE,
} from './iam.tokens';

/**
 * IAM, tenancy, RBAC and the staff lifecycle (Phase 04).
 *
 * The two external systems this module needs — the subscription state contract
 * and staff email delivery — arrive as ports. Outside local, CI and test both
 * resolve to implementations that refuse, so the module fails closed rather than
 * assuming a hotel is entitled or that a link was delivered (CLAUDE.md §9).
 */
export interface IamModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
}

export interface IamModuleOptions {
  /**
   * The configuration this module runs on.
   *
   * Injected, never read from `process.env` here: a module that reads the
   * ambient environment can acquire a credential nobody asked it to hold, which
   * is exactly what the scheduler capability is constructed to prevent.
   * Optional only when every port is supplied instead.
   */
  readonly config?: IamModuleConfig;
  /** Overrides for tests, which supply deterministic simulators. */
  readonly pool?: Pool;
  readonly keys?: KeyManagementPort;
  readonly subscription?: SubscriptionStatePort;
  readonly notifications?: StaffNotificationPort;
  readonly openWork?: OpenWorkPort;
  readonly restaurants?: RestaurantDirectoryPort;
  readonly parameters?: AuthSecurityParameters;
}

/** The configuration must be present whenever a port has to be constructed. */
function requiredConfig(config: IamModuleConfig | undefined): IamModuleConfig {
  if (config === undefined) {
    throw new Error('IamModule needs either a configuration or every port supplied');
  }
  return config;
}

/**
 * Closes the module's own connection pool on shutdown.
 *
 * Without it a `useValue` pool outlives the application: nothing in the
 * container owns it, so a shut-down process keeps idle backends open and a
 * dropped database reports them as unexpected client errors.
 */
class IamPoolLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class IamModule {
  static forRoot(options: IamModuleOptions = {}): DynamicModule {
    const config = options.config;
    const pool =
      options.pool ?? new Pool({ connectionString: requiredConfig(config).databaseUrl, max: 10 });
    const keys =
      options.keys ??
      selectKeyManagement({
        appEnv: requiredConfig(config).appEnv,
        kmsAdapter: requiredConfig(config).kmsAdapter,
        ...(requiredConfig(config).kmsSeed === undefined
          ? {}
          : { seed: requiredConfig(config).kmsSeed as string }),
      });
    const subscription =
      options.subscription ?? selectSubscriptionState(requiredConfig(config).appEnv);
    const notifications =
      options.notifications ?? selectStaffNotification(requiredConfig(config).appEnv);
    const openWork = options.openWork ?? selectOpenWork(requiredConfig(config).appEnv);
    const restaurants =
      options.restaurants ?? selectRestaurantDirectory(requiredConfig(config).appEnv);
    const deps: IamDependencies = {
      pool,
      keys,
      subscription,
      notifications,
      openWork,
      restaurants,
      parameters: options.parameters ?? AUTH_SECURITY_PARAMETERS,
    };
    // The module ends only a pool it created. A pool a test supplied belongs to
    // the test, and ending it here would close it out from under the caller.
    const ownsPool = options.pool === undefined;

    return {
      module: IamModule,
      controllers: [AuthController, StaffController],
      providers: [
        { provide: IAM_POOL, useValue: pool },
        {
          provide: IamPoolLifecycle,
          useValue: new IamPoolLifecycle(pool, ownsPool),
        },
        { provide: KEY_MANAGEMENT, useValue: keys },
        { provide: SUBSCRIPTION_STATE, useValue: subscription },
        { provide: STAFF_NOTIFICATION, useValue: notifications },
        { provide: AUTH_PARAMETERS, useValue: deps.parameters },
        // The Guest realm's door into the account kernel. Constructed here,
        // where the keys and the parameter set live, and consumed by the guest
        // module through the contract (CLAUDE.md §3).
        {
          provide: GUEST_ACCOUNTS,
          useValue: new IamGuestAccounts(keys, deps.parameters ?? AUTH_SECURITY_PARAMETERS),
        },
        { provide: OPEN_WORK, useValue: openWork },
        { provide: RESTAURANT_DIRECTORY, useValue: restaurants },
        { provide: SessionService, useValue: new SessionService(deps) },
        { provide: StaffService, useValue: new StaffService(deps) },
        { provide: HandoffService, useValue: new HandoffService(deps) },
        SessionGuard,
      ],
      exports: [
        SessionService,
        StaffService,
        HandoffService,
        SUBSCRIPTION_STATE,
        STAFF_NOTIFICATION,
        AUTH_PARAMETERS,
        GUEST_ACCOUNTS,
        OPEN_WORK,
        RESTAURANT_DIRECTORY,
      ],
    };
  }
}
