import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { FinanceHarness, FinanceHotel } from './test-support/finance-harness';
import { createFinanceHarness, key, request } from './test-support/finance-harness';

/**
 * Phase 11 concurrency, on real PostgreSQL — the build plan's two gates.
 *
 * Two Receptions opening a shift on one drawer: the partial unique index
 * decides, not a service check, so exactly one drawer has one accountable shift
 * (`CASH-DEC-001`). A transfer confirmation racing the close of the shift it
 * belongs to: either the close sees the transfer still pending and refuses, or
 * the confirmation committed first and its movements are inside the count —
 * never a close whose expected cash misses money that moved (`CASH-DEC-006`).
 */

let env: FinanceHarness;
let h: FinanceHotel;

beforeAll(async () => {
  env = await createFinanceHarness('finance_concurrency');
  h = await env.financeHotel('Race Finance');
}, 180000);

afterAll(async () => {
  env.travel(0);
  await env.close();
}, 30000);

async function settle<T>(
  work: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: error as ApiError };
  }
}

describe('CASH-DEC-001 — one drawer, one accountable shift', () => {
  it('lets exactly one of two Receptions open on the drawer', async () => {
    const [first, second] = await Promise.all([
      settle(
        env.shifts.open(
          { hotelId: h.hotelId, idempotencyKey: key('s1'), openingCountedMnt: 25_000n },
          h.reception,
          request(h.reception),
        ),
      ),
      settle(
        env.shifts.open(
          { hotelId: h.hotelId, idempotencyKey: key('s2'), openingCountedMnt: 25_000n },
          h.reception2,
          request(h.reception2),
        ),
      ),
    ]);
    const winners = [first, second].filter((outcome) => outcome.ok);
    const losers = [first, second].filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (loser?.ok === false) expect(loser.error.message).toContain('SHIFT_ALREADY_OPEN');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.reception_shift
          WHERE hotel_id = $1 AND state <> ALL (ARRAY['SELF_CLOSED', 'CLOSED'])`,
        [h.hotelId],
      ),
    ).toBe(1);
    // And the drawer's one-off float was written once, by the winner.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement
          WHERE location_id = $1 AND movement_type = 'INITIAL_FLOAT'`,
        [h.drawerId],
      ),
    ).toBe(1);
  }, 120000);
});

describe('CASH-DEC-006 — a transfer confirmation racing the close', () => {
  it('either blocks the close or is already inside its count, never neither', async () => {
    const open = await env.admin.query<{
      shift_id: string;
      revision: number;
      opened_by_account_id: string;
    }>(
      `SELECT shift_id, revision, opened_by_account_id FROM platform.reception_shift
        WHERE hotel_id = $1 AND state = 'OPEN'`,
      [h.hotelId],
    );
    const shiftId = open.rows[0]?.shift_id as string;
    const revision = Number(open.rows[0]?.revision);
    // Whichever Reception won the race above owns the count (doc 03 §4.6).
    const owner =
      open.rows[0]?.opened_by_account_id === h.reception.principal.accountId
        ? h.reception
        : h.reception2;
    const safe = await env.cash2.createLocation(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('lc'),
        kind: 'SAFE',
        name: 'Сейф',
        code: `SAFE-${key('c')}`,
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    const transfer = await env.cash2.initiateTransfer(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('tr'),
        sourceLocationId: h.drawerId,
        destinationLocationId: safe.locationId,
        amountMnt: 10_000n,
      },
      h.manager,
      request(h.manager),
    );

    const [confirmed, closed] = await Promise.all([
      settle(
        env.cash2.confirmTransfer(
          {
            hotelId: h.hotelId,
            idempotencyKey: key('tc'),
            transferId: transfer.transferId,
            expectedRevision: transfer.revision,
            countedMnt: 10_000n,
          },
          h.reception,
          request(h.reception),
        ),
      ),
      settle(
        env.shifts.startClose(
          {
            hotelId: h.hotelId,
            shiftId,
            idempotencyKey: key('ct'),
            expectedRevision: revision,
            countedCashMnt: 15_000n,
          },
          owner,
          request(owner),
        ),
      ),
    ]);

    expect(confirmed.ok).toBe(true);
    if (closed.ok) {
      // The confirmation won: its outflow is inside the expectation the count
      // was measured against, so the shift's own numbers still add up.
      expect(closed.value.expectedCashMnt).toBe('15000');
      expect(closed.value.varianceMnt).toBe('0');
    } else {
      expect(closed.error.message).toContain('PENDING_TRANSFER');
    }
    // Either way the ledger holds exactly the two movements of one transfer.
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement WHERE transfer_id = $1`,
        [transfer.transferId],
      ),
    ).toBe(2);
  }, 120000);
});
