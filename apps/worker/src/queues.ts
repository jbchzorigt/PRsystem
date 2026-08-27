import type { ConnectionOptions, WorkerOptions } from 'bullmq';

/**
 * Queue registry.
 *
 * Phase 03 adds the two kernel queues. Domain queues — notification, provisioning,
 * billing boundary, export, reconciliation, retention — arrive with the phases that
 * own them (docs/architecture/02-container-and-deployment.md §5).
 */
export const QUEUE_NAMES = {
  heartbeat: 'system.heartbeat',
  /** Relays committed outbox events after their transaction (ADR-0010). */
  outboxRelay: 'kernel.outbox.relay',
  /** Pre-creates audit partitions and checks the horizon (ADR-0018 §4). */
  partitionMaintenance: 'kernel.audit.partition_maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Redis connection options for BullMQ.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands. Redis is a
 * transport for jobs only and is never authoritative (ADR-0002); business truth is
 * always the PostgreSQL row a job acts on.
 */
export function connectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : 6379;

  return {
    host: parsed.hostname,
    port,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    maxRetriesPerRequest: null,
  };
}

export interface WorkerSettings {
  readonly concurrency: number;
  readonly attempts: number;
}

/** Default worker options. Jobs are re-drivable, so bounded retries are safe. */
export function workerOptions(
  connection: ConnectionOptions,
  settings: WorkerSettings,
): WorkerOptions {
  return {
    connection,
    concurrency: settings.concurrency,
    autorun: true,
  };
}
