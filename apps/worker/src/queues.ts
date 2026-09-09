import type { ConnectionOptions, WorkerOptions } from 'bullmq';

/**
 * Queue registry.
 *
 * Phase 03 adds the two kernel queues; Phase 05 adds the three its own
 * background operations run on; Phase 17 adds the export and retention ones,
 * Phase 18 the matcher, and Phase 20 the two provider jobs Phase 14 built —
 * scheduled only when their adapters are not disabled. The remaining domain
 * queues — notification fan-out — arrive with the phases that own them
 * (docs/architecture/02-container-and-deployment.md §5).
 *
 * Every Phase 05 queue has a consumer in this deployment
 * (`jobs/onboarding.ts`): the provisioning queue takes the API's best-effort
 * signal and a repeatable sweep, the other three run their drains on a
 * repeatable sweep. PostgreSQL is the job record; a name here is a transport.
 */
export const QUEUE_NAMES = {
  heartbeat: 'system.heartbeat',
  /** Relays committed outbox events after their transaction (ADR-0010). */
  outboxRelay: 'kernel.outbox.relay',
  /** Pre-creates audit partitions and checks the horizon (ADR-0018 §4). */
  partitionMaintenance: 'kernel.audit.partition_maintenance',
  /** Claims and runs paid provisioning jobs; signalled by the API, swept on a cadence (doc 15 §5). */
  provisioning: 'onboarding.provisioning',
  /** Applies a paid pending upgrade at its service-month boundary (doc 17 §4.4). */
  subscriptionBoundary: 'subscription.upgrade.boundary',
  /** Delivers the first Hotel Admin's activation link (doc 15 §5). */
  activationDelivery: 'onboarding.activation.delivery',
  /** Issues and retries eBarimt receipts (doc 16 §4.1). */
  ebarimtIssuance: 'subscription.ebarimt.issuance',
  /** Builds the queued background exports (doc 12 §7, `GUEST-DEC-006`). */
  exportRun: 'reporting.export.run',
  /** Deletes export files whose hour has passed (doc 12 §7, `GUEST-DEC-007`). */
  exportExpiry: 'reporting.export.expiry',
  /** Anonymises stays past their retention deadline (doc 12 §9, `GUEST-DEC-008`). */
  retentionPurge: 'reporting.retention.purge',
  /** Matches recorded check-ins against active wanted records (doc 13 §8.3). */
  policeMatcher: 'police.match.check_in',
  /** Executes open refund obligations against the gateway (doc 11 §7, `PAY-DEC-006`). */
  settlementRefund: 'settlement.refund.execute',
  /** Assembles and submits due payout batches (doc 11 §8, `PAY-DEC-009`). */
  settlementPayout: 'settlement.payout.run',
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
