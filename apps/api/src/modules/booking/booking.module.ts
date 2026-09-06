import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { PaymentGateways } from '@prsystem/ports';
import { selectPaymentGateways } from '@prsystem/ports';
import { TariffService } from '../catalog/services/tariff.service';
import { BookingController } from './http/booking.controller';
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
 * Capture, refund, commission and settlement are Phase 14's. This module
 * records that an attempt existed and that an obligation was raised; it settles
 * neither.
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
    const clock = options.clock;

    const deps = (tariffs: TariffService): BookingDependencies => ({
      pool,
      tariffs,
      payments,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [TariffService];

    return {
      module: BookingModule,
      imports: [
        ...(options.iam === undefined ? [] : [options.iam]),
        ...(options.catalog === undefined ? [] : [options.catalog]),
      ],
      controllers: [BookingController],
      providers: [
        { provide: BOOKING_POOL, useValue: pool },
        { provide: BOOKING_PAYMENTS, useValue: payments },
        { provide: BookingLifecycle, useValue: new BookingLifecycle(pool, ownsPool) },
        {
          provide: BookingService,
          useFactory: (tariffs: TariffService) => new BookingService(deps(tariffs)),
          inject,
        },
        {
          provide: BookingExpiryService,
          useFactory: (tariffs: TariffService) => new BookingExpiryService(deps(tariffs)),
          inject,
        },
      ],
      exports: [BookingService, BookingExpiryService, BOOKING_POOL],
    };
  }
}
