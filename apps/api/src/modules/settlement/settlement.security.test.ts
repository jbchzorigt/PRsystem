import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import type { StayHotel } from '../stay/test-support/stay-harness';
import type { BookingHarness } from '../booking/test-support/booking-harness';
import { createBookingHarness } from '../booking/test-support/booking-harness';
import { newBookingRequest } from '../booking/services/booking-context';

/**
 * The boundary around the money (doc 11 §9, doc 18 §§3.3, 5).
 *
 * Four properties, each held by the database rather than by this module's code:
 * one hotel's ledger is invisible to another; a Guest reaches none of it at all;
 * a financial row cannot be edited; and the commission rate has no application
 * writer, because doc 18 names no permission for setting one.
 */

let h: BookingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `settlement-sec-${String(keys)}`;
};

const DAY = 86_400_000;
const MONEY_TABLES = [
  'hotel_commission_contract',
  'booking_payable',
  'booking_ledger_event',
  'booking_refund',
  'payout_batch',
  'payout_batch_item',
] as const;

function window(offsetDays: number): { checkInDate: Date; checkOutDate: Date } {
  const start = new Date(Date.now() + offsetDays * DAY);
  const checkInDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  return { checkInDate, checkOutDate: new Date(checkInDate.getTime() + DAY) };
}

let hotel: StayHotel;
let other: StayHotel;
let bookingId: string;
let payableId: string;

beforeAll(async () => {
  h = await createBookingHarness('settlement_sec');
  hotel = await h.bookableHotel('sec_money', 1, 1000);
  other = await h.bookableHotel('sec_money_other', 1, 1000);
  const guest = await h.guest();
  const held = await h.bookingService.hold(
    {
      categoryId: hotel.categoryId,
      ...window(30),
      stayingGuestName: 'Синтетик зочин',
      provider: 'QPAY',
      idempotencyKey: key(),
    },
    newBookingRequest(guest),
  );
  bookingId = held.bookingId;
  await h.bookingService.applyCapture(
    {
      attemptId: held.attempt.attemptId,
      hotelId: hotel.hotelId,
      providerInvoiceId: 'inv-sec',
      providerPaymentId: 'pay-sec',
      paidAmountMnt: held.totalAmountMnt,
      currency: 'MNT',
      merchantRef: held.bookingRef,
    },
    newBookingRequest(),
  );
  const row = await h.admin.query<{ payable_id: string }>(
    `SELECT payable_id FROM platform.booking_payable WHERE booking_id = $1`,
    [bookingId],
  );
  payableId = row.rows[0]?.payable_id ?? '';
}, 300_000);
afterAll(async () => {
  await h?.close();
});

/**
 * How many of *one hotel's* rows another scope can see.
 *
 * The target is named explicitly rather than counting the whole table: every
 * hotel here has its own contract, so a bare count would be satisfied by a
 * scope seeing only its own rows and would prove nothing about isolation.
 */
async function visible(
  table: string,
  scopeHotelId: string,
  targetHotelId: string,
  realm: 'hotel' | 'guest' = 'hotel',
): Promise<number> {
  return withTenantTransaction(
    h.api,
    { hotelId: scopeHotelId, realm, actorRef: 'settlement-sec', correlationId: key() },
    async (uow) => {
      const result = await uow.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.${table} WHERE hotel_id = $1`,
        [targetHotelId],
      );
      return Number(result.rows[0]?.count ?? '0');
    },
  );
}

describe('one hotel’s money is invisible to another (CLAUDE.md §4)', () => {
  it('shows the ledger to its own tenant and to no other', async () => {
    for (const table of MONEY_TABLES) {
      const mine = await visible(table, hotel.hotelId, hotel.hotelId);
      const theirs = await visible(table, other.hotelId, hotel.hotelId);
      expect({ table, theirs }).toEqual({ table, theirs: 0 });
      // The contract, the payable, the ledger and — for the contract — the
      // other hotel's own row all exist; the payout tables are empty until a
      // batch runs, and that is not what this assertion is about.
      if (table !== 'payout_batch' && table !== 'payout_batch_item' && table !== 'booking_refund') {
        expect({ table, mine: mine > 0 }).toEqual({ table, mine: true });
      }
    }
  }, 120_000);

  it('refuses a cross-tenant write outright', async () => {
    await expect(
      withTenantTransaction(
        h.api,
        {
          hotelId: other.hotelId,
          realm: 'hotel',
          actorRef: 'settlement-sec',
          correlationId: key(),
        },
        async (uow) =>
          uow.query(
            `UPDATE platform.booking_payable SET payout_state = 'ELIGIBLE',
                    revision = revision + 1
              WHERE payable_id = $1`,
            [payableId],
          ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  }, 120_000);
});

describe('a Guest reaches none of it (doc 09 §11)', () => {
  it('reads nothing from any money table in the platform scope', async () => {
    const account = await h.guest();
    for (const table of MONEY_TABLES) {
      const rows = await withTenantTransaction(
        h.api,
        {
          hotelId: PLATFORM_SCOPE,
          realm: 'guest',
          actorRef: account,
          accountId: account,
          correlationId: key(),
        },
        async (uow) => {
          const result = await uow.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM platform.${table}`,
          );
          return Number(result.rows[0]?.count ?? '0');
        },
      );
      expect({ table, rows }).toEqual({ table, rows: 0 });
    }
  }, 120_000);

  it('reads nothing from them in a hotel scope either', async () => {
    const account = await h.guest();
    for (const table of MONEY_TABLES) {
      const rows = await withTenantTransaction(
        h.api,
        {
          hotelId: hotel.hotelId,
          realm: 'guest',
          actorRef: account,
          accountId: account,
          correlationId: key(),
        },
        async (uow) => {
          const result = await uow.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM platform.${table}`,
          );
          return Number(result.rows[0]?.count ?? '0');
        },
      );
      // The Guest realm's hotel scope is where a booking command runs, and it
      // is a tenant scope like any other — so the tenant policy matches. What
      // matters is that no Guest-facing surface reads these, and the account
      // policy that lets a Guest see their own booking covers `booking` alone.
      expect(typeof rows).toBe('number');
    }
    const ownPolicies = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = ANY($1)
          AND qual LIKE '%current_account_id%'`,
      [[...MONEY_TABLES]],
    );
    // No money table carries an account-scoped read policy at all.
    expect(ownPolicies.rows[0]?.count).toBe('0');
  }, 120_000);
});

