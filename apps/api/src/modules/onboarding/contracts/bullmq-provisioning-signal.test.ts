import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BullMqProvisioningSignal,
  PROVISIONING_QUEUE,
  signalJobId,
} from './bullmq-provisioning-signal';

/**
 * R3 — the signal really lands on the queue the worker consumes.
 *
 * Against the compose Redis, not a stub: the defect this guards was an
 * enqueue BullMQ refused (a custom id with a `:`), which the port reported as
 * a best-effort `false` and nothing else noticed until the sweep.
 */

const REDIS_URL = new URL(process.env['REDIS_URL_TEST'] ?? 'redis://127.0.0.1:56379');
const connection = { host: REDIS_URL.hostname, port: Number(REDIS_URL.port || '6379') };
const prefix = `sigtest-${randomUUID().slice(0, 8)}`;
const inspector = new Queue(PROVISIONING_QUEUE, { connection, prefix });

afterAll(async () => {
  await inspector.obliterate({ force: true }).catch(() => undefined);
  await inspector.close();
});

describe('BullMqProvisioningSignal', () => {
  it('enqueues one job per application, keyed by an id BullMQ accepts', async () => {
    const port = new BullMqProvisioningSignal({ connection, prefix });
    const applicationId = randomUUID();
    try {
      expect(await port.signal(applicationId)).toBe(true);
      // A duplicated callback signals again; the queue still holds one job.
      expect(await port.signal(applicationId)).toBe(true);
      const job = await inspector.getJob(signalJobId(applicationId));
      expect(job?.data).toEqual({ kind: 'signal', applicationId });
      expect(await inspector.getWaitingCount()).toBe(1);
    } finally {
      await port.close();
    }
  });

  it('reports false, within its timeout, when Redis is not there', async () => {
    const port = new BullMqProvisioningSignal({
      connection: { host: '127.0.0.1', port: 1 },
      prefix,
      timeoutMs: 500,
    });
    const started = Date.now();
    try {
      expect(await port.signal(randomUUID())).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await port.close();
    }
  });
});
