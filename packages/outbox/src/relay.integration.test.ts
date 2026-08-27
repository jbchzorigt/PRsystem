import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { ClaimedOutboxEvent, LoginPrincipal, TenantContext } from '@prsystem/db';
import {
  LOGIN_PRINCIPALS,
  appendOutboxEvent,
  bootstrapCluster,
  runMigrations,
  withTenantTransaction,
} from '@prsystem/db';
import { relayOnce } from './relay';
import { consumeOnce } from './consumer';

/**
 * GATE-INTEG for the relay — at-least-once delivery turned into exactly-one
 * effect by an idempotent consumer (ADR-0010, ADR-0019 §2).
 */

const HOTEL = '66666666-6666-4666-8666-666666666666';

let db: TestDatabase;
let workerPool: Pool;

const context: TenantContext = {
  hotelId: HOTEL,
  realm: 'hotel',
  actorRef: 'actor-synthetic-relay',
  correlationId: 'corr-relay-1',
};

/** Records what it was asked to publish, and can be told to fail. */
class RecordingPublisher {
  readonly published: string[] = [];
  failFor = new Set<string>();

  publish(event: ClaimedOutboxEvent): Promise<void> {
    if (this.failFor.has(event.aggregateId)) {
      return Promise.reject(new Error('publish failed'));
    }
    this.published.push(event.aggregateId);
    return Promise.resolve();
  }
}

async function seed(aggregateId: string): Promise<void> {
  await withTenantTransaction(workerPool, context, (uow) =>
    appendOutboxEvent(uow, {
      aggregateType: 'kernel_probe',
      aggregateId,
      eventType: 'kernel.probe.created',
      payload: { aggregateId },
    }),
  );
}

beforeAll(async () => {
  db = await createTestDatabase('outbox_relay');
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  // A real worker LOGIN principal, not a superuser with SET ROLE.
  workerPool = new Pool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.worker), max: 6 });
}, 90000);

afterAll(async () => {
  await workerPool.end();
  await db.drop();
}, 30000);

describe('relay', () => {
  it('publishes a committed event and does not publish it twice', async () => {
    await seed('relay-1');
    const publisher = new RecordingPublisher();

    const first = await relayOnce(workerPool, context, publisher, { workerId: 'w1' });
    expect(first).toEqual({ claimed: 1, published: 1, failed: 0, staleClaims: 0 });

    const second = await relayOnce(workerPool, context, publisher, { workerId: 'w1' });
    expect(second.claimed).toBe(0);
    expect(publisher.published).toEqual(['relay-1']);
  });

  it('backs a failed delivery off instead of losing the event', async () => {
    await seed('relay-fail');
    const publisher = new RecordingPublisher();
    publisher.failFor.add('relay-fail');

    const result = await relayOnce(workerPool, context, publisher, { workerId: 'w1' });
    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, staleClaims: 0 });

    const state = await withTenantTransaction(workerPool, context, (uow) =>
      uow.query<{ state: string; attempts: number; last_error: string }>(
        `SELECT d.state, d.attempts, d.last_error
           FROM platform.outbox_delivery d
           JOIN platform.outbox_event e ON e.event_id = d.event_id
          WHERE e.aggregate_id = 'relay-fail'`,
      ),
    );

    expect(state.rows[0]?.state).toBe('pending');
    expect(state.rows[0]?.attempts).toBe(1);
    // Only the error's name is durable — never a message that could carry a payload.
    expect(state.rows[0]?.last_error).toBe('Error');
  });

  it('keeps the event row itself untouched through a failure', async () => {
    const event = await withTenantTransaction(workerPool, context, (uow) =>
      uow.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM platform.outbox_event WHERE aggregate_id = 'relay-fail'`,
      ),
    );
    expect(event.rows[0]?.payload).toEqual({ aggregateId: 'relay-fail' });
  });
});

describe('idempotent consumer', () => {
  it('runs the handler once no matter how many times the event is delivered', async () => {
    let handled = 0;

    for (let delivery = 0; delivery < 3; delivery += 1) {
      await withTenantTransaction(workerPool, context, (uow) =>
        consumeOnce(uow, 'kernel.probe.projector', 'evt-relay-1', 'outbox', () => {
          handled += 1;
          return Promise.resolve();
        }),
      );
    }

    expect(handled).toBe(1);
  });

  it('rolls back the consumption record when the handler fails', async () => {
    await expect(
      withTenantTransaction(workerPool, context, (uow) =>
        consumeOnce(uow, 'kernel.probe.projector', 'evt-relay-2', 'outbox', () =>
          Promise.reject(new Error('projection failed')),
        ),
      ),
    ).rejects.toThrow('projection failed');

    // The record and the handler share a transaction, so a failed projection
    // leaves the event redeliverable rather than silently marked consumed.
    let handled = 0;
    const consumed = await withTenantTransaction(workerPool, context, (uow) =>
      consumeOnce(uow, 'kernel.probe.projector', 'evt-relay-2', 'outbox', () => {
        handled += 1;
        return Promise.resolve();
      }),
    );

    expect(consumed).toBe(true);
    expect(handled).toBe(1);
  });
});
