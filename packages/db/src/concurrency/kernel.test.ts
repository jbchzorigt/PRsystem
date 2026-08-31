import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import type { TenantContext } from '../tenant-context';
import { readSessionScope, withTenantTransaction } from '../unit-of-work';
import { claimIdempotencyKey, completeIdempotencyKey } from '../kernel/idempotency';
import { appendOutboxEvent, claimOutboxBatch, markOutboxPublished } from '../kernel/outbox';
import { claimConsumption, registerProviderEvent } from '../kernel/inbox';
import { recordPlatformAudit } from '../kernel/audit';
import { MIGRATION_LOCK_KEY, runMigrations } from '../migrate';
import { schemaFingerprint } from '../test-support/schema-fingerprint';
import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';
import {
  TEST_LOGIN_PASSWORD,
  TEST_LOGIN_PRINCIPALS,
  createTestDatabase,
  quietPool,
} from '@prsystem/testing';

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

/**
 * Releases only once `parties` callers have arrived.
 *
 * Without this, `Promise.all` of two transactions proves nothing: the first can
 * finish its critical section before the second has started one.
 */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) release();
    return gate;
  };
}

/**
 * A dedicated single-connection pool for one racer.
 *
 * A shared pool cannot prove a race: two checkouts may be served by the same
 * backend, and a `max` large enough to avoid that is still an assumption rather
 * than evidence. Every race below asserts distinct `pg_backend_pid()` values.
 */
function racerPool(): Pool {
  return quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
}

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
    const single = quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
    try {
      await withTenantTransaction(single, ctx(), async (uow) => {
        const seen = await uow.query<{ hotel_id: string }>(
          `SELECT current_setting('app.hotel_id', true) AS hotel_id`,
        );
        expect(seen.rows[0]?.hotel_id).toBe(HOTEL);
      });

      // The account scope is read back too: Phase 04 added a fourth setting, and
      // a leak check that inspected three of four would pass while the new one
      // survived on the connection.
      expect(await readSessionScope(single)).toEqual({
        hotelId: null,
        realm: null,
        accountId: null,
      });
    } finally {
      await single.end();
    }
  });

  it('does not let one transaction inherit another transaction s scope', async () => {
    const single = quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
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
    const pools = [racerPool(), racerPool()];

    try {
      const barrier = createBarrier(2);
      const race = async (pool: Pool) =>
        withTenantTransaction(pool, ctx(), async (uow) => {
          const backend = await uow.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          // Both participants are inside an open transaction with tenant context
          // applied before either reaches the unique index that arbitrates.
          await barrier();
          const outcome = await claimIdempotencyKey(uow, {
            operation: 'kernel.probe.create',
            key,
            clientRef: 'client-synthetic',
            payload: { amountMnt: '1000' },
          });
          if (outcome.kind === 'claimed') {
            await appendOutboxEvent(uow, {
              aggregateType: 'kernel_probe',
              aggregateId: key,
              eventType: 'kernel.probe.created',
              payload: { key },
            });
            await completeIdempotencyKey(uow, outcome.idempotencyId, 201, { key });
          }
          return { pid: backend.rows[0]!.pid, outcome };
        });

      // Promise.all, not allSettled: a transaction that failed is not an
      // acceptable loser. Both must complete and report a coherent outcome.
      const [a, b] = await Promise.all([race(pools[0]!), race(pools[1]!)]);

      expect(a.pid).not.toBe(b.pid);
      expect([a.outcome.kind, b.outcome.kind].sort()).toEqual(['claimed', 'replay']);
      // The loser is served the winner's committed response, not a bare refusal.
      const loser = (a.outcome.kind === 'claimed' ? b : a).outcome;
      expect(loser).toEqual({ kind: 'replay', status: 201, body: { key } });

      const effects = await withTenantTransaction(apiPool, ctx(), (uow) =>
        uow.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM platform.outbox_event WHERE aggregate_id = $1`,
          [key],
        ),
      );
      expect(effects.rows[0]?.count).toBe('1');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
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
    const pools = [racerPool(), racerPool()];

    try {
      const barrier = createBarrier(2);
      const race = async (pool: Pool) =>
        withTenantTransaction(pool, ctx(), async (uow) => {
          const backend = await uow.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          await barrier();
          const claimed = await claimConsumption(uow, 'kernel.probe.projector', dedupKey, 'outbox');
          return { pid: backend.rows[0]!.pid, claimed };
        });

      const [a, b] = await Promise.all([race(pools[0]!), race(pools[1]!)]);

      expect(a.pid).not.toBe(b.pid);
      // Exactly one consumer wins; the other is told it lost rather than failing.
      expect([a.claimed, b.claimed].sort()).toEqual([false, true]);

      const rows = await withTenantTransaction(apiPool, ctx(), (uow) =>
        uow.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM platform.inbox_consumption WHERE dedup_key = $1`,
          [dedupKey],
        ),
      );
      expect(rows.rows[0]?.count).toBe('1');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
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

  it('never lets two workers claim the same row, and both claim something', async () => {
    await seed(20, 'race');

    // Two dedicated pools so the two claims cannot share a backend, and a
    // barrier so both are genuinely inside the critical section at once.
    const poolA = quietPool({ connectionString: env.db.loginUrl('prsystem_worker_login'), max: 1 });
    const poolB = quietPool({ connectionString: env.db.loginUrl('prsystem_worker_login'), max: 1 });
    try {
      const barrier = createBarrier(2);
      const claim = async (pool: Pool, worker: string): Promise<{ pid: number; ids: string[] }> =>
        withTenantTransaction(pool, ctx(), async (uow) => {
          const backend = await uow.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          // Inside the transaction, before claiming: neither side may run ahead.
          await barrier();
          const events = await claimOutboxBatch(uow, worker, 10);
          return { pid: backend.rows[0]!.pid, ids: events.map((e) => e.eventId) };
        });

      const [first, second] = await Promise.all([
        claim(poolA, 'worker-1'),
        claim(poolB, 'worker-2'),
      ]);

      // Distinct backends, or the "race" was one session doing two things.
      expect(first.pid).not.toBe(second.pid);
      expect(first.ids.length).toBeGreaterThan(0);
      expect(second.ids.length).toBeGreaterThan(0);
      expect(first.ids.filter((id) => second.ids.includes(id))).toEqual([]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }, 60000);

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

    await withTenantTransaction(workerPool, ctx(), (uow) => markOutboxPublished(uow, event!));

    const after = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-2', 50),
    );
    expect(after.some((candidate) => candidate.eventId === event?.eventId)).toBe(false);
  });
});

