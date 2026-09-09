import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import type { PoliceActor, PoliceHarness } from './test-support/police-harness';
import { createPoliceHarness, key, newPoliceRequest, request } from './test-support/police-harness';

/**
 * GATE — the two boundaries Phase 18 exists to hold (doc 13 §3, §13.2).
 *
 * **Isolation.** No hotel-facing response, error text or shape differs
 * according to whether a Match exists (`POL-DEC-007`). That is asserted here
 * over the real check-in path, on two guests who differ in exactly one respect:
 * one of them is wanted.
 *
 * **Separation of role, realm and unit.** An Officer is not a smaller Admin and
 * an Admin is not a bigger Officer (`POL-DEC-021`); a Hotel, Guest or Operation
 * account is not a Police account at all; and an Officer's match view is
 * confined to their own unit.
 *
 * Every refusal below is measured against the real pipeline, on the real Police
 * login, over real PostgreSQL.
 */

let h: PoliceHarness;
let keys = 0;
const nextKey = (): string => {
  keys += 1;
  return `police-sec-${String(keys)}`;
};
const ctx = (actor: PoliceActor) => newPoliceRequest(actor.accountId, 'sec-device');

let numbers = 0;
const registration = (): string => {
  numbers += 1;
  return `БА${String(85040112 + numbers).slice(0, 8)}`;
};

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiError)) throw new Error(`expected a refusal, got ${String(outcome)}`);
  return outcome;
}

/** An active wanted person, ready to match. */
async function wanted(officer: PoliceActor, number: string): Promise<string> {
  h.xyp.register(number, {
    familyName: 'Хамгаалалт',
    givenName: 'Шалгалт',
    dateOfBirth: '1987-07-07',
    parentName: 'Дорж',
    homeDistrict: 'Баянгол',
  });
  const person = await h.wanted.register(
    { registrationNumber: number, idempotencyKey: nextKey() },
    officer.actor,
    ctx(officer),
  );
  const opened = await h.cases.open(
    {
      personId: person.personId,
      reasonText: 'Хамгаалалтын шалгалтын хэрэг, идэвхтэй эрэн сурвалжлалт.',
      crimeCategory: 'Шалгалт',
      owningUnitRef: officer.unitRef,
      idempotencyKey: nextKey(),
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
      idempotencyKey: nextKey(),
    },
    officer.actor,
    ctx(officer),
  );
  return person.personId;
}

