import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HotelRole } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { CommandActor } from '../iam/services/iam-context';
import type { StayHotel } from '../stay/test-support/stay-harness';
import type { ReportingHarness } from './test-support/reporting-harness';
import { createReportingHarness, newReportingRequest } from './test-support/reporting-harness';

/**
 * GATE — who may read a guest registry, a financial dashboard and an export
 * (doc 12 §7, doc 18 §3, `RBAC-DEC-015`).
 *
 * The matrix is narrow and the phase gate names it: Reception, Cleaner and the
 * Restaurant Manager have no bulk guest access at all; Manager Plus reaches
 * the registry only in the 30,000₮ package; the full financial dashboard and
 * the expense categories belong to Hotel Admin alone. Every one of those is
 * asserted here as a refusal from the real authorization pipeline over real
 * PostgreSQL, and every one is asserted again for a caller pointing at a hotel
 * that is not theirs.
 *
 * Job creation and download are checked separately on purpose: doc 12 §7 makes
 * the download its own authorization, so a token that was allowed to create is
 * not thereby allowed to fetch.
 */

let h: ReportingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `reporting-sec-${String(keys)}`;
};
const ctx = (actor: CommandActor) => newReportingRequest(actor.principal.accountId);
const NOWHERE = '00000000-0000-4000-8000-000000000000';

let sequence = 0;
async function actorWith(hotel: StayHotel, role: HotelRole): Promise<CommandActor> {
  sequence += 1;
  const member = await h.stay.seed(
    hotel.hotelId,
    `${role.toLowerCase()}-${String(sequence)}@reporting-sec.test`,
    [role],
  );
  return h.stay.actorFor(member);
}

/**
 * A Restaurant Manager, whose membership is scoped to one restaurant
 * (`RBAC-DEC-016`). The restaurant row is written directly rather than
 * registered through Phase 15's service: what this suite needs from it is the
 * scope on the membership, and nothing here reads a menu.
 */
async function restaurantManagerOf(hotel: StayHotel): Promise<CommandActor> {
  sequence += 1;
  const restaurant = await h.admin.query<{ restaurant_id: string }>(
    `INSERT INTO platform.restaurant
       (hotel_id, display_name, cuisine_kind, address_line,
        latitude_micro, longitude_micro, contact_phone)
     VALUES ($1::uuid, $2, 'MONGOLIAN', 'Улаанбаатар, Сүхбаатар дүүрэг',
             47918000, 106917000, '+97699001122')
     RETURNING restaurant_id`,
    [hotel.hotelId, `Reporting Sec ${String(sequence)}`],
  );
  const member = await h.stay.minibar.catalog.iam.seedMembership({
    hotelId: hotel.hotelId,
    email: `restaurant-${String(sequence)}@reporting-sec.test`,
    roles: ['RESTAURANT_MANAGER'],
    restaurantId: restaurant.rows[0]?.restaurant_id as string,
  });
  return h.stay.actorFor(member);
}

/**
 * Every denial in this codebase is the same opaque `NOT_FOUND` (doc 06 §5):
 * a caller cannot tell a missing role from a missing package from a hotel
 * that is not theirs, and that is the point.
 */
const OPAQUE = 'NOT_FOUND';

/** The error a refusal must be, and never a leak of what exists. */
async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiError)) {
    throw new Error(`expected a refusal, got ${String(outcome)}`);
  }
  return outcome;
}

