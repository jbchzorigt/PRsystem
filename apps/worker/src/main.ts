import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { env } from '@prsystem/config';
import { selectKeyManagement } from '@prsystem/ports';
import { createLogger, newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import { QUEUE_NAMES, connectionFromUrl, workerOptions } from './queues';
import { assertWorkerConnectionPrincipal } from './observability/connection-guard';

async function main(): Promise<void> {
  const config = env();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: `${config.OTEL_SERVICE_NAME}-worker`,
  });

  // Before Redis is contacted and before any Worker is constructed: a process
  // that cannot prove its database identity, or that has no key management, must
  // not start consuming jobs.
  const guardPool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    await assertWorkerConnectionPrincipal(guardPool, logger);
    selectKeyManagement({
      appEnv: config.APP_ENV,
      kmsAdapter: config.KMS_ADAPTER,
      ...(config.KMS_SEED === undefined ? {} : { seed: config.KMS_SEED }),
    });
  } finally {
    await guardPool.end();
  }

  const connection = connectionFromUrl(config.REDIS_URL);

  const heartbeat = new Worker(
    QUEUE_NAMES.heartbeat,
    async (job) =>
      runWithCorrelation({ requestId: newRequestId() }, () => {
        logger.info({ jobId: job.id, queue: QUEUE_NAMES.heartbeat }, 'job processed');
        return Promise.resolve();
      }),
    workerOptions(connection, { concurrency: 1, attempts: 3 }),
  );

  heartbeat.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'job failed');
  });

  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await heartbeat.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error', serviceName: 'prsystem-worker' });
  logger.error(
    { err: error instanceof Error ? error : new Error(String(error)) },
    'worker failed to start',
  );
  process.exitCode = 1;
});
