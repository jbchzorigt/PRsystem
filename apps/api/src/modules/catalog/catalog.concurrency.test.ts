import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { withTenantTransaction } from '@prsystem/db';
import type { CommandActor } from '../iam/services/iam-context';
import { hotelScope } from './services/catalog-context';
import type { CaptureOutcome, SnapshotView } from './services/tariff.service';
import type { CatalogHarness } from './test-support/catalog-harness';
import { countRows, createCatalogHarness, key, request } from './test-support/catalog-harness';

/**
 * Phase 06 concurrency, on real PostgreSQL.
 *
 * Every race is run genuinely simultaneously, on separate connections. What is
 * asserted is the invariant, not the winner: one transition per revision, no
 * room active inside an inactive category, one snapshot per subject, and a
 * snapshot whose price belongs to the configuration version it names.
 */

let env: CatalogHarness;
let hotelId: string;
let manager: CommandActor;

beforeAll(async () => {
  env = await createCatalogHarness('catalog_concurrency');
  const seeded = await env.hotelWithManager('Race Hotel', 'P30');
  hotelId = seeded.hotelId;
  manager = seeded.actor;
  await env.catalog.configureStay(
    {
      hotelId,
      idempotencyKey: key(),
      hourlyRateMnt: 20_000n,
      nightlyRateMnt: 100_000n,
      fixedCheckoutMinute: 720,
      cleaningBufferMinutes: 30,
    },
    manager,
    request(manager),
  );
}, 120000);

