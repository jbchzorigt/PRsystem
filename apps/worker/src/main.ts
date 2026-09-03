import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { workerEnv } from '@prsystem/config';
import { selectKeyManagement } from '@prsystem/ports';
import { createLogger, newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import { createOnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import type { OnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import { QUEUE_NAMES, connectionFromUrl, workerOptions } from './queues';
import { startOnboardingConsumers } from './jobs/onboarding';
import type { OnboardingConsumers } from './jobs/onboarding';
import { startWorker } from './startup';

async function main(): Promise<void> {
  const config = workerEnv();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: `${config.OTEL_SERVICE_NAME}-worker`,
  });
  let onboarding: OnboardingConsumers | undefined;

  // Startup order is enforced by startWorker: the security preconditions run to
  // completion before Redis is contacted or any consumer is constructed.
  const started = await startWorker({
    logger,
    openGuardPool: () => new Pool({ connectionString: config.DATABASE_URL, max: 1 }),
    verifyKeyManagement: () => {
      selectKeyManagement({
        appEnv: config.APP_ENV,
        kmsAdapter: config.KMS_ADAPTER,
        ...(config.KMS_SEED === undefined ? {} : { seed: config.KMS_SEED }),
      });
    },
    createConnection: () => connectionFromUrl(config.REDIS_URL),
    createWorkers: (connection) => {
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

      return [heartbeat];
    },
  });

  // The Phase 05 operations, bound to this deployment's own restricted login
  // and the environment's ports (R3, R5). Consumers and sweeps open together
  // or not at all: a failure here closes what was opened, then the heartbeat,
  // and the process exits non-zero (remediation 2, finding 3).
  const runtime: OnboardingWorkerRuntime = createOnboardingWorkerRuntime({
    databaseUrl: config.DATABASE_URL,
    appEnv: config.APP_ENV,
    kmsAdapter: config.KMS_ADAPTER,
    ...(config.KMS_SEED === undefined ? {} : { kmsSeed: config.KMS_SEED }),
  });
  try {
    onboarding = await startOnboardingConsumers({
      connection: connectionFromUrl(config.REDIS_URL),
      runtime,
      logger,
      options: { ...(config.QUEUE_PREFIX === undefined ? {} : { prefix: config.QUEUE_PREFIX }) },
    });
  } catch (error) {
    await started.close();
    throw error;
  }

  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await onboarding?.close();
    await started.close();
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
