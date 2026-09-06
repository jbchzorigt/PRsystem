import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { HotelPayoutPort, PaymentGateways } from '@prsystem/ports';
import { selectHotelPayout, selectPaymentGateways } from '@prsystem/ports';
import type { BookingRefundAxisPort } from './contracts/booking-refund-axis';
import { UnprovisionedBookingRefundAxis } from './contracts/booking-refund-axis';
import type { SettlementDependencies } from './services/settlement-context';
import { BookingRefundService } from './services/refund.service';
import { PayoutService } from './services/payout.service';
import { SETTLEMENT_PAYOUTS, SETTLEMENT_POOL } from './settlement.tokens';

/**
 * Online payment, refund, commission and settlement (Phase 14).
 *
 * It owns the commission contract, the payable, the immutable money ledger, the
 * refund axis and the payout batch. It has no HTTP surface, and that is not an
 * omission: doc 18 names no permission for administering a commission rate or
 * for releasing a payout by hand, and a role the requirements do not grant is
 * one this module will not invent. What it exposes instead is the booking
 * module's contract — evaluated inside the booking's own transaction — and two
 * jobs that find their work through resolver functions and then act in one
 * hotel at a time.
 */
export interface SettlementModuleConfig {
  readonly databaseUrl: string;
  /** Chooses the simulators or the fail-closed adapters (ADR-0020 §7). */
  readonly appEnv: string;
}

export interface SettlementModuleOptions {
  readonly config?: SettlementModuleConfig;
  readonly pool?: Pool;
  readonly payments?: PaymentGateways;
  readonly payouts?: HotelPayoutPort;
  /** The booking's refund axis, from the module that owns the booking. */
  readonly bookings?: BookingRefundAxisPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class SettlementLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class SettlementModule {
  static forRoot(options: SettlementModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('SettlementModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const appEnv = options.config?.appEnv ?? 'production';
    const payments = options.payments ?? selectPaymentGateways(appEnv);
    const payouts = options.payouts ?? selectHotelPayout(appEnv);
    const bookings = options.bookings ?? new UnprovisionedBookingRefundAxis();
    const clock = options.clock;

    const deps: SettlementDependencies = {
      pool,
      payments,
      payouts,
      bookings,
      ...(clock === undefined ? {} : { clock }),
    };

    return {
      module: SettlementModule,
      controllers: [],
      providers: [
        { provide: SETTLEMENT_POOL, useValue: pool },
        { provide: SETTLEMENT_PAYOUTS, useValue: payouts },
        { provide: SettlementLifecycle, useValue: new SettlementLifecycle(pool, ownsPool) },
        { provide: BookingRefundService, useValue: new BookingRefundService(deps) },
        { provide: PayoutService, useValue: new PayoutService(deps) },
      ],
      exports: [BookingRefundService, PayoutService, SETTLEMENT_POOL, SETTLEMENT_PAYOUTS],
    };
  }
}