beforeAll(async () => {
  h = await createReportingHarness('reporting_sec');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('the registry refuses every role that has no bulk guest access', () => {
  it('denies Reception, Cleaner and the Restaurant Manager on list and on export', async () => {
    const hotel = await h.hotel('Registry roles');
    await h.stayFor(hotel, { familyName: 'Нууц', givenName: 'Зочин' });

    for (const role of ['RECEPTION', 'CLEANER', 'RESTAURANT_MANAGER'] as const) {
      const actor =
        role === 'RESTAURANT_MANAGER'
          ? await restaurantManagerOf(hotel)
          : await actorWith(hotel, role);
      const listed = await refusal(h.registry.list({ hotelId: hotel.hotelId }, actor, ctx(actor)));
      expect({ role, code: listed.code }).toEqual({ role, code: OPAQUE });
      const requested = await refusal(
        h.exports.request(
          { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
          actor,
          ctx(actor),
        ),
      );
      expect({ role, code: requested.code }).toEqual({ role, code: OPAQUE });
    }

    // And nothing they were refused was written.
    const jobs = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.report_export_job WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(jobs.rows[0]?.count).toBe('0');
  }, 300_000);

  it('lets Manager in on every package, and Manager Plus only on the 30,000₮ one', async () => {
    const p25 = await h.hotel('Manager P25');
    await h.stayFor(p25);
    const manager = await actorWith(p25, 'MANAGER');
    const managerPlus = await actorWith(p25, 'MANAGER_PLUS');

    const allowed = await h.registry.list({ hotelId: p25.hotelId }, manager, ctx(manager));
    expect(allowed.totalRows).toBe(1);
    const refused = await refusal(
      h.registry.list({ hotelId: p25.hotelId }, managerPlus, ctx(managerPlus)),
    );
    // The package is the gate above the role, and its refusal is deliberately
    // indistinguishable from the role having no such right at all.
    expect(refused.code).toBe(OPAQUE);

    const p30 = await h.stay.hotel('Manager P30', 'P30');
    const plusOnP30 = await actorWith(p30, 'MANAGER_PLUS');
    const opened = await h.registry.list({ hotelId: p30.hotelId }, plusOnP30, ctx(plusOnP30));
    expect(opened.totalRows).toBe(0);
  }, 300_000);
});

describe('the financial dashboard and the expense categories are Hotel Admin only', () => {
  it('denies Manager, Manager Plus, Reception, Cleaner and the Restaurant Manager', async () => {
    const hotel = await h.hotel('Dashboard roles');
    for (const role of [
      'MANAGER',
      'MANAGER_PLUS',
      'RECEPTION',
      'CLEANER',
      'RESTAURANT_MANAGER',
    ] as const) {
      const actor =
        role === 'RESTAURANT_MANAGER'
          ? await restaurantManagerOf(hotel)
          : await actorWith(hotel, role);
      const dashboard = await refusal(
        h.dashboard.read({ hotelId: hotel.hotelId }, actor, ctx(actor)),
      );
      expect({ role, code: dashboard.code }).toEqual({ role, code: OPAQUE });
      const category = await refusal(
        h.categories.create(
          {
            hotelId: hotel.hotelId,
            name: `Ангилал-${role}`,
            kind: 'OPERATING',
            idempotencyKey: key(),
          },
          actor,
          ctx(actor),
        ),
      );
      expect({ role, code: category.code }).toEqual({ role, code: OPAQUE });
      const financial = await refusal(
        h.exports.request(
          { hotelId: hotel.hotelId, kind: 'ROOM_SALES', idempotencyKey: key() },
          actor,
          ctx(actor),
        ),
      );
      expect({ role, code: financial.code }).toEqual({ role, code: OPAQUE });
    }
  }, 300_000);

  it('refuses the minibar Excel in the package that does not carry it', async () => {
    const p20 = await h.stay.hotel('Minibar P20', 'P20');
    const member = await h.stay.seed(p20.hotelId, `admin-p20@reporting-sec.test`, ['HOTEL_ADMIN']);
    const admin = await h.stay.actorFor(member);
    const refused = await refusal(
      h.exports.request(
        { hotelId: p20.hotelId, kind: 'MINIBAR_SALES', idempotencyKey: key() },
        admin,
        ctx(admin),
      ),
    );
    expect(refused.code).toBe(OPAQUE);
    // The room Excel is in every package, so the refusal above was the
    // entitlement on this one action and not a role that reaches nothing.
    const allowed = await h.exports.request(
      { hotelId: p20.hotelId, kind: 'ROOM_SALES', idempotencyKey: key() },
      admin,
      ctx(admin),
    );
    expect(allowed.state).toBe('QUEUED');
  }, 300_000);
});

describe('a hotel id in the request never widens the caller’s scope', () => {
  it('refuses another hotel’s registry, dashboard, categories and exports', async () => {
    const mine = await h.hotel('Mine');
    const theirs = await h.hotel('Theirs');
    await h.stayFor(theirs, { familyName: 'Хөрш', givenName: 'Зочин' });

    for (const hotelId of [theirs.hotelId, NOWHERE]) {
      expect((await refusal(h.registry.list({ hotelId }, mine.admin, ctx(mine.admin)))).code).toBe(
        OPAQUE,
      );
      expect((await refusal(h.dashboard.read({ hotelId }, mine.admin, ctx(mine.admin)))).code).toBe(
        OPAQUE,
      );
      expect(
        (
          await refusal(
            h.exports.request(
              { hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
              mine.admin,
              ctx(mine.admin),
            ),
          )
        ).code,
      ).toBe(OPAQUE);
      expect(
        (
          await refusal(
            h.categories.create(
              { hotelId, name: 'Хулгай', kind: 'OPERATING', idempotencyKey: key() },
              mine.admin,
              ctx(mine.admin),
            ),
          )
        ).code,
      ).toBe(OPAQUE);
    }
  }, 300_000);

  it('answers the same for another hotel’s finished export as for one that never existed', async () => {
    const mine = await h.hotel('Downloader');
    const theirs = await h.hotel('Owner');
    await h.stayFor(theirs, { familyName: 'Тайлан', givenName: 'Зочин' });

    const job = await h.exports.request(
      { hotelId: theirs.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      theirs.admin,
      ctx(theirs.admin),
    );
    const done = await h.exports.run(job.jobId);
    expect(done?.state).toBe('COMPLETED');

    // Someone else's job id, presented under the caller's own hotel: the row
    // is outside the tenant scope, so it is simply not there.
    const stranger = await refusal(
      h.exports.download({ hotelId: mine.hotelId, jobId: job.jobId }, mine.admin, ctx(mine.admin)),
    );
    const missing = await refusal(
      h.exports.download({ hotelId: mine.hotelId, jobId: NOWHERE }, mine.admin, ctx(mine.admin)),
    );
    expect(stranger.code).toBe(missing.code);
    expect(stranger.message).toBe(missing.message);

    // And the owner's own hotel id under the stranger's token is refused
    // before the row is ever read.
    const crossed = await refusal(
      h.exports.download(
        { hotelId: theirs.hotelId, jobId: job.jobId },
        mine.admin,
        ctx(mine.admin),
      ),
    );
    expect(crossed.code).toBe(OPAQUE);
  }, 300_000);

  it('re-checks authority on download, not only when the job was created', async () => {
    const hotel = await h.hotel('Revoked');
    await h.stayFor(hotel);
    const job = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    await h.exports.run(job.jobId);

    // A role that could never have created the job cannot fetch what one
    // created: the download carries its own named permission.
    const reception = await actorWith(hotel, 'RECEPTION');
    const refused = await refusal(
      h.exports.download({ hotelId: hotel.hotelId, jobId: job.jobId }, reception, ctx(reception)),
    );
    expect(refused.code).toBe(OPAQUE);
    const grants = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.report_export_grant WHERE job_id = $1`,
      [job.jobId],
    );
    expect(grants.rows[0]?.count).toBe('0');
  }, 300_000);
});

describe('the registry surface hands out no identifier it was not asked for', () => {
  it('never returns a registration number, a ciphertext or a lookup token', async () => {
    const hotel = await h.hotel('No identifiers');
    await h.stayFor(hotel, { familyName: 'Данс', givenName: 'Зочин' });
    const page = await h.registry.list({ hotelId: hotel.hotelId }, hotel.admin, ctx(hotel.admin));
    const serialised = JSON.stringify(page);

    const stored = await h.admin.query<{ lookup_token: string | null }>(
      `SELECT lookup_token FROM platform.stay_guest WHERE hotel_id = $1 AND is_current`,
      [hotel.hotelId],
    );
    const token = stored.rows[0]?.lookup_token;
    expect(typeof token).toBe('string');
    expect(serialised).not.toContain(token as string);
    for (const field of ['identifier_ciphertext', 'lookupToken', 'registrationNumber']) {
      expect(serialised).not.toContain(field);
    }
  }, 300_000);
});
