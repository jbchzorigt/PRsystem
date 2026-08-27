import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import type { TenantContext } from '../tenant-context';
import { readSessionScope, withTenantTransaction } from '../unit-of-work';
import { claimIdempotencyKey, completeIdempotencyKey } from '../kernel/idempotency';
import { appendOutboxEvent, claimOutboxBatch, markOutboxPublished } from '../kernel/outbox';
import { claimConsumption, registerProviderEvent } from '../kernel/inbox';
import { recordPlatformAudit } from '../kernel/audit';
import { runMigrations } from '../migrate';

/**
 * GATE-CONC — real connections racing against each other, not a simulated
 * interleaving (11-concurrency-strategy, ADR-0011).
 *
 * Each race asserts the *effect* count, not the return values: "one effect under
 * concurrency" is the invariant, and a mechanism that returns tidy values while
 * producing two rows has failed.
 */

const HOTEL = '33333333-3333-4333-8333-333333333333';

let env: ProvisionedDatabase;
let apiPool: Pool;
let workerPool: Pool;
let auditReader: Pool;

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
  env = await provisionKernelDatabase('kernel_conc');
  apiPool = env.api;
  workerPool = env.worker;
  auditReader = env.auditReader;
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('connection pool tenant context (ADR-0017 §2)', () => {
  it('leaves no tenant context on a connection returned to the pool', async () => {
    // max: 1 guarantees the second borrow is the same physical connection, which
    // is the only way this test can prove anything.
    const single = new Pool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
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
    const single = new Pool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
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

describe('additional concurrency evidence (Phase 03 review)', () => {
  it('separates two different keys sharing one provider reference', async () => {
    // Two distinct idempotency keys may legitimately carry the same business
    // reference. The provider-event unique constraint, not the idempotency key,
    // is what stops the second one producing a second effect.
    const reference = 'REF-SHARED-0001';

    const first = await withTenantTransaction(apiPool, ctx(), async (uow) => {
      const claim = await claimIdempotencyKey(uow, {
        operation: 'kernel.callback.apply',
        key: 'idem-shared-ref-00001',
        clientRef: 'client-synthetic',
        payload: { reference },
      });
      expect(claim.kind).toBe('claimed');
      return registerProviderEvent(uow, {
        provider: 'qpay',
        providerEventId: reference,
        eventKind: 'payment.succeeded',
        rawPayload: `{"reference":"${reference}"}`,
        metadata: { reference },
      });
    });
    expect(first.kind).toBe('first_delivery');

    const second = await withTenantTransaction(apiPool, ctx(), async (uow) => {
      const claim = await claimIdempotencyKey(uow, {
        operation: 'kernel.callback.apply',
        key: 'idem-shared-ref-00002',
        clientRef: 'client-synthetic',
        payload: { reference },
      });
      expect(claim.kind).toBe('claimed');
      return registerProviderEvent(uow, {
        provider: 'qpay',
        providerEventId: reference,
        eventKind: 'payment.succeeded',
        rawPayload: `{"reference":"${reference}"}`,
        metadata: { reference },
      });
    });
    expect(second).toEqual({ kind: 'duplicate', payloadMatches: true });
  });

  it('leaves no audit or outbox orphan when the losing transaction rolls back', async () => {
    const key = 'idem-rollback-00001';

    // Two racing attempts; the loser must leave nothing behind at all.
    const attempts = await Promise.all(
      [0, 1].map(async () =>
        withTenantTransaction(apiPool, ctx(), async (uow) => {
          const claim = await claimIdempotencyKey(uow, {
            operation: 'kernel.probe.create',
            key,
            clientRef: 'client-synthetic',
            payload: { amountMnt: '5000' },
          });
          if (claim.kind !== 'claimed') return claim.kind;

          await recordPlatformAudit(uow, {
            action: 'kernel.rollback.probe',
            outcome: 'allowed',
            targetRef: key,
          });
          await appendOutboxEvent(uow, {
            aggregateType: 'kernel_probe',
            aggregateId: key,
            eventType: 'kernel.probe.created',
            payload: { key },
          });
          await completeIdempotencyKey(uow, claim.idempotencyId, 201, { key });
          return claim.kind;
        }).catch(() => 'rolled_back'),
      ),
    );

    expect(attempts.filter((r) => r === 'claimed')).toHaveLength(1);

    const events = await withTenantTransaction(apiPool, ctx(), (uow) =>
      uow.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.outbox_event WHERE aggregate_id = $1`,
        [key],
      ),
    );
    expect(events.rows[0]?.count).toBe('1');

    const audits = await auditReader.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit.platform_event
        WHERE action = 'kernel.rollback.probe' AND target_ref = $1`,
      [key],
    );
    expect(audits.rows[0]?.count).toBe('1');
  });

  it('keeps the event when a worker crashes before sending', async () => {
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: 'crash-before-send',
        eventType: 'kernel.probe.created',
        payload: { stage: 'before-send' },
      }),
    );

    const claimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-crash-before', 1, 1),
    );
    expect(claimed).toHaveLength(1);

    // The worker dies here: no publish, no mark. The lease expires.
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      uow.query(
        `UPDATE platform.outbox_delivery SET claimed_until = now() - interval '1 minute'
          WHERE event_id = $1`,
        [claimed[0]?.eventId],
      ),
    );

    const again = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-healthy', 20),
    );
    expect(again.some((e) => e.aggregateId === 'crash-before-send')).toBe(true);
  });

  it('redelivers when a worker crashes after sending but before acknowledging', async () => {
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: 'crash-after-send',
        eventType: 'kernel.probe.created',
        payload: { stage: 'after-send' },
      }),
    );

    const claimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-crash-after', 50, 1),
    );
    const target = claimed.find((e) => e.aggregateId === 'crash-after-send');
    expect(target).toBeDefined();

    // The send succeeded; the acknowledgement never landed. At-least-once means
    // the event comes back, and the consumer's inbox key is what makes the
    // second delivery produce no second effect.
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      uow.query(
        `UPDATE platform.outbox_delivery SET claimed_until = now() - interval '1 minute'
          WHERE event_id = $1`,
        [target?.eventId],
      ),
    );

    const redelivered = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-healthy', 50),
    );
    const again = redelivered.find((e) => e.eventId === target?.eventId);
    expect(again).toBeDefined();

    let effects = 0;
    for (const delivery of [target, again]) {
      await withTenantTransaction(workerPool, ctx(), async (uow) => {
        const first = await claimConsumption(
          uow,
          'kernel.probe.projector',
          `outbound-${String(delivery?.eventUuid)}`,
          'outbox',
        );
        if (first) effects += 1;
      });
    }
    expect(effects).toBe(1);
  });

  it('derives a stable outbound idempotency key from the event identity', async () => {
    // The relay must present the same key on every redelivery, or the downstream
    // provider would treat a retry as a new request.
    const claimed = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-stable', 50, 60),
    );
    const withUuid = claimed.filter((e) => e.eventUuid.length > 0);
    expect(withUuid.length).toBe(claimed.length);
    expect(new Set(claimed.map((e) => e.eventUuid)).size).toBe(claimed.length);
  });

  it('serialises two migration runners after one role bootstrap', async () => {
    // Bootstrap has already run once for this database. Two concurrent journal
    // runs must both succeed, applying nothing, without contending on a
    // cluster-wide catalogue tuple.
    const [first, second] = await Promise.all([
      runMigrations(env.migrateUrl),
      runMigrations(env.migrateUrl),
    ]);

    expect(first.appliedBefore).toBe(first.appliedAfter);
    expect(second.appliedBefore).toBe(second.appliedAfter);
  }, 60000);
});
