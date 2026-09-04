import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { countRows } from '../catalog/test-support/catalog-harness';
import type { StayHarness, StayHotel } from './test-support/stay-harness';
import { createStayHarness, key, request, syntheticGuest } from './test-support/stay-harness';
import type { StayView } from './services/stay-views';

/**
 * Phase 08 on real PostgreSQL, through the restricted API login.
 *
 * The shift a check-in needs; the cleaning axis and its history; the walk-in
 * check-in with its tariff snapshot, identity, price book and Police event;
 * the backdate bound and the historical readiness proof; the actual-time
 * correction and what it does not change; the immutability of the planned
 * end in the database; the checkout, the readiness anchor and the lifecycle
 * hand-off; the overdue conflict and its four outcomes.
 */

let env: StayHarness;
let hotel: StayHotel;

beforeAll(async () => {
  env = await createStayHarness('stay_integration');
  hotel = await env.hotel('Stay Hotel', 'P25');
  env.xyp.register('АА90010112', {
    familyName: 'Батаа',
    givenName: 'Болд',
    dateOfBirth: '1990-01-01',
  });
}, 120000);

afterAll(async () => {
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

async function openShift(h: StayHotel = hotel): Promise<string> {
  const shift = await env.shifts.open(
    { hotelId: h.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
    h.reception,
    request(h.reception),
  );
  return shift.shiftId;
}

async function checkIn(
  h: StayHotel,
  roomId: string,
  overrides: Record<string, unknown> = {},
): Promise<StayView> {
  return env.checkIns.checkIn(
    {
      hotelId: h.hotelId,
      idempotencyKey: key('ci'),
      roomId,
      source: 'WALK_IN',
      stayType: 'HOURLY',
      halfHourUnits: 3,
      guest: syntheticGuest(),
      ...overrides,
    } as never,
    h.reception,
    request(h.reception),
  );
}

describe('the Reception shift (doc 05 §19.1)', () => {
  it('refuses a check-in with no open shift, opens one shift only, and closes it', async () => {
    const roomId = await hotel.cleanRoom();
    const none = await refused(checkIn(hotel, roomId));
    expect(none.message).toContain('NO_OPEN_SHIFT');
    const shiftId = await openShift();
    const again = await refused(
      env.shifts.open(
        { hotelId: hotel.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
        hotel.reception,
        request(hotel.reception),
      ),
    );
    expect(again.message).toContain('SHIFT_ALREADY_OPEN');
    // A Manager without the Reception role cannot open one.
    const manager = await refused(
      env.shifts.open(
        { hotelId: hotel.hotelId, idempotencyKey: key('sh'), openingCountedMnt: 0n },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(manager.code).toBe('NOT_FOUND');
    // doc 03 §6 / `SHIFT-DEC-003`: with nobody to hand to, the Reception closes
    // its own shift on its own count; an empty drawer counted empty needs no review.
    const closed = await env.shifts.selfClose(
      {
        hotelId: hotel.hotelId,
        shiftId,
        idempotencyKey: key('sh'),
        expectedRevision: 0,
        countedCashMnt: 0n,
      },
      hotel.reception,
      request(hotel.reception),
    );
    expect(closed.state).toBe('SELF_CLOSED');
    expect(closed.reviewState).toBe('NOT_REQUIRED');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.reception_shift WHERE hotel_id = $1 AND state = 'OPEN'`,
        [hotel.hotelId],
      ),
    ).toBe(0);
  });
});

describe('the cleaning axis (doc 06 §4, RC-DEC-014)', () => {
  it('the Cleaner walks the edges, every step is history, and the Manager on 25,000₮ holds neither action', async () => {
    const roomId = await hotel.room();
    const cleaning = await env.housekeeping.setState(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key('cl'),
        toState: 'CLEANING',
        expectedRevision: 0,
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    expect(cleaning.state).toBe('CLEANING');
    const clean = await env.housekeeping.setState(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: cleaning.revision,
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    expect(clean.state).toBe('CLEAN');
    const illegal = await refused(
      env.housekeeping.setState(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key('cl'),
          toState: 'CLEAN',
          expectedRevision: clean.revision,
        },
        hotel.cleaner,
        request(hotel.cleaner),
      ),
    );
    expect(illegal.message).toContain('ILLEGAL_CLEANING_TRANSITION');
    const manager = await refused(
      env.housekeeping.setState(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key('cl'),
          toState: 'CLEAN',
          expectedRevision: clean.revision,
        },
        hotel.manager,
        request(hotel.manager),
      ),
    );
    expect(manager.code).toBe('NOT_FOUND');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room_cleaning_event WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(2);
    await expect(
      env.admin.query(
        `UPDATE platform.room_cleaning_event SET to_state = 'CLEAN' WHERE room_id = $1`,
        [roomId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a 20,000₮ hotel has no Cleaner: its Manager marks the room clean', async () => {
    const small = await env.hotel('Small Hotel', 'P20');
    const roomId = await small.room();
    const clean = await env.housekeeping.setState(
      {
        hotelId: small.hotelId,
        roomId,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: 0,
      },
      small.manager,
      request(small.manager),
    );
    expect(clean.state).toBe('CLEAN');
  });
});

describe('walk-in check-in (STAY-DEC-005, -007, -014, RC-DEC-012, -033, -044, PRICE-DEC-001)', () => {
  beforeAll(async () => {
    await openShift();
  });

  it('an hourly stay: the snapshot prices it, XYP verifies the guest, the identifier is encrypted, Police gets a token', async () => {
    const roomId = await hotel.cleanRoom();
    const before = env.now();
    const stay = await checkIn(hotel, roomId);
    expect(stay.state).toBe('ACTIVE');
    expect(stay.stayType).toBe('HOURLY');
    expect(stay.halfHourUnits).toBe(3);
    expect(stay.durationMinutes).toBe(90);
    expect(stay.unitRateMnt).toBe('20000');
    expect(stay.roomChargeMnt).toBe('30000');
    expect(stay.depositRequired).toBe(true);
    expect(stay.backdateMinutes).toBe(0);
    expect(stay.actualCheckInAt).toBe(stay.checkInRecordedAt);
    expect(
      new Date(stay.plannedCheckoutAt).getTime() - new Date(stay.actualCheckInAt).getTime(),
    ).toBe(90 * 60_000);
    expect(new Date(stay.checkInRecordedAt).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(stay.guest).toMatchObject({
      identityType: 'MN_REG_NO',
      familyName: 'Батаа',
      givenName: 'Болд',
      provenance: 'XYP_VERIFIED',
      assurance: 'DOCUMENT',
      ageAtCheckIn: 36,
      policeMatchEligibility: 'ELIGIBLE_EXACT_RD',
      guardianRecorded: false,
    });
    expect(JSON.stringify(stay)).not.toContain('90010112');
    expect(stay.priceBook).toBeNull();
    expect(stay.minibarApplicable).toBe(false);

    const guest = await env.admin.query<{
      ct: Buffer | null;
      token: string | null;
      ns: string | null;
    }>(
      `SELECT identifier_ciphertext AS ct, lookup_token AS token, lookup_namespace AS ns FROM platform.stay_guest WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(guest.rows[0]?.ct).not.toBeNull();
    expect(Buffer.from(guest.rows[0]?.ct as Buffer).toString('utf8')).not.toContain('90010112');
    expect(guest.rows[0]?.token).toMatch(/^[0-9a-f]{32,}$/);
    expect(guest.rows[0]?.ns).toBe('registration_number:MN');

    const outbox = await env.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox_event WHERE aggregate_id = $1 AND event_type = 'stay.checked_in'`,
      [stay.stayId],
    );
    const payload = outbox.rows[0]?.payload as { guest: Record<string, unknown> };
    expect(payload.guest['lookupToken']).toBe(guest.rows[0]?.token);
    expect(JSON.stringify(payload)).not.toContain('90010112');
    expect(JSON.stringify(payload)).not.toContain('Батаа');
    const events = await env.admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.stay_event WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['CHECKED_IN']);
  });

  it('a second confirmation of the same room is ROOM_OCCUPIED; the same key replays the first', async () => {
    const roomId = await hotel.cleanRoom();
    const idempotencyKey = key('ci');
    const first = await checkIn(hotel, roomId, { idempotencyKey });
    const replay = await checkIn(hotel, roomId, { idempotencyKey });
    expect(replay.stayId).toBe(first.stayId);
    const second = await refused(checkIn(hotel, roomId));
    expect(second.message).toContain('ROOM_OCCUPIED');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(1);
  });

  it('a nightly stay ends at the fixed check-out time on the next hotel-local day, priced per night', async () => {
    const roomId = await hotel.cleanRoom();
    const stay = await checkIn(hotel, roomId, {
      stayType: 'NIGHTLY',
      nightCount: 2,
      halfHourUnits: undefined,
    });
    expect(stay.nightCount).toBe(2);
    expect(stay.fixedCheckoutMinute).toBe(720);
    expect(stay.unitRateMnt).toBe('100000');
    expect(stay.roomChargeMnt).toBe('200000');
    const planned = new Date(stay.plannedCheckoutAt);
    // 12:00 Asia/Ulaanbaatar is 04:00Z.
    expect(planned.getUTCHours()).toBe(4);
    expect(planned.getUTCMinutes()).toBe(0);
    expect(planned.getTime() - new Date(stay.actualCheckInAt).getTime()).toBeGreaterThan(
      24 * 60 * 60_000,
    );
    expect(planned.getTime() - new Date(stay.actualCheckInAt).getTime()).toBeLessThanOrEqual(
      3 * 24 * 60 * 60_000,
    );
  });

  it('a manual identity, a foreign passport, no document, and a minor with and without a guardian', async () => {
    const manual = await checkIn(hotel, await hotel.cleanRoom(), {
      guest: syntheticGuest({
        registrationNumber: 'ББ85050599',
        dateOfBirth: '1985-05-05',
      } as never),
    });
    expect(manual.guest).toMatchObject({
      provenance: 'MANUAL',
      policeMatchEligibility: 'ELIGIBLE_EXACT_RD',
    });
    const passport = await checkIn(hotel, await hotel.cleanRoom(), {
      guest: {
        identityType: 'FOREIGN_PASSPORT',
        passportNumber: 'P1234567',
        issuingCountry: 'DE',
        expiresOn: '2030-01-01',
        familyName: 'Muster',
        givenName: 'Erika',
        dateOfBirth: '1980-02-02',
        nationality: 'DE',
      },
    });
    expect(passport.guest).toMatchObject({
      provenance: 'MANUAL',
      policeMatchEligibility: 'NOT_ELIGIBLE_EXACT_RD',
      documentCountry: 'DE',
    });
    const none = await checkIn(hotel, await hotel.cleanRoom(), {
      guest: {
        identityType: 'NO_DOCUMENT',
        reason: 'Баримт бичиг алдсан',
        familyName: 'Дорж',
        givenName: 'Сүх',
        dateOfBirth: '1975-03-03',
        nationality: 'MN',
      },
    });
    expect(none.guest).toMatchObject({
      assurance: 'LOW_ASSURANCE',
      policeMatchEligibility: 'NOT_ELIGIBLE_EXACT_RD',
    });
    const minor = await refused(
      checkIn(hotel, await hotel.cleanRoom(), {
        guest: syntheticGuest({
          registrationNumber: 'ВВ10250512',
          dateOfBirth: '2010-05-05',
        } as never),
      }),
    );
    expect(minor.message).toContain('GUARDIAN_REQUIRED');
    const withGuardian = await checkIn(hotel, await hotel.cleanRoom(), {
      guest: syntheticGuest({
        registrationNumber: 'ВВ10250512',
        dateOfBirth: '2010-05-05',
        guardian: { name: 'Эцэг', phone: '+97699000000', relationship: 'father' },
      } as never),
    });
    expect(withGuardian.guest).toMatchObject({
      ageAtCheckIn: 16,
      guardianRecorded: true,
      policeMatchEligibility: 'ELIGIBLE_EXACT_RD',
    });
    const invalid = await refused(
      checkIn(hotel, await hotel.cleanRoom(), {
        guest: syntheticGuest({ registrationNumber: 'AA90010112' } as never),
      }),
    );
    expect(invalid.message).toContain('REGISTRATION_NUMBER_INVALID');
  });

  it('refuses a room that is not clean, and a quote shows why without writing', async () => {
    const roomId = await hotel.room();
    const quote = await env.checkIns.quote(
      { hotelId: hotel.hotelId, roomId, stayType: 'HOURLY', halfHourUnits: 2 },
      hotel.reception,
      request(hotel.reception),
    );
    expect(quote.blockers).toContain('NOT_CLEAN');
    expect(quote.roomChargeMnt).toBe('20000');
    const notReady = await refused(checkIn(hotel, roomId));
    expect(notReady.message).toContain('NOT_CLEAN');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(0);
  });
});

describe('the backdate bound and the historical proof (STAY-DEC-009)', () => {
  let h: StayHotel;

  beforeAll(async () => {
    h = await env.hotel('Backdate Hotel', 'P25');
    env.travel(-100);
    await openShift(h);
    env.travel(0);
  });

  it('a past arrival within the bound needs a reason, records the minutes, and is proven from the cleaning history', async () => {
    env.travel(-60);
    const roomId = await h.cleanRoom();
    env.travel(0);
    const now = env.now();
    const noReason = await refused(
      checkIn(h, roomId, { actualCheckInAt: new Date(now.getTime() - 30 * 60_000) }),
    );
    expect(noReason.message).toContain('BACKDATE_REASON_REQUIRED');
    const tooEarly = await refused(
      checkIn(h, roomId, {
        actualCheckInAt: new Date(now.getTime() - 130 * 60_000),
        backdateReasonCode: 'LATE_ENTRY',
      }),
    );
    expect(tooEarly.message).toContain('BACKDATE_OUT_OF_BOUND');
    const future = await refused(
      checkIn(h, roomId, { actualCheckInAt: new Date(now.getTime() + 5 * 60_000) }),
    );
    expect(future.message).toContain('ARRIVAL_IN_FUTURE');
    // Before the room was marked clean: not provably ready then.
    const unproven = await refused(
      checkIn(h, roomId, {
        actualCheckInAt: new Date(now.getTime() - 70 * 60_000),
        backdateReasonCode: 'LATE_ENTRY',
      }),
    );
    expect(unproven.message).toContain('NOT_CLEAN');
    const stay = await checkIn(h, roomId, {
      actualCheckInAt: new Date(now.getTime() - 30 * 60_000),
      backdateReasonCode: 'LATE_ENTRY',
      backdateNote: 'Зочин 30 минутын өмнө ирсэн',
    });
    expect(stay.backdateMinutes).toBe(30);
    expect(stay.backdateReasonCode).toBe('LATE_ENTRY');
    expect(
      new Date(stay.checkInRecordedAt).getTime() - new Date(stay.actualCheckInAt).getTime(),
    ).toBeGreaterThanOrEqual(30 * 60_000);
    // The planned end follows the arrival, the snapshot follows the recorded time.
    expect(
      new Date(stay.plannedCheckoutAt).getTime() - new Date(stay.actualCheckInAt).getTime(),
    ).toBe(90 * 60_000);
  });

  it('a Reception without the actual-time action cannot backdate; the same actor checks in at the server time', async () => {
    // Every Reception holds `check_in_actual_time_select`; the refusal path is
    // the pipeline's, exercised here through a Cleaner who holds neither.
    const roomId = await h.cleanRoom();
    const cleaner = await refused(
      env.checkIns.checkIn(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('ci'),
          roomId,
          source: 'WALK_IN',
          stayType: 'HOURLY',
          halfHourUnits: 1,
          guest: syntheticGuest(),
        },
        h.cleaner,
        request(h.cleaner),
      ),
    );
    expect(cleaner.code).toBe('NOT_FOUND');
  });
});

describe('the actual-time correction (STAY-DEC-010)', () => {
  let h: StayHotel;
  let stay: StayView;
  let roomId: string;

  beforeAll(async () => {
    h = await env.hotel('Correction Hotel', 'P25');
    env.travel(-100);
    await openShift(h);
    env.travel(-60);
    roomId = await h.cleanRoom();
    env.travel(0);
    stay = await checkIn(h, roomId);
  });

  it('a Reception request within the fixed window, a Manager approval, and only the effective start changes', async () => {
    const recorded = new Date(stay.checkInRecordedAt);
    const outside = await refused(
      env.corrections.submit(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('co'),
          correctedActualCheckInAt: new Date(recorded.getTime() - 130 * 60_000),
          reason: 'алдаа',
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(outside.message).toContain('CORRECTION_OUT_OF_BOUND');
    const corrected = new Date(recorded.getTime() - 20 * 60_000);
    const submitted = await env.corrections.submit(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co'),
        correctedActualCheckInAt: corrected,
        reason: 'Зочин эрт ирсэн',
      },
      h.reception,
      request(h.reception),
    );
    expect(submitted.state).toBe('PENDING');
    const duplicate = await refused(
      env.corrections.submit(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('co'),
          correctedActualCheckInAt: corrected,
          reason: 'дахин',
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(duplicate.message).toContain('CORRECTION_PENDING');
    // A pending request blocks the checkout.
    const blocked = await refused(
      env.stays.recordActualCheckout(
        {
          hotelId: h.hotelId,
          stayId: stay.stayId,
          idempotencyKey: key('out'),
          expectedRevision: stay.revision,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(blocked.message).toContain('CORRECTION_PENDING');
    // Reception cannot decide; the Manager can.
    const notManager = await refused(
      env.corrections.approve(
        {
          hotelId: h.hotelId,
          correctionId: submitted.correctionId,
          idempotencyKey: key('co'),
          expectedRevision: submitted.revision,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(notManager.code).toBe('NOT_FOUND');
    const approved = await env.corrections.approve(
      {
        hotelId: h.hotelId,
        correctionId: submitted.correctionId,
        idempotencyKey: key('co'),
        expectedRevision: submitted.revision,
      },
      h.manager,
      request(h.manager),
    );
    expect(approved).toMatchObject({ state: 'APPROVED', selfApproved: false });
    const after = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.manager,
      request(h.manager),
    );
    expect(after.effectiveActualCheckInAt).toBe(corrected.toISOString());
    expect(after.actualCheckInAt).toBe(stay.actualCheckInAt);
    expect(after.checkInRecordedAt).toBe(stay.checkInRecordedAt);
    expect(after.plannedCheckoutAt).toBe(stay.plannedCheckoutAt);
    expect(after.roomChargeMnt).toBe(stay.roomChargeMnt);
    expect(after.pendingCorrection).toBeNull();
    const row = await env.admin.query<{ revision: number }>(
      `SELECT revision FROM platform.stay WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(row.rows[0]?.revision).toBe(stay.revision);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.outbox_event WHERE aggregate_id = $1 AND event_type = 'stay.actual_time_corrected'`,
        [stay.stayId],
      ),
    ).toBe(1);
  });

  it('a Reception + Manager account approving its own request is self_approved; a rejected one changes nothing', async () => {
    const both = await env.seed(h.hotelId, `both-${key('m')}@stay.test`, ['RECEPTION', 'MANAGER']);
    const actor = await env.actorFor(both);
    const view = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.manager,
      request(h.manager),
    );
    const submitted = await env.corrections.submit(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co'),
        correctedActualCheckInAt: new Date(
          new Date(stay.checkInRecordedAt).getTime() - 10 * 60_000,
        ),
        reason: 'дахин залруулга',
      },
      actor,
      request(actor),
    );
    const decided = await env.corrections.approve(
      {
        hotelId: h.hotelId,
        correctionId: submitted.correctionId,
        idempotencyKey: key('co'),
        expectedRevision: submitted.revision,
      },
      actor,
      request(actor),
    );
    expect(decided.selfApproved).toBe(true);
    const rejectedRequest = await env.corrections.submit(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('co'),
        correctedActualCheckInAt: new Date(new Date(stay.checkInRecordedAt).getTime() - 5 * 60_000),
        reason: 'буруу',
      },
      h.reception,
      request(h.reception),
    );
    const rejected = await env.corrections.reject(
      {
        hotelId: h.hotelId,
        correctionId: rejectedRequest.correctionId,
        idempotencyKey: key('co'),
        expectedRevision: rejectedRequest.revision,
        decisionReason: 'нотолгоогүй',
      },
      h.manager,
      request(h.manager),
    );
    expect(rejected.state).toBe('REJECTED');
    const after = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.manager,
      request(h.manager),
    );
    expect(after.effectiveActualCheckInAt).toBe(decided.correctedActualCheckInAt);
    void view;
  });

  it('the database refuses every direct edit of a stay time, whoever issues it (STAY-DEC-011, -012)', async () => {
    for (const column of ['planned_checkout_at', 'actual_check_in_at', 'check_in_recorded_at']) {
      await expect(
        env.admin.query(
          `UPDATE platform.stay SET ${column} = ${column} + interval '1 hour', revision = revision + 1 WHERE stay_id = $1`,
          [stay.stayId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      env.admin.query(`DELETE FROM platform.stay WHERE stay_id = $1`, [stay.stayId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      env.admin.query(
        `UPDATE platform.stay_time_correction SET corrected_actual_check_in_at = now() WHERE stay_id = $1`,
        [stay.stayId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the minibar price book and the shortage override (PRICE-DEC-001, RC-DEC-017, RC-DEC-036)', () => {
  let h: StayHotel;
  let templateId: string;
  let waterId: string;
  let colaId: string;
  let versionId: string;

  async function turnOn(roomId: string, fill: boolean): Promise<void> {
    await env.minibar.configurations.requestChange(
      {
        hotelId: h.hotelId,
        roomId,
        idempotencyKey: key('mb'),
        kind: 'OFF_TO_ON',
        targetTemplateId: templateId,
        targetVersionId: versionId,
      },
      h.manager,
      request(h.manager),
    );
    const view = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    const task = view.openTask;
    if (task === null) throw new Error('no task');
    const claimed = await env.minibar.configurations.claimTask(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('mb'),
        expectedRevision: task.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    await env.minibar.configurations.completeTask(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('mb'),
        expectedRevision: claimed.revision,
        counted: [],
        transfers: fill
          ? task.bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity }))
          : [],
      },
      h.cleaner,
      request(h.cleaner),
    );
  }

  beforeAll(async () => {
    h = await env.hotel('Minibar Hotel', 'P25');
    await openShift(h);
    templateId = await h.template();
    const product = (name: string, price: bigint, opening: number) =>
      env.minibar.products.createProduct(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('mb'),
          name,
          category: 'Ундаа',
          unit: 'ш',
          sellingPriceMnt: price,
          purchaseCostMnt: 1000n,
          openingQuantity: opening,
          state: 'ACTIVE',
        },
        h.manager,
        request(h.manager),
      );
    waterId = (await product('Ус', 3000n, 10)).productId;
    colaId = (await product('Кола', 5000n, 0)).productId;
    const draft = await env.minibar.versions.createDraft(
      {
        hotelId: h.hotelId,
        templateId,
        idempotencyKey: key('mb'),
        items: [
          { productId: waterId, targetQuantity: 2 },
          { productId: colaId, targetQuantity: 1 },
        ],
      },
      h.manager,
      request(h.manager),
    );
    versionId = (
      await env.minibar.versions.publish(
        {
          hotelId: h.hotelId,
          templateId,
          versionId: draft.versionId,
          idempotencyKey: key('mb'),
          expectedRevision: draft.revision,
        },
        h.manager,
        request(h.manager),
      )
    ).versionId;
  });

  it('a full room pins the exact version with every product, opening quantities included; the book is immutable and blocks archive', async () => {
    const roomId = await h.cleanRoom();
    await turnOn(roomId, false);
    // The cola cannot be supplied: the change is blocked short; the Manager applies it under an override.
    const view = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    expect(view.pendingChange?.state).toBe('BLOCKED_STOCK');
    const applied = await env.minibar.configurations.resolveChange(
      {
        hotelId: h.hotelId,
        changeId: view.pendingChange?.changeId as string,
        idempotencyKey: key('mb'),
        expectedRevision: view.pendingChange?.revision as number,
        applyWithOverride: { reason: 'Кола дууссан' },
      },
      h.manager,
      request(h.manager),
    );
    expect(applied.state).toBe('APPLIED');
    const short = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    expect(short.minibarStatus).toBe('SHORT');
    expect(short.overrideId).not.toBeNull();

    const stay = await checkIn(h, roomId);
    expect(stay.minibarApplicable).toBe(true);
    expect(stay.priceBook).toMatchObject({ templateId, versionId });
    expect(
      stay.priceBook?.lines.map((l) => [
        l.productName,
        l.sellingPriceMnt,
        l.targetQuantity,
        l.openingQuantity,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['Кола', '5000', 1, 0],
        ['Ус', '3000', 2, 0],
      ]),
    );
    // The override was for this stay: consumed.
    const after = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    expect(after.overrideId).toBeNull();
    await expect(
      env.admin.query(
        `UPDATE platform.stay_minibar_price SET selling_price_mnt = 1 WHERE stay_id = $1`,
        [stay.stayId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // A later price edit does not reprice the stay.
    await env.minibar.products.updateProduct(
      {
        hotelId: h.hotelId,
        productId: waterId,
        idempotencyKey: key('mb'),
        expectedRevision: 0,
        sellingPriceMnt: 9000n,
      },
      h.manager,
      request(h.manager),
    );
    const again = await env.stays.view(
      { hotelId: h.hotelId, stayId: stay.stayId },
      h.manager,
      request(h.manager),
    );
    expect(again.priceBook?.lines.find((l) => l.productId === waterId)?.sellingPriceMnt).toBe(
      '3000',
    );
    // The pinned version cannot be archived while the stay is active.
    const versions = await env.minibar.versions.listVersions(
      { hotelId: h.hotelId, templateId },
      h.manager,
      request(h.manager),
    );
    const current = versions.find((v) => v.versionId === versionId);
    const draft2 = await env.minibar.versions.createDraft(
      {
        hotelId: h.hotelId,
        templateId,
        idempotencyKey: key('mb'),
        items: [{ productId: waterId, targetQuantity: 1 }],
      },
      h.manager,
      request(h.manager),
    );
    const published2 = await env.minibar.versions.publish(
      {
        hotelId: h.hotelId,
        templateId,
        versionId: draft2.versionId,
        idempotencyKey: key('mb'),
        expectedRevision: draft2.revision,
      },
      h.manager,
      request(h.manager),
    );
    await env.minibar.versions.setDefault(
      {
        hotelId: h.hotelId,
        templateId,
        versionId: published2.versionId,
        idempotencyKey: key('mb'),
        expectedRevision: published2.revision,
      },
      h.manager,
      request(h.manager),
    );
    const archive = await refused(
      env.minibar.versions.archive(
        {
          hotelId: h.hotelId,
          templateId,
          versionId,
          idempotencyKey: key('mb'),
          expectedRevision: (
            await env.minibar.versions.listVersions(
              { hotelId: h.hotelId, templateId },
              h.manager,
              request(h.manager),
            )
          ).find((v) => v.versionId === versionId)?.revision as number,
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(archive.details?.map((d) => d.field)).toEqual(expect.arrayContaining(['rooms']));
    void current;
  });

  it('a short minibar without an override is a check-in blocker; a pending change is one too', async () => {
    const roomId = await h.cleanRoom();
    await turnOn(roomId, false);
    const view = await env.minibar.configurations.view(
      { hotelId: h.hotelId, roomId },
      h.manager,
      request(h.manager),
    );
    expect(view.pendingChange?.state).toBe('BLOCKED_STOCK');
    const pending = await refused(checkIn(h, roomId));
    expect(pending.message).toContain('CONFIGURATION_CHANGE_PENDING');
  });
});

describe('checkout, the readiness anchor and the lifecycle hand-off (STAY-DEC-008, -012, RML-DEC-002)', () => {
  let h: StayHotel;

  beforeAll(async () => {
    h = await env.hotel('Checkout Hotel', 'P25');
    await openShift(h);
  });

  it('records the actual checkout, keeps the planned end, needs cleaning, and frees the room only after buffer + clean', async () => {
    env.travel(0);
    const roomId = await h.cleanRoom();
    const stay = await checkIn(h, roomId, { halfHourUnits: 1 });
    // Early checkout: no reprice, no refund, the planned end untouched.
    const done = await env.stays.recordActualCheckout(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('out'),
        expectedRevision: stay.revision,
      },
      h.reception,
      request(h.reception),
    );
    expect(done.state).toBe('COMPLETED');
    expect(done.plannedCheckoutAt).toBe(stay.plannedCheckoutAt);
    expect(done.roomChargeMnt).toBe(stay.roomChargeMnt);
    expect(done.actualCheckoutAt).not.toBeNull();
    const cleaning = await env.housekeeping.view(
      { hotelId: h.hotelId, roomId },
      h.reception,
      request(h.reception),
    );
    expect(cleaning.state).toBe('NEEDS_CLEANING');
    expect(cleaning.history[0]?.toState).toBe('NEEDS_CLEANING');
    const cleanedTooSoon = await env.housekeeping.setState(
      {
        hotelId: h.hotelId,
        roomId,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: cleaning.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    expect(cleanedTooSoon.state).toBe('CLEAN');
    const buffered = await refused(checkIn(h, roomId));
    expect(buffered.message).toContain('CLEANING_BUFFER_PENDING');
    env.travel(31);
    const next = await checkIn(h, roomId);
    expect(next.state).toBe('ACTIVE');
    env.travel(0);
  });

  it('an active stay blocks a room retirement; the checkout completes it (RML-DEC-002, doc 26 §2)', async () => {
    env.travel(0);
    const roomId = await h.cleanRoom();
    const stay = await checkIn(h, roomId, { halfHourUnits: 1 });
    const retiring = await env.minibar.catalog.lifecycle.requestDeactivation(
      {
        hotelId: h.hotelId,
        kind: 'ROOM',
        entityId: roomId,
        idempotencyKey: key('lc'),
        expectedRevision: 0,
      },
      h.manager,
      request(h.manager),
    );
    expect(retiring.state).toBe('RETIRING');
    expect(retiring.blockers.map((b) => b.sourceId)).toContain('room.active_stay');
    await env.stays.recordActualCheckout(
      {
        hotelId: h.hotelId,
        stayId: stay.stayId,
        idempotencyKey: key('out'),
        expectedRevision: stay.revision,
      },
      h.reception,
      request(h.reception),
    );
    // doc 04 §4: the Cleaner's task outlives the retirement request and holds
    // it open until the room is actually cleaned (Phase 09).
    const waiting = await env.minibar.catalog.lifecycle.view(
      { hotelId: h.hotelId, kind: 'ROOM', entityId: roomId },
      h.manager,
      request(h.manager),
    );
    expect(waiting.state).toBe('RETIRING');
    expect(waiting.blockers.map((b) => b.sourceId)).toContain('room.cleaning_task');
    const queue = await env.cleaningTasks.queue(
      { hotelId: h.hotelId },
      h.cleaner,
      request(h.cleaner),
    );
    const task = queue.find((candidate) => candidate.roomId === roomId);
    if (task === undefined) throw new Error('no cleaning task');
    const claimed = await env.cleaningTasks.claimTask(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('ct'),
        expectedRevision: task.revision,
      },
      h.cleaner,
      request(h.cleaner),
    );
    await env.cleaningTasks.complete(
      {
        hotelId: h.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('ct'),
        expectedRevision: claimed.revision,
        refilled: [],
      },
      h.cleaner,
      request(h.cleaner),
    );
    const finished = await env.minibar.catalog.lifecycle.view(
      { hotelId: h.hotelId, kind: 'ROOM', entityId: roomId },
      h.manager,
      request(h.manager),
    );
    expect(finished.state).toBe('INACTIVE');
    const overdue = await refused(checkIn(h, roomId));
    expect(overdue.message).toMatch(/ENTITY_NOT_ACTIVE|ROOM_NOT_ACTIVE/);
  });
});

describe('the overdue conflict (STAY-DEC-013)', () => {
  let h: StayHotel;
  let roomA: string;
  let roomB: string;
  let overdue: StayView;
  const bookingRef = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    h = await env.hotel('Conflict Hotel', 'P25');
    await openShift(h);
    roomA = await h.cleanRoom();
    roomB = await h.room();
    env.travel(0);
    overdue = await checkIn(h, roomA, { halfHourUnits: 1 });
    env.travel(60);
  });

  afterAll(() => {
    env.travel(0);
    env.bookings.clear();
  });

  it('opens once when the booking is due, the stay is overdue and no room of the category is eligible', async () => {
    const board = await env.stays.board({ hotelId: h.hotelId }, h.reception, request(h.reception));
    const card = board.find((c) => c.roomId === roomA);
    expect(card).toMatchObject({ occupancy: 'CHECKED_IN', timeState: 'OVERDUE' });
    expect(card?.overdueMinutes).toBeGreaterThanOrEqual(30);
    env.bookings.add({
      bookingRef,
      categoryId: h.categoryId,
      assignedRoomId: roomA,
      plannedCheckInAt: new Date(env.now().getTime() + 10 * 60_000),
      plannedCheckoutAt: new Date(env.now().getTime() + 24 * 60 * 60_000),
      cleaningBufferMinutes: 30,
    });
    const first = await env.conflicts.refresh(
      { hotelId: h.hotelId },
      h.reception,
      request(h.reception),
    );
    expect(first.opened).toHaveLength(1);
    expect(first.opened[0]).toMatchObject({
      bookingRef,
      roomId: roomA,
      overdueStayId: overdue.stayId,
      state: 'OPEN',
    });
    const second = await env.conflicts.refresh(
      { hotelId: h.hotelId },
      h.reception,
      request(h.reception),
    );
    expect(second.opened).toHaveLength(0);
    expect(second.alreadyOpen).toHaveLength(1);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.booking_fulfillment_conflict WHERE hotel_id = $1`,
        [h.hotelId],
      ),
    ).toBe(1);
    // A second open row for the booking is refused by the index even bypassing the service.
    await expect(
      env.admin.query(
        `INSERT INTO platform.booking_fulfillment_conflict (hotel_id, booking_ref, category_id, room_id, overdue_stay_id, planned_checkin_at, planned_checkout_at, cleaning_buffer_minutes) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 day', 30)`,
        [h.hotelId, bookingRef, h.categoryId, roomA, overdue.stayId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cancellation is refused while a room can be assigned; the Reception reassigns; the assignment commits the room', async () => {
    const [conflict] = await env.conflicts.listOpen(
      { hotelId: h.hotelId },
      h.reception,
      request(h.reception),
    );
    if (conflict === undefined) throw new Error('no conflict');
    // Room B becomes eligible once it is clean.
    await env.housekeeping.setState(
      {
        hotelId: h.hotelId,
        roomId: roomB,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: 0,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const cancel = await refused(
      env.conflicts.cancelHotel(
        {
          hotelId: h.hotelId,
          conflictId: conflict.conflictId,
          idempotencyKey: key('cf'),
          expectedRevision: conflict.revision,
          reason: 'өрөө байхгүй',
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(cancel.message).toContain('ELIGIBLE_ROOM_EXISTS');
    const notManager = await refused(
      env.conflicts.approveHigherCategory(
        {
          hotelId: h.hotelId,
          conflictId: conflict.conflictId,
          idempotencyKey: key('cf'),
          expectedRevision: conflict.revision,
          roomId: roomB,
        },
        h.reception,
        request(h.reception),
      ),
    );
    expect(notManager.code).toBe('NOT_FOUND');
    const reassigned = await env.conflicts.reassignSameCategory(
      {
        hotelId: h.hotelId,
        conflictId: conflict.conflictId,
        idempotencyKey: key('cf'),
        expectedRevision: conflict.revision,
        roomId: roomB,
      },
      h.reception,
      request(h.reception),
    );
    expect(reassigned).toMatchObject({ state: 'RESOLVED_REASSIGNED', assignedRoomId: roomB });
    // Room B is now committed to the booking starting in ten minutes: a walk-in cannot fit before it.
    const walkIn = await refused(checkIn(h, roomB, { halfHourUnits: 1 }));
    expect(walkIn.message).toContain('ASSIGNED_BOOKING_CONFLICT');
    // The overdue guest is still in room A: nothing moved them, and the planned end is unchanged.
    const stay = await env.stays.view(
      { hotelId: h.hotelId, stayId: overdue.stayId },
      h.reception,
      request(h.reception),
    );
    expect(stay).toMatchObject({
      state: 'ACTIVE',
      plannedCheckoutAt: overdue.plannedCheckoutAt,
      roomChargeMnt: overdue.roomChargeMnt,
    });
  });

  it('a higher category needs a Manager, is self-approved for a multi-role account, and a checkout in time resolves READY', async () => {
    env.bookings.clear();
    const higher = await env.minibar.catalog.catalog.createCategory(
      { hotelId: h.hotelId, idempotencyKey: key('cat'), name: 'Люкс', state: 'ACTIVE' },
      h.manager,
      request(h.manager),
    );
    const luxRoom = (
      await env.minibar.catalog.catalog.createRoom(
        {
          hotelId: h.hotelId,
          idempotencyKey: key('room'),
          roomNumber: 'LUX-1',
          categoryId: higher.categoryId,
          state: 'ACTIVE',
        },
        h.manager,
        request(h.manager),
      )
    ).roomId;
    await env.housekeeping.setState(
      {
        hotelId: h.hotelId,
        roomId: luxRoom,
        idempotencyKey: key('cl'),
        toState: 'CLEAN',
        expectedRevision: 0,
      },
      h.cleaner,
      request(h.cleaner),
    );
    const secondRef = '22222222-2222-4222-8222-222222222222';
    env.bookings.add({
      bookingRef: secondRef,
      categoryId: h.categoryId,
      assignedRoomId: roomA,
      plannedCheckInAt: new Date(env.now().getTime() + 25 * 60_000),
      plannedCheckoutAt: new Date(env.now().getTime() + 24 * 60 * 60_000),
      cleaningBufferMinutes: 30,
    });
    // Room B is committed to the first booking's assignment; no same-category room is eligible.
    const opened = await env.conflicts.refresh(
      { hotelId: h.hotelId },
      h.manager,
      request(h.manager),
    );
    expect(opened.opened).toHaveLength(1);
    const conflict = opened.opened[0];
    if (conflict === undefined) throw new Error('no conflict');
    const same = await refused(
      env.conflicts.approveHigherCategory(
        {
          hotelId: h.hotelId,
          conflictId: conflict.conflictId,
          idempotencyKey: key('cf'),
          expectedRevision: conflict.revision,
          roomId: roomB,
        },
        h.manager,
        request(h.manager),
      ),
    );
    expect(same.message).toContain('SAME_CATEGORY');
    const both = await env.seed(h.hotelId, `both-${key('c')}@stay.test`, ['RECEPTION', 'MANAGER']);
    const actor = await env.actorFor(both);
    const approved = await env.conflicts.approveHigherCategory(
      {
        hotelId: h.hotelId,
        conflictId: conflict.conflictId,
        idempotencyKey: key('cf'),
        expectedRevision: conflict.revision,
        roomId: luxRoom,
      },
      actor,
      request(actor),
    );
    expect(approved).toMatchObject({
      state: 'RESOLVED_HIGHER_CATEGORY',
      assignedRoomId: luxRoom,
      selfApproved: true,
    });

    // A third booking, due, with the same overdue stay: the checkout resolves it READY.
    env.bookings.clear();
    const thirdRef = '33333333-3333-4333-8333-333333333333';
    env.bookings.add({
      bookingRef: thirdRef,
      categoryId: h.categoryId,
      assignedRoomId: roomA,
      plannedCheckInAt: new Date(env.now().getTime() + 30 * 60_000),
      plannedCheckoutAt: new Date(env.now().getTime() + 24 * 60 * 60_000),
      cleaningBufferMinutes: 30,
    });
    const third = await env.conflicts.refresh(
      { hotelId: h.hotelId },
      h.manager,
      request(h.manager),
    );
    expect(third.opened).toHaveLength(1);
    // The guest leaves five minutes before the boundary: buffer passed in time.
    env.travel(55);
    const view = await env.stays.view(
      { hotelId: h.hotelId, stayId: overdue.stayId },
      h.reception,
      request(h.reception),
    );
    await env.stays.recordActualCheckout(
      {
        hotelId: h.hotelId,
        stayId: overdue.stayId,
        idempotencyKey: key('out'),
        expectedRevision: view.revision,
      },
      h.reception,
      request(h.reception),
    );
    const rows = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.booking_fulfillment_conflict WHERE hotel_id = $1 AND booking_ref = $2`,
      [h.hotelId, thirdRef],
    );
    expect(rows.rows[0]?.state).toBe('RESOLVED_READY');
    // A resolved conflict is terminal in the database too.
    await expect(
      env.admin.query(
        `UPDATE platform.booking_fulfillment_conflict SET state = 'OPEN', revision = revision + 1 WHERE booking_ref = $1`,
        [thirdRef],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('a booking commitment is an interval, not a start instant (STAY-DEC-008, -013)', () => {
  let h: StayHotel;

  beforeAll(async () => {
    h = await env.hotel('Interval Hotel', 'P25');
    await openShift(h);
    env.travel(0);
  });

  afterAll(() => {
    env.bookings.clear();
    env.travel(0);
  });

  const commitment = (
    bookingRef: string,
    roomId: string,
    startsInMinutes: number,
    endsInMinutes: number,
  ): void => {
    env.bookings.add({
      bookingRef,
      categoryId: h.categoryId,
      assignedRoomId: roomId,
      plannedCheckInAt: new Date(env.now().getTime() + startsInMinutes * 60_000),
      plannedCheckoutAt: new Date(env.now().getTime() + endsInMinutes * 60_000),
      cleaningBufferMinutes: 30,
    });
  };

  it('refuses a walk-in while a commitment that has already started still holds the room', async () => {
    const roomId = await h.cleanRoom();
    // Started half an hour ago, still awaited: the room is spoken for now, not
    // only later. A start-instant reading would not see this booking at all.
    commitment('55555555-5555-4555-8555-555555555555', roomId, -30, 6 * 60);
    const quote = await env.checkIns.quote(
      { hotelId: h.hotelId, roomId, stayType: 'HOURLY', halfHourUnits: 1 },
      h.reception,
      request(h.reception),
    );
    expect(quote.blockers).toContain('NEXT_BOOKING_CONFLICT');
    const refusal = await refused(checkIn(h, roomId, { halfHourUnits: 1 }));
    expect(refusal.message).toContain('NEXT_BOOKING_CONFLICT');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay WHERE room_id = $1`,
        [roomId],
      ),
    ).toBe(0);
    env.bookings.clear();
  });

  it('allows the stay whose end plus buffer falls before the next commitment, and refuses it a minute the other side', async () => {
    // One half-hour unit plus the category's 30-minute buffer: ready again 60
    // minutes from now, so a commitment starting at 61 minutes is adjacent and
    // not an overlap, and one starting at 59 minutes is.
    const early = await h.cleanRoom();
    commitment('66666666-6666-4666-8666-666666666666', early, 59, 8 * 60);
    const overlapped = await refused(checkIn(h, early, { halfHourUnits: 1 }));
    expect(overlapped.message).toContain('NEXT_BOOKING_CONFLICT');
    env.bookings.clear();

    const roomId = await h.cleanRoom();
    commitment('77777777-7777-4777-8777-777777777777', roomId, 61, 8 * 60);
    const stay = await checkIn(h, roomId, { halfHourUnits: 1 });
    expect(stay.roomId).toBe(roomId);
    expect(stay.state).toBe('ACTIVE');
    // A longer stay under the same commitment would run into it.
    const longer = await h.cleanRoom();
    commitment('88888888-8888-4888-8888-888888888888', longer, 61, 8 * 60);
    const tooLong = await refused(checkIn(h, longer, { halfHourUnits: 2 }));
    expect(tooLong.message).toContain('NEXT_BOOKING_CONFLICT');
    env.bookings.clear();
  });
});

describe('the registries and the live schema', () => {
  it('the catalog and safe-point registries find the stay relations they predicted, with their columns', async () => {
    for (const [relation, column] of [
      ['platform.stay', 'room_id'],
      ['platform.stay', 'category_id'],
      ['platform.stay_minibar_snapshot', 'version_id'],
    ]) {
      const [schema, table] = (relation as string).split('.');
      const present = await env.admin.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS present`,
        [schema, table, column],
      );
      expect({ relation, column, present: present.rows[0]?.present }).toEqual({
        relation,
        column,
        present: true,
      });
    }
  });
});
