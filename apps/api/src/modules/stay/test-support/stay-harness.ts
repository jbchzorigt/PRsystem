import type { Pool } from 'pg';
import type { HotelRole, PackageCode } from '@prsystem/authz';
import { LocalKeyManagement, SimulatedXypIdentity } from '@prsystem/ports';
import type { TestDatabase } from '@prsystem/testing';
import type { CommandActor } from '../../iam/services/iam-context';
import type { SeededMembership } from '../../iam/test-support/iam-harness';
import { provisionIamDatabase } from '../../iam/test-support/iam-harness';
import type { MinibarHarness, MinibarHotel } from '../../minibar/test-support/minibar-harness';
import { attachMinibarHarness, key, request } from '../../minibar/test-support/minibar-harness';
import { SimulatedConfirmedBookings } from '../contracts/confirmed-bookings';
import { SimulatedPaymentAttempts } from '../contracts/payment-attempts';
import type { DepositsPort } from '../contracts/deposits';
import { SimulatedDeposits } from '../contracts/deposits';
import type { GuestIdentityInput } from '../domain/identity';
import { CheckInService } from '../services/check-in.service';
import { CheckoutService } from '../services/checkout.service';
import { CleaningTaskService } from '../services/cleaning-task.service';
import { ConflictService } from '../services/conflict.service';
import { DisputeService } from '../services/dispute.service';
import { PaymentLockService } from '../services/payment-lock.service';
import { RefillService } from '../services/refill.service';
import { MinibarReportService } from '../services/report.service';
import { CorrectionService } from '../services/correction.service';
import { HousekeepingService } from '../services/housekeeping.service';
import { ShiftService } from '../services/shift.service';
import type { StayDependencies } from '../services/stay-context';
import { StayService } from '../services/stay.service';

/**
 * The stay services on a real database, through the restricted API login, on
 * top of the minibar harness — which brings the catalog and IAM harnesses,
 * hotels, memberships, rooms, products and versions. XYP is the simulator
 * with synthetic identities only; the clock is movable so a stay can be made
 * overdue without waiting.
 */

export interface StayHotel extends MinibarHotel {
  readonly reception: CommandActor;
  readonly receptionMember: SeededMembership;
  /** A room that is ACTIVE and marked `CLEAN` by the Cleaner. */
  cleanRoom(): Promise<string>;
}

export interface StayHarness {
  readonly db: TestDatabase;
  readonly admin: Pool;
  readonly api: Pool;
  readonly minibar: MinibarHarness;
  readonly deps: StayDependencies;
  readonly xyp: SimulatedXypIdentity;
  readonly bookings: SimulatedConfirmedBookings;
  readonly payments: SimulatedPaymentAttempts;
  readonly deposits: SimulatedDeposits;
  readonly shifts: ShiftService;
  readonly housekeeping: HousekeepingService;
  readonly checkIns: CheckInService;
  readonly stays: StayService;
  readonly corrections: CorrectionService;
  readonly conflicts: ConflictService;
  readonly checkouts: CheckoutService;
  readonly reports: MinibarReportService;
  readonly disputes: DisputeService;
  readonly paymentLocks: PaymentLockService;
  readonly refills: RefillService;
  readonly cleaningTasks: CleaningTaskService;
  /** Moves the server's now for every command by this many minutes (0 resets). */
  travel(minutes: number): void;
  now(): Date;
  hotel(name: string, packageCode?: PackageCode): Promise<StayHotel>;
  actorFor(member: SeededMembership): Promise<CommandActor>;
  seed(hotelId: string, email: string, roles: readonly HotelRole[]): Promise<SeededMembership>;
  close(): Promise<void>;
}

/** A synthetic Mongolian primary guest, of age, manual unless the simulator knows the number. */
export function syntheticGuest(overrides: Partial<GuestIdentityInput> = {}): GuestIdentityInput {
  return {
    identityType: 'MN_REG_NO',
    registrationNumber: 'АА90010112',
    familyName: 'Синтетик',
    givenName: 'Зочин',
    dateOfBirth: '1990-01-01',
    nationality: 'MN',
    ...overrides,
  } as GuestIdentityInput;
}

export interface StayHarnessOptions {
  /** Phase 10 supplies its own implementation so a check-in opens a real folio. */
  readonly deposits?: DepositsPort;
}

export function attachStayHarness(
  db: TestDatabase,
  suite: string,
  options: StayHarnessOptions = {},
): StayHarness {
  const minibar = attachMinibarHarness(db, suite);
  const xyp = new SimulatedXypIdentity();
  const bookings = new SimulatedConfirmedBookings();
  const payments = new SimulatedPaymentAttempts();
  const simulatedDeposits = new SimulatedDeposits();
  const deposits = options.deposits ?? simulatedDeposits;
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const deps: StayDependencies = {
    pool: minibar.api,
    subscription: minibar.catalog.subscription,
    tariffs: minibar.catalog.tariffs,
    minibar: minibar.configurations,
    lifecycle: minibar.catalog.lifecycle,
    keys: new LocalKeyManagement({ appEnv: 'test', seed: `synthetic-${suite}` }),
    xyp,
    bookings,
    payments,
    deposits,
    clock,
  };
  let hotelSequence = 0;

  return {
    db,
    admin: db.pool,
    api: minibar.api,
    minibar,
    deps,
    xyp,
    bookings,
    payments,
    deposits: simulatedDeposits,
    shifts: new ShiftService(deps),
    housekeeping: new HousekeepingService(deps),
    checkIns: new CheckInService(deps),
    stays: new StayService(deps),
    corrections: new CorrectionService(deps),
    conflicts: new ConflictService(deps),
    checkouts: new CheckoutService(deps),
    reports: new MinibarReportService(deps),
    disputes: new DisputeService(deps),
    paymentLocks: new PaymentLockService(deps),
    refills: new RefillService(deps),
    cleaningTasks: new CleaningTaskService(deps),
    travel(minutes) {
      offsetMs = minutes * 60_000;
    },
    now: clock,

    async hotel(name, packageCode = 'P25') {
      hotelSequence += 1;
      const seeded = await minibar.hotel(name, packageCode);
      const receptionMember = await minibar.seed(
        seeded.hotelId,
        `reception-${String(hotelSequence)}-${suite}@stay.test`,
        ['RECEPTION'],
      );
      const reception = await minibar.actorFor(receptionMember);
      const housekeeping = new HousekeepingService(deps);
      return {
        ...seeded,
        reception,
        receptionMember,
        async cleanRoom() {
          const roomId = await seeded.room();
          await housekeeping.setState(
            {
              hotelId: seeded.hotelId,
              roomId,
              idempotencyKey: key('st'),
              toState: 'CLEAN',
              expectedRevision: 0,
            },
            seeded.cleaner,
            request(seeded.cleaner),
          );
          return roomId;
        },
      };
    },

    actorFor(member) {
      return minibar.actorFor(member);
    },

    seed(hotelId, email, roles) {
      return minibar.seed(hotelId, email, roles);
    },

    close() {
      return minibar.close();
    },
  };
}

export async function createStayHarness(
  suite: string,
  options: StayHarnessOptions = {},
): Promise<StayHarness> {
  const db = await provisionIamDatabase(suite);
  return attachStayHarness(db, suite, options);
}

export { key, request };
