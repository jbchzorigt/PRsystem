import { SimulatedPaymentGateway } from '@prsystem/ports';
import type { PaymentGateways } from '@prsystem/ports';
import type { PublicHarness } from '../../public/test-support/public-harness';
import { createPublicHarness } from '../../public/test-support/public-harness';
import type { StayHotel } from '../../stay/test-support/stay-harness';
import { IamGuestAccounts } from '../../iam/contracts/guest-accounts.port';
import { AUTH_SECURITY_PARAMETERS } from '../../iam/contracts/security-parameters';
import type { BookingDependencies } from '../services/booking-context';
import { BookingService } from '../services/booking.service';
import { BookingExpiryService } from '../services/expiry.service';

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
  /** A published hotel whose category has exactly `rooms` bookable rooms. */
  bookableHotel(name: string, rooms: number): Promise<StayHotel>;
  /** A Guest account, created the way Phase 12 creates one. */
  guest(): Promise<string>;
  /** Moves the server's now for every booking command. */
  advance(seconds: number): void;
}

export async function createBookingHarness(suite: string): Promise<BookingHarness> {
  const base = await createPublicHarness(suite);
  let offsetMs = 0;
  const gateway = new SimulatedPaymentGateway('QPAY');
  const gateways: PaymentGateways = {
    QPAY: gateway,
    KHAAN: new SimulatedPaymentGateway('KHAAN'),
  } as unknown as PaymentGateways;
  const bookingDeps: BookingDependencies = {
    pool: base.api,
    tariffs: base.minibar.catalog.tariffs,
    payments: gateways,
    clock: () => new Date(Date.now() + offsetMs),
  };
  const bookings = new BookingService(bookingDeps);

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

  return {
    ...base,
    publicDeps: searchDeps,
    search,
    bookingService: bookings,
    bookingDeps,
    expiry: new BookingExpiryService(bookingDeps),
    gateways,

    async bookableHotel(name: string, rooms: number): Promise<StayHotel> {
      const hotel = await base.publishedHotel(name);
      // `cleanRoom()` creates an ACTIVE room in the seeded category and marks
      // it clean, which is what makes it count towards capacity.
      for (let i = 0; i < rooms; i += 1) await hotel.cleanRoom();
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
  };
}