beforeAll(async () => {
  h = await createPoliceHarness('police_sec');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('GATE — a hotel cannot tell that a match happened (POL-DEC-007)', () => {
  it('answers a wanted guest’s check-in exactly as it answers anybody else’s', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const wantedNumber = registration();
    await wanted(officer, wantedNumber);
    const hotel = await h.hotelInDistrict('Isolation Hotel', 'Баянгол', officer.unitRef);

    const matched = await h.checkIn(hotel, wantedNumber, { familyName: 'Тэнцсэн' });
    const ordinary = await h.checkIn(hotel, registration(), { familyName: 'Энгийн' });
    await h.matcher.matchPendingCheckIns();

    // A match exists for exactly one of them.
    const matches = await h.admin.query<{ stay_id: string }>(
      `SELECT stay_id FROM police.police_match WHERE stay_id = ANY($1::uuid[])`,
      [[matched.stayId, ordinary.stayId]],
    );
    expect(matches.rows.map((row) => row.stay_id)).toEqual([matched.stayId]);

    // And the hotel's own view of the two stays is the same shape, field for
    // field, with nothing that could be read as a signal.
    const views = await Promise.all(
      [matched.stayId, ordinary.stayId].map((stayId) =>
        h.stay.stays.view(
          { hotelId: hotel.hotelId, stayId },
          hotel.reception,
          request(hotel.reception),
        ),
      ),
    );
    const [a, b] = views;
    expect(Object.keys(a as object).sort()).toEqual(Object.keys(b as object).sort());

    // Stronger than equal key sets: every value that is not an identifier, a
    // time or the guest's own name is identical between the two. The wanted
    // guest's view differs from the ordinary one in nothing a hotel could read
    // as a signal.
    const ignored = new Set([
      'stayId',
      'roomId',
      'categoryId',
      'guestRecordId',
      'shiftId',
      'rateSnapshotId',
      'familyName',
      'givenName',
      'roomNumber',
      'actualCheckInAt',
      'checkInRecordedAt',
      'effectiveActualCheckInAt',
      'plannedCheckoutAt',
      'createdAt',
      'updatedAt',
      'revision',
    ]);
    const comparable = (view: unknown): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(view as Record<string, unknown>)
          .filter(([field]) => !ignored.has(field))
          .map(([field, value]) => [
            field,
            typeof value === 'object' && value !== null ? '<object>' : value,
          ]),
      );
    expect(comparable(a)).toEqual(comparable(b));

    // And nothing in either names a match, an alert or a wanted record. The
    // guest's own `policeMatchEligibility` is not one of those: doc 13 §8.2
    // makes it a property of the identity the receptionist typed, identical for
    // both guests here, and it says nothing about whether anybody is wanted.
    const serialised = JSON.stringify(views);
    for (const leak of ['matchId', 'wanted', 'alert', 'FOUND', 'detectedAt']) {
      expect(serialised).not.toContain(leak);
    }
  }, 300_000);

  it('gives the API role no way to read a Police table at all', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    await wanted(officer, registration());

    // The hotel API's own connection, which every hotel command runs on.
    for (const table of ['police.police_match', 'police.wanted_person', 'police.match_alert']) {
      await expect(h.stay.api.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
    // And the reverse: the Police connection reaches no hotel table.
    await expect(
      withTenantTransaction(
        h.police,
        {
          hotelId: PLATFORM_SCOPE,
          realm: 'police',
          actorRef: 'sec',
          correlationId: 'sec-probe',
        },
        (uow) => uow.query(`SELECT count(*) FROM platform.stay`),
      ),
    ).rejects.toThrow(/permission denied/);
  }, 300_000);

  it('refuses a Police transaction that does not declare its realm', async () => {
    // RLS on every Police table compares the realm, so a connection that held
    // the role and ran as another realm reads nothing.
    const rows = await withTenantTransaction(
      h.police,
      {
        hotelId: PLATFORM_SCOPE,
        realm: 'operation',
        actorRef: 'sec',
        correlationId: 'sec-realm',
      },
      (uow) => uow.query<{ n: string }>(`SELECT count(*)::text AS n FROM police.wanted_person`),
    );
    expect(rows.rows[0]?.n).toBe('0');
  }, 300_000);
});

describe('the Police columns are not two sizes of the same role (POL-DEC-021)', () => {
  it('refuses an Officer the all-hotel list, the charts and the export', async () => {
    const officer = await h.officer();
    const admin = await h.officer({ role: 'POLICE_ADMIN' });

    expect((await refusal(h.checkIns.list({}, officer.actor, ctx(officer)))).code).toBeDefined();
    expect(
      (
        await refusal(
          h.dashboard.charts(
            { from: new Date(Date.now() - 86_400_000), to: new Date() },
            officer.actor,
            ctx(officer),
          ),
        )
      ).code,
    ).toBeDefined();
    expect(
      (
        await refusal(
          h.exports.run(
            {
              purpose: 'Шалгалтын зорилгоор татаж байна.',
              taskReference: 'T-1',
              fullIdentifier: false,
              idempotencyKey: nextKey(),
            },
            officer.actor,
            ctx(officer),
          ),
        )
      ).code,
    ).toBeDefined();

    // The Admin holds the list and the charts, and still needs the named
    // permission for the export.
    const listed = await h.checkIns.list({}, admin.actor, ctx(admin));
    expect(listed.historical).toBe(false);
    await refusal(
      h.exports.run(
        {
          purpose: 'Шалгалтын зорилгоор татаж байна.',
          taskReference: 'T-2',
          fullIdentifier: false,
          idempotencyKey: nextKey(),
        },
        admin.actor,
        ctx(admin),
      ),
    );
  }, 300_000);

  it('refuses an Admin the Officer mutations they were not granted', async () => {
    const admin = await h.officer({ role: 'POLICE_ADMIN' });
    const number = registration();
    h.xyp.register(number, {
      familyName: 'Админ',
      givenName: 'Оролдлого',
      dateOfBirth: '1980-01-01',
      parentName: 'Дорж',
    });
    // `POL-DEC-021`: a Police Admin creates drafts only with WANTED_CASE_CREATE.
    expect(
      (
        await refusal(
          h.wanted.register(
            { registrationNumber: number, idempotencyKey: nextKey() },
            admin.actor,
            ctx(admin),
          ),
        )
      ).code,
    ).toBeDefined();

    const granted = await h.officer({
      role: 'POLICE_ADMIN',
      permissions: ['WANTED_CASE_CREATE'],
    });
    const person = await h.wanted.register(
      { registrationNumber: number, idempotencyKey: nextKey() },
      granted.actor,
      ctx(granted),
    );
    expect(person.personId).toBeDefined();
  }, 300_000);

  it('confines an Officer’s match view to their own unit', async () => {
    const owner = await h.officer({
      unitRef: 'UNIT-OWN',
      permissions: ['WANTED_CASE_STATE_MANAGE'],
    });
    const stranger = await h.officer({ unitRef: 'UNIT-FAR' });
    const admin = await h.officer({ role: 'POLICE_ADMIN', unitRef: 'UNIT-FAR' });
    const number = registration();
    await wanted(owner, number);
    const hotel = await h.hotelInDistrict('Scope Hotel', 'Хан-Уул', 'UNIT-OWN');
    const stay = await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();
    const row = await h.admin.query<{ match_id: string }>(
      `SELECT match_id FROM police.police_match WHERE stay_id = $1`,
      [stay.stayId],
    );
    const matchId = row.rows[0]?.match_id as string;

    const mine = await h.matches.read(matchId, owner.actor, ctx(owner));
    expect(mine.matchId).toBe(matchId);
    // doc 18 §6: `own_police_scope` on the Officer's row, and no such limit on
    // the Admin's.
    await refusal(h.matches.read(matchId, stranger.actor, ctx(stranger)));
    const seen = await h.matches.read(matchId, admin.actor, ctx(admin));
    expect(seen.matchId).toBe(matchId);
  }, 300_000);
});

describe('no other realm reaches a Police action', () => {
  it('refuses a Hotel account every Police command', async () => {
    const hotel = await h.hotelInDistrict('Realm Hotel', 'Сүхбаатар', 'UNIT-A');
    const hotelActor = {
      accountId: hotel.reception.principal.accountId,
      actor: hotel.reception,
      email: 'reception@hotel.test',
      unitRef: 'UNIT-A',
    } as PoliceActor;

    await refusal(
      h.wanted.register(
        { registrationNumber: registration(), idempotencyKey: nextKey() },
        hotelActor.actor,
        ctx(hotelActor),
      ),
    );
    await refusal(h.checkIns.list({}, hotelActor.actor, ctx(hotelActor)));
    await refusal(
      h.dashboard.counts(
        { from: new Date(Date.now() - 86_400_000), to: new Date() },
        hotelActor.actor,
        ctx(hotelActor),
      ),
    );
  }, 300_000);
});

describe('what the Police side records, and what it never records', () => {
  it('keeps no registration number in its audit stream or its delivery rows', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    await wanted(officer, number);
    const hotel = await h.hotelInDistrict('Audit Hotel', 'Чингэлтэй', officer.unitRef);
    await h.checkIn(hotel, number);
    await h.matcher.matchPendingCheckIns();

    const audit = await h.admin.query<{ payload: unknown; action: string }>(
      `SELECT action, payload FROM police_audit.security_event`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(audit.rows);
    expect(serialised).not.toContain(number);
    // Nor the plaintext anywhere in the Police tables that are not the sealed
    // identifier itself.
    const stored = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.alert_delivery
        WHERE masked_identifier IS NOT NULL AND masked_identifier LIKE '%' || $1 || '%'`,
      [number],
    );
    expect(stored.rows[0]?.n).toBe('0');
  }, 300_000);

  it('masks the export unless a second permission and a step-up say otherwise', async () => {
    const officer = await h.officer({ permissions: ['WANTED_CASE_STATE_MANAGE'] });
    const number = registration();
    await wanted(officer, number);
    const exporter = await h.officer({
      role: 'POLICE_ADMIN',
      permissions: ['WANTED_CASE_EXPORT'],
    });

    const masked = await h.exports.run(
      {
        purpose: 'Хэргийн материалд хавсаргах зорилгоор.',
        taskReference: 'T-100',
        fullIdentifier: false,
        idempotencyKey: nextKey(),
      },
      exporter.actor,
      ctx(exporter),
    );
    expect(masked.state).toBe('COMPLETED');
    expect(masked.fullIdentifier).toBe(false);

    // Asking for the full number without the second permission is refused.
    expect(
      (
        await refusal(
          h.exports.run(
            {
              purpose: 'Бүтэн регистр шаардсан хүсэлт.',
              taskReference: 'T-101',
              fullIdentifier: true,
              idempotencyKey: nextKey(),
            },
            exporter.actor,
            ctx(exporter),
          ),
        )
      ).message,
    ).toMatch(/FULL_IDENTIFIER_NOT_GRANTED/);

    const full = await h.officer({
      role: 'POLICE_ADMIN',
      permissions: ['WANTED_CASE_EXPORT', 'WANTED_EXPORT_FULL_IDENTIFIER'],
    });
    const unmasked = await h.exports.run(
      {
        purpose: 'Шүүхэд гаргах материалын хувьд бүтэн регистр шаардлагатай.',
        taskReference: 'T-102',
        fullIdentifier: true,
        idempotencyKey: nextKey(),
      },
      full.actor,
      ctx(full),
    );
    expect(unmasked.fullIdentifier).toBe(true);
  }, 300_000);

  it('holds the exact search to a rate, and records every attempt', async () => {
    const officer = await h.officer();
    const unknown = registration();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await refusal(
        h.matches.searchActive({ registrationNumber: unknown }, officer.actor, ctx(officer)),
      );
    }
    const limited = await refusal(
      h.matches.searchActive({ registrationNumber: unknown }, officer.actor, ctx(officer)),
    );
    expect(limited.message).toMatch(/RATE_LIMITED/);
    const attempts = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM police.exact_search_attempt WHERE account_id = $1`,
      [officer.accountId],
    );
    expect(Number(attempts.rows[0]?.n)).toBe(10);
  }, 300_000);
});

export { key };
