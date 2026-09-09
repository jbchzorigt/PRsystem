import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@prsystem/telemetry';
import { newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import type { PoliceMatcherRuntime } from '@prsystem/api/police-worker';
import { QUEUE_NAMES } from '../queues';

/**
 * The Phase 18 matcher (doc 13 §8.3).
 *
 * One queue, one sweep. There is no signal shape here on purpose: the row that
 * says there is work to do is the `stay.checked_in` event, already committed by
 * the check-in that wrote it, and the consumer claims its own consumption of
 * each one. A duplicated, delayed or reordered message produces one match and
 * one alert (`POL-DEC-017`).
 *
 * Nothing this consumer logs can carry a wanted person's identity: the runtime
 * answers counts, and the function it calls answers a match id or nothing.
 */

export type PoliceJob = { kind: 'sweep' };

export async function processPoliceJob(
  runtime: PoliceMatcherRuntime,
  queue: string,
  job: unknown,
): Promise<void> {
  const payload = job as Partial<PoliceJob> | undefined;
  if (payload?.kind !== 'sweep') throw new Error(`unrecognised job on ${queue}`);
  if (queue !== QUEUE_NAMES.policeMatcher) {
    throw new Error(`no Phase 18 operation is bound to ${queue}`);
  }
  await runtime.matchPendingCheckIns();
}

export interface PoliceWorkerOptions {
  readonly prefix?: string;
  readonly autorun?: boolean;
  readonly concurrency?: number;
}

export interface PoliceConsumersStart {
  readonly connection: ConnectionOptions;
  readonly runtime: PoliceMatcherRuntime;
  readonly logger: Logger;
  readonly options?: PoliceWorkerOptions;
  readonly schedule?: (
    connection: ConnectionOptions,
    options: PoliceWorkerOptions,
  ) => Promise<void>;
}

export interface PoliceConsumers {
  readonly workers: readonly Worker[];
  close(): Promise<void>;
}

export async function startPoliceConsumers(start: PoliceConsumersStart): Promise<PoliceConsumers> {
  const options = start.options ?? {};
  const queue = QUEUE_NAMES.policeMatcher;
  const worker = new Worker(
    queue,
    (job) =>
      runWithCorrelation({ requestId: newRequestId() }, async () => {
        await processPoliceJob(start.runtime, queue, job.data);
        logProcessed(start.logger, job.id, queue);
      }),
    {
      connection: start.connection,
      concurrency: options.concurrency ?? 1,
      autorun: options.autorun ?? true,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );
  worker.on('failed', (job, error) => {
    // The error's name only. A message from this consumer could otherwise carry
    // a registration number out of the Police boundary (doc 13 §13.2).
    start.logger.error({ jobId: job?.id, queue, err: { name: error.name } }, 'job failed');
  });
  worker.on('error', (error) => {
    start.logger.error({ queue, err: { name: error.name } }, 'worker error');
  });

  const closeAll = async (): Promise<void> => {
    await worker.close().catch(() => undefined);
    await start.runtime.close().catch(() => undefined);
  };
  try {
    await (start.schedule ?? schedulePoliceSweep)(start.connection, options);
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { workers: [worker], close: closeAll };
}

function logProcessed(logger: Logger, jobId: string | undefined, queue: string): void {
  logger.info({ jobId, queue }, 'job processed');
}

/**
 * The repeatable sweep.
 *
 * Every minute, like the other domain sweeps. A check-in that produced a match
 * is Police work somebody is waiting on, and the relay is not a queue this
 * consumer can be signalled through — the event is the only trigger there is.
 */
export async function schedulePoliceSweep(
  connection: ConnectionOptions,
  options: { prefix?: string; everyMs?: number } = {},
): Promise<void> {
  const queue = QUEUE_NAMES.policeMatcher;
  const handle = new Queue(queue, {
    connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
  try {
    await handle.upsertJobScheduler(
      `${queue}:sweep`,
      { every: options.everyMs ?? 60_000 },
      {
        name: 'sweep',
        data: { kind: 'sweep' },
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
  } finally {
    await handle.close();
  }
}
