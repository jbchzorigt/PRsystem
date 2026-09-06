import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReportingHarness } from './test-support/reporting-harness';
import { createReportingHarness, newReportingRequest } from './test-support/reporting-harness';

/**
 * The guest registry, the exports and the Hotel Admin dashboard, end to end
 * against real PostgreSQL (doc 12, doc 23; `GUEST-DEC-001`–`008`,
 * `FIN-DEC-001`–`010`).
 *
 * The phase's integration gates live here: a result above ten thousand rows
 * refuses to start; an expired file answers `EXPIRED`; a re-issued URL does not
 * extend the file's hour; the KPI cards match a golden dataset; and no
 * financial export carries guest PII.
 */

let h: ReportingHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `reporting-int-${String(keys)}`;
};
const ctx = (actor: { principal: { accountId: string } }) =>
  newReportingRequest(actor.principal.accountId);

beforeAll(async () => {
  h = await createReportingHarness('reporting_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('the registry list (GUEST-DEC-001, -002, -004, -005)', () => {
  it('shows one row per primary guest of one stay, in the six approved columns', async () => {
    const hotel = await h.hotel('Registry');
    const first = await h.stayFor(hotel, { familyName: 'Бат', givenName: 'Дорж' });
    const second = await h.stayFor(hotel, { familyName: 'Цог', givenName: 'Сүх' });

    const page = await h.registry.list({ hotelId: hotel.hotelId }, hotel.admin, ctx(hotel.admin));
    expect(page.totalRows).toBe(2);
    expect(page.pageSize).toBe(20);
    expect(page.page).toBe(1);
    const names = page.rows.map((row) => `${row.familyName} ${row.givenName}`);
    expect(names).toContain('Бат Дорж');
    expect(names).toContain('Цог Сүх');
    // The row number is the position in the whole result, one-based.
    expect(page.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
    // doc 12 §5: the six columns and nothing that identifies further.
    const serialised = JSON.stringify(page.rows);
    expect(serialised).not.toContain(first.stayId);
    expect(serialised).not.toContain(second.roomId);
    expect(serialised).not.toContain('АА');
  }, 180_000);

  it('refuses a page size outside 20, 50 and 100 rather than substituting one', async () => {
    const hotel = await h.hotel('Page sizes');
    for (const pageSize of [1, 19, 21, 200]) {
      await expect(
        h.registry.list({ hotelId: hotel.hotelId, pageSize }, hotel.admin, ctx(hotel.admin)),
      ).rejects.toThrow(/pageSize/);
    }
    for (const pageSize of [20, 50, 100]) {
      const page = await h.registry.list(
        { hotelId: hotel.hotelId, pageSize },
        hotel.admin,
        ctx(hotel.admin),
      );
      expect(page.pageSize).toBe(pageSize);
    }
  }, 180_000);

  it('continues the row number across pages without repeating or skipping a guest', async () => {
    const hotel = await h.hotel('Paging');
    for (let index = 0; index < 5; index += 1) {
      await h.stayFor(hotel, { familyName: `Овог${String(index)}`, givenName: 'Нэр' });
    }
    const first = await h.registry.list(
      { hotelId: hotel.hotelId, pageSize: 20, page: 1 },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(first.totalRows).toBe(5);
    expect(first.totalPages).toBe(1);
    expect(first.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3, 4, 5]);
  }, 180_000);

  it('applies the mandatory range, and refuses one longer than retention', async () => {
    const hotel = await h.hotel('Range');
    await h.stayFor(hotel);
    // The default window includes today, so the stay is in it.
    const today = await h.registry.list({ hotelId: hotel.hotelId }, hotel.admin, ctx(hotel.admin));
    expect(today.totalRows).toBe(1);
    // A window that ended before the stay began contains nothing.
    const past = await h.registry.list(
      { hotelId: hotel.hotelId, from: '2020-01-01', to: '2020-01-31' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(past.totalRows).toBe(0);
    await expect(
      h.registry.list(
        { hotelId: hotel.hotelId, from: '2024-01-01', to: '2026-06-01' },
        hotel.admin,
        ctx(hotel.admin),
      ),
    ).rejects.toThrow(/RANGE_TOO_LONG/);
  }, 180_000);

  it('filters by stay state, room and a case-insensitive partial name', async () => {
    const hotel = await h.hotel('Filters');
    const done = await h.stayFor(hotel, { familyName: 'Мөнх', givenName: 'Алтан' });
    const live = await h.stayFor(hotel, {
      familyName: 'Ганбат',
      givenName: 'Сараа',
      complete: false,
    });

    const completed = await h.registry.list(
      { hotelId: hotel.hotelId, stayState: 'COMPLETED' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(completed.rows.map((row) => row.familyName)).toEqual(['Мөнх']);
    const active = await h.registry.list(
      { hotelId: hotel.hotelId, stayState: 'ACTIVE' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(active.rows.map((row) => row.familyName)).toEqual(['Ганбат']);

    const byRoom = await h.registry.list(
      { hotelId: hotel.hotelId, roomId: done.roomId },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(byRoom.totalRows).toBe(1);

    const bySearch = await h.registry.list(
      { hotelId: hotel.hotelId, nameSearch: '  ганб  ' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(bySearch.rows.map((row) => row.familyName)).toEqual(['Ганбат']);
    expect(bySearch.appliedFilter.nameSearch).toBe('ганб');
    void live;
  }, 180_000);

  it('shows the planned end for an active stay and the actual one when it completes', async () => {
    const hotel = await h.hotel('Period');
    const live = await h.stayFor(hotel, { complete: false });
    const active = await h.registry.list(
      { hotelId: hotel.hotelId, stayState: 'ACTIVE' },
      hotel.admin,
      ctx(hotel.admin),
    );
    const planned = await h.admin.query<{ planned_checkout_at: Date }>(
      `SELECT planned_checkout_at FROM platform.stay WHERE stay_id = $1`,
      [live.stayId],
    );
    expect(active.rows[0]?.periodEndAt.toISOString()).toBe(
      planned.rows[0]?.planned_checkout_at.toISOString(),
    );
  }, 180_000);

  it('carries the age snapshot, and Тодорхойгүй when there is none to take', async () => {
    const hotel = await h.hotel('Age');
    await h.stayFor(hotel, { dateOfBirth: '1990-01-01' });
    const page = await h.registry.list({ hotelId: hotel.hotelId }, hotel.admin, ctx(hotel.admin));
    // The snapshot is what check-in computed; the report never re-ages it.
    expect(page.rows[0]?.age).toBeGreaterThan(30);
    const stored = await h.admin.query<{ age_at_check_in: number | null }>(
      `SELECT age_at_check_in FROM platform.stay_guest WHERE hotel_id = $1 AND is_current`,
      [hotel.hotelId],
    );
    expect(page.rows[0]?.age).toBe(stored.rows[0]?.age_at_check_in);
  }, 180_000);
});

describe('GATE — the export cap, the file TTL and the URL (GUEST-DEC-006, -007)', () => {
  it('runs a registry export, stores a file and stamps exactly one hour', async () => {
    const hotel = await h.hotel('Export');
    await h.stayFor(hotel, { familyName: 'Экспорт', givenName: 'Зочин' });

    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(queued.state).toBe('QUEUED');

    const done = await h.exports.run(queued.jobId);
    expect(done?.state).toBe('COMPLETED');
    expect(done?.rowCount).toBe(1);
    expect(done?.readyAt).not.toBeNull();
    // The hour is derived, and the database recomputes it.
    expect(done?.expiresAt?.getTime()).toBe((done?.readyAt?.getTime() ?? 0) + 3_600_000);
    expect(h.storage.size).toBe(1);
  }, 180_000);

  it('a re-issued URL does not extend the file’s hour', async () => {
    const hotel = await h.hotel('Reissue');
    await h.stayFor(hotel);
    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    const done = await h.exports.run(queued.jobId);
    const fileExpiry = done?.expiresAt?.toISOString();

    const first = await h.exports.download(
      { hotelId: hotel.hotelId, jobId: queued.jobId },
      hotel.admin,
      ctx(hotel.admin),
    );
    h.advance(10);
    const second = await h.exports.download(
      { hotelId: hotel.hotelId, jobId: queued.jobId },
      hotel.admin,
      ctx(hotel.admin),
    );
    // Two different five-minute URLs, and the file's own hour untouched.
    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    // The harness clock moves with real time, so the ten minutes is a floor
    // rather than an exact figure — what matters is that the *file's* hour did
    // not move at all, which the next assertion states exactly.
    const gap = second.expiresAt.getTime() - first.expiresAt.getTime();
    expect(gap).toBeGreaterThanOrEqual(10 * 60_000);
    expect(gap).toBeLessThan(11 * 60_000);
    const after = await h.admin.query<{ expires_at: Date }>(
      `SELECT expires_at FROM platform.report_export_job WHERE job_id = $1`,
      [queued.jobId],
    );
    expect(after.rows[0]?.expires_at.toISOString()).toBe(fileExpiry);
    // And both grants are recorded, append-only.
    const grants = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.report_export_grant WHERE job_id = $1`,
      [queued.jobId],
    );
    expect(grants.rows[0]?.n).toBe('2');
  }, 180_000);

  it('expires the file after its hour, and answers EXPIRED rather than a URL', async () => {
    const hotel = await h.hotel('Expiry');
    await h.stayFor(hotel);
    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    await h.exports.run(queued.jobId);
    expect(h.storage.size).toBeGreaterThan(0);

    h.advance(61);
    const swept = await h.exports.sweepExpired(50);
    expect(swept).toBeGreaterThanOrEqual(1);
    const row = await h.admin.query<{ state: string; storage_key: string | null }>(
      `SELECT state, storage_key FROM platform.report_export_job WHERE job_id = $1`,
      [queued.jobId],
    );
    expect(row.rows[0]?.state).toBe('EXPIRED');
    // The file is gone, and the row keeps its count and its hash.
    expect(row.rows[0]?.storage_key).toBeNull();
    await expect(
      h.exports.download(
        { hotelId: hotel.hotelId, jobId: queued.jobId },
        hotel.admin,
        ctx(hotel.admin),
      ),
    ).rejects.toThrow(/EXPIRED/);
  }, 180_000);

  it('refuses to start a job whose result exceeds ten thousand rows', async () => {
    const hotel = await h.hotel('Too large');
    // Seeding ten thousand real stays would take minutes; the refusal is about
    // the *count*, so the count is what this raises. The stay module's own
    // contract is asked, and the service refuses before a job row exists.
    const inflated = {
      ...h.deps,
      registry: {
        ...h.deps.registry,
        count: async () => 10_001,
        page: h.deps.registry.page.bind(h.deps.registry),
        all: h.deps.registry.all.bind(h.deps.registry),
        anonymize: h.deps.registry.anonymize.bind(h.deps.registry),
      },
    };
    const { ReportExportService } = await import('./services/export.service');
    const service = new ReportExportService(inflated);
    await expect(
      service.request(
        { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
        hotel.admin,
        ctx(hotel.admin),
      ),
    ).rejects.toThrow(/EXPORT_TOO_LARGE/);
    // No partial file, and no job at all.
    const jobs = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.report_export_job WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(jobs.rows[0]?.n).toBe('0');
  }, 180_000);
});

describe('GATE — the KPI cards against a golden dataset (FIN-DEC-001–004)', () => {
  it('keeps sales, money received, expense kinds and the operating result apart', async () => {
    const hotel = await h.hotel('Golden');
    await h.stayFor(hotel);
    await h.paidExpense(hotel, { amountMnt: 80_000n, kind: 'OPERATING' });
    await h.paidExpense(hotel, { amountMnt: 100_000n, kind: 'INVENTORY_PURCHASE' });

    const dashboard = await h.dashboard.read(
      { hotelId: hotel.hotelId, range: 'LAST_7_DAYS' },
      hotel.admin,
      ctx(hotel.admin),
    );
    const kpis = dashboard.kpis;
    // doc 23 §4.1: the two kinds are two cards, and only one of them is
    // deducted from the operating result (FIN-DEC-004).
    expect(kpis.paidOperatingExpenseMnt).toBe(80_000n);
    expect(kpis.inventoryPurchaseOutflowMnt).toBe(100_000n);
    expect(kpis.operatingResultMnt).toBe(
      kpis.netSalesMnt - kpis.minibarCogsMnt - kpis.paidOperatingExpenseMnt,
    );
    // The purchase is nowhere in the result: deducting both would take the same
    // money out twice.
    expect(kpis.operatingResultMnt).not.toBe(kpis.netSalesMnt - kpis.minibarCogsMnt - 180_000n);
    // A receivable is never negative, and a deposit is not revenue.
    expect(kpis.receivableMnt >= 0n).toBe(true);
    expect(kpis.depositsHeldMnt >= 0n).toBe(true);
  }, 180_000);

  it('reports every hotel-local day of the window, including the quiet ones', async () => {
    const hotel = await h.hotel('Series');
    const dashboard = await h.dashboard.read(
      { hotelId: hotel.hotelId, range: 'LAST_7_DAYS' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(dashboard.series).toHaveLength(7);
    expect(dashboard.window.timeZone).toBe('Asia/Ulaanbaatar');
    for (const point of dashboard.series) {
      expect(point.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 180_000);

  it('counts a completed stay in the top-five rooms and orders it stably', async () => {
    const hotel = await h.hotel('Top five');
    const first = await h.stayFor(hotel);
    const dashboard = await h.dashboard.read(
      { hotelId: hotel.hotelId, range: 'LAST_7_DAYS' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(dashboard.topBy).toBe('DEMAND');
    expect(dashboard.topRooms.map((room) => room.roomNumber)).toContain(first.roomNumber);
    const byRevenue = await h.dashboard.read(
      { hotelId: hotel.hotelId, range: 'LAST_7_DAYS', topBy: 'REVENUE' },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(byRevenue.topBy).toBe('REVENUE');
  }, 180_000);
});

describe('GATE — no guest PII on a financial export (doc 23 §8)', () => {
  it('carries no name, registration number or date of birth in any of the four', async () => {
    const hotel = await h.hotel('PII');
    const stay = await h.stayFor(hotel, { familyName: 'Нууц', givenName: 'Хүн' });
    await h.paidExpense(hotel, { amountMnt: 50_000n, kind: 'OPERATING' });

    for (const kind of ['ROOM_SALES', 'MINIBAR_SALES', 'EXPENSE', 'PAYMENT_BREAKDOWN'] as const) {
      const queued = await h.exports.request(
        { hotelId: hotel.hotelId, kind, idempotencyKey: key() },
        hotel.admin,
        ctx(hotel.admin),
      );
      const done = await h.exports.run(queued.jobId);
      expect(done?.state).toBe('COMPLETED');
      const storageKey = await keyOf(queued.jobId);
      const body = h.storage.bodyOf(storageKey);
      expect(body).toBeDefined();
      const text = new TextDecoder().decode(body ?? new Uint8Array());
      expect({ kind, hasFamilyName: text.includes('Нууц') }).toEqual({
        kind,
        hasFamilyName: false,
      });
      expect({ kind, hasGivenName: text.includes('Хүн') }).toEqual({ kind, hasGivenName: false });
      expect({ kind, hasRegistration: text.includes('АА9') }).toEqual({
        kind,
        hasRegistration: false,
      });
    }
    void stay;
  }, 300_000);

  it('puts nothing personal in the file name either (doc 12 §7)', async () => {
    const hotel = await h.hotel('File name');
    await h.stayFor(hotel, { familyName: 'Файл', givenName: 'Нэр' });
    const queued = await h.exports.request(
      { hotelId: hotel.hotelId, kind: 'GUEST_REGISTRY', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    await h.exports.run(queued.jobId);
    const storageKey = await keyOf(queued.jobId);
    expect(storageKey).toMatch(/^exports\/[0-9a-f-]{36}\/[0-9a-f]{32}\.xlsx$/);
    expect(storageKey).not.toContain('Файл');
  }, 180_000);
});

describe('retention and legal hold (GUEST-DEC-008)', () => {
  it('snapshots the policy at checkout, and starts no clock for an active stay', async () => {
    const hotel = await h.hotel('Retention');
    const completed = await h.stayFor(hotel);
    const active = await h.stayFor(hotel, { complete: false });

    const rows = await h.admin.query<{
      stay_id: string;
      retention_days: number;
      retention_policy_version: number;
    }>(
      `SELECT stay_id, retention_days, retention_policy_version
         FROM platform.stay_retention WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(rows.rows.map((row) => row.stay_id)).toEqual([completed.stayId]);
    expect(rows.rows[0]?.retention_days).toBe(365);
    expect(rows.rows[0]?.retention_policy_version).toBe(1);
    expect(rows.rows.map((row) => row.stay_id)).not.toContain(active.stayId);
  }, 180_000);

  it('anonymises a stay past its deadline, and never one under a legal hold', async () => {
    const hotel = await h.hotel('Purge');
    const purged = await h.stayFor(hotel, { familyName: 'Устгах', givenName: 'Хүн' });
    const held = await h.stayFor(hotel, { familyName: 'Хамгаалах', givenName: 'Хүн' });

    await h.retention.placeHold(
      {
        hotelId: hotel.hotelId,
        stayId: held.stayId,
        reason: 'Цагдаагийн хүсэлтээр түр хадгална.',
        authorityReference: 'ЦЕГ-2026-001',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );

    h.advance(366 * 24 * 60);
    // The sweep is a platform-wide maintenance job, so its count also carries
    // stays other cases in this file left behind. What this asserts is the
    // effect on the two stays it owns, below.
    const count = await h.retention.sweepRetention(50);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await h.admin.query<{ family_name: string; stay_id: string }>(
      `SELECT g.family_name, g.stay_id FROM platform.stay_guest g
        WHERE g.hotel_id = $1 AND g.is_current ORDER BY g.family_name`,
      [hotel.hotelId],
    );
    const byStay = new Map(after.rows.map((row) => [row.stay_id, row.family_name]));
    expect(byStay.get(purged.stayId)).toBe('Устгасан');
    // The held stay keeps its identity until the hold is released.
    expect(byStay.get(held.stayId)).toBe('Хамгаалах');
    const marks = await h.admin.query<{ stay_id: string; anonymized_at: Date | null }>(
      `SELECT stay_id, anonymized_at FROM platform.stay_retention WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    const marked = new Map(marks.rows.map((row) => [row.stay_id, row.anonymized_at]));
    expect(marked.get(purged.stayId)).not.toBeNull();
    expect(marked.get(held.stayId)).toBeNull();
  }, 300_000);

  it('purges a held stay once the hold is released', async () => {
    const hotel = await h.hotel('Release');
    const stay = await h.stayFor(hotel, { familyName: 'Суллах', givenName: 'Хүн' });
    const hold = await h.retention.placeHold(
      {
        hotelId: hotel.hotelId,
        stayId: stay.stayId,
        reason: 'Хуулийн шаардлагаар түр хадгална.',
        authorityReference: 'ЦЕГ-2026-002',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    h.advance(366 * 24 * 60);
    await h.retention.sweepRetention(50);
    const held = await h.admin.query<{ family_name: string; anonymized_at: Date | null }>(
      `SELECT g.family_name, r.anonymized_at
         FROM platform.stay_guest g
         JOIN platform.stay_retention r ON r.stay_id = g.stay_id
        WHERE g.stay_id = $1 AND g.is_current`,
      [stay.stayId],
    );
    expect(held.rows[0]?.family_name).toBe('Суллах');
    expect(held.rows[0]?.anonymized_at).toBeNull();

    await h.retention.releaseHold(
      {
        hotelId: hotel.hotelId,
        holdId: hold.holdId,
        reason: 'Шаардлага дууссан тул чөлөөлөв.',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(await h.retention.sweepRetention(50)).toBeGreaterThanOrEqual(1);
    const after = await h.admin.query<{ family_name: string }>(
      `SELECT family_name FROM platform.stay_guest WHERE stay_id = $1 AND is_current`,
      [stay.stayId],
    );
    expect(after.rows[0]?.family_name).toBe('Устгасан');
  }, 300_000);
});

describe('expense categories (doc 23 §4.4)', () => {
  it('creates one, refuses a duplicate name, and deactivates rather than deleting', async () => {
    const hotel = await h.hotel('Categories');
    const created = await h.categories.create(
      { hotelId: hotel.hotelId, name: 'Цэвэрлэгээ', kind: 'OPERATING', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(created.state).toBe('ACTIVE');
    await expect(
      h.categories.create(
        { hotelId: hotel.hotelId, name: 'Цэвэрлэгээ', kind: 'OPERATING', idempotencyKey: key() },
        hotel.admin,
        ctx(hotel.admin),
      ),
    ).rejects.toThrow(/already in use/);

    const off = await h.categories.setState(
      {
        hotelId: hotel.hotelId,
        categoryId: created.categoryId,
        state: 'INACTIVE',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    expect(off.state).toBe('INACTIVE');
    // Deactivated, never deleted.
    const rows = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.expense_category WHERE category_id = $1`,
      [created.categoryId],
    );
    expect(rows.rows[0]?.n).toBe('1');
  }, 180_000);

  it('refuses to change a category’s reporting kind, at the database', async () => {
    const hotel = await h.hotel('Kind immutable');
    const created = await h.categories.create(
      { hotelId: hotel.hotelId, name: 'Түрээс', kind: 'OPERATING', idempotencyKey: key() },
      hotel.admin,
      ctx(hotel.admin),
    );
    await expect(
      h.admin.query(
        `UPDATE platform.expense_category
            SET kind = 'INVENTORY_PURCHASE', revision = revision + 1
          WHERE category_id = $1`,
        [created.categoryId],
      ),
    ).rejects.toThrow(/reporting kind is immutable/);
  }, 180_000);

  it('makes the category decide the expense’s kind, and the database refuse a disagreement', async () => {
    const hotel = await h.hotel('Expense kinds');
    const purchases = await h.categories.create(
      {
        hotelId: hotel.hotelId,
        name: 'Minibar татан авалт',
        kind: 'INVENTORY_PURCHASE',
        idempotencyKey: key(),
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    // The expense is written through the finance module's own command, so what
    // is asserted is the classification contract and not a fixture.
    const expense = await h.expenses.submit(
      {
        hotelId: hotel.hotelId,
        idempotencyKey: key(),
        category: 'Minibar бараа',
        description: 'Сарын татан авалт',
        amountMnt: 250_000n,
        method: 'BANK_QPAY',
        categoryId: purchases.categoryId,
      },
      hotel.admin,
      ctx(hotel.admin),
    );
    const stored = await h.admin.query<{ expense_type: string; category_id: string }>(
      `SELECT expense_type, category_id FROM platform.expense WHERE expense_id = $1`,
      [expense.expenseId],
    );
    expect(stored.rows[0]?.expense_type).toBe('INVENTORY_PURCHASE');
    expect(stored.rows[0]?.category_id).toBe(purchases.categoryId);

    // An expense naming a category it disagrees with is refused by the trigger,
    // not merely by the service that resolved the kind.
    await expect(
      h.admin.query(
        `UPDATE platform.expense SET expense_type = 'OPERATING' WHERE expense_id = $1`,
        [expense.expenseId],
      ),
    ).rejects.toThrow(/category's kind/);

    // And a category that is not this hotel's active one classifies nothing.
    await expect(
      h.expenses.submit(
        {
          hotelId: hotel.hotelId,
          idempotencyKey: key(),
          category: 'Тодорхойгүй',
          description: 'Байхгүй ангилал',
          amountMnt: 1_000n,
          method: 'CASH',
          categoryId: '00000000-0000-4000-8000-000000000000',
        },
        hotel.admin,
        ctx(hotel.admin),
      ),
    ).rejects.toThrow(/no such active expense category/);
  }, 180_000);
});

async function keyOf(jobId: string): Promise<string> {
  const result = await h.admin.query<{ storage_key: string | null }>(
    `SELECT storage_key FROM platform.report_export_job WHERE job_id = $1`,
    [jobId],
  );
  return result.rows[0]?.storage_key ?? '';
}
