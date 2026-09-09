import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoliceActor, PoliceHarness } from './test-support/police-harness';
import { createPoliceHarness, newPoliceRequest } from './test-support/police-harness';

/**
 * The races Phase 18 has to lose safely (doc 13 §9, `POL-DEC-017`,
 * `POL-DEC-019`).
 *
 * Three of them would be visible to a person if they went wrong: a second alert
 * about a guest already reported, two officers each believing they confirmed
 * the Found, and a correction approved twice. What orders them is the unique
 * `(stay_id, wanted_person_id)` pair, the partial unique indexes on the pending
 * requests, and the revision compare-and-set on the match — none of which is
 * stubbed here.
 */

let h: PoliceHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `police-con-${String(keys)}`;
};
const ctx = (actor: PoliceActor) => newPoliceRequest(actor.accountId, 'con-device');

let numbers = 0;
const registration = (): string => {
  numbers += 1;
  return `ВА${String(92060112 + numbers).slice(0, 8)}`;
};

async function activeWanted(officer: PoliceActor, number: string): Promise<string> {
  h.xyp.register(number, {
    familyName: 'Зэрэгцээ',
    givenName: 'Шалгалт',
    dateOfBirth: '1992-06-01',
    parentName: 'Дорж',
  });
  const person = await h.wanted.register(
    { registrationNumber: number, idempotencyKey: key() },
    officer.actor,
    ctx(officer),
  );
  const opened = await h.cases.open(
    {
      personId: person.personId,
      reasonText: 'Зэрэгцээ ажиллагааны шалгалтын хэрэг.',
      crimeCategory: 'Шалгалт',
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
      reason: 'Шалгалтын зорилгоор идэвхжүүлэв.',
      expectedRevision: 0,
      idempotencyKey: key(),
    },
    officer.actor,
    ctx(officer),
  );
  return person.personId;
}

beforeAll(async () => {
  h = await createPoliceHarness('police_con');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('two matchers over one check-in', () => {
  it('creates one match and one alert, whichever wins', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    await activeWanted(officer, number);
    const hotel = await h.hotelInDistrict('Race Hotel', 'Баянзүрх', officer.unitRef);
    const stay = await h.checkIn(hotel, number);

    const outcomes = await Promise.allSettled([
      h.matcher.matchPendingCheckIns(),
      h.matcher.matchPendingCheckIns(),
      h.matcher.matchPendingCheckIns(),
    ]);
    const matched = outcomes
      .filter((outcome) => outcome.status === 'fulfilled')
      .reduce((total, outcome) => total + outcome.value.matched, 0);
    expect(matched).toBe(1);

    const matches = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    expect(matches.rows[0]?.n).toBe('1');
    const alerts = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_alert a
         JOIN police.police_match m ON m.match_id = a.match_id WHERE m.stay_id = $1`,
      [stay.stayId],
    );
    expect(alerts.rows[0]?.n).toBe('1');
    // And one detection event, not three.
    const events = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.match_event e
         JOIN police.police_match m ON m.match_id = e.match_id
        WHERE m.stay_id = $1 AND e.event_type = 'DETECTED'`,
      [stay.stayId],
    );
    expect(events.rows[0]?.n).toBe('1');
  }, 300_000);
});