afterAll(async () => {
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

let roomSequence = 500;
function roomNumber(): string {
  roomSequence += 1;
  return String(roomSequence);
}

async function category(name: string, nightly?: bigint): Promise<string> {
  const created = await env.catalog.createCategory(
    {
      hotelId,
      idempotencyKey: key(),
      name,
      state: 'ACTIVE',
      ...(nightly === undefined ? {} : { nightlyRateMnt: nightly }),
    },
    manager,
    request(manager),
  );
  return created.categoryId;
}

async function transitions(entityType: string, entityId: string): Promise<number> {
  return countRows(
    env.admin,
    `SELECT count(*)::text AS n FROM platform.catalog_event
      WHERE hotel_id = $1 AND entity_type = $2 AND entity_id = $3
        AND event_type IN ('RETIREMENT_REQUESTED', 'DEACTIVATED', 'REACTIVATED', 'RETIREMENT_CANCELLED')`,
    [hotelId, entityType, entityId],
  );
}

function capture(
  input: Parameters<CatalogHarness['tariffs']['captureRateSnapshot']>[1],
): Promise<CaptureOutcome> {
  return withTenantTransaction(env.api, hotelScope(hotelId, request(manager)), (uow) =>
    env.tariffs.captureRateSnapshot(uow, input),
  );
}

describe('competing state transitions on one entity', () => {
  it('two deactivation requests at the same revision produce exactly one transition', async () => {
    const categoryId = await category('Race A');
    const command = () =>
      env.lifecycle.requestDeactivation(
        {
          hotelId,
          kind: 'ROOM_CATEGORY',
          entityId: categoryId,
          idempotencyKey: key(),
          expectedRevision: 0,
        },
        manager,
        request(manager),
      );
    const [a, b] = await Promise.all([settle(command()), settle(command())]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok);
    if (loser === undefined || loser.ok) throw new Error('expected one refusal');
    expect(loser.error.code).toBe('CONFLICT');
    expect(await transitions('ROOM_CATEGORY', categoryId)).toBe(2); // requested + deactivated
    const view = await env.lifecycle.view(
      { hotelId, kind: 'ROOM_CATEGORY', entityId: categoryId },
      manager,
      request(manager),
    );
    expect(view).toMatchObject({ state: 'INACTIVE', revision: 1 });
  });

  it('a deactivation and a hard delete racing leave either an INACTIVE row or no row, never both effects', async () => {
    const templateId = (
      await env.catalog.createMinibarEntity(
        {
          hotelId,
          idempotencyKey: key(),
          kind: 'MINIBAR_TEMPLATE',
          name: 'Race T',
          state: 'ACTIVE',
        },
        manager,
        request(manager),
      )
    ).entityId;
    const [deactivate, remove] = await Promise.all([
      settle(
        env.lifecycle.requestDeactivation(
          {
            hotelId,
            kind: 'MINIBAR_TEMPLATE',
            entityId: templateId,
            idempotencyKey: key(),
            expectedRevision: 0,
          },
          manager,
          request(manager),
        ),
      ),
      settle(
        env.lifecycle.hardDelete(
          {
            hotelId,
            kind: 'MINIBAR_TEMPLATE',
            entityId: templateId,
            idempotencyKey: key(),
            expectedRevision: 0,
          },
          manager,
          request(manager),
        ),
      ),
    ]);
    expect([deactivate.ok, remove.ok].filter(Boolean)).toHaveLength(1);
    const rows = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM platform.minibar_template WHERE template_id = $1`,
      [templateId],
    );
    if (remove.ok) expect(rows).toBe(0);
    else {
      expect(rows).toBe(1);
      expect(remove.error.code).toBe('CONFLICT');
    }
  });
});

describe('assignment versus retirement', () => {
  it('a room created into a category racing its deactivation never ends active inside an inactive category', async () => {
    for (let round = 0; round < 6; round += 1) {
      const categoryId = await category(`Race B${String(round)}`);
      const [created, retired] = await Promise.all([
        settle(
          env.catalog.createRoom(
            {
              hotelId,
              idempotencyKey: key(),
              roomNumber: roomNumber(),
              categoryId,
              state: 'ACTIVE',
            },
            manager,
            request(manager),
          ),
        ),
        settle(
          env.lifecycle.requestDeactivation(
            {
              hotelId,
              kind: 'ROOM_CATEGORY',
              entityId: categoryId,
              idempotencyKey: key(),
              expectedRevision: 0,
            },
            manager,
            request(manager),
          ),
        ),
      ]);
      expect(retired.ok).toBe(true);
      const state = await env.admin.query<{ state: string }>(
        `SELECT state FROM platform.room_category WHERE category_id = $1`,
        [categoryId],
      );
      const categoryState = state.rows[0]?.state;
      if (created.ok) {
        // The room won the category lock: the category saw a live child.
        expect(categoryState).toBe('RETIRING');
      } else {
        // The retirement won: the room was refused, and the category is done.
        expect(created.error.message).toContain('ENTITY_NOT_ACTIVE');
        expect(categoryState).toBe('INACTIVE');
      }
      const activeChildrenInInactive = await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.room r
           JOIN platform.room_category c ON c.category_id = r.category_id
          WHERE r.category_id = $1 AND r.state = 'ACTIVE' AND c.state = 'INACTIVE'`,
        [categoryId],
      );
      expect(activeChildrenInInactive).toBe(0);
    }
  });
});

describe('readers and movers never deadlock', () => {
  it('rate resolutions racing category moves in both directions all complete', async () => {
    const left = await category('Race L', 100_000n);
    const right = await category('Race R', 110_000n);
    const rooms: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const created = await env.catalog.createRoom(
        {
          hotelId,
          idempotencyKey: key(),
          roomNumber: roomNumber(),
          categoryId: i % 2 === 0 ? left : right,
          state: 'ACTIVE',
        },
        manager,
        request(manager),
      );
      rooms.push(created.roomId);
    }
    // Movers cross: even rooms go right, odd rooms go left, while readers
    // resolve every room and both categories at the same time. A reader takes
    // the category before the room; a mover takes both categories before the
    // room — one order, so PostgreSQL never has to break a cycle.
    for (let round = 0; round < 3; round += 1) {
      const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
      const revisions = new Map(listing.rooms.map((r) => [r.roomId, r.revision]));
      const movers = rooms.map((roomId, i) =>
        settle(
          env.catalog.updateRoom(
            {
              hotelId,
              roomId,
              idempotencyKey: key(),
              expectedRevision: revisions.get(roomId) ?? 0,
              categoryId: (i + round) % 2 === 0 ? right : left,
            },
            manager,
            request(manager),
          ),
        ),
      );
      const readers = [
        ...rooms.map((roomId) =>
          settle(
            env.tariffs.effectiveRate(
              { hotelId, stayType: 'NIGHTLY', channel: 'WALK_IN', roomId },
              manager,
              request(manager),
            ),
          ),
        ),
        ...[left, right].map((categoryId) =>
          settle(
            env.tariffs.effectiveRate(
              { hotelId, stayType: 'NIGHTLY', channel: 'ONLINE', categoryId },
              manager,
              request(manager),
            ),
          ),
        ),
      ];
      const results = await Promise.all([...movers, ...readers]);
      for (const result of results) {
        // The only refusal a reader may see is the one it is told to retry on;
        // a deadlock would surface as a raw 40P01, never as an ApiError.
        if (!result.ok) expect(result.error.code).toBe('CONFLICT');
      }
      expect(results.slice(0, movers.length).every((r) => r.ok)).toBe(true);
    }
  });
});

