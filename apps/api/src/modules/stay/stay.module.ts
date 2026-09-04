import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { KeyManagementPort, XypIdentityPort } from '@prsystem/ports';
import { selectKeyManagement, selectXypIdentity } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import { LifecycleService } from '../catalog/services/lifecycle.service';
import { TariffService } from '../catalog/services/tariff.service';
import { ConfigurationService } from '../minibar/services/configuration.service';
import type { ConfirmedBookingsPort } from './contracts/confirmed-bookings';
import { UnprovisionedConfirmedBookings } from './contracts/confirmed-bookings';
import { ConflictController } from './http/conflict.controller';
import { CorrectionController } from './http/correction.controller';
import { HousekeepingController } from './http/housekeeping.controller';
import { ShiftController } from './http/shift.controller';
import { StayController } from './http/stay.controller';
import { CheckInService } from './services/check-in.service';
import { ConflictService } from './services/conflict.service';
import { CorrectionService } from './services/correction.service';
import { HousekeepingService } from './services/housekeeping.service';
import { ShiftService } from './services/shift.service';
import type { StayDependencies } from './services/stay-context';
import { StayService } from './services/stay.service';
import { CONFIRMED_BOOKINGS, STAY_CLOCK, STAY_POOL, XYP_IDENTITY } from './stay.tokens';

/**
 * Availability, guest identity, reception, and stay (Phase 08).
 *
 * In-process dependencies are the earlier phases' contracts, resolved from
 * the modules that own them: the subscription-state port (IAM), the tariff
 * snapshot and the lifecycle hand-off (catalog), the check-in pin, override
 * consumption and scheduled-change advance (minibar). External ones are
 * ports: XYP identity (EXT-01, disabled outside local/CI/test) and key
 * management for the guest's identifier. Confirmed bookings arrive through a
 * contract Phase 13 will implement; until then the default answers from the
 * absence of the relation and refuses once it exists.
 *
 * `ConflictService.detect`, `StayService.recordActualCheckout` and
 * `CheckInService` are exported for Phases 09, 10 and 13.
 */
export interface StayModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
}

export interface StayModuleOptions {
  readonly config?: StayModuleConfig;
  readonly iam?: DynamicModule;
  readonly catalog?: DynamicModule;
  readonly minibar?: DynamicModule;
  readonly pool?: Pool;
  readonly keys?: KeyManagementPort;
  readonly xyp?: XypIdentityPort;
  readonly bookings?: ConfirmedBookingsPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

function requiredConfig(config: StayModuleConfig | undefined): StayModuleConfig {
  if (config === undefined) {
    throw new Error('StayModule needs either a configuration or every port supplied');
  }
  return config;
}

class StayLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class StayModule {
  static forRoot(options: StayModuleOptions = {}): DynamicModule {
    const pool =
      options.pool ??
      new Pool({ connectionString: requiredConfig(options.config).databaseUrl, max: 10 });
    const ownsPool = options.pool === undefined;
    const keys =
      options.keys ??
      selectKeyManagement({
        appEnv: requiredConfig(options.config).appEnv,
        kmsAdapter: requiredConfig(options.config).kmsAdapter,
        ...(requiredConfig(options.config).kmsSeed === undefined
          ? {}
          : { seed: requiredConfig(options.config).kmsSeed as string }),
      });
    const xyp = options.xyp ?? selectXypIdentity(requiredConfig(options.config).appEnv);
    const bookings = options.bookings ?? new UnprovisionedConfirmedBookings();
    const clock = options.clock;
    const deps = (
      subscription: SubscriptionStatePort,
      tariffs: TariffService,
      lifecycle: LifecycleService,
      minibar: ConfigurationService,
    ): StayDependencies => ({
      pool,
      subscription,
      tariffs,
      minibar,
      lifecycle,
      keys,
      xyp,
      bookings,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE, TariffService, LifecycleService, ConfigurationService];
    const service = <T>(
      make: (deps: StayDependencies) => T,
    ): ((
      subscription: SubscriptionStatePort,
      tariffs: TariffService,
      lifecycle: LifecycleService,
      minibar: ConfigurationService,
    ) => T) => {
      return (subscription, tariffs, lifecycle, minibar) =>
        make(deps(subscription, tariffs, lifecycle, minibar));
    };

    return {
      module: StayModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.catalog === undefined ? [] : [options.catalog]),
        ...(options.minibar === undefined ? [] : [options.minibar]),
      ],
      controllers: [
        ShiftController,
        HousekeepingController,
        StayController,
        CorrectionController,
        ConflictController,
      ],
      providers: [
        { provide: STAY_POOL, useValue: pool },
        { provide: XYP_IDENTITY, useValue: xyp },
        { provide: CONFIRMED_BOOKINGS, useValue: bookings },
        { provide: STAY_CLOCK, useValue: clock ?? null },
        { provide: StayLifecycle, useValue: new StayLifecycle(pool, ownsPool) },
        { provide: ShiftService, useFactory: service((d) => new ShiftService(d)), inject },
        {
          provide: HousekeepingService,
          useFactory: service((d) => new HousekeepingService(d)),
          inject,
        },
        { provide: CheckInService, useFactory: service((d) => new CheckInService(d)), inject },
        { provide: StayService, useFactory: service((d) => new StayService(d)), inject },
        {
          provide: CorrectionService,
          useFactory: service((d) => new CorrectionService(d)),
          inject,
        },
        { provide: ConflictService, useFactory: service((d) => new ConflictService(d)), inject },
      ],
      exports: [
        ShiftService,
        HousekeepingService,
        CheckInService,
        StayService,
        CorrectionService,
        ConflictService,
        STAY_POOL,
        XYP_IDENTITY,
        CONFIRMED_BOOKINGS,
      ],
    };
  }
}
