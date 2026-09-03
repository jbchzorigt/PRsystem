import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { ProvisioningSignalPort } from './provisioning-signal';

/**
 * The provisioning signal over Redis, as a BullMQ job (R3).
 *
 * The queue name and the job shape are shared with the worker deployment
 * (`apps/worker/src/jobs/onboarding.ts`). The job id is the application id, so
 * a callback that is delivered twice enqueues one message — and even two would
 * be harmless, because the worker provisions from the row.
 *
 * Every failure mode of Redis is absorbed here: a connection that cannot be
 * made, a command that hangs, an enqueue that throws. None of them may hold a
 * provider callback open or turn a confirmed payment into an error, so the
 * enqueue is bounded by a short timeout and reports `false` rather than
 * throwing. The sweep is what makes that safe.
 */
export const PROVISIONING_QUEUE = 'onboarding.provisioning';

/**
 * The job id a signal carries: the application id, so a duplicated callback
 * enqueues one job. BullMQ reserves `:` in custom ids (it is the key
 * separator), so the id is joined with `-` — an id with a colon is refused at
 * enqueue, which would silently turn every signal into a sweep wait.
 */
export function signalJobId(applicationId: string): string {
  return `signal-${applicationId}`;
}

export interface BullMqSignalOptions {
  readonly connection: ConnectionOptions;
  readonly prefix?: string;
  /** How long an enqueue may take before it is given up on. */
  readonly timeoutMs?: number;
}

export class BullMqProvisioningSignal implements ProvisioningSignalPort {
  readonly id = 'bullmq';
  private readonly queue: Queue;
  private readonly timeoutMs: number;

  constructor(options: BullMqSignalOptions) {
    // A signal must never wait on a Redis that is down: no offline queue, no
    // unbounded reconnects, and a lazy connection so constructing the port
    // contacts nothing. The connection is always plain options here — the
    // worker registry hands over host and port, never a live client.
    const connection: RedisOptions = {
      ...(options.connection as RedisOptions),
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    };
    this.queue = new Queue(PROVISIONING_QUEUE, {
      connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
    this.timeoutMs = options.timeoutMs ?? 1_500;
    // Connection errors are reported through `signal`'s result; an unhandled
    // 'error' event on the queue would otherwise crash the process.
    this.queue.on('error', () => undefined);
  }

  async signal(applicationId: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.timeoutMs);
    });
    try {
      const accepted = await Promise.race([
        this.queue
          .add(
            'signal',
            { kind: 'signal', applicationId },
            { jobId: signalJobId(applicationId), removeOnComplete: true, removeOnFail: true },
          )
          .then(
            () => true,
            () => false,
          ),
        timeout,
      ]);
      return accepted;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }
}
