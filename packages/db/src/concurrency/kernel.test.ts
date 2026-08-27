import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { TestDatabase } from '@prsystem/testing';
import { createRolePool, createTestDatabase } from '@prsystem/testing';
import { runMigrations } from '../migrate';
import { DATABASE_ROLES } from '../roles';
import type { TenantContext } from '../tenant-context';
import { readSessionScope, withTenantTransaction } from '../unit-of-work';
import { claimIdempotencyKey, completeIdempotencyKey } from '../kernel/idempotency';
import { appendOutboxEvent, claimOutboxBatch, markOutboxPublished } from '../kernel/outbox';
import { claimConsumption } from '../kernel/inbox';

/**
 * GATE-CONC — real connections racing against each other, not a simulated
 * interleaving (11-concurrency-strategy, ADR-0011).
 *
 * Each race asserts the *effect* count, not the return values: "one effect under
 * concurrency" is the invariant, and a mechanism that returns tidy values while
 * producing two rows has failed.
 */

const HOTEL = '33333333-3333-4333-8333-333333333333';

let db: TestDatabase;
let apiPool: Pool;
let workerPool: Pool;

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    hotelId: HOTEL,
    realm: 'hotel',
    actorRef: 'actor-synthetic-conc',
    correlationId: 'corr-conc-1',
    ...overrides,
  };
}

beforeAll(async () => {
  db = await createTestDatabase('kernel_conc');
  await runMigrations(db.url);
  apiPool = createRolePool(db.url, DATABASE_ROLES.api);
  workerPool = createRolePool(db.url, DATABASE_ROLES.worker);
}, 60000);

afterAll(async () => {
  await apiPool.end();
  await workerPool.end();
  await db.drop();
}, 30000);

describe('connection pool tenant context (ADR-0017 §2)', () => {
  it('leaves no tenant context on a connection returned to the pool', async () => {
    // max: 1 guarantees the second borrow is the same physical connection, which
    // is the only way this test can prove anything.
    const single = createRolePool(db.url, DATABASE_ROLES.api, 1);
    try {
      await withTenantTransaction(single, ctx(), async (uow) => {
        const seen = await uow.query<{ hotel_id: string }>(
          `SELECT current_setting('app.hotel_id', true) AS hotel_id`,
        );
        expect(seen.rows[0]?.hotel_id).toBe(HOTEL);
      });

      expect(await readSessionScope(single)).toEqual({ hotelId: null, realm: null });
    } finally {
      await single.end();
    }
  });

  it('does not let one transaction inherit another transaction s scope', async () => {
    const single = createRolePool(db.url, DATABASE_ROLES.api, 1);
    try {
      await withTenantTransaction(single, ctx(), async () => undefined);

      const other = '44444444-4444-4444-8444-444444444444';
      const seen = await withTenantTransaction(single, ctx({ hotelId: other }), async (uow) => {
        const row = await uow.query<{ hotel_id: string }>(
          `SELECT current_setting('app.hotel_id', true) AS hotel_id`,
        );
        return row.rows[0]?.hotel_id;
      });
      expect(seen).toBe(other);
    } finally {
      await single.end();
    }
  });
});

