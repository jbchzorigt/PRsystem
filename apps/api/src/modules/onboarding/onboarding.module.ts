import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type {
  EBarimtPort,
  KeyManagementPort,
  PaymentGateways,
  PhoneVerificationPort,
  StaffNotificationPort,
} from '@prsystem/ports';
import {
  selectEBarimt,
  selectKeyManagement,
  selectPaymentGateways,
  selectPhoneVerification,
  selectStaffNotification,
} from '@prsystem/ports';
import type { OnboardingParameters } from './contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from './contracts/onboarding-parameters';
import type { ProvisioningSignalPort } from './contracts/provisioning-signal';
import { NoProvisioningSignal } from './contracts/provisioning-signal';
import { BullMqProvisioningSignal } from './contracts/bullmq-provisioning-signal';
import type { OnboardingDependencies } from './services/onboarding-context';
import { OnboardingService } from './services/onboarding.service';
import { ProvisioningService } from './services/provisioning.service';
import { ActivationService } from './services/activation.service';
import { SubscriptionService } from './services/subscription.service';
import { EBarimtService } from './services/ebarimt.service';
import { OnboardingController } from './http/onboarding.controller';
import { SubscriptionController } from './http/subscription.controller';
import { OperationController } from './http/operation.controller';
import {
  EBARIMT,
  ONBOARDING_PARAMS,
  ONBOARDING_POOL,
  PAYMENT_GATEWAYS,
  PHONE_VERIFICATION,
  PROVISIONING_SIGNAL,
} from './onboarding.tokens';

/**
 * Hotel onboarding and subscription (Phase 05).
 *
 * Four external systems arrive as ports — the two payment gateways, eBarimt and
 * phone OTP — and outside local, CI and test every one of them resolves to an
 * implementation that answers `DISABLED`. `EXT-03`, `EXT-04`, `EXT-11` and
 * `INT-OTP-01` are all closed, so the module fails closed rather than assuming
 * a payment succeeded, a receipt exists or a phone was verified (CLAUDE.md §9).
 *
 * Email delivery is **not** a new port: the Phase 04 `StaffNotificationPort` and
 * its `INT-MAIL-01` blocker cover it, and the eBarimt receipt is one more
 * template on it.
 *
 * The provisioning signal is the one Redis-backed dependency. It is best-effort
 * by contract — PostgreSQL is the job record — so a module constructed without
 * a Redis URL simply has no signal, and the worker's sweep is the only trigger.
 */
export interface OnboardingModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
  readonly redisUrl?: string;
  readonly queuePrefix?: string;
}

export interface OnboardingModuleOptions {
  readonly config?: OnboardingModuleConfig;
  /**
   * The already-constructed IAM module.
   *
   * The subscription and Operation routes are guarded by the Phase 04
   * `SessionGuard`, and a guard is instantiated in the module that hosts the
   * controller — so `SessionService` has to be resolvable from here. It is
   * imported rather than rebuilt: a second `SessionService` would be a second
   * session model reading the same rows. `AppModule` passes the same
   * dynamic-module object it imports itself, so the container resolves one
   * instance, not two.
   */
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly keys?: KeyManagementPort;
  readonly gateways?: PaymentGateways;
  readonly ebarimt?: EBarimtPort;
  readonly phone?: PhoneVerificationPort;
  readonly notifications?: StaffNotificationPort;
  readonly signals?: ProvisioningSignalPort;
  readonly parameters?: OnboardingParameters;
}

function requiredConfig(config: OnboardingModuleConfig | undefined): OnboardingModuleConfig {
  if (config === undefined) {
    throw new Error('OnboardingModule needs either a configuration or every port supplied');
  }
  return config;
}

/** Closes the module's own pool and signal on shutdown, exactly as the IAM module does. */
class OnboardingLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
    private readonly signals: ProvisioningSignalPort,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.signals.close().catch(() => undefined);
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

function signalFrom(config: OnboardingModuleConfig | undefined): ProvisioningSignalPort {
  if (config?.redisUrl === undefined) return new NoProvisioningSignal();
  const parsed = new URL(config.redisUrl);
  return new BullMqProvisioningSignal({
    connection: {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      ...(parsed.username ? { username: parsed.username } : {}),
      ...(parsed.password ? { password: parsed.password } : {}),
    },
    ...(config.queuePrefix === undefined ? {} : { prefix: config.queuePrefix }),
  });
}

@Module({})
export class OnboardingModule {
  static forRoot(options: OnboardingModuleOptions = {}): DynamicModule {
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
    const gateways = options.gateways ?? selectPaymentGateways(requiredConfig(config).appEnv);
    const ebarimt = options.ebarimt ?? selectEBarimt(requiredConfig(config).appEnv);
    const phone = options.phone ?? selectPhoneVerification(requiredConfig(config).appEnv);
    const notifications =
      options.notifications ?? selectStaffNotification(requiredConfig(config).appEnv);
    const signals = options.signals ?? signalFrom(config);
    const parameters = options.parameters ?? ONBOARDING_PARAMETERS;

    const deps: OnboardingDependencies = {
      pool,
      keys,
      gateways,
      ebarimt,
      phone,
      notifications,
      signals,
      parameters,
    };
    const ownsPool = options.pool === undefined;

    return {
      module: OnboardingModule,
      imports: options.iam === undefined ? [] : [options.iam],
      controllers: [OnboardingController, SubscriptionController, OperationController],
      providers: [
        { provide: ONBOARDING_POOL, useValue: pool },
        {
          provide: OnboardingLifecycle,
          useValue: new OnboardingLifecycle(pool, ownsPool, signals),
        },
        { provide: PAYMENT_GATEWAYS, useValue: gateways },
        { provide: EBARIMT, useValue: ebarimt },
        { provide: PHONE_VERIFICATION, useValue: phone },
        { provide: PROVISIONING_SIGNAL, useValue: signals },
        { provide: ONBOARDING_PARAMS, useValue: parameters },
        { provide: OnboardingService, useValue: new OnboardingService(deps) },
        { provide: ProvisioningService, useValue: new ProvisioningService(deps) },
        { provide: ActivationService, useValue: new ActivationService(deps) },
        { provide: SubscriptionService, useValue: new SubscriptionService(deps) },
        { provide: EBarimtService, useValue: new EBarimtService(deps) },
      ],
      exports: [
        OnboardingService,
        ProvisioningService,
        ActivationService,
        SubscriptionService,
        EBarimtService,
        PAYMENT_GATEWAYS,
        EBARIMT,
        PHONE_VERIFICATION,
        PROVISIONING_SIGNAL,
        ONBOARDING_PARAMS,
      ],
    };
  }
}
