import type { Pool } from 'pg';
import type { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@prsystem/telemetry';
import { assertWorkerConnectionPrincipal } from './observability/connection-guard';

/**
 * Worker startup, as an orchestration boundary.
 *
 * Extracted so the *ordering* can be tested rather than asserted in prose: the
 * security preconditions must complete before Redis is contacted and before any
 * BullMQ Worker exists. With the factories injected, a test can prove they were
 * never called when a precondition fails — which is the only thing that makes
 * "fails before it starts consuming jobs" a fact rather than a claim.
 */
export interface WorkerStartupDependencies {
  /** Opens the guard connection. Closed here whether the guard passes or throws. */
  readonly openGuardPool: () => Pool;
  /** Verifies the key-management configuration. Throws to refuse startup. */
  readonly verifyKeyManagement: () => void;
  /** Builds the Redis connection. Must not be called before the guards pass. */
  readonly createConnection: () => ConnectionOptions;
  /** Constructs the queue consumers. Must not be called before the guards pass. */
  readonly createWorkers: (connection: ConnectionOptions) => readonly Worker[];
  readonly logger: Logger;
}

export interface StartedWorker {
  readonly workers: readonly Worker[];
  close(): Promise<void>;
}

export async function startWorker(deps: WorkerStartupDependencies): Promise<StartedWorker> {
  const guardPool = deps.openGuardPool();
  try {
    await assertWorkerConnectionPrincipal(guardPool, deps.logger);
    deps.verifyKeyManagement();
  } finally {
    // Released on both paths: a refused startup must leave no connection behind.
    await guardPool.end();
  }

  // Only now. Nothing above this line may touch Redis or construct a consumer.
  const connection = deps.createConnection();
  const workers = deps.createWorkers(connection);

  return {
    workers,
    async close(): Promise<void> {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
