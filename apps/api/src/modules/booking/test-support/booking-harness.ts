import { TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import {
  PaymentGatewayRegistry,
  SimulatedHotelPayout,
  SimulatedPaymentGateway,
} from '@prsystem/ports';
import type { PaymentGateways, PaymentProvider } from '@prsystem/ports';
import type { PublicHarness } from '../../public/test-support/public-harness';
import { createPublicHarness } from '../../public/test-support/public-harness';
import type { StayHotel } from '../../stay/test-support/stay-harness';
import { IamGuestAccounts } from '../../iam/contracts/guest-accounts.port';
import { AUTH_SECURITY_PARAMETERS } from '../../iam/contracts/security-parameters';
import type { BookingDependencies } from '../services/booking-context';
import { BookingService } from '../services/booking.service';
import { BookingExpiryService } from '../services/expiry.service';
import { RepositorySettlement } from '../../settlement/contracts/booking-settlement';
import { RepositoryBookingRefundAxis } from '../contracts/refund-axis';
import type { SettlementDependencies } from '../../settlement/services/settlement-context';
import { BookingRefundService } from '../../settlement/services/refund.service';
import { PayoutService } from '../../settlement/services/payout.service';

/**
 * The Phase 13 harness: the Phase 12 public harness — which already gives a
 * published hotel with a priced, photographed category and real rooms — plus
 * the booking services over the same pool and clock.
 *
 * The public search is wired to the *real* `RepositoryCategoryHolds`, so the
 * availability a searcher sees and the units a booking takes are the same
 * arithmetic rather than two that happen to agree.
 */

export interface BookingHarness extends Omit<PublicHarness, 'publicDeps'> {
  readonly publicDeps: PublicHarness['publicDeps'];
  readonly bookingService: BookingService;
  readonly expiry: BookingExpiryService;
  readonly bookingDeps: BookingDependencies;
  readonly gateways: PaymentGateways;
  readonly settlementDeps: SettlementDependencies;
  readonly refunds: BookingRefundService;
  readonly payouts: PayoutService;
  readonly payoutPort: SimulatedHotelPayout;
  /** The simulator behind one provider, for arming failures and paying invoices. */
  gateway(provider: PaymentProvider): SimulatedPaymentGateway;
  /**
   * A published hotel whose category has exactly `rooms` bookable rooms, and —
   * unless `commissionRateBps` is `null` — the explicit contract `PAY-DEC-001`
   * requires before it can take an online payment at all.
   */
  bookableHotel(name: string, rooms: number, commissionRateBps?: number | null): Promise<StayHotel>;
  /**
   * `PAY-DEC-001`: the hotel's explicit commission rate.
   *
   * Written over the owner connection because doc 18 names no permission for
   * administering one — a commission contract reaches the platform the way the
   * agreement it records does, not through an API.
   */
  commissionContract(hotelId: string, rateBps: number, version?: number): Promise<string>;
  /** A Guest account, created the way Phase 12 creates one. */
  guest(): Promise<string>;
  /** Moves the server's now for every booking and settlement command. */
  advance(seconds: number): void;
  /** Puts it back. A test that moved the clock and threw must not move the next. */
  resetClock(): void;
}

export async function createBookingHarness(suite: string): Promise<BookingHarness> {
  const base = await createPublicHarness(suite);
  let offsetMs = 0;
  const simulators = new Map<PaymentProvider, SimulatedPaymentGateway>([
    ['QPAY', new SimulatedPaymentGateway('QPAY')],
    ['KHAAN', new SimulatedPaymentGateway('KHAAN')],
  ]);
  const gateways: PaymentGateways = new PaymentGatewayRegistry(simulators);
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const bookingDeps: BookingDependencies = {
    pool: base.api,
    tariffs: base.minibar.catalog.tariffs,
    payments: gateways,
    settlement: new RepositorySettlement(),
    subscription: base.minibar.catalog.subscription,
    clock,
  };
  const bookings = new BookingService(bookingDeps);
  const payoutPort = new SimulatedHotelPayout();
  // The refund and payout jobs are the *worker's*, and the worker's grants are
  // narrower than the API's — it may settle a payable and open a payout batch,
  // and may create neither a booking nor a payable. Running them through the
  // API's connection would prove nothing about the deployment that actually
  // runs them.
  const workerPool = quietPool(
    { connectionString: base.db.loginUrl(TEST_LOGIN_PRINCIPALS.worker), max: 4 },
    `settlement-worker:${suite}`,
    base.db.name,
  );
  const settlementDeps: SettlementDependencies = {
    pool: workerPool,
    payments: gateways,
    payouts: payoutPort,
    bookings: new RepositoryBookingRefundAxis(),
    clock,
  };

  // The public search already subtracts what bookings hold: the Phase 12
  // harness carries Phase 13's contract, so the availability a searcher is
  // shown and the units a booking takes are one arithmetic rather than two
  // that happen to agree.
  const searchDeps = base.publicDeps;
  const search = base.search;
  const accounts = new IamGuestAccounts(
    base.minibar.catalog.iam.deps.keys,
    AUTH_SECURITY_PARAMETERS,
  );
  let guests = 0;

  const commissionContract = async (
    hotelId: string,
    rateBps: number,
    version = 1,
  ): Promise<string> => {
    const result = await base.admin.query<{ contract_id: string }>(
      `INSERT INTO platform.hotel_commission_contract
         (hotel_id, contract_version, party_type, commission_rate_bps,
          cancellation_policy_version, effective_from)
       VALUES ($1::uuid, $2, 'NEGOTIATED', $3, 1, now() - interval '1 day')
       RETURNING contract_id`,
      [hotelId, version, rateBps],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the commission contract insert returned no row');
    return row.contract_id;
  };

  return {
    ...base,
    publicDeps: searchDeps,
    search,
    bookingService: bookings,
    bookingDeps,
    expiry: new BookingExpiryService(bookingDeps),
    gateways,
    settlementDeps,
    payoutPort,
    refunds: new BookingRefundService(settlementDeps),
    payouts: new PayoutService(settlementDeps),

    gateway(provider: PaymentProvider): SimulatedPaymentGateway {
      const simulator = simulators.get(provider);
      if (simulator === undefined) throw new Error(`no simulator for ${provider}`);
      return simulator;
    },

    commissionContract,

    async bookableHotel(
      name: string,
      rooms: number,
      commissionRateBps: number | null = 1000,
    ): Promise<StayHotel> {
      const hotel = await base.publishedHotel(name);
      // `cleanRoom()` creates an ACTIVE room in the seeded category and marks
      // it clean, which is what makes it count towards capacity.
      for (let i = 0; i < rooms; i += 1) await hotel.cleanRoom();
      if (commissionRateBps !== null) {
        await commissionContract(hotel.hotelId, commissionRateBps);
      }
      return hotel;
    },

    async guest(): Promise<string> {
      guests += 1;
      const { withTenantTransaction, PLATFORM_SCOPE } = await import('@prsystem/db');
      return withTenantTransaction(
        base.api,
        {
          hotelId: PLATFORM_SCOPE,
          realm: 'guest',
          actorRef: `booking-harness-${String(guests)}`,
          correlationId: `booking-harness-${String(guests)}`,
        },
        async (uow) => {
          const account = await accounts.createAccount(uow);
          await uow.query(
            `INSERT INTO platform.guest_account
               (account_id, registered_via, phone_token, phone_token_key_version,
                phone_ciphertext, phone_wrapped_dek, phone_key_version, phone_verified_at)
             VALUES ($1::uuid, 'PHONE_OTP', encode(digest($1::text, 'sha256'), 'hex'), 'v1',
                     '\\x00'::bytea, '\\x00'::bytea, 'v1', now())`,
            [account.accountId],
          );
          return account.accountId;
        },
      );
    },

    advance: (seconds: number) => {
      offsetMs += seconds * 1000;
    },

    resetClock: () => {
      offsetMs = 0;
    },
  };
}