describe('two officers over one match', () => {
  it('confirms one Found, and tells the other who was already there', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const second = await h.officer({ unitRef: officer.unitRef });
    const number = registration();
    await activeWanted(officer, number);
    const hotel = await h.hotelInDistrict('Found Race', 'Хан-Уул', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string; revision: number }>(
      `SELECT match_id, revision FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;
    const revision = Number(row.rows[0]?.revision);

    const outcomes = await Promise.allSettled(
      [officer, second].map((who) =>
        h.matches.confirmFound(
          {
            matchId,
            expectedRevision: revision,
            locationKind: 'AT_MATCH_HOTEL',
            idempotencyKey: key(),
          },
          who.actor,
          ctx(who),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const founds = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.found_confirmation
        WHERE match_id = $1 AND state = 'ACTIVE'`,
      [matchId],
    );
    expect(founds.rows[0]?.n).toBe('1');
  }, 300_000);

  it('keeps one pending False Match request however many are asked for at once', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const second = await h.officer({ unitRef: officer.unitRef });
    const number = registration();
    await activeWanted(officer, number);
    const hotel = await h.hotelInDistrict('False Race', 'Сүхбаатар', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string }>(
      `SELECT match_id FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;

    const outcomes = await Promise.allSettled(
      [officer, second, officer].map((who) =>
        h.matches.requestFalseMatch(
          {
            matchId,
            reasonCode: 'WRONG_NUMBER_ENTERED',
            reasonNote: 'Регистрийг буруу оруулсан байж болзошгүй.',
            idempotencyKey: key(),
          },
          who.actor,
          ctx(who),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const pending = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.false_match_request
        WHERE match_id = $1 AND state = 'PENDING'`,
      [matchId],
    );
    expect(pending.rows[0]?.n).toBe('1');
  }, 300_000);

  it('decides a Found correction once, however many approvers arrive together', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const first = await h.officer({ permissions: ['FOUND_CORRECTION_APPROVE'] });
    const alsoApprover = await h.officer({ permissions: ['FOUND_CORRECTION_APPROVE'] });
    const number = registration();
    await activeWanted(officer, number);
    const hotel = await h.hotelInDistrict('Decide Race', 'Чингэлтэй', officer.unitRef);
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string; revision: number }>(
      `SELECT match_id, revision FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;
    const confirmed = await h.matches.confirmFound(
      {
        matchId,
        expectedRevision: Number(row.rows[0]?.revision),
        locationKind: 'AT_MATCH_HOTEL',
        idempotencyKey: key(),
      },
      officer.actor,
      ctx(officer),
    );
    expect(confirmed.outcome).toBe('FOUND');
    const requested = await h.matches.requestFoundCorrection(
      { matchId, reason: 'Тодорхойлолт буруу байсан тул залруулна.', idempotencyKey: key() },
      officer.actor,
      ctx(officer),
    );

    const outcomes = await Promise.allSettled(
      [first, alsoApprover].map((who) =>
        h.matches.decideFoundCorrection(
          {
            matchId,
            requestId: requested.requestId,
            approve: true,
            note: 'Шалгаж баталгаажууллаа.',
            idempotencyKey: key(),
          },
          who.actor,
          ctx(who),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const decided = await h.admin.query<{ n: string; state: string }>(
      `SELECT count(*)::text AS n, min(state) AS state FROM police.found_correction_request
        WHERE request_id = $1`,
      [requested.requestId],
    );
    expect(decided.rows[0]).toEqual({ n: '1', state: 'APPROVED' });
  }, 300_000);
});

describe('two lifecycle commands over one case', () => {
  it('lets one win on the revision, and tells the other it changed', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    const personId = await activeWanted(officer, number);
    const cases = await h.cases.list(personId, officer.actor, ctx(officer));
    const caseId = cases[0]?.caseId as string;
    const current = await h.admin.query<{ revision: number }>(
      `SELECT revision FROM police.wanted_case WHERE case_id = $1`,
      [caseId],
    );
    const revision = Number(current.rows[0]?.revision);

    const outcomes = await Promise.allSettled([
      h.cases.move(
        {
          caseId,
          to: 'SUSPENDED',
          reason: 'Түр зогсоох шийдвэр гарсан.',
          expectedRevision: revision,
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
      h.cases.move(
        {
          caseId,
          to: 'CLOSED',
          reason: 'Хэрэг хаагдсан гэж үзэв.',
          expectedRevision: revision,
          idempotencyKey: key(),
        },
        officer.actor,
        ctx(officer),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const events = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.wanted_case_event WHERE case_id = $1`,
      [caseId],
    );
    // Two moves: the activation this fixture made, and the one that won here.
    expect(events.rows[0]?.n).toBe('2');
  }, 300_000);
});
