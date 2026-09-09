import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@prsystem/telemetry';
import { newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import type { SettlementWorkerRuntime } from '@prsystem/api/settlement-worker';
import { QUEUE_NAMES } from '../queues';
import type { QueueName } from '../queues';

/**
 * The Phase 14 provider jobs (Phase 20; doc 11 §7–§8).
 *
 * Two queues, two `Worker`s, one processor, and every job is a `sweep`: the
 * rows that say there is work to do — an open refund, a payable past its
 * `D+1 12:00` — are already in PostgreSQL. The processor calls the runtime,
 * the runtime claims from the table, and a duplicated or reordered message
 * changes nothing.
 *
 * What is new with Phase 20 is that a sweep is registered only when its
 * adapter can run. A refund executor whose gateways answer `DISABLED`, or a
 * payout runner behind an uncleared `EXT-07`, is not scheduled at all: the
 * consumer opens, so the queue has an owner, and the log records once at
 * startup which gate kept the sweep off. A job that exists to be refused every
 * minute is not a job.
 */

export type SettlementJob = { kind: 'sweep' };

export const SETTLEMENT_QUEUES: readonly QueueName[] = [
  QUEUE_NAMES.settlementRefund,
  QUEUE_NAMES.settlementPayout,
];

/** Routes one job to the operation its queue names. Refuses what it does not recognise. */
export async function processSettlementJob(
  runtime: SettlementWorkerRuntime,
  queue: string,
  job: unknown,
): Promise<void> {
  const payload = job as Partial<SettlementJob> | undefined;
  if (payload?.kind !== 'sweep') {
    throw new Error(`unrecognised job on ${queue}`);
  }
  switch (queue) {
    case QUEUE_NAMES.settlementRefund:
      if (!runtime.enabled.refunds) throw new Error('the refund executor is disabled by its gate');
      await runtime.executeOpenRefunds();
      return;
    case QUEUE_NAMES.settlementPayout:
      if (!runtime.enabled.payouts) throw new Error('the payout runner is disabled by its gate');
      await runtime.runDuePayouts();
      return;
    default:
      throw new Error(`no Phase 14 operation is bound to ${queue}`);
  }
}

export interface SettlementWorkerOptions {
  readonly prefix?: string;
  readonly autorun?: boolean;
  readonly concurrency?: number;
}

function createSettlementWorker(
  queue: QueueName,
  connection: ConnectionOptions,
  runtime: SettlementWorkerRuntime,
  logger: Logger,
  options: SettlementWorkerOptions,
): Worker {
  const worker = new Worker(
    queue,
    (job) =>
      runWithCorrelation({ requestId: newRequestId() }, async () => {
        await processSettlementJob(runtime, queue, job.data);
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
    // The error's name only: a message can carry a provider reference.
    logger.error({ jobId: job?.id, queue, err: { name: error.name } }, 'job failed');
  });
  worker.on('error', (error) => {
    logger.error({ queue, err: { name: error.name } }, 'worker error');
  });
  return worker;
}

/** The sweeps a runtime's adapters permit, in queue order. */
export function enabledSettlementQueues(
  enabled: SettlementWorkerRuntime['enabled'],
): readonly QueueName[] {
  return [
    ...(enabled.refunds ? [QUEUE_NAMES.settlementRefund] : []),
    ...(enabled.payouts ? [QUEUE_NAMES.settlementPayout] : []),
  ];
}

export interface SettlementConsumersStart {
  readonly connection: ConnectionOptions;
  readonly runtime: SettlementWorkerRuntime;
  readonly logger: Logger;
  readonly options?: SettlementWorkerOptions;
  /** Registers the sweeps; the real one is `scheduleSettlementSweeps`. */
  readonly schedule?: (
    connection: ConnectionOptions,
    queues: readonly QueueName[],
    options: SettlementWorkerOptions,
  ) => Promise<void>;
  readonly construct?: (queue: QueueName, make: () => Worker) => Worker;
  readonly onWorkerClosed?: (queue: string) => void;
}

export interface SettlementConsumers {
  readonly workers: readonly Worker[];
  /** The queues whose sweep was registered. */
  readonly scheduled: readonly QueueName[];
  close(): Promise<void>;
}

/**
 * Opens both consumers and registers the sweeps the adapters permit — or
 * opens nothing. The same all-or-nothing shape as the other consumers.
 */
export async function startSettlementConsumers(
  start: SettlementConsumersStart,
): Promise<SettlementConsumers> {
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
  const scheduled = enabledSettlementQueues(start.runtime.enabled);
  try {
    for (const queue of SETTLEMENT_QUEUES) {
      const make = (): Worker =>
        createSettlementWorker(queue, start.connection, start.runtime, start.logger, options);
      opened.push(start.construct === undefined ? make() : start.construct(queue, make));
    }
    for (const queue of SETTLEMENT_QUEUES) {
      if (!scheduled.includes(queue)) {
        // Once, at startup, and by name: the operator can see which sweep is
        // off and why without a failed job per minute telling them.
        start.logger.warn(
          { queue, reason: 'adapter disabled by its external gate' },
          'settlement sweep not scheduled',
        );
      }
    }
    await (start.schedule ?? scheduleSettlementSweeps)(start.connection, scheduled, options);
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { workers: opened, scheduled, close: closeAll };
}

/**
 * The repeatable sweeps, for the queues named and no others.
 *
 * A minute for the refunds — a guest is waiting on one — and a minute for the
 * payouts too: `D+1 12:00 Asia/Ulaanbaatar` is a deadline the resolver
 * evaluates, so polling it every minute settles a batch within the minute it
 * falls due and does nothing before.
 */
export async function scheduleSettlementSweeps(
  connection: ConnectionOptions,
  queues: readonly QueueName[],
  options: { prefix?: string; everyMs?: number } = {},
): Promise<void> {
  const everyMs = options.everyMs ?? 60_000;
  for (const queue of queues) {
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
