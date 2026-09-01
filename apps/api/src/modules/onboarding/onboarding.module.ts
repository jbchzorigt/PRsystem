import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { KeyManagementPort } from '@prsystem/ports';
import { selectKeyManagement } from '@prsystem/ports';
import type { StaffNotificationPort } from '../iam/contracts/staff-notification.port';
import { selectStaffNotification } from '../iam/contracts/staff-notification.port';
import type { OnboardingParameters } from './contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from './contracts/onboarding-parameters';
import type { PaymentGateways } from './contracts/payment-gateway.port';
import { selectPaymentGateways } from './contracts/payment-gateway.port';
import type { EBarimtPort } from './contracts/ebarimt.port';
import { selectEBarimt } from './contracts/ebarimt.port';
import type { PhoneVerificationPort } from './contracts/phone-verification.port';
import { selectPhoneVerification } from './contracts/phone-verification.port';
import type { OnboardingDependencies } from './services/onboarding-context';
import { OnboardingService } from './services/onboarding.service';
import { ProvisioningService } from './services/provisioning.service';
import { ActivationService } from './services/activation.service';
import { SubscriptionService } from './services/subscription.service';
import { EBarimtService } from './services/ebarimt.service';
import { OnboardingController } from './http/onboarding.controller';
import { SubscriptionController } from './http/subscription.controller';
import {
  EBARIMT,
  ONBOARDING_PARAMS,
  ONBOARDING_POOL,
  PAYMENT_GATEWAYS,
  PHONE_VERIFICATION,
} from './onboarding.tokens';

/**
 * Hotel onboarding and subscription (Phase 05).
 *
 * Four external systems arrive as ports — the two payment gateways, eBarimt and
 * phone OTP — and outside local, CI and test every one of them resolves to an
 * implementation that refuses. `EXT-03`, `EXT-04`, `EXT-11` and `INT-OTP-01` are
 * all closed, so the module fails closed rather than assuming a payment
 * succeeded, a receipt exists or a phone was verified (CLAUDE.md §9).
 *
 * Email delivery is **not** a new port: the Phase 04 `StaffNotificationPort` and
 * its `INT-MAIL-01` blocker cover it, and a second one would be a second thing
 * to keep closed.
 */
export interface OnboardingModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
}

export interface OnboardingModuleOptions {
  readonly config?: OnboardingModuleConfig;
  /**
   * The already-constructed IAM module.
   *
   * The subscription routes are guarded by the Phase 04 `SessionGuard`, and a
   * guard is instantiated in the module that hosts the controller — so
   * `SessionService` has to be resolvable from here. It is imported rather than
   * rebuilt: a second `SessionService` would be a second session model reading
   * the same rows, which `LIFE`/Phase 04 explicitly forbid. `AppModule` passes
   * the same dynamic-module object it imports itself, so the container resolves
   * one instance, not two.
   */
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly keys?: KeyManagementPort;
  readonly gateways?: PaymentGateways;
  readonly ebarimt?: EBarimtPort;
  readonly phone?: PhoneVerificationPort;
  readonly notifications?: StaffNotificationPort;
  readonly parameters?: OnboardingParameters;
}

function requiredConfig(config: OnboardingModuleConfig | undefined): OnboardingModuleConfig {
  if (config === undefined) {
    throw new Error('OnboardingModule needs either a configuration or every port supplied');
  }
  return config;
}

/** Closes the module's own pool on shutdown, exactly as the IAM module does. */
class OnboardingPoolLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
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
    const parameters = options.parameters ?? ONBOARDING_PARAMETERS;

    const deps: OnboardingDependencies = {
      pool,
      keys,
      gateways,
      ebarimt,
      phone,
      notifications,
      parameters,
    };
    const ownsPool = options.pool === undefined;

    return {
      module: OnboardingModule,
      imports: options.iam === undefined ? [] : [options.iam],
      controllers: [OnboardingController, SubscriptionController],
      providers: [
        { provide: ONBOARDING_POOL, useValue: pool },
        { provide: OnboardingPoolLifecycle, useValue: new OnboardingPoolLifecycle(pool, ownsPool) },
        { provide: PAYMENT_GATEWAYS, useValue: gateways },
        { provide: EBARIMT, useValue: ebarimt },
        { provide: PHONE_VERIFICATION, useValue: phone },
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
        ONBOARDING_PARAMS,
      ],
    };
  }
}
