import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@prsystem/telemetry';
import type { PoliceMatcherRuntime } from '@prsystem/api/police-worker';
import { QUEUE_NAMES } from '../queues';
import { processPoliceJob, startPoliceConsumers } from './police';

/**
 * The Phase 18 queue has a consumer, and it calls the one operation it names
 * (doc 13 §8.3).
 */

const logger = createLogger({ level: 'error', serviceName: 'police-jobs-test' });
const CONNECTION = { host: '127.0.0.1', port: 59998, maxRetriesPerRequest: null } as const;

function stubRuntime(): PoliceMatcherRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    matchPendingCheckIns: vi.fn(async () => {
      calls.push('matchPendingCheckIns');
      return { consumed: 0, matched: 0 };
    }),
    close: vi.fn(async () => undefined),
  } as unknown as PoliceMatcherRuntime & { calls: string[] };
}

describe('processPoliceJob', () => {
  it('routes the sweep to the matcher', async () => {
    const runtime = stubRuntime();
    await processPoliceJob(runtime, QUEUE_NAMES.policeMatcher, { kind: 'sweep' });
    expect(runtime.calls).toEqual(['matchPendingCheckIns']);
  });

  it('refuses a payload or a queue it does not recognise', async () => {
    const runtime = stubRuntime();
    await expect(
      processPoliceJob(runtime, QUEUE_NAMES.policeMatcher, { kind: 'signal' }),
    ).rejects.toThrow(/unrecognised job/);
    await expect(processPoliceJob(runtime, 'police.other', { kind: 'sweep' })).rejects.toThrow(
      /no Phase 18 operation/,
    );
    expect(runtime.calls).toEqual([]);
  });
});

describe('startPoliceConsumers', () => {
  it('closes the consumer and the runtime when the sweep cannot be registered', async () => {
    const runtime = stubRuntime();
    await expect(
      startPoliceConsumers({
        connection: CONNECTION,
        runtime,
        logger,
        options: { autorun: false },
        schedule: () => Promise.reject(new Error('redis unreachable')),
      }),
    ).rejects.toThrow(/redis unreachable/);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
