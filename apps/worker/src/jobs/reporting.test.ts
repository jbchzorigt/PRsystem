import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@prsystem/telemetry';
import type { ReportingWorkerRuntime } from '@prsystem/api/reporting-worker';
import { QUEUE_NAMES } from '../queues';
import { REPORTING_QUEUES, processReportingJob, startReportingConsumers } from './reporting';

/**
 * The Phase 17 queues have consumers, and each consumer calls the operation
 * its queue names (doc 12 §7–§9).
 *
 * Construction runs against a Redis nobody is listening on with `autorun` off,
 * so what is asserted is the registration and the routing — not Redis.
 */

const logger = createLogger({ level: 'error', serviceName: 'reporting-jobs-test' });
const CONNECTION = { host: '127.0.0.1', port: 59998, maxRetriesPerRequest: null } as const;

function stubRuntime(): ReportingWorkerRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runQueuedExports: vi.fn(async () => {
      calls.push('runQueuedExports');
      return 0;
    }),
    expireLapsedFiles: vi.fn(async () => {
      calls.push('expireLapsedFiles');
      return 0;
    }),
    purgeDueRetention: vi.fn(async () => {
      calls.push('purgeDueRetention');
      return 0;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as ReportingWorkerRuntime & { calls: string[] };
}

describe('processReportingJob', () => {
  it('routes each queue’s sweep to its own operation', async () => {
    const runtime = stubRuntime();
    for (const queue of REPORTING_QUEUES) {
      await processReportingJob(runtime, queue, { kind: 'sweep' });
    }
    expect(runtime.calls).toEqual(['runQueuedExports', 'expireLapsedFiles', 'purgeDueRetention']);
  });

  it('refuses a payload it does not recognise rather than guessing', async () => {
    const runtime = stubRuntime();
    await expect(
      processReportingJob(runtime, QUEUE_NAMES.exportRun, { kind: 'signal', jobId: 'x' }),
    ).rejects.toThrow(/unrecognised job/);
    await expect(
      processReportingJob(runtime, 'reporting.unknown', { kind: 'sweep' }),
    ).rejects.toThrow(/no Phase 17 operation/);
    expect(runtime.calls).toEqual([]);
  });
});

describe('startReportingConsumers', () => {
  it('opens one consumer per queue, and closes them all when the sweeps cannot be registered', async () => {
    const runtime = stubRuntime();
    const closed: string[] = [];
    await expect(
      startReportingConsumers({
        connection: CONNECTION,
        runtime,
        logger,
        options: { autorun: false },
        schedule: () => Promise.reject(new Error('redis unreachable')),
        onWorkerClosed: (name) => closed.push(name),
      }),
    ).rejects.toThrow(/redis unreachable/);
    expect(closed.sort()).toEqual([...REPORTING_QUEUES].sort());
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('closes the consumers already opened when a later one cannot be constructed', async () => {
    const runtime = stubRuntime();
    const closed: string[] = [];
    let constructed = 0;
    await expect(
      startReportingConsumers({
        connection: CONNECTION,
        runtime,
        logger,
        options: { autorun: false },
        schedule: () => Promise.resolve(),
        onWorkerClosed: (name) => closed.push(name),
        construct: (queue, make) => {
          constructed += 1;
          if (constructed === 3) throw new Error(`cannot construct ${queue}`);
          return make();
        },
      }),
    ).rejects.toThrow(/cannot construct/);
    expect(closed).toHaveLength(2);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