describe('duplicate and concurrent identical requests', () => {
  it('the same idempotency key sent twice at once yields one effect', async () => {
    const categoryId = await category('Race C');
    const idempotencyKey = key();
    const command = () =>
      env.lifecycle.requestDeactivation(
        {
          hotelId,
          kind: 'ROOM_CATEGORY',
          entityId: categoryId,
          idempotencyKey,
          expectedRevision: 0,
        },
        manager,
        request(manager),
      );
    const results = await Promise.all([settle(command()), settle(command()), settle(command())]);
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (!result.ok) expect(result.error.code).toBe('CONFLICT');
      else expect(result.value.state).toBe('INACTIVE');
    }
    expect(await transitions('ROOM_CATEGORY', categoryId)).toBe(2);
    // And a later replay returns the stored answer without touching the row.
    const replay = await command();
    expect(replay.state).toBe('INACTIVE');
    expect(await transitions('ROOM_CATEGORY', categoryId)).toBe(2);
  });
});

describe('snapshots under concurrent edits', () => {
  it('two confirmations for one subject write one snapshot and both read it', async () => {
    const categoryId = await category('Race D', 150_000n);
    const subjectRef = '66666666-6666-4666-8666-666666666666';
    const input = {
      subjectType: 'ONLINE_BOOKING' as const,
      subjectRef,
      stayType: 'NIGHTLY' as const,
      categoryId,
    };
    const [a, b] = await Promise.all([capture(input), capture(input)]);
    expect([a.captured, b.captured].filter(Boolean)).toHaveLength(1);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.stay_rate_snapshot WHERE hotel_id = $1 AND subject_ref = $2`,
        [hotelId, subjectRef],
      ),
    ).toBe(1);
  });

  it('a snapshot racing a tariff edit carries the price of the version it names', async () => {
    const categoryId = await category('Race E', 150_000n);
    for (let round = 0; round < 5; round += 1) {
      const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
      const row = listing.categories.find((c) => c.categoryId === categoryId);
      if (row === undefined) throw new Error('category missing');
      const newRate = 150_000n + BigInt(round + 1) * 10_000n;
      const subjectRef = `77777777-7777-4777-8777-${String(round).padStart(12, '0')}`;
      const [captured, edited] = await Promise.all([
        capture({ subjectType: 'ONLINE_BOOKING', subjectRef, stayType: 'NIGHTLY', categoryId }),
        env.catalog.updateCategory(
          {
            hotelId,
            categoryId,
            idempotencyKey: key(),
            expectedRevision: row.revision,
            nightlyRateMnt: newRate,
          },
          manager,
          request(manager),
        ),
      ]);
      const snapshot: SnapshotView = captured.snapshot;
      const editVersion = await env.admin.query<{ config_version: number }>(
        `SELECT config_version FROM platform.catalog_event
          WHERE hotel_id = $1 AND entity_id = $2 AND event_type = 'TARIFF_SET'
          ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
        [hotelId, categoryId],
      );
      const version = Number(editVersion.rows[0]?.config_version);
      expect(edited.nightlyRateMnt).toBe(newRate.toString());
      if (snapshot.pricingConfigVersion >= version) {
        expect(snapshot.unitPriceMnt).toBe(newRate.toString());
      } else {
        expect(BigInt(snapshot.unitPriceMnt)).toBe(newRate - 10_000n);
      }
    }
  });
});