describe('idempotency under concurrency (CLAUDE.md §6)', () => {
  /** Claim, and only on a successful claim perform the effect. */
  async function attempt(key: string, payload: unknown): Promise<string> {
    return withTenantTransaction(apiPool, ctx(), async (uow) => {
      const outcome = await claimIdempotencyKey(uow, {
        operation: 'kernel.probe.create',
        key,
        clientRef: 'client-synthetic',
        payload,
      });

      if (outcome.kind !== 'claimed') return outcome.kind;

      await appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: key,
        eventType: 'kernel.probe.created',
        payload: { key },
      });
      await completeIdempotencyKey(uow, outcome.idempotencyId, 201, { key });
      return outcome.kind;
    });
  }

  it('produces exactly one effect for concurrent identical requests', async () => {
    const key = 'idem-concurrent-000001';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => attempt(key, { amountMnt: '1000' })),
    );

    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);

    const effects = await withTenantTransaction(apiPool, ctx(), (uow) =>
      uow.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.outbox_event WHERE aggregate_id = $1`,
        [key],
      ),
    );
    expect(effects.rows[0]?.count).toBe('1');
  });

  it('replays the stored response instead of repeating the effect', async () => {
    const key = 'idem-replay-0000002';
    await attempt(key, { amountMnt: '2000' });

    const replay = await withTenantTransaction(apiPool, ctx(), (uow) =>
      claimIdempotencyKey(uow, {
        operation: 'kernel.probe.create',
        key,
        clientRef: 'client-synthetic',
        payload: { amountMnt: '2000' },
      }),
    );

    expect(replay).toEqual({ kind: 'replay', status: 201, body: { key } });
  });

  it('is insensitive to key order in the request body', async () => {
    const key = 'idem-canonical-00003';
    await attempt(key, { amountMnt: '3000', reference: 'REF' });

    const replay = await withTenantTransaction(apiPool, ctx(), (uow) =>
      claimIdempotencyKey(uow, {
        operation: 'kernel.probe.create',
        key,
        clientRef: 'client-synthetic',
        payload: { reference: 'REF', amountMnt: '3000' },
      }),
    );
    expect(replay.kind).toBe('replay');
  });

  it('rejects the same key carrying a different payload', async () => {
    const key = 'idem-mismatch-00004';
    await attempt(key, { amountMnt: '4000' });

    const reused = await withTenantTransaction(apiPool, ctx(), (uow) =>
      claimIdempotencyKey(uow, {
        operation: 'kernel.probe.create',
        key,
        clientRef: 'client-synthetic',
        payload: { amountMnt: '9999' },
      }),
    );

    expect(reused).toEqual({ kind: 'key_reused_with_different_payload' });

    const effects = await withTenantTransaction(apiPool, ctx(), (uow) =>
      uow.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.outbox_event WHERE aggregate_id = $1`,
        [key],
      ),
    );
    expect(effects.rows[0]?.count).toBe('1');
  });
});

describe('inbox deduplication under concurrency (ADR-0019 §2)', () => {
  it('consumes a redelivered event once when consumers race', async () => {
    const dedupKey = 'evt-redelivered-0001';
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenantTransaction(apiPool, ctx(), (uow) =>
          claimConsumption(uow, 'kernel.probe.projector', dedupKey, 'outbox'),
        ),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe('outbox relay under concurrency (ADR-0010, ADR-0011)', () => {
  async function seed(count: number, prefix: string): Promise<void> {
    await withTenantTransaction(workerPool, ctx(), async (uow) => {
      for (let index = 0; index < count; index += 1) {
        await appendOutboxEvent(uow, {
          aggregateType: 'kernel_probe',
          aggregateId: `${prefix}-${String(index)}`,
          eventType: 'kernel.probe.created',
          payload: { index },
        });
      }
    });
  }

  it('never lets two workers claim the same row', async () => {
    await seed(20, 'race');

    const [first, second] = await Promise.all([
      withTenantTransaction(workerPool, ctx(), (uow) => claimOutboxBatch(uow, 'worker-1', 20)),
      withTenantTransaction(workerPool, ctx(), (uow) => claimOutboxBatch(uow, 'worker-2', 20)),
    ]);

    const firstIds = new Set(first.map((event) => event.eventId));
    const overlap = second.filter((event) => firstIds.has(event.eventId));

    expect(overlap).toEqual([]);
    expect(first.length + second.length).toBeGreaterThan(0);
  });

  it('returns an event to the queue when a worker dies mid-delivery', async () => {
    await seed(1, 'crash');

    const claimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-doomed', 1, 1),
    );
    expect(claimed).toHaveLength(1);
    const event = claimed[0];
    expect(event).toBeDefined();

    // The worker never marks it published. Expire its lease the way time would.
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      uow.query(
        `UPDATE platform.outbox_delivery
            SET claimed_until = now() - interval '1 minute'
          WHERE event_id = $1`,
        [event?.eventId],
      ),
    );

    const reclaimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-healthy', 10),
    );
    const again = reclaimed.find((candidate) => candidate.eventId === event?.eventId);

    expect(again).toBeDefined();
    // The event itself is untouched: only its delivery state moved.
    expect(again?.payload).toEqual(event?.payload);
    expect(again?.attempts).toBe((event?.attempts ?? 0) + 1);
  });

  it('marks a published row so it is not claimed again', async () => {
    await seed(1, 'published');

    const claimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-1', 1),
    );
    const event = claimed[0];
    expect(event).toBeDefined();

    await withTenantTransaction(workerPool, ctx(), (uow) =>
      markOutboxPublished(uow, String(event?.eventId)),
    );

    const after = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-2', 50),
    );
    expect(after.some((candidate) => candidate.eventId === event?.eventId)).toBe(false);
  });
});
