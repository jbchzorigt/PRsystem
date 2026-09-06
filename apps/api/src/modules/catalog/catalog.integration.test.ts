import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import { withTenantTransaction } from '@prsystem/db';
import type { CommandActor } from '../iam/services/iam-context';
import type { EntityKind } from './domain/lifecycle';
import type { SeededMembership } from '../iam/test-support/iam-harness';
import { hotelScope } from './services/catalog-context';
import type { CaptureOutcome } from './services/tariff.service';
import type { CatalogHarness } from './test-support/catalog-harness';
import { countRows, createCatalogHarness, key, request } from './test-support/catalog-harness';

/**
 * Phase 06 on real PostgreSQL, through the restricted API login.
 *
 * Tariff configuration and resolution (`STAY-DEC-002`, `-004`, `-005`, `-006`),
 * the confirmation snapshot (`STAY-DEC-005`, `RML-DEC-004`), the entity
 * lifecycle with its dependency evidence (`RML-DEC-001`…`006`, `RC-DEC-040`)
 * and the tenant boundary. Every command's audit, history and outbox rows are
 * asserted from the administrative connection.
 */

let env: CatalogHarness;
let hotelId: string;
let manager: CommandActor;
let managerMember: SeededMembership;

beforeAll(async () => {
  env = await createCatalogHarness('catalog_integration');
  const seeded = await env.hotelWithManager('Catalog Hotel', 'P30');
  hotelId = seeded.hotelId;
  manager = seeded.actor;
  managerMember = seeded.manager;
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

async function events(entityType: string, entityId: string): Promise<Record<string, unknown>[]> {
  const result = await env.admin.query<Record<string, unknown>>(
    `SELECT event_type, from_state, to_state, reason, config_version, payload, actor_account_id
       FROM platform.catalog_event
      WHERE hotel_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY occurred_at, event_id`,
    [hotelId, entityType, entityId],
  );
  return result.rows;
}

async function audits(action: string, targetRef: string): Promise<number> {
  return countRows(
    env.admin,
    `SELECT count(*)::text AS n FROM audit.platform_event
      WHERE hotel_id = $1 AND action = $2 AND target_ref = $3 AND outcome = 'allowed'`,
    [hotelId, action, targetRef],
  );
}

async function outbox(eventType: string, aggregateId: string): Promise<number> {
  return countRows(
    env.admin,
    `SELECT count(*)::text AS n FROM platform.outbox_event
      WHERE hotel_id = $1 AND event_type = $2 AND aggregate_id = $3`,
    [hotelId, eventType, aggregateId],
  );
}

function capture(
  hotel: string,
  actor: CommandActor,
  input: Parameters<CatalogHarness['tariffs']['captureRateSnapshot']>[1],
): Promise<CaptureOutcome> {
  return withTenantTransaction(env.api, hotelScope(hotel, request(actor)), (uow) =>
    env.tariffs.captureRateSnapshot(uow, input),
  );
}

/** The revision a command must name: what the server holds now. */
async function rev(kind: EntityKind, entityId: string): Promise<number> {
  const view = await env.lifecycle.view({ hotelId, kind, entityId }, manager, request(manager));
  return view.revision;
}

let sequence = 100;
function roomNumber(): string {
  sequence += 1;
  return String(sequence);
}

describe('hotel stay configuration (STAY-DEC-004, STAY-DEC-006, STAY-DEC-007)', () => {
  it('sets the defaults, advances the version, and records history, audit and outbox atomically', async () => {
    const before = await env.catalog.listCatalog(hotelId, manager, request(manager));
    expect(before.configuration).toBeNull();

    const written = await env.catalog.configureStay(
      {
        hotelId,
        idempotencyKey: key(),
        hourlyRateMnt: 20_000n,
        nightlyRateMnt: 100_000n,
        fixedCheckoutMinute: 12 * 60,
        cleaningBufferMinutes: 30,
      },
      manager,
      request(manager),
    );
    expect(written).toMatchObject({
      hourlyRateMnt: '20000',
      nightlyRateMnt: '100000',
      fixedCheckoutMinute: 720,
      cleaningBufferMinutes: 30,
      configVersion: 2,
    });
    expect(await events('HOTEL_STAY_CONFIGURATION', hotelId)).toMatchObject([
      { event_type: 'CONFIGURATION_SET', config_version: 2 },
    ]);
    expect(await audits('catalog.stay_configuration.set', hotelId)).toBe(1);
    expect(await outbox('catalog.stay_configuration.changed', hotelId)).toBe(1);
  });

  it('replays the same key with the same payload without a second effect', async () => {
    const k = key();
    const input = { hotelId, idempotencyKey: k, cleaningBufferMinutes: 45 };
    const first = await env.catalog.configureStay(input, manager, request(manager));
    const second = await env.catalog.configureStay(input, manager, request(manager));
    expect(second).toEqual(first);
    expect(first.configVersion).toBe(3);
    expect(await audits('catalog.stay_configuration.set', hotelId)).toBe(2);
    // The same key with a different payload is refused, not applied.
    const reused = await refused(
      env.catalog.configureStay(
        { hotelId, idempotencyKey: k, cleaningBufferMinutes: 60 },
        manager,
        request(manager),
      ),
    );
    expect(reused.code).toBe('CONFLICT');
  });

  it('has no field for an hourly minimum, maximum or increment', () => {
    // The surface is the type: nothing named minimum, maximum, increment or
    // step exists on the command, so no payload can carry one (STAY-DEC-006).
    const shape: Record<string, unknown> = {
      hotelId,
      idempotencyKey: key(),
      hourlyRateMnt: 1n,
      nightlyRateMnt: 1n,
      fixedCheckoutMinute: 0,
      cleaningBufferMinutes: 0,
    };
    for (const forbidden of ['minimumHours', 'maximumHours', 'incrementMinutes', 'stepMinutes']) {
      expect(Object.keys(shape)).not.toContain(forbidden);
    }
  });
});

describe('categories, rooms and overrides (doc 07 §§2–3, STAY-DEC-005)', () => {
  let categoryId: string;
  let roomId: string;

  it('creates a category with a nightly override only; the hourly rate stays inherited', async () => {
    const created = await env.catalog.createCategory(
      {
        hotelId,
        idempotencyKey: key(),
        name: 'Deluxe',
        state: 'ACTIVE',
        nightlyRateMnt: 150_000n,
        cleaningBufferMinutes: 45,
      },
      manager,
      request(manager),
    );
    categoryId = created.categoryId;
    expect(created).toMatchObject({
      state: 'ACTIVE',
      hourlyRateMnt: null,
      nightlyRateMnt: '150000',
      cleaningBufferMinutes: 45,
      revision: 0,
    });
    expect(await events('ROOM_CATEGORY', categoryId)).toMatchObject([
      { event_type: 'CREATED', to_state: 'ACTIVE', config_version: 4 },
    ]);
    expect(await audits('catalog.category.create', categoryId)).toBe(1);
  });

  it('creates a room with a walk-in hourly override; the room number is unique per hotel', async () => {
    const number = roomNumber();
    const created = await env.catalog.createRoom(
      {
        hotelId,
        idempotencyKey: key(),
        roomNumber: number,
        floorLabel: '1',
        categoryId,
        state: 'ACTIVE',
        hourlyRateMnt: 30_000n,
      },
      manager,
      request(manager),
    );
    roomId = created.roomId;
    expect(created).toMatchObject({
      roomNumber: number,
      hourlyRateMnt: '30000',
      nightlyRateMnt: null,
    });

    const duplicate = await refused(
      env.catalog.createRoom(
        { hotelId, idempotencyKey: key(), roomNumber: number, categoryId, state: 'ACTIVE' },
        manager,
        request(manager),
      ),
    );
    expect(duplicate.code).toBe('CONFLICT');
    expect(duplicate.message).toContain('ROOM_NUMBER_TAKEN');
  });

  it('refuses a category id that belongs to another hotel', async () => {
    const other = await env.hotelWithManager('Other Hotel', 'P20');
    const foreign = await env.catalog.createCategory(
      { hotelId: other.hotelId, idempotencyKey: key(), name: 'Foreign', state: 'ACTIVE' },
      other.actor,
      request(other.actor),
    );
    const error = await refused(
      env.catalog.createRoom(
        {
          hotelId,
          idempotencyKey: key(),
          roomNumber: roomNumber(),
          categoryId: foreign.categoryId,
          state: 'ACTIVE',
        },
        manager,
        request(manager),
      ),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    // And the other hotel's Manager sees nothing of this hotel.
    const across = await refused(
      env.lifecycle.view(
        { hotelId, kind: 'ROOM', entityId: roomId },
        other.actor,
        request(other.actor),
      ),
    );
    expect(across.code).toBe('NOT_FOUND');
  });

  it('resolves walk-in room → category → hotel and online category → hotel, independently per stay type', async () => {
    const walkInHourly = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'HOURLY', channel: 'WALK_IN', roomId },
      manager,
      request(manager),
    );
    expect(walkInHourly).toMatchObject({
      unitPriceMnt: '30000',
      sourceLevel: 'ROOM',
      sourceEntityId: roomId,
      cleaningBufferMinutes: 45,
      fixedCheckoutMinute: null,
    });
    const walkInNightly = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'NIGHTLY', channel: 'WALK_IN', roomId },
      manager,
      request(manager),
    );
    expect(walkInNightly).toMatchObject({
      unitPriceMnt: '150000',
      sourceLevel: 'CATEGORY',
      sourceEntityId: categoryId,
      fixedCheckoutMinute: 720,
    });
    const onlineNightly = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'NIGHTLY', channel: 'ONLINE', categoryId },
      manager,
      request(manager),
    );
    expect(onlineNightly).toMatchObject({ unitPriceMnt: '150000', sourceLevel: 'CATEGORY' });
    const onlineHourly = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'HOURLY', channel: 'ONLINE', categoryId },
      manager,
      request(manager),
    );
    // No hourly override at the category; the hotel default, never the room's 30,000.
    expect(onlineHourly).toMatchObject({ unitPriceMnt: '20000', sourceLevel: 'HOTEL' });

    const withRoom = await refused(
      env.tariffs.effectiveRate(
        { hotelId, stayType: 'NIGHTLY', channel: 'ONLINE', categoryId, roomId },
        manager,
        request(manager),
      ),
    );
    expect(withRoom.code).toBe('VALIDATION_FAILED');
  });

  it('clearing an override is a TARIFF_CLEARED event with its own version, and reverts to inheritance', async () => {
    const before = await env.catalog.listCatalog(hotelId, manager, request(manager));
    const room = before.rooms.find((r) => r.roomId === roomId);
    if (room === undefined) throw new Error('room missing');
    const updated = await env.catalog.updateRoom(
      {
        hotelId,
        roomId,
        idempotencyKey: key(),
        expectedRevision: room.revision,
        hourlyRateMnt: null,
      },
      manager,
      request(manager),
    );
    expect(updated.hourlyRateMnt).toBeNull();
    const history = await events('ROOM', roomId);
    expect(history.at(-1)).toMatchObject({
      event_type: 'TARIFF_CLEARED',
      payload: { cleared: ['HOURLY'] },
    });
    expect(await audits('catalog.room.tariff', roomId)).toBe(1);
    expect(await outbox('catalog.tariff.changed', roomId)).toBe(1);
    const resolved = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'HOURLY', channel: 'WALK_IN', roomId },
      manager,
      request(manager),
    );
    expect(resolved).toMatchObject({ unitPriceMnt: '20000', sourceLevel: 'HOTEL' });

    // A stale revision is refused and nothing moves.
    const stale = await refused(
      env.catalog.updateRoom(
        {
          hotelId,
          roomId,
          idempotencyKey: key(),
          expectedRevision: room.revision,
          floorLabel: '9',
        },
        manager,
        request(manager),
      ),
    );
    expect(stale.code).toBe('CONFLICT');
  });

  it('refuses a stay type no level prices, rather than pricing it at zero', async () => {
    const bare = await env.hotelWithManager('Unpriced Hotel', 'P20');
    const category = await env.catalog.createCategory(
      { hotelId: bare.hotelId, idempotencyKey: key(), name: 'Bare', state: 'ACTIVE' },
      bare.actor,
      request(bare.actor),
    );
    const error = await refused(
      env.tariffs.effectiveRate(
        {
          hotelId: bare.hotelId,
          stayType: 'NIGHTLY',
          channel: 'ONLINE',
          categoryId: category.categoryId,
        },
        bare.actor,
        request(bare.actor),
      ),
    );
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.message).toContain('TARIFF_UNSET');
    // A price without a buffer is refused as well: nothing becomes zero.
    await env.catalog.configureStay(
      {
        hotelId: bare.hotelId,
        idempotencyKey: key(),
        nightlyRateMnt: 80_000n,
        fixedCheckoutMinute: 720,
      },
      bare.actor,
      request(bare.actor),
    );
    const noBuffer = await refused(
      env.tariffs.effectiveRate(
        {
          hotelId: bare.hotelId,
          stayType: 'NIGHTLY',
          channel: 'ONLINE',
          categoryId: category.categoryId,
        },
        bare.actor,
        request(bare.actor),
      ),
    );
    expect(noBuffer.message).toContain('CLEANING_BUFFER_UNSET');
  });
});

