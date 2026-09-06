import { SimulatedObjectStorage } from '@prsystem/ports';
import type { CommandActor } from '../../iam/services/iam-context';
import type { StayHarness, StayHotel } from '../../stay/test-support/stay-harness';
import { createStayHarness, key, request } from '../../stay/test-support/stay-harness';
import { RepositoryRegistryFacts } from '../../stay/contracts/registry-reads';
import { RepositoryFinancialReads } from '../../billing/contracts/financial-reads';
import { RepositoryMinibarReads } from '../../minibar/contracts/minibar-reads';
import { RepositoryExpenseReads } from '../../finance/contracts/expense-reads';
import { RepositoryRetention } from '../contracts/stay-retention';
import { RepositoryShiftLookup } from '../../stay/contracts/shift-lookup';
import { RepositoryExpenseClassification } from '../contracts/expense-classification';
import { ExpenseService } from '../../finance/services/expense.service';
import type { ReportingDependencies } from '../services/reporting-context';
import { newReportingRequest } from '../services/reporting-context';
import { GuestRegistryService } from '../services/registry.service';
import { FinancialDashboardService } from '../services/dashboard.service';
import { ReportExportService } from '../services/export.service';
import { RetentionService } from '../services/retention.service';
import { ExpenseCategoryService } from '../services/category.service';

/**
 * The Phase 17 harness: the Phase 08 stay harness — which already gives a
 * hotel, rooms, Reception, a Manager and a real check-in — plus the reporting
 * services over the same pool and the same movable clock.
 *
 * Every read contract is the **real** repository implementation, not a
 * simulator, so what the registry shows and what the dashboard counts is the
 * owning module's own SQL over rows earlier phases wrote. Object storage is the
 * deterministic simulator, because its production adapter is a registered gate
 * that writes nothing.
 */

export interface ReportedStay {
  readonly stayId: string;
  readonly roomId: string;
  readonly roomNumber: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly checkedInAt: string;
  readonly checkedOutAt: string | null;
}

export interface ReportingHarness {
  readonly stay: StayHarness;
  readonly admin: StayHarness['admin'];
  readonly api: StayHarness['api'];
  readonly deps: ReportingDependencies;
  readonly registry: GuestRegistryService;
  readonly dashboard: FinancialDashboardService;
  readonly exports: ReportExportService;
  readonly retention: RetentionService;
  readonly categories: ExpenseCategoryService;
  /**
   * Phase 11's own expense command, so a test can assert that a category
   * classifies a real expense rather than a fixture row.
   */
  readonly expenses: ExpenseService;
  readonly storage: SimulatedObjectStorage;
  /** A P25 hotel with a Hotel Admin actor and an open Reception shift. */
  hotel(name: string): Promise<StayHotel & { admin: CommandActor }>;
  /**
   * A stay that really happened: a room, a check-in with a synthetic identity,
   * and — unless `complete` is false — a recorded checkout.
   *
   * Driven through the Phase 08 and 09 services rather than written by hand, so
   * the registry reads the rows the real flow produces.
   */
  stayFor(
    hotel: StayHotel,
    options?: {
      familyName?: string;
      givenName?: string;
      dateOfBirth?: string;
      complete?: boolean;
      roomCharge?: bigint;
    },
  ): Promise<ReportedStay>;
  /** A paid expense of one kind, at a chosen instant. */
  paidExpense(
    hotel: StayHotel & { admin: CommandActor },
    input: { amountMnt: bigint; kind: 'INVENTORY_PURCHASE' | 'OPERATING'; paidAt?: Date },
  ): Promise<string>;
  advance(minutes: number): void;
  resetClock(): void;
  now(): Date;
  close(): Promise<void>;
}