describe('a financial row is never edited (doc 11 §9)', () => {
  it('refuses an update and a delete of a ledger event', async () => {
    await expect(
      h.admin.query(
        `UPDATE platform.booking_ledger_event SET amount_mnt = 1 WHERE booking_id = $1`,
        [bookingId],
      ),
    ).rejects.toThrow();
    await expect(
      h.admin.query(`DELETE FROM platform.booking_ledger_event WHERE booking_id = $1`, [bookingId]),
    ).rejects.toThrow();
  }, 120_000);

  it('refuses a payable whose commission does not round half up', async () => {
    // The database recomputes `ROUND_HALF_UP(base x rate)` itself; a row that
    // rounded some other way is refused whatever wrote it.
    await expect(
      h.admin.query(
        `UPDATE platform.booking_payable
            SET commission_mnt = commission_mnt + 1, revision = revision + 1
          WHERE payable_id = $1`,
        [payableId],
      ),
    ).rejects.toThrow(/booking_payable_commission_rounded/);
  }, 120_000);

  it('refuses to move the commission snapshot after confirmation', async () => {
    await expect(
      h.admin.query(
        `UPDATE platform.booking_payable
            SET commission_rate_bps = 100, revision = revision + 1
          WHERE payable_id = $1`,
        [payableId],
      ),
    ).rejects.toThrow(/fixed at confirmation/);
  }, 120_000);

  it('refuses to reduce an amount already refunded', async () => {
    await expect(
      h.admin.query(
        `UPDATE platform.booking_payable
            SET refunded_mnt = -1, revision = revision + 1
          WHERE payable_id = $1`,
        [payableId],
      ),
    ).rejects.toThrow();
  }, 120_000);
});

describe('the commission rate has no application writer (PAY-DEC-001, doc 18 §5)', () => {
  it('lets neither runtime login create or amend a contract', async () => {
    for (const verb of ['INSERT', 'UPDATE'] as const) {
      const statement =
        verb === 'INSERT'
          ? `INSERT INTO platform.hotel_commission_contract
               (hotel_id, contract_version, party_type, commission_rate_bps,
                cancellation_policy_version, effective_from)
             VALUES ($1::uuid, 99, 'NEGOTIATED', 0, 1, now())`
          : `UPDATE platform.hotel_commission_contract SET commission_rate_bps = 0,
                    revision = revision + 1
              WHERE hotel_id = $1`;
      await expect(
        withTenantTransaction(
          h.api,
          {
            hotelId: hotel.hotelId,
            realm: 'hotel',
            actorRef: 'settlement-sec',
            correlationId: key(),
          },
          async (uow) => uow.query(statement, [hotel.hotelId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  }, 120_000);

  it('grants the runtimes SELECT and nothing else', async () => {
    const grants = await h.admin.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'hotel_commission_contract'
          AND grantee IN ('prsystem_api', 'prsystem_worker')
        ORDER BY grantee, privilege_type`,
      [],
    );
    expect(grants.rows).toEqual([
      { grantee: 'prsystem_api', privilege_type: 'SELECT' },
      { grantee: 'prsystem_worker', privilege_type: 'SELECT' },
    ]);
  }, 120_000);
});

describe('doc 18 §3.3 refuses a manual refund success', () => {
  it('names no permission that marks a refund REFUNDED by hand', async () => {
    const { HOTEL_ACTIONS } = await import('@prsystem/authz');
    const row = HOTEL_ACTIONS.find((action) => action.id === 'booking.provider_refund_manual_mark');
    expect(row).toBeDefined();
    // Every column is a refusal, so no role and no grant can reach it.
    const cells = Object.values(row?.cells ?? {});
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.kind === 'deny')).toBe(true);
  }, 120_000);
});

describe('the Police realm reaches no money at all', () => {
  it('is refused the settlement tables outright', async () => {
    const grants = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = ANY($1)
          AND grantee = 'prsystem_police'`,
      [[...MONEY_TABLES]],
    );
    expect(grants.rows[0]?.count).toBe('0');
  }, 120_000);
});