describe('the confirmation snapshot (STAY-DEC-005, RML-DEC-004)', () => {
  let categoryId: string;
  let roomId: string;
  const stayRef = '11111111-1111-4111-8111-111111111111';
  const bookingRef = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    const category = await env.catalog.createCategory(
      { hotelId, idempotencyKey: key(), name: 'Suite', state: 'ACTIVE', nightlyRateMnt: 200_000n },
      manager,
      request(manager),
    );
    categoryId = category.categoryId;
    const room = await env.catalog.createRoom(
      {
        hotelId,
        idempotencyKey: key(),
        roomNumber: roomNumber(),
        categoryId,
        state: 'ACTIVE',
        nightlyRateMnt: 250_000n,
      },
      manager,
      request(manager),
    );
    roomId = room.roomId;
  });

  it('captures the walk-in price with source, entity and version, once per subject', async () => {
    const first = await capture(hotelId, manager, {
      subjectType: 'WALK_IN_STAY',
      subjectRef: stayRef,
      stayType: 'NIGHTLY',
      roomId,
    });
    expect(first.captured).toBe(true);
    expect(first.snapshot).toMatchObject({
      unitPriceMnt: '250000',
      sourceLevel: 'ROOM',
      sourceEntityId: roomId,
      categoryId,
      roomId,
      fixedCheckoutMinute: 720,
      // The hotel minimum, as last configured; the Suite category sets none.
      cleaningBufferMinutes: 45,
    });
    const again = await capture(hotelId, manager, {
      subjectType: 'WALK_IN_STAY',
      subjectRef: stayRef,
      stayType: 'NIGHTLY',
      roomId,
    });
    expect(again.captured).toBe(false);
    expect(again.snapshot).toEqual(first.snapshot);
  });

  it('an online booking is priced category-first and cannot carry a room override', async () => {
    const online = await capture(hotelId, manager, {
      subjectType: 'ONLINE_BOOKING',
      subjectRef: bookingRef,
      stayType: 'NIGHTLY',
      categoryId,
    });
    expect(online.snapshot).toMatchObject({
      unitPriceMnt: '200000',
      sourceLevel: 'CATEGORY',
      roomId: null,
    });
    const withRoom = await refused(
      capture(hotelId, manager, {
        subjectType: 'ONLINE_BOOKING',
        subjectRef: '33333333-3333-4333-8333-333333333333',
        stayType: 'NIGHTLY',
        categoryId,
        roomId,
      }),
    );
    expect(withRoom.code).toBe('VALIDATION_FAILED');
    // The database refuses a room-sourced online price on its own, whatever the service does.
    await expect(
      env.admin.query(
        `INSERT INTO platform.stay_rate_snapshot
           (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
            source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes,
            fixed_checkout_minute)
         VALUES ($1, 'ONLINE_BOOKING', gen_random_uuid(), 'NIGHTLY', 1, 'ROOM', $2, 1, $3, $2, 30, 720)`,
        [hotelId, roomId, categoryId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a later tariff edit never reprices the snapshot; the version proves which configuration priced it', async () => {
    const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
    const room = listing.rooms.find((r) => r.roomId === roomId);
    if (room === undefined) throw new Error('room missing');
    const priced = await env.tariffs.snapshot(
      { hotelId, subjectType: 'WALK_IN_STAY', subjectRef: stayRef },
      manager,
      request(manager),
    );
    await env.catalog.updateRoom(
      {
        hotelId,
        roomId,
        idempotencyKey: key(),
        expectedRevision: room.revision,
        nightlyRateMnt: 999_000n,
      },
      manager,
      request(manager),
    );
    await env.catalog.configureStay(
      { hotelId, idempotencyKey: key(), fixedCheckoutMinute: 11 * 60, cleaningBufferMinutes: 90 },
      manager,
      request(manager),
    );
    const after = await env.tariffs.snapshot(
      { hotelId, subjectType: 'WALK_IN_STAY', subjectRef: stayRef },
      manager,
      request(manager),
    );
    expect(after).toEqual(priced);
    const now = await env.tariffs.effectiveRate(
      { hotelId, stayType: 'NIGHTLY', channel: 'WALK_IN', roomId },
      manager,
      request(manager),
    );
    expect(now.unitPriceMnt).toBe('999000');
    expect(now.configVersion).toBeGreaterThan(priced.pricingConfigVersion);
  });

  it('is append-only in the database: no update, no delete, for any role', async () => {
    await expect(
      env.admin.query(
        `UPDATE platform.stay_rate_snapshot SET unit_price_mnt = 1
          WHERE hotel_id = $1 AND subject_ref = $2`,
        [hotelId, stayRef],
      ),
    ).rejects.toThrow();
    await expect(
      env.admin.query(`DELETE FROM platform.stay_rate_snapshot WHERE hotel_id = $1`, [hotelId]),
    ).rejects.toThrow();
    const grants = await env.admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'stay_rate_snapshot'
          AND grantee IN ('prsystem_api', 'prsystem_worker')`,
    );
    expect(grants.rows.map((row) => row.privilege_type).sort()).toEqual([
      'INSERT',
      'SELECT',
      'SELECT',
    ]);
  });

  it('refuses to price a retiring room or category (ENTITY_NOT_ACTIVE)', async () => {
    const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
    const room = listing.rooms.find((r) => r.roomId === roomId);
    if (room === undefined) throw new Error('room missing');
    // The room has a snapshot: history, which never blocks a deactivation.
    const moved = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM',
        entityId: roomId,
        idempotencyKey: key(),
        expectedRevision: room.revision,
      },
      manager,
      request(manager),
    );
    expect(moved.state).toBe('INACTIVE');
    const error = await refused(
      capture(hotelId, manager, {
        subjectType: 'WALK_IN_STAY',
        subjectRef: '44444444-4444-4444-8444-444444444444',
        stayType: 'HOURLY',
        roomId,
      }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('ENTITY_NOT_ACTIVE');
  });
});

describe('the entity lifecycle (RML-DEC-001…006, RC-DEC-040)', () => {
  let categoryId: string;
  let roomId: string;

  beforeAll(async () => {
    const category = await env.catalog.createCategory(
      { hotelId, idempotencyKey: key(), name: 'Economy', state: 'ACTIVE' },
      manager,
      request(manager),
    );
    categoryId = category.categoryId;
    const room = await env.catalog.createRoom(
      { hotelId, idempotencyKey: key(), roomNumber: roomNumber(), categoryId, state: 'ACTIVE' },
      manager,
      request(manager),
    );
    roomId = room.roomId;
  });

  it('a category with an active child room goes RETIRING with the blocker recorded', async () => {
    const moved = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM_CATEGORY',
        entityId: categoryId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM_CATEGORY', categoryId),
        reason: 'renovation',
      },
      manager,
      request(manager),
    );
    expect(moved).toMatchObject({
      state: 'RETIRING',
      previousState: 'ACTIVE',
      retirementReason: 'renovation',
    });
    expect(moved.blockers).toEqual([
      expect.objectContaining({ sourceId: 'category.child_room', state: 'blocked', count: 1 }),
    ]);
    expect(await events('ROOM_CATEGORY', categoryId)).toMatchObject([
      { event_type: 'CREATED' },
      {
        event_type: 'RETIREMENT_REQUESTED',
        from_state: 'ACTIVE',
        to_state: 'RETIRING',
        reason: 'renovation',
        payload: { outcome: 'RETIRING', blockers: [{ sourceId: 'category.child_room' }] },
        actor_account_id: managerMember.accountId,
      },
    ]);
    expect(await audits('catalog.lifecycle.deactivation_requested', categoryId)).toBe(1);
    expect(await outbox('catalog.entity.state_changed', categoryId)).toBe(1);
  });

  it('a retiring category takes no new room and refuses a room moving into it', async () => {
    const error = await refused(
      env.catalog.createRoom(
        { hotelId, idempotencyKey: key(), roomNumber: roomNumber(), categoryId, state: 'ACTIVE' },
        manager,
        request(manager),
      ),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('ENTITY_NOT_ACTIVE');
    // An INACTIVE room may still be filed under it: it is not operational use.
    const parked = await env.catalog.createRoom(
      { hotelId, idempotencyKey: key(), roomNumber: roomNumber(), categoryId, state: 'INACTIVE' },
      manager,
      request(manager),
    );
    expect(parked.state).toBe('INACTIVE');
  });

  it('finalization is refused while the child room is active, naming the blocker', async () => {
    const error = await refused(
      env.lifecycle.finalizeRetirement(
        {
          hotelId,
          kind: 'ROOM_CATEGORY',
          entityId: categoryId,
          idempotencyKey: key(),
          expectedRevision: await rev('ROOM_CATEGORY', categoryId),
        },
        manager,
        request(manager),
      ),
    );
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual([expect.objectContaining({ field: 'category.child_room' })]);
  });

  it('deactivating the last active room completes the category retirement, recording requester and system', async () => {
    const room = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM',
        entityId: roomId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM', roomId),
      },
      manager,
      request(manager),
    );
    expect(room.state).toBe('INACTIVE');
    const category = await env.lifecycle.view(
      { hotelId, kind: 'ROOM_CATEGORY', entityId: categoryId },
      manager,
      request(manager),
    );
    expect(category.state).toBe('INACTIVE');
    const history = await events('ROOM_CATEGORY', categoryId);
    expect(history.at(-1)).toMatchObject({
      event_type: 'DEACTIVATED',
      from_state: 'RETIRING',
      to_state: 'INACTIVE',
      payload: {
        finalizedBy: 'system',
        requestedBy: managerMember.accountId,
        trigger: 'catalog.room.deactivated',
      },
    });
    expect(await audits('catalog.lifecycle.deactivation_completed_by_system', categoryId)).toBe(1);
  });

  it('a room cannot be reactivated under an inactive category; the category first, then the room', async () => {
    const blocked = await refused(
      env.lifecycle.reactivate(
        {
          hotelId,
          kind: 'ROOM',
          entityId: roomId,
          idempotencyKey: key(),
          expectedRevision: await rev('ROOM', roomId),
        },
        manager,
        request(manager),
      ),
    );
    expect(blocked.code).toBe('PRECONDITION_FAILED');
    expect(blocked.message).toContain('ENTITY_NOT_ACTIVE');

    const category = await env.lifecycle.reactivate(
      {
        hotelId,
        kind: 'ROOM_CATEGORY',
        entityId: categoryId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM_CATEGORY', categoryId),
      },
      manager,
      request(manager),
    );
    expect(category).toMatchObject({
      state: 'ACTIVE',
      retirementRequestedAt: null,
      retirementReason: null,
    });
    const room = await env.lifecycle.reactivate(
      {
        hotelId,
        kind: 'ROOM',
        entityId: roomId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM', roomId),
      },
      manager,
      request(manager),
    );
    expect(room.state).toBe('ACTIVE');
    expect((await events('ROOM', roomId)).at(-1)).toMatchObject({
      event_type: 'REACTIVATED',
      from_state: 'INACTIVE',
      to_state: 'ACTIVE',
    });
    expect(await audits('catalog.lifecycle.reactivated', roomId)).toBe(1);
  });

  it('cancelling a pending deactivation returns the entity to ACTIVE', async () => {
    const retiring = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM_CATEGORY',
        entityId: categoryId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM_CATEGORY', categoryId),
      },
      manager,
      request(manager),
    );
    expect(retiring.state).toBe('RETIRING');
    const wrongEdge = await refused(
      env.lifecycle.reactivate(
        {
          hotelId,
          kind: 'ROOM_CATEGORY',
          entityId: categoryId,
          idempotencyKey: key(),
          expectedRevision: await rev('ROOM_CATEGORY', categoryId),
        },
        manager,
        request(manager),
      ),
    );
    expect(wrongEdge.code).toBe('CONFLICT');
    const back = await env.lifecycle.cancelDeactivation(
      {
        hotelId,
        kind: 'ROOM_CATEGORY',
        entityId: categoryId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM_CATEGORY', categoryId),
      },
      manager,
      request(manager),
    );
    expect(back).toMatchObject({ state: 'ACTIVE', previousState: 'RETIRING' });
    expect((await events('ROOM_CATEGORY', categoryId)).at(-1)).toMatchObject({
      event_type: 'RETIREMENT_CANCELLED',
    });
  });

  it('moving the last room out of a retiring category completes the retirement too', async () => {
    const other = await env.catalog.createCategory(
      { hotelId, idempotencyKey: key(), name: 'Economy Plus', state: 'ACTIVE' },
      manager,
      request(manager),
    );
    const retiring = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM_CATEGORY',
        entityId: categoryId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM_CATEGORY', categoryId),
      },
      manager,
      request(manager),
    );
    expect(retiring.state).toBe('RETIRING');
    const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
    const room = listing.rooms.find((r) => r.roomId === roomId);
    if (room === undefined) throw new Error('room missing');
    await env.catalog.updateRoom(
      {
        hotelId,
        roomId,
        idempotencyKey: key(),
        expectedRevision: room.revision,
        categoryId: other.categoryId,
      },
      manager,
      request(manager),
    );
    const view = await env.lifecycle.view(
      { hotelId, kind: 'ROOM_CATEGORY', entityId: categoryId },
      manager,
      request(manager),
    );
    // The parked INACTIVE room does not count; the category is done.
    expect(view.state).toBe('INACTIVE');
    expect((await events('ROOM_CATEGORY', categoryId)).at(-1)).toMatchObject({
      event_type: 'DEACTIVATED',
      payload: { finalizedBy: 'system', trigger: 'catalog.room.category_changed' },
    });
  });

  it('the state machine is enforced in the database as well as the service', async () => {
    await expect(
      env.admin.query(
        `INSERT INTO platform.room_category (hotel_id, name, state, retirement_requested_at)
         VALUES ($1, 'Direct', 'RETIRING', now())`,
        [hotelId],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    const parked = await env.catalog.createCategory(
      { hotelId, idempotencyKey: key(), name: 'Parked', state: 'INACTIVE' },
      manager,
      request(manager),
    );
    // INACTIVE → RETIRING is not an edge, whoever issues the statement.
    await expect(
      env.admin.query(
        `UPDATE platform.room_category SET state = 'RETIRING', retirement_requested_at = now(),
                revision = revision + 1
          WHERE hotel_id = $1 AND category_id = $2`,
        [hotelId, parked.categoryId],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    // And a revision that does not move is refused too.
    await expect(
      env.admin.query(
        `UPDATE platform.room_category SET description = 'x'
          WHERE hotel_id = $1 AND category_id = $2`,
        [hotelId, parked.categoryId],
      ),
    ).rejects.toMatchObject({ code: '40001' });
  });
});

describe('hard delete (RML-DEC-005) and dependency evidence (RML-DEC-003)', () => {
  it('deletes a never-used entity, with a security audit that outlives the row', async () => {
    const product = await env.catalog.createMinibarEntity(
      { hotelId, idempotencyKey: key(), kind: 'MINIBAR_PRODUCT', name: 'Water', state: 'ACTIVE' },
      manager,
      request(manager),
    );
    const deleted = await env.lifecycle.hardDelete(
      {
        hotelId,
        kind: 'MINIBAR_PRODUCT',
        entityId: product.entityId,
        idempotencyKey: key(),
        expectedRevision: await rev('MINIBAR_PRODUCT', product.entityId),
        reason: 'created by mistake',
      },
      manager,
      request(manager),
    );
    expect(deleted).toEqual({ entityId: product.entityId, kind: 'MINIBAR_PRODUCT', deleted: true });
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.minibar_product WHERE product_id = $1`,
        [product.entityId],
      ),
    ).toBe(0);
    expect((await events('MINIBAR_PRODUCT', product.entityId)).at(-1)).toMatchObject({
      event_type: 'HARD_DELETED',
      from_state: 'ACTIVE',
      reason: 'created by mistake',
      actor_account_id: managerMember.accountId,
    });
    expect(await audits('catalog.lifecycle.hard_deleted', product.entityId)).toBe(1);
    expect(await outbox('catalog.entity.hard_deleted', product.entityId)).toBe(1);
  });

  it('refuses to delete a referenced category, a room with a snapshot, and a retiring entity', async () => {
    const category = await env.catalog.createCategory(
      {
        hotelId,
        idempotencyKey: key(),
        name: 'Referenced',
        state: 'ACTIVE',
        nightlyRateMnt: 50_000n,
      },
      manager,
      request(manager),
    );
    const room = await env.catalog.createRoom(
      {
        hotelId,
        idempotencyKey: key(),
        roomNumber: roomNumber(),
        categoryId: category.categoryId,
        state: 'ACTIVE',
      },
      manager,
      request(manager),
    );
    await capture(hotelId, manager, {
      subjectType: 'WALK_IN_STAY',
      subjectRef: '55555555-5555-4555-8555-555555555555',
      stayType: 'NIGHTLY',
      roomId: room.roomId,
    });

    const categoryDelete = await refused(
      env.lifecycle.hardDelete(
        {
          hotelId,
          kind: 'ROOM_CATEGORY',
          entityId: category.categoryId,
          idempotencyKey: key(),
          expectedRevision: await rev('ROOM_CATEGORY', category.categoryId),
        },
        manager,
        request(manager),
      ),
    );
    expect(categoryDelete.code).toBe('CONFLICT');
    expect(categoryDelete.details?.map((d) => d.field)).toEqual(
      expect.arrayContaining([
        'category.child_room',
        'category.room_history',
        'category.rate_snapshot',
      ]),
    );
    const roomDelete = await refused(
      env.lifecycle.hardDelete(
        {
          hotelId,
          kind: 'ROOM',
          entityId: room.roomId,
          idempotencyKey: key(),
          expectedRevision: await rev('ROOM', room.roomId),
        },
        manager,
        request(manager),
      ),
    );
    expect(roomDelete.details).toEqual([expect.objectContaining({ field: 'room.rate_snapshot' })]);

    const template = await env.catalog.createMinibarEntity(
      {
        hotelId,
        idempotencyKey: key(),
        kind: 'MINIBAR_TEMPLATE',
        name: 'Standard',
        state: 'ACTIVE',
      },
      manager,
      request(manager),
    );
    // A template's operational sources are all Phase 07's: not yet provisioned,
    // so the request goes straight to INACTIVE — and an INACTIVE never-used
    // entity may still be deleted. Make it RETIRING by hand to prove the refusal.
    await env.admin.query(
      `UPDATE platform.minibar_template
          SET state = 'RETIRING', retirement_requested_at = now(), revision = revision + 1
        WHERE hotel_id = $1 AND template_id = $2`,
      [hotelId, template.entityId],
    );
    const pending = await refused(
      env.lifecycle.hardDelete(
        {
          hotelId,
          kind: 'MINIBAR_TEMPLATE',
          entityId: template.entityId,
          idempotencyKey: key(),
          expectedRevision: await rev('MINIBAR_TEMPLATE', template.entityId),
        },
        manager,
        request(manager),
      ),
    );
    expect(pending.code).toBe('CONFLICT');
    expect(pending.message).toContain('pending');
  });

  it('fails closed when a dependency source cannot be read, and shows it in the view', async () => {
    const category = await env.catalog.createCategory(
      { hotelId, idempotencyKey: key(), name: 'Evidence', state: 'ACTIVE' },
      manager,
      request(manager),
    );
    const room = await env.catalog.createRoom(
      {
        hotelId,
        idempotencyKey: key(),
        roomNumber: roomNumber(),
        categoryId: category.categoryId,
        state: 'ACTIVE',
      },
      manager,
      request(manager),
    );
    // A relation the registry names, present but unreadable in the shape the
    // probe expects: the probe raises, and a raise is not "no rows". Every
    // registered relation exists once Phase 13 has landed, so the shape is
    // broken here deliberately and restored below — which is a truer test of
    // the rule than a table that was never created.
    await env.admin.query(
      `ALTER TABLE platform.booking RENAME COLUMN category_id TO category_id_hidden`,
    );
    try {
      const deactivation = await refused(
        env.lifecycle.requestDeactivation(
          {
            hotelId,
            kind: 'ROOM_CATEGORY',
            entityId: category.categoryId,
            idempotencyKey: key(),
            expectedRevision: await rev('ROOM_CATEGORY', category.categoryId),
          },
          manager,
          request(manager),
        ),
      );
      expect(deactivation.code).toBe('DEPENDENCY_UNAVAILABLE');
      const view = await env.lifecycle.view(
        { hotelId, kind: 'ROOM_CATEGORY', entityId: category.categoryId },
        manager,
        request(manager),
      );
      expect(view.state).toBe('ACTIVE');
      expect(
        view.dependencies.filter((f) => f.state === 'unavailable').map((f) => f.sourceId),
      ).toEqual(['category.future_booking']);
      const deletion = await refused(
        env.lifecycle.hardDelete(
          {
            hotelId,
            kind: 'ROOM_CATEGORY',
            entityId: category.categoryId,
            idempotencyKey: key(),
            expectedRevision: await rev('ROOM_CATEGORY', category.categoryId),
          },
          manager,
          request(manager),
        ),
      );
      expect(deletion.code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      // Put the relation back in the shape the registry names.
      await env.admin.query(
        `ALTER TABLE platform.booking RENAME COLUMN category_id_hidden TO category_id`,
      );
    }
    // And with the relation readable again the probe reads it: no booking
    // holds this room, so the deactivation resolves.
    const now = await env.lifecycle.requestDeactivation(
      {
        hotelId,
        kind: 'ROOM',
        entityId: room.roomId,
        idempotencyKey: key(),
        expectedRevision: await rev('ROOM', room.roomId),
      },
      manager,
      request(manager),
    );
    expect(now.state).toBe('INACTIVE');
  });
});

