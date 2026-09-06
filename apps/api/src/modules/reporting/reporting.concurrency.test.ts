import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReportingHarness } from './test-support/reporting-harness';
import { createReportingHarness, newReportingRequest } from './test-support/reporting-harness';

/**
 * The races Phase 17 has to lose safely (doc 12 §7–§8, doc 23 §4.4).
 *
 * An export job is a piece of work handed to a worker, and a purge is a
 * one-way deletion — both are exactly the shapes where a duplicate run costs
 * something real: a second file that nobody expires, or a second anonymisation
 * writing over a row that no longer holds what it thinks. What orders these is
 * the job's own row lock plus the revision compare-and-set, and the retention
 * row's `anonymized_at` written under the same lock. Nothing here is stubbed:
 * the two callers race over one PostgreSQL cluster.
 */

let h: ReportingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `reporting-con-${String(keys)}`;
};
const ctx = (actor: { principal: { accountId: string } }) =>
  newReportingRequest(actor.principal.accountId);

beforeAll(async () => {
  h = await createReportingHarness('reporting_con');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('two requests for one export', () => {
  it('queues one job under one idempotency key, and answers both callers the same', async () => {
    const hotel = await h.hotel('One job');
    await h.stayFor(hotel);
    const shared = key();

    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(() =>
        h.exports.request(
          { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: shared },
          hotel.admin,
          ctx(hotel.admin),
        ),
      ),
    );
    const settled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    // A concurrent claim on a key still in flight is refused rather than
    // duplicated, so what this asserts is that no two callers got two jobs.
    expect(settled.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(settled.map((outcome) => outcome.value.jobId));
    expect(ids.size).toBe(1);

    const rows = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.report_export_job WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  }, 240_000);
});

describe('two workers over one queued job', () => {
  it('builds and stores it exactly once', async () => {
    const hotel = await h.hotel('One build');
    await h.stayFor(hotel);
    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    const before = h.storage.size;

    const outcomes = await Promise.allSettled([
      h.exports.run(queued.jobId),
      h.exports.run(queued.jobId),
      h.exports.run(queued.jobId),
    ]);
    const completed = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value?.state === 'COMPLETED',
    );
    expect(completed).toHaveLength(1);
    // The losers claimed nothing: the job moved out of QUEUED under a lock,
    // and a run that does not claim never reaches the storage call.
    expect(h.storage.size).toBe(before + 1);

    const row = await h.admin.query<{ state: string; row_count: number; storage_key: string }>(
      `SELECT state, row_count, storage_key FROM platform.report_export_job WHERE job_id = $1`,
      [queued.jobId],
    );
    expect(row.rows[0]?.state).toBe('COMPLETED');
    expect(row.rows[0]?.row_count).toBe(1);
  }, 240_000);

  it('expires it once, however many sweeps arrive together', async () => {
    const hotel = await h.hotel('One expiry');
    await h.stayFor(hotel);
    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    await h.exports.run(queued.jobId);
    h.advance(61);

    const outcomes = await Promise.all([
      h.exports.expireOne(hotel.hotelId, queued.jobId),
      h.exports.expireOne(hotel.hotelId, queued.jobId),
      h.exports.expireOne(hotel.hotelId, queued.jobId),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const audits = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit.platform_event
        WHERE action = 'reporting.export_expired' AND target_ref = $1`,
      [queued.jobId],
    );
    expect(audits.rows[0]?.count).toBe('1');
  }, 240_000);
});

describe('two purges over one stay', () => {
  it('anonymises it once, and stamps the retention row once', async () => {
    const hotel = await h.hotel('One purge');
    const stay = await h.stayFor(hotel, { familyName: 'Давхар', givenName: 'Устгал' });
    h.advance(366 * 24 * 60);

    const outcomes = await Promise.all([
      h.retention.purgeOne(hotel.hotelId, stay.stayId),
      h.retention.purgeOne(hotel.hotelId, stay.stayId),
      h.retention.purgeOne(hotel.hotelId, stay.stayId),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const guest = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.stay_guest
        WHERE stay_id = $1 AND is_current AND family_name = 'Устгасан'`,
      [stay.stayId],
    );
    expect(guest.rows[0]?.count).toBe('1');
    const audits = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit.platform_event
        WHERE action = 'retention.anonymized' AND target_ref = $1`,
      [stay.stayId],
    );
    expect(audits.rows[0]?.count).toBe('1');
  }, 240_000);

  it('never purges a stay a hold reached first', async () => {
    const hotel = await h.hotel('Hold race');
    const stay = await h.stayFor(hotel, { familyName: 'Барьцаа', givenName: 'Зочин' });
    await h.retention.placeHold(
      {
        hotelId: hotel.hotelId,
        stayId: stay.stayId,
        reason: 'Мөрдөн байцаалтын шаардлагаар хадгална.',
        authorityReference: 'ЦЕГ-2026-777',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    h.advance(366 * 24 * 60);

    const outcomes = await Promise.all([
      h.retention.purgeOne(hotel.hotelId, stay.stayId),
      h.retention.sweepRetention(50),
      h.retention.purgeOne(hotel.hotelId, stay.stayId),
    ]);
    expect(outcomes[0]).toBe(false);
    expect(outcomes[2]).toBe(false);

    const guest = await h.admin.query<{ family_name: string }>(
      `SELECT family_name FROM platform.stay_guest WHERE stay_id = $1 AND is_current`,
      [stay.stayId],
    );
    expect(guest.rows[0]?.family_name).toBe('Барьцаа');
  }, 240_000);
});

describe('two categories of one name', () => {
  it('keeps one, and the loser is refused by the index rather than by a read', async () => {
    const hotel = await h.hotel('Category race');
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(() =>
        h.categories.create(
          { hotelId: hotel.hotelId, name: 'Угаалга', kind: 'OPERATING', idempotencyKey: key() },
          hotel.admin,
          ctx(hotel.admin),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    const rows = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.expense_category
        WHERE hotel_id = $1 AND name = 'Угаалга'`,
      [hotel.hotelId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  }, 240_000);
});
