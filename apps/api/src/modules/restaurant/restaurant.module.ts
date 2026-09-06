import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import type { KeyManagementPort, PaymentGateways } from '@prsystem/ports';
import { selectKeyManagement, selectPaymentGateways } from '@prsystem/ports';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { StayFactsPort } from './contracts/stay-facts';
import { RepositoryStayFacts } from './contracts/stay-facts';
import type { RestaurantDependencies } from './services/restaurant-context';
import { RestaurantAdminService } from './services/restaurant.service';
import { GuestAccessService } from './services/guest-access.service';
import { RestaurantOrderService } from './services/order.service';
import { RestaurantRefundService } from './services/refund.service';
import { RestaurantExpiryService } from './services/expiry.service';
import { RESTAURANT_PAYMENTS, RESTAURANT_POOL } from './restaurant.tokens';
import { GuestAccessController } from './http/guest-access.controller';
import { GuestOrderController } from './http/guest-order.controller';
import { RestaurantAdminController } from './http/restaurant-admin.controller';
import { RestaurantCallbackController } from './http/restaurant-callback.controller';
import { RestaurantOrderController } from './http/restaurant-order.controller';
import { RestaurantGuestGuard } from './http/guest-session.guard';

/**
 * Restaurant registration, guest access, ordering and refunds (Phase 15).
 *
 * It owns the restaurant, its link to a hotel, its schedule and menu, the room
 * QR and the guest sessions it opens, and the order on its seven axes. What it
 * does **not** own is any of the money: doc 08 §13 sends a food payment to the
 * restaurant's own merchant, and this module records the order, the invoice and
 * what the provider said about them — no payable, no batch, no settlement, and
 * nothing that reaches a folio, a deposit, a drawer or a shift.
 *
 * The 30,000₮ entitlement is enforced by the Phase 04 pipeline, because every
 * permission this module names is granted on that package alone.
 */
export interface RestaurantModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
}

export interface RestaurantModuleOptions {
  readonly config?: RestaurantModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly payments?: PaymentGateways;
  readonly keys?: KeyManagementPort;
  readonly stays?: StayFactsPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class RestaurantLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class RestaurantModule {
  static forRoot(options: RestaurantModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('RestaurantModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const appEnv = options.config?.appEnv ?? 'production';
    const payments = options.payments ?? selectPaymentGateways(appEnv);
    const keys =
      options.keys ??
      selectKeyManagement({
        appEnv,
        kmsAdapter: (options.config?.kmsAdapter ?? 'unavailable') as 'local' | 'unavailable',
        ...(options.config?.kmsSeed === undefined ? {} : { seed: options.config.kmsSeed }),
      });
    const stays = options.stays ?? new RepositoryStayFacts();
    const clock = options.clock;

    const deps = (subscription: SubscriptionStatePort): RestaurantDependencies => ({
      pool,
      subscription,
      payments,
      keys,
      stays,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];

    return {
      module: RestaurantModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [
        RestaurantAdminController,
        GuestAccessController,
        GuestOrderController,
        RestaurantOrderController,
        RestaurantCallbackController,
      ],
      providers: [
        RestaurantGuestGuard,
        { provide: RESTAURANT_POOL, useValue: pool },
        { provide: RESTAURANT_PAYMENTS, useValue: payments },
        { provide: RestaurantLifecycle, useValue: new RestaurantLifecycle(pool, ownsPool) },
        {
          provide: RestaurantAdminService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new RestaurantAdminService(deps(subscription)),
          inject,
        },
        {
          provide: GuestAccessService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new GuestAccessService(deps(subscription)),
          inject,
        },
        {
          provide: RestaurantOrderService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new RestaurantOrderService(deps(subscription)),
          inject,
        },
        {
          provide: RestaurantRefundService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new RestaurantRefundService(deps(subscription)),
          inject,
        },
        {
          provide: RestaurantExpiryService,
          useFactory: (subscription: SubscriptionStatePort) =>
            new RestaurantExpiryService(deps(subscription)),
          inject,
        },
      ],
      exports: [
        RestaurantAdminService,
        GuestAccessService,
        RestaurantOrderService,
        RestaurantRefundService,
        RestaurantExpiryService,
        RESTAURANT_POOL,
      ],
    };
  }
}