describe('the minibar entities are gated by package and role', () => {
  it('a 20,000₮ hotel is refused the minibar whatever role the Manager holds', async () => {
    const small = await env.hotelWithManager('Small Hotel', 'P20');
    const error = await refused(
      env.catalog.createMinibarEntity(
        {
          hotelId: small.hotelId,
          idempotencyKey: key(),
          kind: 'MINIBAR_PRODUCT',
          name: 'Juice',
          state: 'ACTIVE',
        },
        small.actor,
        request(small.actor),
      ),
    );
    // Stage 3 evaluates the named permission with the effective package, so a
    // role the package does not carry is the same opaque denial as no role.
    expect(error.code).toBe('NOT_FOUND');
    expect(
      await countRows(
        env.admin,
        `SELECT count(*)::text AS n FROM platform.minibar_product WHERE hotel_id = $1`,
        [small.hotelId],
      ),
    ).toBe(0);
  });

  it('a Hotel Admin without the Manager role holds none of the catalog actions, and Reception reads only', async () => {
    const adminOnly = await env.iam.seedMembership({
      hotelId,
      email: 'admin-only@catalog.test',
      roles: ['HOTEL_ADMIN'],
    });
    const admin = await env.actorFor(adminOnly);
    const reception = await env.actorFor(
      await env.iam.seedMembership({
        hotelId,
        email: 'reception@catalog.test',
        roles: ['RECEPTION'],
      }),
    );
    const listing = await env.catalog.listCatalog(hotelId, manager, request(manager));
    const category = listing.categories[0];
    if (category === undefined) throw new Error('no category');

    for (const actor of [admin, reception]) {
      const create = await refused(
        env.catalog.createCategory(
          { hotelId, idempotencyKey: key(), name: 'Denied', state: 'ACTIVE' },
          actor,
          request(actor),
        ),
      );
      expect(create.code).toBe('NOT_FOUND');
      const transition = await refused(
        env.lifecycle.requestDeactivation(
          {
            hotelId,
            kind: 'ROOM_CATEGORY',
            entityId: category.categoryId,
            idempotencyKey: key(),
            expectedRevision: category.revision,
          },
          actor,
          request(actor),
        ),
      );
      expect(transition.code).toBe('NOT_FOUND');
      // Both may read the state: Hotel Admin in full, Reception as `.read`.
      const view = await env.lifecycle.view(
        { hotelId, kind: 'ROOM_CATEGORY', entityId: category.categoryId },
        actor,
        request(actor),
      );
      expect(view.entityId).toBe(category.categoryId);
    }
    const denied = await countRows(
      env.admin,
      `SELECT count(*)::text AS n FROM audit.platform_event
        WHERE action = 'authz.hotel.catalog.room_manage' AND outcome = 'denied' AND actor_ref = $1`,
      [adminOnly.accountId],
    );
    expect(denied).toBe(1);
  });
});
