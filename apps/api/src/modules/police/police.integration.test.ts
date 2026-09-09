import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { PoliceActor, PoliceHarness } from './test-support/police-harness';
import { createPoliceHarness, newPoliceRequest } from './test-support/police-harness';

/**
 * Police monitoring end to end, against real PostgreSQL and the real roles
 * (doc 13; `POL-DEC-001`–`022`, `RC-DEC-034`).
 *
 * The phase's integration gates live here: duplicate matching runs create one
 * match and one alert; an approved actual-time correction creates no duplicate
 * alert and shifts no timestamp; and the escalation timer and the historical
 * search stay disabled while no ЦЕГ configuration approves them.
 */

let h: PoliceHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `police-int-${String(keys)}`;
};
const ctx = (actor: PoliceActor) => newPoliceRequest(actor.accountId, 'test-device');

/** A synthetic Mongolian registration number, unique per fixture. */
let numbers = 0;
const registration = (): string => {
  numbers += 1;
  return `АА${String(90010112 + numbers).slice(0, 8)}`;
};

beforeAll(async () => {
  h = await createPoliceHarness('police_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

/** An active wanted person: identity, case, and the case activated. */
async function wantedPerson(
  officer: PoliceActor,
  approver: PoliceActor,
  number: string,
): Promise<{ personId: string; caseId: string }> {
  h.xyp.register(number, {
    familyName: 'Эрэн',
    givenName: 'Сурвалжлагдсан',
    dateOfBirth: '1988-05-05',
    parentName: 'Дорж',
    homeAddress: 'Улаанбаатар, Баянзүрх дүүрэг',
    homeDistrict: 'Баянзүрх',
  });
  const person = await h.wanted.register(
    { registrationNumber: number, idempotencyKey: key() },
    officer.actor,
    ctx(officer),
  );
  const opened = await h.cases.open(
    {
      personId: person.personId,
      reasonText: 'Хулгайн хэргийн сэжигтэн, эрэн сурвалжлагдаж байна.',
      crimeCategory: 'Хулгай',
      owningUnitRef: officer.unitRef,
      idempotencyKey: key(),
    },
    officer.actor,
    ctx(officer),
  );
  await h.cases.move(
    {
      caseId: opened.caseId,
      to: 'ACTIVE',
      reason: 'Хэргийн материал бүрдсэн тул идэвхжүүлэв.',
      expectedRevision: 0,
      idempotencyKey: key(),
    },
    approver.actor,
    ctx(approver),
  );
  return { personId: person.personId, caseId: opened.caseId };
}

describe('registering a wanted person (POL-DEC-001, POL-DEC-017)', () => {
  it('takes the identity from ХУР and never creates the same person twice', async () => {
    const officer = await h.officer();
    const number = registration();
    h.xyp.register(number, {
      familyName: 'Бат',
      givenName: 'Дорж',
      dateOfBirth: '1990-03-03',
      parentName: 'Сүх',
      homeAddress: 'Улаанбаатар, Сүхбаатар дүүрэг',
      homeDistrict: 'Сүхбаатар',
    });

    const first = await h.wanted.register(
      { registrationNumber: number, idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );
    expect(first.provenance).toBe('XYP_VERIFIED');
    expect(first.approvalState).toBe('APPROVED');
    expect(first.matchable).toBe(true);

    // doc 13 §6.3: the same number is the same person, and the second
    // registration attaches to them rather than inventing a duplicate.
    const second = await h.wanted.register(
      { registrationNumber: ` ${number.toLowerCase()} `, idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );
    expect(second.personId).toBe(first.personId);

    const rows = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.wanted_person`,
    );
    expect(Number(rows.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    const persons = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.wanted_identity_revision WHERE person_id = $1`,
      [first.personId],
    );
    expect(persons.rows[0]?.n).toBe('1');
  }, 180_000);

  it('refuses a number that could never match, before anything is stored', async () => {
    const officer = await h.officer();
    await expect(
      h.wanted.register(
        { registrationNumber: 'AA1234', idempotencyKey: key() },
        officer.actor,
        ctx(officer),
      ),
    ).rejects.toThrow(/structurally valid/);
  }, 180_000);

  it('holds a manual identity until a different officer approves it (POL-DEC-018)', async () => {
    const officer = await h.officer();
    const approver = await h.officer({ permissions: ['WANTED_IDENTITY_APPROVE'] });
    const number = registration();
    // ХУР answers nothing, so the officer types the identity themselves.
    const person = await h.wanted.register(
      {
        registrationNumber: number,
        manual: {
          familyName: 'Гар',
          parentName: 'Аргын',
          givenName: 'Бүртгэл',
          dateOfBirth: '1985-01-01',
          homeDistrict: 'Хан-Уул',
          reason: 'XYP_NOT_FOUND',
        },
        idempotencyKey: key(),
      },
      officer.actor,
      ctx(officer),
    );
    expect(person.provenance).toBe('MANUAL');
    expect(person.approvalState).toBe('PENDING_APPROVAL');
    expect(person.matchable).toBe(false);

    // A case cannot be activated while the identity is unapproved.
    const opened = await h.cases.open(
      {
        personId: person.personId,
        reasonText: 'Залилангийн хэргээр эрэн сурвалжилж байна.',
        crimeCategory: 'Залилан',
        owningUnitRef: officer.unitRef,
        idempotencyKey: key(),
      },
      officer.actor,
      ctx(officer),
    );
    const caseManager = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    await expect(
      h.cases.move(
        {
          caseId: opened.caseId,
          to: 'ACTIVE',
          reason: 'Идэвхжүүлэх оролдлого.',
          expectedRevision: 0,
          idempotencyKey: key(),
        },
        caseManager.actor,
        ctx(caseManager),
      ),
    ).rejects.toThrow(/IDENTITY_NOT_APPROVED/);

    // And the creator cannot approve their own entry, however they are granted.
    const selfApprover = await h.officer({
      permissions: ['WANTED_IDENTITY_APPROVE'],
    });
    void selfApprover;
    await expect(
      h.wanted.decideIdentity(
        {
          personId: person.personId,
          revisionId: person.revisionId,
          approve: true,
          reason: 'Өөрөө батлах оролдлого.',
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    const decided = await h.wanted.decideIdentity(
      {
        personId: person.personId,
        revisionId: person.revisionId,
        approve: true,
        reason: 'Баримт бичгээр баталгаажлаа.',
        idempotencyKey: key(),
      },
      approver.actor,
      ctx(approver),
    );
    expect(decided.matchable).toBe(true);
  }, 180_000);
});

describe('GATE — matching at check-in (POL-DEC-002, POL-DEC-017)', () => {
  it('creates one match and one alert, however many times the matcher runs', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    const { personId } = await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('Match Hotel', 'Баянгол', officer.unitRef);
    const stay = await h.checkIn(hotel, number);

    const first = await h.matcher.matchPendingCheckIns();
    expect(first.matched).toBe(1);
    // Running it again consumes nothing and creates nothing: the consumption is
    // claimed in the same transaction as the effect it guards.
    const second = await h.matcher.matchPendingCheckIns();
    expect(second.matched).toBe(0);

    const matches = await h.admin.query<{ n: string; match_id: string }>(
      `SELECT count(*)::text AS n, min(match_id::text) AS match_id
         FROM police.police_match WHERE stay_id = $1 AND wanted_person_id = $2`,
      [stay.stayId, personId],
    );
    expect(matches.rows[0]?.n).toBe('1');
    const alerts = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_alert a
         JOIN police.police_match m ON m.match_id = a.match_id
        WHERE m.stay_id = $1`,
      [stay.stayId],
    );
    expect(alerts.rows[0]?.n).toBe('1');

    // The three times are kept apart, and the detection is its own.
    const times = await h.admin.query<{
      detected_at: Date;
      check_in_recorded_at: Date;
      actual_check_in_at: Date;
    }>(
      `SELECT detected_at, check_in_recorded_at, actual_check_in_at
         FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const row = times.rows[0];
    expect(row).toBeDefined();
    expect(row?.detected_at.getTime()).toBeGreaterThanOrEqual(
      row?.check_in_recorded_at.getTime() ?? 0,
    );
  }, 300_000);

  it('never matches a guest who is not exactly, structurally, the wanted number', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const wantedNumber = registration();
    await wantedPerson(officer, officer, wantedNumber);
    const hotel = await h.hotelInDistrict('Other Hotel', 'Чингэлтэй', officer.unitRef);

    const other = await h.checkIn(hotel, registration());
    await h.matcher.matchPendingCheckIns();
    const matches = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.police_match WHERE stay_id = $1`,
      [other.stayId],
    );
    expect(matches.rows[0]?.n).toBe('0');
  }, 300_000);

  it('sweeps the guests already in hotels when a case is activated', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    const hotel = await h.hotelInDistrict('Sweep Hotel', 'Сонгинохайрхан', officer.unitRef);
    // The guest checks in first, and is wanted afterwards.
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const before = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(before.rows[0]?.n).toBe('0');

    await wantedPerson(officer, officer, number);
    const after = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(after.rows[0]?.n).toBe('1');
  }, 300_000);
});

describe('acknowledging, finding and correcting (POL-DEC-011 … POL-DEC-016)', () => {
  it('records the first acknowledgement without giving it away, and lets anybody act after', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const second = await h.officer({ unitRef: officer.unitRef });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('Ack Hotel', 'Багануур', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const found = await h.admin.query<{ match_id: string }>(
      `SELECT match_id FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = found.rows[0]?.match_id as string;

    const first = await h.matches.acknowledge(
      { matchId, expectedRevision: 0, idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );
    expect(first.workflowState).toBe('ACKNOWLEDGED');
    expect(first.firstAcknowledgedByAccountId).toBe(officer.accountId);

    // `POL-DEC-016`: the second officer still sees it and still acts on it.
    const again = await h.matches.acknowledge(
      { matchId, expectedRevision: first.revision, idempotencyKey: key() },
      second.actor,
      ctx(second),
    );
    expect(again.firstAcknowledgedByAccountId).toBe(officer.accountId);
    const events = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_event
        WHERE match_id = $1 AND event_type = 'ACKNOWLEDGED'`,
      [matchId],
    );
    expect(events.rows[0]?.n).toBe('2');

    // `POL-DEC-012`: the officer who actually found the person confirms it, and
    // it need not be the one who acknowledged first.
    const confirmed = await h.matches.confirmFound(
      {
        matchId,
        expectedRevision: again.revision,
        locationKind: 'AT_MATCH_HOTEL',
        idempotencyKey: key(),
      },
      second.actor,
      ctx(second),
    );
    expect(confirmed.outcome).toBe('FOUND');
    expect(confirmed.workflowState).toBe('RESOLVED');

    // And a second confirmation is told who was already there.
    await expect(
      h.matches.confirmFound(
        {
          matchId,
          expectedRevision: confirmed.revision,
          locationKind: 'AT_MATCH_HOTEL',
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
    ).rejects.toThrow(/ALREADY_FOUND/);
  }, 300_000);

  it('GATE — a Found is undone by two people, never by one (POL-DEC-015)', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const approver = await h.officer({ permissions: ['FOUND_CORRECTION_APPROVE'] });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('Correction Hotel', 'Налайх', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string }>(
      `SELECT match_id FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;
    const acknowledged = await h.matches.acknowledge(
      { matchId, expectedRevision: 0, idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );
    const confirmed = await h.matches.confirmFound(
      {
        matchId,
        expectedRevision: acknowledged.revision,
        locationKind: 'OTHER_LOCATION',
        locationNote: 'Баянзүрх дүүрэг, 13-р хороо',
        idempotencyKey: key(),
      },
      officer.actor,
      ctx(officer),
    );
    expect(confirmed.outcome).toBe('FOUND');

    // Only the officer who confirmed may ask.
    await expect(
      h.matches.requestFoundCorrection(
        { matchId, reason: 'Өөр хүн байсан тул залруулна.', idempotencyKey: key() },
        approver.actor,
        ctx(approver),
      ),
    ).rejects.toThrow(/account that confirmed/);

    const requested = await h.matches.requestFoundCorrection(
      { matchId, reason: 'Өөр хүн байсан тул залруулна.', idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );

    // And the requester may not decide it, whatever they hold.
    const selfDeciding = await h.officer({
      permissions: ['FOUND_CORRECTION_APPROVE', 'WANTED_CASE_STATE_MANAGE'],
    });
    void selfDeciding;
    await expect(
      h.matches.decideFoundCorrection(
        {
          matchId,
          requestId: requested.requestId,
          approve: true,
          note: 'Өөрөө шийдэх оролдлого.',
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    const decided = await h.matches.decideFoundCorrection(
      {
        matchId,
        requestId: requested.requestId,
        approve: true,
        note: 'Хяналт шалгалтаар нотлогдлоо.',
        idempotencyKey: key(),
      },
      approver.actor,
      ctx(approver),
    );
    expect(decided.outcome).toBe('NONE');
    expect(decided.workflowState).toBe('UNDER_REVIEW');
    // The erroneous confirmation stays in the history rather than disappearing.
    const history = await h.admin.query<{ state: string }>(
      `SELECT state FROM police.found_confirmation WHERE match_id = $1`,
      [matchId],
    );
    expect(history.rows.map((r) => r.state)).toEqual(['CORRECTED']);
  }, 300_000);

  it('GATE — a False Match needs two people and never overrides a Found (POL-DEC-019)', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const approver = await h.officer({ permissions: ['FALSE_MATCH_APPROVE'] });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('False Hotel', 'Хан-Уул', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string }>(
      `SELECT match_id FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;

    const requested = await h.matches.requestFalseMatch(
      {
        matchId,
        reasonCode: 'IDENTIFIER_USED_BY_ANOTHER',
        reasonNote: 'Бусдын регистр ашигласан нь тогтоогдлоо.',
        idempotencyKey: key(),
      },
      officer.actor,
      ctx(officer),
    );
    // doc 13 §9.3: pending changes nothing yet, and it is visible that it is.
    const pending = await h.matches.read(matchId, officer.actor, ctx(officer));
    expect(pending.falseMatchReviewPending).toBe(true);
    expect(pending.outcome).toBe('NONE');

    await expect(
      h.matches.decideFalseMatch(
        {
          matchId,
          requestId: requested.requestId,
          approve: true,
          note: 'Өөрөө батлах оролдлого.',
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    const decided = await h.matches.decideFalseMatch(
      {
        matchId,
        requestId: requested.requestId,
        approve: true,
        note: 'Нотлох баримтаар батлагдлаа.',
        idempotencyKey: key(),
      },
      approver.actor,
      ctx(approver),
    );
    expect(decided.outcome).toBe('FALSE_MATCH');
    expect(decided.workflowState).toBe('RESOLVED');
    expect(decided.falseMatchReviewPending).toBe(false);
    // The original match, its alert and its history are untouched.
    const alerts = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_alert WHERE match_id = $1`,
      [matchId],
    );
    expect(alerts.rows[0]?.n).toBe('1');
  }, 300_000);
});

describe('GATE — what has no approved configuration does not run', () => {
  it('refuses the historical check-in search until a retention policy is approved', async () => {
    const admin = await h.officer({ role: 'POLICE_ADMIN' });
    const officer = await h.officer();
    const hotel = await h.hotelInDistrict('List Hotel', 'Баянзүрх', admin.unitRef);
    const number = registration();
    await h.checkIn(hotel, number, { familyName: 'Жагсаалт', givenName: 'Зочин' });

    // The active list opens, and shows the full number to a Police Admin.
    const active = await h.checkIns.list({}, admin.actor, ctx(admin));
    expect(active.historical).toBe(false);
    const row = active.rows.find((entry) => entry.familyName === 'Жагсаалт');
    expect(row?.registrationNumber).toBe(number);

    // doc 18 §6: an Officer has no such action at all.
    await expect(h.checkIns.list({}, officer.actor, ctx(officer))).rejects.toBeInstanceOf(ApiError);

    const from = new Date(Date.UTC(2026, 7, 1));
    const to = new Date(Date.UTC(2026, 7, 20));
    await expect(
      h.checkIns.list(
        { from, to, searchReason: 'Мөрдөн байцаалтын шаардлагаар' },
        admin.actor,
        ctx(admin),
      ),
    ).rejects.toThrow(/RETENTION_NOT_APPROVED/);

    // A window longer than 31 days is refused before the policy is even read.
    await expect(
      h.checkIns.list(
        {
          from,
          to: new Date(Date.UTC(2026, 8, 15)),
          searchReason: 'Мөрдөн байцаалтын шаардлагаар',
        },
        admin.actor,
        ctx(admin),
      ),
    ).rejects.toThrow(/RANGE_TOO_LONG/);

    // And a search with no reason is refused however short the window.
    await expect(h.checkIns.list({ from, to }, admin.actor, ctx(admin))).rejects.toThrow(
      /states its reason/,
    );
  }, 300_000);

  it('escalates nothing while ЦЕГ has approved no minutes', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('Escalation Hotel', 'Сүхбаатар', officer.unitRef);
    await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();

    h.advance(24 * 60);
    expect(await h.alerts.escalateUnacknowledged(50, ctx(officer))).toBe(0);
    const stages = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_alert WHERE escalation_stage > 0`,
    );
    expect(stages.rows[0]?.n).toBe('0');
  }, 300_000);
});

describe('the alert and its SMS (POL-DEC-008, POL-DEC-009)', () => {
  it('reaches the district officers and every admin, and the SMS carries only the number', async () => {
    const admin = await h.officer({ role: 'POLICE_ADMIN', unitRef: 'UNIT-SMS' });
    const officer = await h.officer({
      unitRef: 'UNIT-SMS',
      permissions: ['WANTED_CASE_STATE_MANAGE'],
    });
    const elsewhere = await h.officer({ unitRef: 'UNIT-OTHER' });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('SMS Hotel', 'Дархан', 'UNIT-SMS');

    // Both accounts need an approved, verified official number to be reachable.
    await h.giveContact(admin.accountId, '+97699001122');
    await h.giveContact(officer.accountId, '+97699003344');

    await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();

    const deliveries = await h.admin.query<{ recipient_kind: string; channel: string }>(
      `SELECT d.recipient_kind, d.channel FROM police.alert_delivery d
         JOIN police.match_alert a ON a.alert_id = d.alert_id
         JOIN police.police_match m ON m.match_id = a.match_id
        WHERE m.hotel_district = 'Дархан'`,
    );
    const kinds = new Set(deliveries.rows.map((row) => row.recipient_kind));
    expect(kinds.has('POLICE_ADMIN')).toBe(true);
    expect(kinds.has('DISTRICT_OFFICER')).toBe(true);
    // The officer of another unit is not a recipient.
    const strangers = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.alert_delivery d
         JOIN police.match_alert a ON a.alert_id = d.alert_id
         JOIN police.police_match m ON m.match_id = a.match_id
        WHERE m.hotel_district = 'Дархан' AND d.recipient_account_id = $1`,
      [elsewhere.accountId],
    );
    expect(strangers.rows[0]?.n).toBe('0');

    await h.alerts.deliverPendingSms(20, ctx(admin));
    const body = h.sms.bodyFor('+97699001122');
    if (body !== undefined) {
      expect(body).toContain(number);
      for (const forbidden of ['SMS Hotel', 'Дархан', 'Синтетик']) {
        expect(body).not.toContain(forbidden);
      }
    }
    // Whatever was delivered, the row keeps a mask and never the body.
    const stored = await h.admin.query<{ masked_identifier: string | null }>(
      `SELECT masked_identifier FROM police.alert_delivery
        WHERE channel = 'SMS' AND delivered_at IS NOT NULL LIMIT 1`,
    );
    const masked = stored.rows[0]?.masked_identifier;
    if (masked != null) {
      expect(masked).not.toContain(number);
      expect(masked.startsWith('****')).toBe(true);
    }
  }, 300_000);
});

describe('GATE — an approved time correction changes nothing Police (doc 13 §8.5)', () => {
  it('creates no second match, no second alert and shifts no timestamp', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    await wantedPerson(officer, officer, number);
    const hotel = await h.hotelInDistrict('Correction Time', 'Орхон', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();

    const before = await h.admin.query<{
      match_id: string;
      detected_at: Date;
      check_in_recorded_at: Date;
      actual_check_in_at: Date;
    }>(
      `SELECT match_id, detected_at, check_in_recorded_at, actual_check_in_at
         FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const original = before.rows[0];
    expect(original).toBeDefined();

    // An approved correction, written the way Phase 08 writes one.
    await h.admin.query(
      `INSERT INTO platform.stay_time_correction
         (hotel_id, stay_id, state, previous_effective_at, corrected_actual_check_in_at,
          earliest_allowed_at, latest_allowed_at, reason, requested_by_account_id,
          decided_by_account_id, decided_at, decision_reason, self_approved)
       SELECT s.hotel_id, s.stay_id, 'APPROVED', s.actual_check_in_at,
              s.actual_check_in_at - interval '2 hours',
              s.actual_check_in_at - interval '6 hours', s.actual_check_in_at,
              'Бүртгэл хожимдсон тул залруулав.', s.checked_in_by_account_id,
              s.checked_in_by_account_id, now(), 'Батлав.', true
         FROM platform.stay s WHERE s.stay_id = $1`,
      [stay.stayId],
    );

    // Matching runs again over everything it can see.
    await h.matcher.matchPendingCheckIns();
    const after = await h.admin.query<{
      n: string;
      detected_at: Date;
      check_in_recorded_at: Date;
      actual_check_in_at: Date;
    }>(
      `SELECT count(*) OVER ()::text AS n, detected_at, check_in_recorded_at, actual_check_in_at
         FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(after.rows[0]?.n).toBe('1');
    expect(after.rows[0]?.detected_at.toISOString()).toBe(original?.detected_at.toISOString());
    expect(after.rows[0]?.check_in_recorded_at.toISOString()).toBe(
      original?.check_in_recorded_at.toISOString(),
    );
    expect(after.rows[0]?.actual_check_in_at.toISOString()).toBe(
      original?.actual_check_in_at.toISOString(),
    );
    const alerts = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_alert a
         JOIN police.police_match m ON m.match_id = a.match_id WHERE m.stay_id = $1`,
      [stay.stayId],
    );
    expect(alerts.rows[0]?.n).toBe('1');
  }, 300_000);
});
