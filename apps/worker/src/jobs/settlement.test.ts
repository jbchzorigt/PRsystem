import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@prsystem/telemetry';
import type { SettlementWorkerRuntime } from '@prsystem/api/settlement-worker';
import { QUEUE_NAMES } from '../queues';
import {
  SETTLEMENT_QUEUES,
  enabledSettlementQueues,
  processSettlementJob,
  startSettlementConsumers,
} from './settlement';

/**
 * The Phase 14 provider jobs have consumers, each consumer calls the operation
 * its queue names, and a sweep is registered only when its adapter can run
 * (Phase 20).
 *
 * Construction runs against a Redis nobody is listening on with `autorun`
 * off, so what is asserted is the registration and the routing — not Redis.
 */

const logger = createLogger({ level: 'error', serviceName: 'settlement-jobs-test' });
const CONNECTION = { host: '127.0.0.1', port: 59998, maxRetriesPerRequest: null } as const;

function stubRuntime(
  enabled = { refunds: true, payouts: true },
): SettlementWorkerRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enabled,
    executeOpenRefunds: vi.fn(async () => {
      calls.push('executeOpenRefunds');
      return 0;
    }),
    runDuePayouts: vi.fn(async () => {
      calls.push('runDuePayouts');
      return 0;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as SettlementWorkerRuntime & { calls: string[] };
}

describe('processSettlementJob', () => {
  it('routes each queue’s sweep to its own operation', async () => {
    const runtime = stubRuntime();
    for (const queue of SETTLEMENT_QUEUES) {
      await processSettlementJob(runtime, queue, { kind: 'sweep' });
    }
    expect(runtime.calls).toEqual(['executeOpenRefunds', 'runDuePayouts']);
  });

  it('refuses a payload it does not recognise, and a sweep whose adapter is disabled', async () => {
    const runtime = stubRuntime({ refunds: false, payouts: false });
    await expect(
      processSettlementJob(runtime, QUEUE_NAMES.settlementRefund, { kind: 'signal' }),
    ).rejects.toThrow(/unrecognised job/);
    await expect(
      processSettlementJob(runtime, QUEUE_NAMES.settlementRefund, { kind: 'sweep' }),
    ).rejects.toThrow(/disabled by its gate/);
    await expect(
      processSettlementJob(runtime, QUEUE_NAMES.settlementPayout, { kind: 'sweep' }),
    ).rejects.toThrow(/disabled by its gate/);
    await expect(
      processSettlementJob(runtime, 'settlement.unknown', { kind: 'sweep' }),
    ).rejects.toThrow(/no Phase 14 operation/);
    expect(runtime.calls).toEqual([]);
  });
});

describe('startSettlementConsumers', () => {
  it('schedules only the sweeps the adapters permit, and warns by name for the rest', async () => {
    const warned: unknown[] = [];
    const quiet = createLogger({ level: 'warn', serviceName: 'settlement-jobs-test' });
    quiet.warn = ((payload: unknown) => {
      warned.push(payload);
    }) as typeof quiet.warn;
    const scheduled: string[][] = [];
    const consumers = await startSettlementConsumers({
      connection: CONNECTION,
      runtime: stubRuntime({ refunds: true, payouts: false }),
      logger: quiet,
      options: { autorun: false },
      schedule: (_connection, queues) => {
        scheduled.push([...queues]);
        return Promise.resolve();
      },
    });
    expect(scheduled).toEqual([[QUEUE_NAMES.settlementRefund]]);
    expect(consumers.scheduled).toEqual([QUEUE_NAMES.settlementRefund]);
    expect(consumers.workers.map((worker) => worker.name).sort()).toEqual(
      [...SETTLEMENT_QUEUES].sort(),
    );
    expect(warned).toEqual([
      { queue: QUEUE_NAMES.settlementPayout, reason: 'adapter disabled by its external gate' },
    ]);
    await consumers.close();
  });

  it('schedules nothing when both adapters are disabled, and everything when both can run', () => {
    expect(enabledSettlementQueues({ refunds: false, payouts: false })).toEqual([]);
    expect(enabledSettlementQueues({ refunds: true, payouts: true })).toEqual([
      ...SETTLEMENT_QUEUES,
    ]);
  });

  it('closes both consumers when the sweeps cannot be registered', async () => {
    const runtime = stubRuntime();
    const closed: string[] = [];
    await expect(
      startSettlementConsumers({
        connection: CONNECTION,
        runtime,
        logger,
        options: { autorun: false },
        schedule: () => Promise.reject(new Error('redis unreachable')),
        onWorkerClosed: (name) => closed.push(name),
      }),
    ).rejects.toThrow(/redis unreachable/);
    expect(closed.sort()).toEqual([...SETTLEMENT_QUEUES].sort());
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
