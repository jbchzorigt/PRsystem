import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@prsystem/telemetry';
import { newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import type { ReportingWorkerRuntime } from '@prsystem/api/reporting-worker';
import { QUEUE_NAMES } from '../queues';
import type { QueueName } from '../queues';

/**
 * The Phase 17 consumers (doc 12 §7–§9, doc 23 §6).
 *
 * Three queues, three `Worker`s, one processor. Every job is a `sweep`: these
 * operations have no signal, because the row that says there is work to do is
 * already in PostgreSQL when the API answers `QUEUED`. The processor calls the
 * runtime, the runtime claims from the table, and a duplicated or reordered
 * message changes nothing.
 */

export type ReportingJob = { kind: 'sweep' };

export const REPORTING_QUEUES: readonly QueueName[] = [
  QUEUE_NAMES.exportRun,
  QUEUE_NAMES.exportExpiry,
  QUEUE_NAMES.retentionPurge,
];

/** Routes one job to the operation its queue names. Refuses what it does not recognise. */
export async function processReportingJob(
  runtime: ReportingWorkerRuntime,
  queue: string,
  job: unknown,
): Promise<void> {
  const payload = job as Partial<ReportingJob> | undefined;
  if (payload?.kind !== 'sweep') {
    throw new Error(`unrecognised job on ${queue}`);
  }
  switch (queue) {
    case QUEUE_NAMES.exportRun:
      await runtime.runQueuedExports();
      return;
    case QUEUE_NAMES.exportExpiry:
      await runtime.expireLapsedFiles();
      return;
    case QUEUE_NAMES.retentionPurge:
      await runtime.purgeDueRetention();
      return;
    default:
      throw new Error(`no Phase 17 operation is bound to ${queue}`);
  }
}

export interface ReportingWorkerOptions {
  readonly prefix?: string;
  readonly autorun?: boolean;
  readonly concurrency?: number;
}

function createReportingWorker(
  queue: QueueName,
  connection: ConnectionOptions,
  runtime: ReportingWorkerRuntime,
  logger: Logger,
  options: ReportingWorkerOptions,
): Worker {
  const worker = new Worker(
    queue,
    (job) =>
      runWithCorrelation({ requestId: newRequestId() }, async () => {
        await processReportingJob(runtime, queue, job.data);
        logger.info({ jobId: job.id, queue }, 'job processed');
      }),
    {
      connection,
      concurrency: options.concurrency ?? 1,
      autorun: options.autorun ?? true,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );
  worker.on('failed', (job, error) => {
    // The error's name only: a message can carry a guest's name or a file key.
    logger.error({ jobId: job?.id, queue, err: { name: error.name } }, 'job failed');
  });
  worker.on('error', (error) => {
    logger.error({ queue, err: { name: error.name } }, 'worker error');
  });
  return worker;
}

export interface ReportingConsumersStart {
  readonly connection: ConnectionOptions;
  readonly runtime: ReportingWorkerRuntime;
  readonly logger: Logger;
  readonly options?: ReportingWorkerOptions;
  /** Registers the sweeps; the real one is `scheduleReportingSweeps`. */
  readonly schedule?: (
    connection: ConnectionOptions,
    options: ReportingWorkerOptions,
  ) => Promise<void>;
  /** Constructs one consumer; a seam for a test that fails the third. */
  readonly construct?: (queue: QueueName, make: () => Worker) => Worker;
  readonly onWorkerClosed?: (queue: string) => void;
}

export interface ReportingConsumers {
  readonly workers: readonly Worker[];
  close(): Promise<void>;
}

/**
 * Opens every Phase 17 consumer and registers the sweeps — or opens nothing.
 *
 * The same all-or-nothing shape Phase 05's consumers were repaired into: a
 * scheduler that cannot reach Redis, or a third consumer that cannot be
 * constructed, must not leave the first two running behind an exited startup.
 */
export async function startReportingConsumers(
  start: ReportingConsumersStart,
): Promise<ReportingConsumers> {
  const options = start.options ?? {};
  const opened: Worker[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.all(
      opened.map(async (worker) => {
        await worker.close().catch(() => undefined);
        start.onWorkerClosed?.(worker.name);
      }),
    );
    await start.runtime.close().catch(() => undefined);
  };
  try {
    for (const queue of REPORTING_QUEUES) {
      const make = (): Worker =>
        createReportingWorker(queue, start.connection, start.runtime, start.logger, options);
      opened.push(start.construct === undefined ? make() : start.construct(queue, make));
    }
    await (start.schedule ?? scheduleReportingSweeps)(start.connection, options);
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { workers: opened, close: closeAll };
}

/**
 * The repeatable sweeps.
 *
 * A minute for all three: an export a caller is waiting for should start
 * promptly, and the two deletions are deadlines rather than instants — a file
 * lives an hour, a stay a year, and neither is harmed by being settled within
 * the minute after it falls due.
 */
export async function scheduleReportingSweeps(
  connection: ConnectionOptions,
  options: { prefix?: string; everyMs?: number } = {},
): Promise<void> {
  const everyMs = options.everyMs ?? 60_000;
  for (const queue of REPORTING_QUEUES) {
    const handle = new Queue(queue, {
      connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
    try {
      await handle.upsertJobScheduler(
        `${queue}:sweep`,
        { every: everyMs },
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
}
