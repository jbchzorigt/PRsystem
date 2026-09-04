import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import { syntheticGuest } from '../stay/test-support/stay-harness';
import type { StayView } from '../stay/services/stay-views';
import type { ShiftView } from '../stay/services/shift.service';
import type { FinanceHarness, FinanceHotel } from './test-support/finance-harness';
import { createFinanceHarness, key, request } from './test-support/finance-harness';

/**
 * Phase 11 on real PostgreSQL, through the restricted API login.
 *
 * The shift as the unit of cash accountability; the ledger a guest's cash
 * actually reaches; the transfer that is two movements or none and blocks the
 * close until it is settled; the correction that never rewrites a closed shift;
 * and the expense whose approval moves nothing at all.
 */

let env: FinanceHarness;
let h: FinanceHotel;

beforeAll(async () => {
  env = await createFinanceHarness('finance_integration');
  h = await env.financeHotel('Finance Hotel');
  await env.configureDeposit(h, 50_000n);
}, 180000);

afterAll(async () => {
  env.travel(0);
  await env.close();
}, 30000);

async function refused(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a refusal');
}

async function openShift(actor = h.reception, openingCountedMnt = 0n): Promise<ShiftView> {
  return env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh'), openingCountedMnt },
    actor,
    request(actor),
  );
}

async function selfClose(shift: ShiftView, countedCashMnt: bigint, reason?: string) {
  return env.shifts.selfClose(
    {
      hotelId: h.hotelId,
      shiftId: shift.shiftId,
      idempotencyKey: key('sc'),
      expectedRevision: shift.revision,
      countedCashMnt,
      ...(reason === undefined ? {} : { reason }),
    },
    h.reception,
    request(h.reception),
  );
}

async function checkIn(): Promise<StayView> {
  const roomId = await h.cleanRoom();
  return env.checkIns.checkIn(
    {
      hotelId: h.hotelId,
      idempotencyKey: key('ci'),
      roomId,
      source: 'WALK_IN',
      stayType: 'HOURLY',
      halfHourUnits: 2,
      guest: syntheticGuest(),
    },
    h.reception,
    request(h.reception),
  );
}

async function drawerBalance(locationId = h.drawerId): Promise<string> {
  const view = await env.cash2.locations(
    { hotelId: h.hotelId },
    h.hotelAdmin,
    request(h.hotelAdmin),
  );
  const location = view.locations.find((row) => row.locationId === locationId);
  if (location === undefined) throw new Error('no such location');
  return location.balanceMnt ?? '0';
}