describe('additional concurrency evidence (Phase 03 review)', () => {
  it('separates two different keys sharing one provider reference, concurrently', async () => {
    // Two distinct idempotency keys may legitimately carry the same business
    // reference. The provider-event unique constraint, not the idempotency key,
    // is what stops the second one producing a second effect.
    const reference = 'REF-SHARED-0001';
    const poolA = quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
    const poolB = quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });

    try {
      const barrier = createBarrier(2);
      const attempt = async (pool: Pool, key: string) =>
        withTenantTransaction(pool, ctx(), async (uow) => {
          const backend = await uow.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const claim = await claimIdempotencyKey(uow, {
            operation: 'kernel.callback.apply',
            key,
            clientRef: 'client-synthetic',
            payload: { reference },
          });
          expect(claim.kind).toBe('claimed');
          // Both sides hold their idempotency claim before either registers the
          // provider event, so the unique constraint is what decides.
          await barrier();
          const outcome = await registerProviderEvent(uow, {
            provider: 'qpay',
            providerEventId: reference,
            eventKind: 'payment.succeeded',
            rawPayload: `{"reference":"${reference}"}`,
            metadata: { reference },
          });
          return { pid: backend.rows[0]!.pid, outcome };
        });

      // Promise.all, not allSettled: both transactions must fulfil. A rejected
      // transaction would be an unrelated failure, not a valid loser, and
      // accepting one would let a broken constraint pass as a passing race.
      const [a, b] = await Promise.all([
        attempt(poolA, 'idem-shared-ref-00001'),
        attempt(poolB, 'idem-shared-ref-00002'),
      ]);

      expect(a.pid).not.toBe(b.pid);
      // Distinct idempotency keys both claim; the provider-event unique index
      // decides, giving exactly one first delivery and one recognised duplicate.
      expect([a.outcome.kind, b.outcome.kind].sort()).toEqual(['duplicate', 'first_delivery']);
      const duplicate = (a.outcome.kind === 'duplicate' ? a : b).outcome;
      // The duplicate is recognised as the same payload, not a reconciliation case.
      expect(duplicate).toEqual({ kind: 'duplicate', payloadMatches: true });

      const stored = await withTenantTransaction(apiPool, ctx(), (uow) =>
        uow.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM platform.provider_event WHERE provider_event_id = $1`,
          [reference],
        ),
      );
      expect(stored.rows[0]?.count).toBe('1');
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  it('leaves no audit or outbox orphan when the losing transaction rolls back', async () => {
    // One transaction deliberately writes audit and outbox rows and then throws;
    // the other does the same work and commits. Racing two *identical* attempts
    // and catching whatever happens would prove nothing, because the loser's
    // rollback would be indistinguishable from it never having written anything.
    const committedKey = 'idem-rollback-commit1';
    const rolledBackKey = 'idem-rollback-abort01';
    const pools = [racerPool(), racerPool()];
    const barrier = createBarrier(2);
    // Collected inside the transaction, so the aborting side's backend is
    // recorded even though its promise rejects.
    const pids: number[] = [];

    /** Claim, write an audit row and an outbox row, then either commit or throw. */
    const attempt = async (pool: Pool, key: string, abort: boolean) =>
      withTenantTransaction(pool, ctx(), async (uow) => {
        const backend = await uow.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        pids.push(backend.rows[0]!.pid);
        const claim = await claimIdempotencyKey(uow, {
          operation: 'kernel.probe.create',
          key,
          clientRef: 'client-synthetic',
          payload: { amountMnt: '5000' },
        });
        if (claim.kind !== 'claimed') throw new Error(`expected a claim, got ${claim.kind}`);
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
        // Both sides have written every effect and are inside the critical
        // section together before either resolves.
        await barrier();
        if (abort) throw new Error('deliberate-rollback');
        await completeIdempotencyKey(uow, claim.idempotencyId, 201, { key });
        return backend.rows[0]!.pid;
      });

    try {
      const [committed, aborted] = await Promise.allSettled([
        attempt(pools[0]!, committedKey, false),
        attempt(pools[1]!, rolledBackKey, true),
      ]);

      // The aborting transaction is reported rolled back, by its own error.
      expect(aborted.status).toBe('rejected');
      expect((aborted as PromiseRejectedResult).reason).toMatchObject({
        message: 'deliberate-rollback',
      });
      // The other one commits.
      expect(committed.status).toBe('fulfilled');
      // Two real backends, not one connection reused.
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);

      const counts = await withTenantTransaction(apiPool, ctx(), async (uow) => {
        const outbox = await uow.query<{ aggregate_id: string }>(
          `SELECT aggregate_id FROM platform.outbox_event WHERE aggregate_id = ANY($1)`,
          [[committedKey, rolledBackKey]],
        );
        const idem = await uow.query<{ idempotency_key: string; state: string }>(
          `SELECT idempotency_key, state FROM platform.idempotency_key
            WHERE idempotency_key = ANY($1)`,
          [[committedKey, rolledBackKey]],
        );
        return { outbox: outbox.rows, idem: idem.rows };
      });
      const audits = await auditReader.query<{ target_ref: string }>(
        `SELECT target_ref FROM audit.platform_event
          WHERE action = 'kernel.rollback.probe' AND target_ref = ANY($1)`,
        [[committedKey, rolledBackKey]],
      );

      // Nothing the rolled-back transaction wrote survives — not the outbox row,
      // not the audit row, not the idempotency claim.
      expect(counts.outbox.map((r) => r.aggregate_id)).toEqual([committedKey]);
      expect(audits.rows.map((r) => r.target_ref)).toEqual([committedKey]);
      expect(counts.idem.map((r) => r.idempotency_key)).toEqual([committedKey]);

      // The successful transaction committed exactly one coherent effect.
      expect(counts.idem[0]?.state).toBe('succeeded');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
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

  it('presents the same outbound idempotency key on every redelivery', async () => {
    // Seeded here rather than relying on whatever earlier tests left behind, and
    // actually redelivered: the property is that the key survives a redelivery,
    // not merely that claimed rows have distinct uuids.
    await withTenantTransaction(workerPool, ctx(), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: 'stable-key',
        eventType: 'kernel.probe.created',
        payload: { stage: 'stable' },
      }),
    );

    const first = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-stable-1', 50, 1),
    );
    const target = first.find((e) => e.aggregateId === 'stable-key');
    expect(target).toBeDefined();

    await withTenantTransaction(workerPool, ctx(), (uow) =>
      uow.query(
        `UPDATE platform.outbox_delivery SET claimed_until = now() - interval '1 minute'
          WHERE event_id = $1`,
        [target?.eventId],
      ),
    );

    const second = await withTenantTransaction(workerPool, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-stable-2', 50),
    );
    const again = second.find((e) => e.eventId === target?.eventId);

    expect(again).toBeDefined();
    expect(again?.eventUuid).toBe(target?.eventUuid);
    // The claim fence moved on even though the outbound key did not.
    expect(again?.claimRevision).toBeGreaterThan(target!.claimRevision);
  });

  it('makes one runner wait on the migration advisory lock while the other applies', async () => {
    // Wall-clock overlap between two processes shows they ran at the same time.
    // It does not show that PostgreSQL made either of them *wait*, which is the
    // property the advisory lock exists to provide. This observes the lock
    // itself: a third session takes it, both runners queue behind that exact
    // lock, and pg_blocking_pids names the holder. Remove the lock from
    // runMigrations and the wait never appears, so this test fails.
    const fresh = await createTestDatabase('kernel_conc_empty');
    try {
      await bootstrapCluster({
        adminUrl: fresh.url,
        database: fresh.name,
        logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
          principal,
          password: TEST_LOGIN_PASSWORD,
        })),
      });
      const url = fresh.loginUrl(TEST_LOGIN_PRINCIPALS.migrate);

      // The holder. An ordinary session on the same database, holding the same
      // advisory key a migration runner takes.
      const holder = new Client({ connectionString: fresh.url });
      await holder.connect();
      let released = false;
      try {
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

        // Both runners start and immediately block. Each opens its own Client,
        // so each is a distinct backend.
        const runners = [runMigrations(url), runMigrations(url)];

        // Wait until PostgreSQL reports both of them queued on this exact lock.
        const observer = new Client({ connectionString: fresh.url });
        await observer.connect();
        let waiters: { pid: number; blockers: number[] }[] = [];
        try {
          const deadline = Date.now() + 30_000;
          for (;;) {
            const found = await observer.query<{ pid: number; blockers: number[] }>(
              `SELECT l.pid, pg_blocking_pids(l.pid) AS blockers
                 FROM pg_locks l
                WHERE l.locktype = 'advisory'
                  AND l.objid = $1
                  AND NOT l.granted
                ORDER BY l.pid`,
              [MIGRATION_LOCK_KEY],
            );
            waiters = found.rows;
            if (waiters.length === 2) break;
            if (Date.now() > deadline) {
              throw new Error(
                `expected two runners waiting on the migration lock, saw ${String(waiters.length)}`,
              );
            }
            await new Promise((r) => setTimeout(r, 25));
          }

          // Two distinct backends, neither of which is the holder.
          expect(new Set(waiters.map((w) => w.pid)).size).toBe(2);
          expect(waiters.map((w) => w.pid)).not.toContain(holderPid);

          // And PostgreSQL itself names the holder as what blocks each of them.
          for (const waiter of waiters) {
            expect(waiter.blockers).toContain(holderPid);
          }

          // Only now is the lock released. Until this line nothing could have
          // applied a migration, because the lock was held throughout.
          await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
          released = true;
        } finally {
          await observer.end();
        }

        const outcomes = await Promise.all(runners);

        // Exactly one application and one safe no-op.
        const applied = outcomes.map((o) => o.appliedAfter - o.appliedBefore);
        expect(applied.filter((n) => n > 0)).toHaveLength(1);
        expect(applied.filter((n) => n === 0)).toHaveLength(1);
        expect(outcomes[0]!.appliedAfter).toBe(outcomes[1]!.appliedAfter);
        expect(outcomes[0]!.appliedAfter).toBeGreaterThan(0);
      } finally {
        if (!released) {
          await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
            /* the session is ending; the lock dies with it */
          });
        }
        await holder.end();
      }

      // The raced database is the one a single run produces.
      const solo = await createTestDatabase('kernel_conc_solo');
      try {
        await bootstrapCluster({
          adminUrl: solo.url,
          database: solo.name,
          logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
            principal,
            password: TEST_LOGIN_PASSWORD,
          })),
        });
        await runMigrations(solo.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));

        const raced = quietPool({ connectionString: fresh.url, max: 1 });
        const single = quietPool({ connectionString: solo.url, max: 1 });
        try {
          expect(await schemaFingerprint(raced)).toBe(await schemaFingerprint(single));
        } finally {
          await raced.end();
          await single.end();
        }
      } finally {
        await solo.drop();
      }
    } finally {
      await fresh.drop();
    }
  }, 240000);
});
