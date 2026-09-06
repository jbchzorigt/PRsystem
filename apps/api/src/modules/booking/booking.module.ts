import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { PaymentGateways } from '@prsystem/ports';
import { selectPaymentGateways } from '@prsystem/ports';
import { TariffService } from '../catalog/services/tariff.service';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { SettlementPort } from './contracts/settlement';
import { UnprovisionedSettlement } from './contracts/settlement';
import { BookingController } from './http/booking.controller';
import { BookingOperationsController } from './http/booking-operations.controller';
import { PaymentCallbackController } from './http/payment-callback.controller';
import { BookingService } from './services/booking.service';
import { BookingExpiryService } from './services/expiry.service';
import type { BookingDependencies } from './services/booking-context';
import { BOOKING_PAYMENTS, BOOKING_POOL } from './booking.tokens';

/**
 * Online booking and the inventory hold (Phase 13).
 *
 * It owns the booking, its nights, the per-night inventory, the payment attempt
 * and the booking's history. What it does not own it reaches through contracts:
 * the price belongs to the catalog module (`TariffService.captureRateSnapshot`,
 * the same call a walk-in check-in makes), and the stay and public modules
 * reach *into* this one for the two questions they cannot answer themselves.
 *
 * Phase 14 adds the money: an invoice opened through the gateway adapter, a
 * callback verified server-side before any transition, and the commission,
 * refund and payout the settlement module owns and this one reaches through a
 * contract. doc 18 §3.3's two staff actions — a confirmed no-show and a hotel
 * cancellation — run through the Phase 04 authorization pipeline, which is why
 * this module now holds the subscription-state port.
 */
export interface BookingModuleConfig {
  readonly databaseUrl: string;
  /** Chooses the simulators or the fail-closed adapters (ADR-0020 §7). */
  readonly appEnv: string;
}

export interface BookingModuleOptions {
  readonly config?: BookingModuleConfig;
  readonly iam?: DynamicModule;
  readonly catalog?: DynamicModule;
  readonly pool?: Pool;
  readonly payments?: PaymentGateways;
  /** The ledger, from the module that owns it. Refuses until provisioned. */
  readonly settlement?: SettlementPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class BookingLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class BookingModule {
  static forRoot(options: BookingModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('BookingModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const payments =
      options.payments ?? selectPaymentGateways(options.config?.appEnv ?? 'production');
    const settlement = options.settlement ?? new UnprovisionedSettlement();
    const clock = options.clock;

    const deps = (
      subscription: SubscriptionStatePort,
      tariffs: TariffService,
    ): BookingDependencies => ({
      pool,
      tariffs,
      payments,
      settlement,
      subscription,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE, TariffService];

    return {
      module: BookingModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.catalog === undefined ? [] : [options.catalog]),
      ],
      controllers: [BookingController, BookingOperationsController, PaymentCallbackController],
      providers: [
        { provide: BOOKING_POOL, useValue: pool },
        { provide: BOOKING_PAYMENTS, useValue: payments },
        { provide: BookingLifecycle, useValue: new BookingLifecycle(pool, ownsPool) },
        {
          provide: BookingService,
          useFactory: (subscription: SubscriptionStatePort, tariffs: TariffService) =>
            new BookingService(deps(subscription, tariffs)),
          inject,
        },
        {
          provide: BookingExpiryService,
          useFactory: (subscription: SubscriptionStatePort, tariffs: TariffService) =>
            new BookingExpiryService(deps(subscription, tariffs)),
          inject,
        },
      ],
      exports: [BookingService, BookingExpiryService, BOOKING_POOL],
    };
  }
}
