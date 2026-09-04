import type { CommandActor } from '../../iam/services/iam-context';
import type { BillingHarness } from '../../billing/test-support/billing-harness';
import { createBillingHarness, key, request } from '../../billing/test-support/billing-harness';
import type { StayHotel } from '../../stay/test-support/stay-harness';
import { RepositoryShiftLookup } from '../../stay/contracts/shift-lookup';
import type { FinanceDependencies } from '../services/finance-context';
import { CashService } from '../services/cash.service';
import { CashRequestService } from '../services/request.service';
import { ExpenseService } from '../services/expense.service';

/**
 * The Phase 11 harness: the Phase 10 billing harness with the finance services
 * over the same pool, clock and shift contract.
 *
 * The shift lookup is the real one, not a simulator: which shift is accountable
 * for a drawer is exactly the fact these tests are about, and answering it from
 * memory would prove nothing about the two modules together.
 */

export interface FinanceHotel extends StayHotel {
  /** The default drawer Phase 05 provisions with the hotel. */
  readonly drawerId: string;
  /** A second Reception, for the handover the same person cannot do alone. */
  readonly reception2: CommandActor;
  readonly hotelAdmin: CommandActor;
  readonly managerPlus: CommandActor;
}

export interface FinanceHarness extends BillingHarness {
  readonly financeDeps: FinanceDependencies;
  readonly cash2: CashService;
  readonly cashRequests: CashRequestService;
  readonly expenses2: ExpenseService;
  financeHotel(name: string): Promise<FinanceHotel>;
}

export async function createFinanceHarness(suite: string): Promise<FinanceHarness> {
  const billing = await createBillingHarness(suite);
  const financeDeps: FinanceDependencies = {
    pool: billing.api,
    subscription: billing.deps.subscription,
    shifts: new RepositoryShiftLookup(),
    clock: billing.now,
  };
  let sequence = 0;
  return {
    ...billing,
    financeDeps,
    cash2: new CashService(financeDeps),
    cashRequests: new CashRequestService(financeDeps),
    expenses2: new ExpenseService(financeDeps),

    async financeHotel(name: string): Promise<FinanceHotel> {
      sequence += 1;
      const hotel = await billing.hotel(name, 'P30');
      const tag = `${String(sequence)}-${suite}`;
      const second = await billing.minibar.seed(hotel.hotelId, `reception2-${tag}@finance.test`, [
        'RECEPTION',
      ]);
      const admin = await billing.minibar.seed(hotel.hotelId, `admin-${tag}@finance.test`, [
        'HOTEL_ADMIN',
      ]);
      const plus = await billing.minibar.seed(hotel.hotelId, `plus-${tag}@finance.test`, [
        'MANAGER_PLUS',
      ]);
      const drawer = await billing.admin.query<{ cash_location_id: string }>(
        `SELECT cash_location_id FROM platform.cash_location
          WHERE hotel_id = $1 AND is_default_drawer IS TRUE`,
        [hotel.hotelId],
      );
      const drawerId = drawer.rows[0]?.cash_location_id;
      if (drawerId === undefined) throw new Error('the hotel has no default drawer');
      return {
        ...hotel,
        drawerId,
        reception2: await billing.minibar.actorFor(second),
        hotelAdmin: await billing.minibar.actorFor(admin),
        managerPlus: await billing.minibar.actorFor(plus),
      };
    },
  };
}

export { key, request };
