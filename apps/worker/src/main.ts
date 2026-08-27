import { Worker } from 'bullmq';
import { env } from '@prsystem/config';
import { createLogger, newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import { QUEUE_NAMES, connectionFromUrl, workerOptions } from './queues';

async function main(): Promise<void> {
  const config = env();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: `${config.OTEL_SERVICE_NAME}-worker`,
  });

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