export async function createReportingHarness(suite: string): Promise<ReportingHarness> {
  const stay = await createStayHarness(suite, { retention: new RepositoryRetention() });
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const storage = new SimulatedObjectStorage();
  const deps: ReportingDependencies = {
    pool: stay.api,
    subscription: stay.minibar.catalog.subscription,
    registry: new RepositoryRegistryFacts(),
    sales: new RepositoryFinancialReads(),
    minibar: new RepositoryMinibarReads(),
    expenses: new RepositoryExpenseReads(),
    storage,
    clock,
  };
  let sequence = 0;
  const withShift = new Set<string>();

  return {
    stay,
    admin: stay.admin,
    api: stay.api,
    deps,
    registry: new GuestRegistryService(deps),
    dashboard: new FinancialDashboardService(deps),
    exports: new ReportExportService(deps),
    retention: new RetentionService(deps),
    categories: new ExpenseCategoryService(deps),
    expenses: new ExpenseService({
      pool: stay.api,
      subscription: stay.minibar.catalog.subscription,
      shifts: new RepositoryShiftLookup(),
      classification: new RepositoryExpenseClassification(),
      clock,
    }),
    storage,

    async hotel(name) {
      sequence += 1;
      const suffix = `${String(sequence).padStart(3, '0')}-${suite}`;
      const seeded = await stay.hotel(name, 'P25');
      const adminMember = await stay.seed(seeded.hotelId, `admin-${suffix}@report.test`, [
        'HOTEL_ADMIN',
      ]);
      const admin = await stay.actorFor(adminMember);
      if (!withShift.has(seeded.hotelId)) {
        withShift.add(seeded.hotelId);
        await stay.shifts.open(
          { hotelId: seeded.hotelId, idempotencyKey: key('shift'), openingCountedMnt: 0n },
          seeded.reception,
          request(seeded.reception),
        );
      }
      return { ...seeded, admin };
    },

    async stayFor(hotel, options = {}) {
      const roomId = await hotel.cleanRoom();
      const familyName = options.familyName ?? 'Синтетик';
      const givenName = options.givenName ?? 'Зочин';
      const checkedIn = await stay.checkIns.checkIn(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key('ci'),
          source: 'WALK_IN',
          stayType: 'NIGHTLY',
          nightCount: 1,
          guest: {
            identityType: 'MN_REG_NO',
            registrationNumber: registrationFor(sequence++),
            familyName,
            givenName,
            dateOfBirth: options.dateOfBirth ?? '1990-01-01',
            nationality: 'MN',
          } as Parameters<typeof stay.checkIns.checkIn>[0]['guest'],
        },
        hotel.reception,
        request(hotel.reception),
      );
      const roomNumber = await roomNumberOf(stay.admin, roomId);
      if (options.complete === false) {
        return {
          stayId: checkedIn.stayId,
          roomId,
          roomNumber,
          familyName,
          givenName,
          checkedInAt: checkedIn.actualCheckInAt,
          checkedOutAt: null,
        };
      }
      const revision = await stayRevision(stay.admin, checkedIn.stayId);
      const completed = await stay.stays.recordActualCheckout(
        {
          hotelId: hotel.hotelId,
          stayId: checkedIn.stayId,
          idempotencyKey: key('co'),
          expectedRevision: revision,
        },
        hotel.reception,
        request(hotel.reception),
      );
      return {
        stayId: checkedIn.stayId,
        roomId,
        roomNumber,
        familyName,
        givenName,
        checkedInAt: checkedIn.actualCheckInAt,
        checkedOutAt: completed.actualCheckoutAt ?? null,
      };
    },

    async paidExpense(hotel, input) {
      sequence += 1;
      const paidAt = input.paidAt ?? clock();
      const result = await stay.admin.query<{ expense_id: string }>(
        `INSERT INTO platform.expense
           (hotel_id, category, expense_type, description, amount_mnt, method, state,
            created_by_account_id, submitted_at, decided_by_account_id, decided_at,
            paid_by_account_id, paid_at, provider_reference)
         VALUES ($1::uuid, $2, $3, 'fixture expense', $4::bigint, 'BANK_QPAY', 'PAID',
                 $5::uuid, $6, $5::uuid, $6, $5::uuid, $6, $7)
         RETURNING expense_id`,
        [
          hotel.hotelId,
          input.kind === 'INVENTORY_PURCHASE' ? 'Minibar бараа татан авалт' : 'Түрээс',
          input.kind,
          input.amountMnt.toString(),
          hotel.admin.principal.accountId,
          paidAt,
          `fixture-${String(sequence)}`,
        ],
      );
      const id = result.rows[0]?.expense_id;
      if (id === undefined) throw new Error('the expense fixture wrote no row');
      return id;
    },

    advance(minutes) {
      offsetMs = minutes * 60_000;
      stay.travel(minutes);
    },

    resetClock() {
      offsetMs = 0;
      stay.travel(0);
    },

    now: clock,

    close() {
      return stay.close();
    },
  };
}

/** A synthetic Mongolian registration number, unique per fixture. */
function registrationFor(n: number): string {
  return `АА${String(90010112 + n).slice(0, 8)}`;
}

async function roomNumberOf(
  admin: {
    query: (sql: string, values: unknown[]) => Promise<{ rows: { room_number: string }[] }>;
  },
  roomId: string,
): Promise<string> {
  const result = await admin.query(`SELECT room_number FROM platform.room WHERE room_id = $1`, [
    roomId,
  ]);
  return result.rows[0]?.room_number ?? '';
}

async function stayRevision(
  admin: { query: (sql: string, values: unknown[]) => Promise<{ rows: { revision: number }[] }> },
  stayId: string,
): Promise<number> {
  const result = await admin.query(`SELECT revision FROM platform.stay WHERE stay_id = $1`, [
    stayId,
  ]);
  return Number(result.rows[0]?.revision ?? 0);
}

export { newReportingRequest, key, request };
