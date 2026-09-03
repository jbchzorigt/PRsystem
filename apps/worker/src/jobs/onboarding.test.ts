import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@prsystem/telemetry';
import type { OnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import { QUEUE_NAMES } from '../queues';
import { createOnboardingWorkers, processOnboardingJob } from './onboarding';

/**
 * R3 / R5 — the Phase 05 queues have consumers, and each consumer calls the
 * runtime operation its queue names.
 *
 * The worker construction is exercised against a Redis nobody is listening on,
 * with `autorun` off, so what is asserted is the registration: one BullMQ
 * `Worker` per Phase 05 queue, bound to the right handler.
 */

const logger = createLogger({ level: 'error', serviceName: 'onboarding-jobs-test' });

function stubRuntime(): OnboardingWorkerRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisionDue: vi.fn(async () => {
      calls.push('provisionDue');
      return { claimed: 0, provisioned: 0, failed: 0 };
    }),
    provisionOne: vi.fn(async (applicationId: string) => {
      calls.push(`provisionOne:${applicationId}`);
      return { kind: 'blocked', state: 'stub' } as const;
    }),
    deliverActivations: vi.fn(async () => {
      calls.push('deliverActivations');
      return 0;
    }),
    issueReceipts: vi.fn(async () => {
      calls.push('issueReceipts');
      return 0;
    }),
    applyUpgradeBoundaries: vi.fn(async () => {
      calls.push('applyUpgradeBoundaries');
      return 0;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as OnboardingWorkerRuntime & { calls: string[] };
}

describe('createOnboardingWorkers', () => {
  it('registers one consumer per Phase 05 queue', async () => {
    const runtime = stubRuntime();
    const workers = createOnboardingWorkers(
      { host: '127.0.0.1', port: 59998, maxRetriesPerRequest: null },
      runtime,
      logger,
      { autorun: false },
    );
    try {
      expect(workers.map((worker) => worker.name).sort()).toEqual(
        [
          QUEUE_NAMES.provisioning,
          QUEUE_NAMES.activationDelivery,
          QUEUE_NAMES.ebarimtIssuance,
          QUEUE_NAMES.subscriptionBoundary,
        ].sort(),
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.close(true)));
    }
  });
});

describe('processOnboardingJob', () => {
  it('routes a provisioning signal to the one application it names, and a sweep to the drain', async () => {
    const runtime = stubRuntime();
    await processOnboardingJob(runtime, QUEUE_NAMES.provisioning, {
      kind: 'signal',
      applicationId: '11111111-1111-4111-8111-111111111111',
    });
    await processOnboardingJob(runtime, QUEUE_NAMES.provisioning, { kind: 'sweep' });
    await processOnboardingJob(runtime, QUEUE_NAMES.activationDelivery, { kind: 'sweep' });
    await processOnboardingJob(runtime, QUEUE_NAMES.ebarimtIssuance, { kind: 'sweep' });
    await processOnboardingJob(runtime, QUEUE_NAMES.subscriptionBoundary, { kind: 'sweep' });
    expect(runtime.calls).toEqual([
      'provisionOne:11111111-1111-4111-8111-111111111111',
      'provisionDue',
      'deliverActivations',
      'issueReceipts',
      'applyUpgradeBoundaries',
    ]);
  });

  it('refuses a payload it does not recognise rather than guessing', async () => {
    const runtime = stubRuntime();
    await expect(
      processOnboardingJob(runtime, QUEUE_NAMES.provisioning, {
        kind: 'signal',
        applicationId: 'nope',
      }),
    ).rejects.toThrow(/application id/);
    expect(runtime.calls).toEqual([]);
  });
});