describe('the shift over a drawer (doc 03 §§4–6, CASH-DEC-001)', () => {
  it('opens on the counted float, takes the guest’s cash, and hands over on two counts', async () => {
    const shift = await openShift(h.reception, 100_000n);
    expect(shift.locationId).toBe(h.drawerId);
    expect(shift.openingBalanceMnt).toBe('100000');
    // doc 24 §3: the drawer's ledger starts once, at that count.
    expect(await drawerBalance()).toBe('100000');

    // A guest pays cash: it reaches the folio and the drawer in one transaction.
    const stay = await checkIn();
    await env.folios.postCharges(
      { hotelId: h.hotelId, stayId: stay.stayId, idempotencyKey: key('fc') },
      h.reception,
      request(h.reception),
    );
    await env.folios.pay(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('fp'),
        channel: 'CASH',
        amountMnt: 20_000n,
        shiftId: shift.shiftId,
      },
      h.reception,
      request(h.reception),
    );
    expect(await drawerBalance()).toBe('120000');

    const counted = await env.shifts.startClose(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('ct'),
        expectedRevision: shift.revision,
        countedCashMnt: 120_000n,
      },
      h.reception,
      request(h.reception),
    );
    expect(counted.state).toBe('CLOSING');
    expect(counted.expectedCashMnt).toBe('120000');
    expect(counted.varianceMnt).toBe('0');

    const handed = await env.shifts.handOver(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('ho'),
        expectedRevision: counted.revision,
        toAccountId: h.reception2.principal.accountId,
      },
      h.reception,
      request(h.reception),
    );
    expect(handed.state).toBe('HANDED_OVER');

    // Only the Reception it was handed to may accept it.
    const wrongHands = await refused(
      env.shifts.acceptCash(
        {
          hotelId: h.hotelId,
          shiftId: shift.shiftId,
          idempotencyKey: key('ac'),
          expectedRevision: handed.revision,
          incomingCountedMnt: 120_000n,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(wrongHands.code).toBe('FORBIDDEN');

    const accepted = await env.shifts.acceptCash(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('ac'),
        expectedRevision: handed.revision,
        incomingCountedMnt: 120_000n,
      },
      h.reception2,
      request(h.reception2),
    );
    expect(accepted.state).toBe('CASH_ACCEPTED');
    expect(accepted.incomingCountedMnt).toBe('120000');

    const closed = await env.shifts.close(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('cl'),
        expectedRevision: accepted.revision,
      },
      h.reception2,
      request(h.reception2),
    );
    expect(closed.state).toBe('CLOSED');
    // `SHIFT-DEC-001`: the review runs beside the operation, not in front of it.
    expect(closed.reviewState).toBe('PENDING_MANAGER');

    const reviewed = await env.shifts.review(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('rv'),
        expectedRevision: closed.revision,
        decision: 'ACCEPT',
      },
      h.manager,
      request(h.manager),
    );
    expect(reviewed.reviewState).toBe('RESOLVED');
    expect(reviewed.selfReviewed).toBe(false);
  }, 120000);

  it('refuses a second shift on the same drawer, and the opening count is written once', async () => {
    const shift = await openShift(h.reception, 5_000n);
    const second = await refused(openShift(h.reception2, 5_000n));
    expect(second.message).toContain('SHIFT_ALREADY_OPEN');
    // `SHIFT-DEC-006`: the database refuses an overwritten opening balance.
    const overwrite = await refused(
      env.admin.query(
        `UPDATE platform.reception_shift SET opening_balance_mnt = 1, revision = revision + 1
          WHERE shift_id = $1`,
        [shift.shiftId],
      ),
    );
    expect(overwrite.message).toContain('written once');
    await selfClose(shift, 5_000n);
  }, 90000);

  it('SHIFT-DEC-003: a self-close with no variance needs no review, and one with a variance waits for the Hotel Admin', async () => {
    const clean = await openShift(h.reception, 0n);
    const closedClean = await selfClose(clean, 0n);
    expect(closedClean.state).toBe('SELF_CLOSED');
    expect(closedClean.reviewState).toBe('NOT_REQUIRED');

    const short = await openShift(h.reception, 10_000n);
    const noReason = await refused(selfClose(short, 8_000n));
    expect(noReason.message).toContain('reason');
    const closedShort = await selfClose(short, 8_000n, 'two notes missing at the count');
    expect(closedShort.varianceMnt).toBe('-2000');
    expect(closedShort.reviewState).toBe('PENDING_HOTEL_ADMIN');

    // A Manager cannot take the Hotel Admin's review.
    const manager = await refused(
      env.shifts.review(
        {
          hotelId: h.hotelId,
          shiftId: closedShort.shiftId,
          idempotencyKey: key('rv'),
          expectedRevision: closedShort.revision,
          decision: 'ACCEPT',
          reason: 'accepted',
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(manager.code).toBe('CONFLICT');

    // `SHIFT-DEC-005`: a rejection cannot reopen a closed shift.
    const disputed = await env.shifts.adminReview(
      {
        hotelId: h.hotelId,
        shiftId: closedShort.shiftId,
        idempotencyKey: key('rj'),
        expectedRevision: closedShort.revision,
        decision: 'REJECT',
        reason: 'the count does not match the ledger',
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    expect(disputed.reviewState).toBe('DISPUTED');
    expect(disputed.state).toBe('SELF_CLOSED');
  }, 120000);
});

describe('the transfer (doc 24 §9, CASH-DEC-006)', () => {
  // Its own hotel: a drawer's ledger is cumulative, and these balances are the
  // assertion, so the group starts from a drawer nothing else has spent from.
  beforeAll(async () => {
    h = await env.financeHotel('Transfer Hotel');
  }, 180000);

  it('is two movements or none, and a shift cannot close while it is pending', async () => {
    const shift = await openShift(h.reception, 60_000n);
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
        amountMnt: 40_000n,
      },
      h.manager,
      request(h.manager),
    );
    expect(transfer.state).toBe('PENDING');
    expect(transfer.kind).toBe('DRAWER_SAFE');
    // The money is in neither balance until it is counted.
    expect(await drawerBalance()).toBe('60000');
    expect(await drawerBalance(safe.locationId)).toBe('0');

    const blocked = await refused(
      env.shifts.startClose(
        {
          hotelId: h.hotelId,
          shiftId: shift.shiftId,
          idempotencyKey: key('ct'),
          expectedRevision: shift.revision,
          countedCashMnt: 20_000n,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(blocked.message).toContain('PENDING_TRANSFER');

    const confirmed = await env.cash2.confirmTransfer(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('tc'),
        transferId: transfer.transferId,
        expectedRevision: transfer.revision,
        countedMnt: 40_000n,
      },
      h.reception,
      request(h.reception),
    );
    expect(confirmed.state).toBe('COMPLETED');
    expect(await drawerBalance()).toBe('20000');
    expect(await drawerBalance(safe.locationId)).toBe('40000');

    const counted = await env.shifts.startClose(
      {
        hotelId: h.hotelId,
        shiftId: shift.shiftId,
        idempotencyKey: key('ct2'),
        expectedRevision: shift.revision,
        countedCashMnt: 20_000n,
      },
      h.reception,
      request(h.reception),
    );
    expect(counted.expectedCashMnt).toBe('20000');
    expect(counted.varianceMnt).toBe('0');
    await selfClose({ ...counted }, 20_000n);
  }, 120000);

  it('refuses more cash than the drawer holds, and a cancellation moves nothing', async () => {
    const shift = await openShift(h.reception, 10_000n);
    const other = await env.cash2.createLocation(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('lc'),
        kind: 'DRAWER',
        name: 'Хоёрдугаар касс',
        code: `DRW-${key('c')}`,
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    const tooMuch = await refused(
      env.cash2.initiateTransfer(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('tr'),
          sourceLocationId: h.drawerId,
          destinationLocationId: other.locationId,
          amountMnt: 999_000n,
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(tooMuch.message).toContain('INSUFFICIENT_CASH');

    // A drawer with no shift over it takes no movement at all.
    const noShift = await refused(
      env.cash2.topUp(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('tu'),
          locationId: other.locationId,
          amountMnt: 1_000n,
          reason: 'a float for the second drawer',
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(noShift.message).toContain('NO_ACTIVE_SHIFT');

    const safeRow = await env.admin.query<{ cash_location_id: string }>(
      `SELECT cash_location_id FROM platform.cash_location
        WHERE hotel_id = $1 AND kind = 'SAFE'`,
      [h.hotelId],
    );
    const safeId = safeRow.rows[0]?.cash_location_id as string;
    const transfer = await env.cash2.initiateTransfer(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('tr2'),
        sourceLocationId: h.drawerId,
        destinationLocationId: safeId,
        amountMnt: 5_000n,
      },
      h.manager,
      request(h.manager),
    );
    const cancelled = await env.cash2.cancelTransfer(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('tx'),
        transferId: transfer.transferId,
        expectedRevision: transfer.revision,
        recountMnt: 10_000n,
        reason: 'the envelope never left the drawer',
      },
      h.reception,
      request(h.reception),
    );
    expect(cancelled.state).toBe('CANCELLED');
    // The 20,000₮ the first transfer left behind, untouched by the cancellation.
    expect(await drawerBalance()).toBe('20000');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement WHERE transfer_id = $1`,
        [transfer.transferId],
      ),
    ).toBe(0);
    await selfClose(shift, 10_000n);
  }, 120000);
});

describe('the correction (CASH-DEC-004, SHIFT-DEC-006)', () => {
  // Its own hotel: a drawer's ledger is cumulative, and these balances are the
  // assertion, so the group starts from a drawer nothing else has spent from.
  beforeAll(async () => {
    h = await env.financeHotel('Correction Hotel');
  }, 180000);

  it('is a new movement in the shift it is effective in, and never rewrites the closed one', async () => {
    const first = await openShift(h.reception, 30_000n);
    const topUp = await env.cash2.topUp(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('tu'),
        locationId: h.drawerId,
        amountMnt: 10_000n,
        reason: 'the owner added change',
      },
      h.manager,
      request(h.manager),
    );
    await selfClose(first, 40_000n);
    const closedMovements = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM platform.cash_movement WHERE shift_id = $1`,
      [first.shiftId],
    );

    const second = await openShift(h.reception, 40_000n);
    const correction = await env.cash2.correct(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('cx'),
        originalMovementId: topUp.movementId,
        amountMnt: 2_000n,
        direction: 'OUT',
        reason: 'the top-up was counted 2,000₮ too high',
      },
      h.manager,
      request(h.manager),
    );
    expect(correction.movementType).toBe('CASH_CORRECTION_OUT');
    expect(correction.originalMovementId).toBe(topUp.movementId);
    // The correction belongs to the open shift, not the closed one.
    expect(correction.shiftId).toBe(second.shiftId);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement WHERE shift_id = $1`,
        [first.shiftId],
      ),
    ).toBe(closedMovements);
    expect(await drawerBalance()).toBe('38000');

    // The original movement itself is untouchable.
    const edited = await refused(
      env.admin.query(`UPDATE platform.cash_movement SET amount_mnt = 1 WHERE movement_id = $1`, [
        topUp.movementId,
      ]),
    );
    expect(edited.message).toMatch(/append-only|not permitted|reject/i);
    await selfClose(second, 38_000n);
  }, 120000);
});

describe('the expense (FIN-DEC-005, CASH-DEC-005)', () => {
  // Its own hotel: a drawer's ledger is cumulative, and these balances are the
  // assertion, so the group starts from a drawer nothing else has spent from.
  beforeAll(async () => {
    h = await env.financeHotel('Expense Hotel');
  }, 180000);

  it('moves no cash when it is approved, moves a drawer only when it is paid in cash', async () => {
    const shift = await openShift(h.reception, 50_000n);
    const expense = await env.expenses2.submit(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ex'),
        category: 'Ариун цэврийн хэрэглэл',
        description: 'cleaning supplies',
        amountMnt: 12_000n,
        method: 'CASH',
      },
      h.manager,
      request(h.manager),
    );
    expect(expense.state).toBe('SUBMITTED');

    // A Manager cannot approve; a Hotel Admin can.
    const notManager = await refused(
      env.expenses2.decide(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('ed'),
          expenseId: expense.expenseId,
          expectedRevision: expense.revision,
          decision: 'APPROVE',
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(notManager.code).toBe('NOT_FOUND');

    const approved = await env.expenses2.decide(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ed'),
        expenseId: expense.expenseId,
        expectedRevision: expense.revision,
        decision: 'APPROVE',
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    expect(approved.state).toBe('APPROVED');
    // `FIN-DEC-005`: an approval is not an outflow.
    expect(await drawerBalance()).toBe('50000');

    const paid = await env.expenses2.pay(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ep'),
        expenseId: approved.expenseId,
        expectedRevision: approved.revision,
        locationId: h.drawerId,
      },
      h.manager,
      request(h.manager),
    );
    expect(paid.state).toBe('PAID');
    expect(paid.shiftId).toBe(shift.shiftId);
    expect(await drawerBalance()).toBe('38000');

    // A card payment records the provider's reference and moves no drawer.
    const card = await env.expenses2.submit(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ex2'),
        category: 'Тоног төхөөрөмж',
        description: 'a kettle for room 12',
        amountMnt: 90_000n,
        method: 'CARD_POS',
      },
      h.manager,
      request(h.manager),
    );
    const cardApproved = await env.expenses2.decide(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ed2'),
        expenseId: card.expenseId,
        expectedRevision: card.revision,
        decision: 'APPROVE',
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    const noReference = await refused(
      env.expenses2.pay(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('ep2'),
          expenseId: card.expenseId,
          expectedRevision: cardApproved.revision,
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(noReference.code).toBe('VALIDATION_FAILED');
    const cardPaid = await env.expenses2.pay(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('ep2'),
        expenseId: card.expenseId,
        expectedRevision: cardApproved.revision,
        providerReference: 'POS-448291',
      },
      h.manager,
      request(h.manager),
    );
    expect(cardPaid.state).toBe('PAID');
    expect(cardPaid.movementId).toBeNull();
    expect(await drawerBalance()).toBe('38000');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.cash_movement WHERE expense_id = $1`,
        [card.expenseId],
      ),
    ).toBe(0);
    await selfClose(shift, 38_000n);
  }, 150000);
});

describe('the bank deposit and the owner withdrawal (doc 24 §10)', () => {
  // Its own hotel: a drawer's ledger is cumulative, and these balances are the
  // assertion, so the group starts from a drawer nothing else has spent from.
  beforeAll(async () => {
    h = await env.financeHotel('Banking Hotel');
  }, 180000);

  it('approving is the outflow, and refusing moves nothing', async () => {
    const shift = await openShift(h.reception, 80_000n);
    const deposit = await env.cashRequests.create(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('br'),
        kind: 'BANK_DEPOSIT',
        locationId: h.drawerId,
        amountMnt: 50_000n,
        reason: 'the weekly banking',
        reference: 'KHAN-4410',
      },
      h.manager,
      request(h.manager),
    );
    expect(deposit.state).toBe('PENDING');
    expect(await drawerBalance()).toBe('80000');

    const approved = await env.cashRequests.decide(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('bd'),
        requestId: deposit.requestId,
        expectedRevision: deposit.revision,
        decision: 'APPROVE',
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    expect(approved.state).toBe('APPROVED');
    expect(approved.movementId).not.toBeNull();
    expect(await drawerBalance()).toBe('30000');

    const withdrawal = await env.cashRequests.create(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('wr'),
        kind: 'OWNER_WITHDRAWAL',
        locationId: h.drawerId,
        amountMnt: 20_000n,
        reason: 'the owner asked for cash',
        recipient: 'the owner',
      },
      h.manager,
      request(h.manager),
    );
    const rejected = await env.cashRequests.decide(
      {
        hotelId: h.hotelId,
        idempotencyKey: key('wd'),
        requestId: withdrawal.requestId,
        expectedRevision: withdrawal.revision,
        decision: 'REJECT',
        reason: 'not this week',
      },
      h.hotelAdmin,
      request(h.hotelAdmin),
    );
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.movementId).toBeNull();
    expect(await drawerBalance()).toBe('30000');
    await selfClose(shift, 30_000n);
  }, 120000);
});
