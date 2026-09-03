import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@prsystem/telemetry';
import { newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import type { OnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import { QUEUE_NAMES } from '../queues';
import type { QueueName } from '../queues';

/**
 * The Phase 05 consumers (R3, R5; doc 15 §5, doc 16 §4.1, doc 17 §4.4).
 *
 * Four queues, four `Worker`s, one processor. A job is one of two shapes: a
 * `signal` naming the application a callback just confirmed, or a `sweep`, the
 * repeatable job that runs each operation's drain on a cadence. PostgreSQL is
 * the record either way: the processor calls the runtime, the runtime claims
 * from the table, and a duplicated, delayed or lost message changes nothing.
 */

export type OnboardingJob = { kind: 'signal'; applicationId: string } | { kind: 'sweep' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ONBOARDING_QUEUES: readonly QueueName[] = [
  QUEUE_NAMES.provisioning,
  QUEUE_NAMES.activationDelivery,
  QUEUE_NAMES.ebarimtIssuance,
  QUEUE_NAMES.subscriptionBoundary,
];

/** Routes one job to the runtime operation its queue names. Refuses what it does not recognise. */
export async function processOnboardingJob(
  runtime: OnboardingWorkerRuntime,
  queue: string,
  job: unknown,
): Promise<void> {
  const payload = job as Partial<OnboardingJob> | undefined;
  if (payload?.kind === 'signal') {
    if (queue !== QUEUE_NAMES.provisioning) {
      throw new Error(`a provisioning signal does not belong on ${queue}`);
    }
    if (typeof payload.applicationId !== 'string' || !UUID.test(payload.applicationId)) {
      throw new Error('a provisioning signal must name an application id');
    }
    await runtime.provisionOne(payload.applicationId);
    return;
  }
  if (payload?.kind !== 'sweep') {
    throw new Error(`unrecognised job on ${queue}`);
  }
  switch (queue) {
    case QUEUE_NAMES.provisioning:
      await runtime.provisionDue();
      return;
    case QUEUE_NAMES.activationDelivery:
      await runtime.deliverActivations();
      return;
    case QUEUE_NAMES.ebarimtIssuance:
      await runtime.issueReceipts();
      return;
    case QUEUE_NAMES.subscriptionBoundary:
      await runtime.applyUpgradeBoundaries();
      return;
    default:
      throw new Error(`no Phase 05 operation is bound to ${queue}`);
  }
}

export interface OnboardingWorkerOptions {
  readonly prefix?: string;
  readonly autorun?: boolean;
  readonly concurrency?: number;
}

/** One consumer per Phase 05 queue, each bound to the shared processor. */
export function createOnboardingWorkers(
  connection: ConnectionOptions,
  runtime: OnboardingWorkerRuntime,
  logger: Logger,
  options: OnboardingWorkerOptions = {},
): readonly Worker[] {
  return ONBOARDING_QUEUES.map((queue) => {
    const worker = new Worker(
      queue,
      (job) =>
        runWithCorrelation({ requestId: newRequestId() }, async () => {
          await processOnboardingJob(runtime, queue, job.data);
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
      // The error's name only: a message can carry a column value.
      logger.error({ jobId: job?.id, queue, err: { name: error.name } }, 'job failed');
    });
    worker.on('error', (error) => {
      logger.error({ queue, err: { name: error.name } }, 'worker error');
    });
    return worker;
  });
}

/**
 * The repeatable sweeps: every Phase 05 operation runs on a cadence whether or
 * not a signal ever arrives. Registered by the worker at startup, idempotently
 * — BullMQ keys a job scheduler by its id.
 */
export async function scheduleOnboardingSweeps(
  connection: ConnectionOptions,
  options: { prefix?: string; everyMs?: number } = {},
): Promise<void> {
  const everyMs = options.everyMs ?? 60_000;
  for (const queue of ONBOARDING_QUEUES) {
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
