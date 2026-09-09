import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { workerEnv } from '@prsystem/config';
import { selectAdapters, selectKeyManagement } from '@prsystem/ports';
import { createLogger, newRequestId, runWithCorrelation } from '@prsystem/telemetry';
import { createOnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import type { OnboardingWorkerRuntime } from '@prsystem/api/onboarding-worker';
import { createReportingWorkerRuntime } from '@prsystem/api/reporting-worker';
import type { ReportingWorkerRuntime } from '@prsystem/api/reporting-worker';
import { createPoliceMatcherRuntime } from '@prsystem/api/police-worker';
import type { PoliceMatcherRuntime } from '@prsystem/api/police-worker';
import { createSettlementWorkerRuntime } from '@prsystem/api/settlement-worker';
import type { SettlementWorkerRuntime } from '@prsystem/api/settlement-worker';
import { QUEUE_NAMES, connectionFromUrl, workerOptions } from './queues';
import { startOnboardingConsumers } from './jobs/onboarding';
import type { OnboardingConsumers } from './jobs/onboarding';
import { startReportingConsumers } from './jobs/reporting';
import type { ReportingConsumers } from './jobs/reporting';
import { startPoliceConsumers } from './jobs/police';
import type { PoliceConsumers } from './jobs/police';
import { startSettlementConsumers } from './jobs/settlement';
import type { SettlementConsumers } from './jobs/settlement';
import { startWorker } from './startup';

async function main(): Promise<void> {
  const config = workerEnv();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: `${config.OTEL_SERVICE_NAME}-worker`,
  });
  let onboarding: OnboardingConsumers | undefined;
  let reporting: ReportingConsumers | undefined;
  let police: PoliceConsumers | undefined;
  let settlement: SettlementConsumers | undefined;

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
    // Phase 20. The selection the environment already validated, applied
    // again here so a refused adapter is refused before Redis is contacted;
    // the one line that records which ran carries no endpoint and no credential.
    verifyAdapters: () => {
      logger.info(
        { adapters: selectAdapters(config.adapters).describe() },
        'external adapters selected',
      );
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
    adapters: config.adapters,
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

  // The Phase 17 sweeps: the queued exports, the files whose hour has passed
  // and the stays past their retention deadline. Opened after the Phase 05
  // consumers and closed before them, with the same all-or-nothing rule — a
  // failure here closes what it opened, then everything above it.
  const reportingRuntime: ReportingWorkerRuntime = createReportingWorkerRuntime({
    databaseUrl: config.DATABASE_URL,
    appEnv: config.APP_ENV,
    adapters: config.adapters,
  });
  try {
    reporting = await startReportingConsumers({
      connection: connectionFromUrl(config.REDIS_URL),
      runtime: reportingRuntime,
      logger,
      options: { ...(config.QUEUE_PREFIX === undefined ? {} : { prefix: config.QUEUE_PREFIX }) },
    });
  } catch (error) {
    await onboarding.close();
    await started.close();
    throw error;
  }

  // Phase 18. The matcher runs on the worker's own login and holds no
  // privilege on any Police table — what it may do is call one function.
  const policeRuntime: PoliceMatcherRuntime = createPoliceMatcherRuntime({
    databaseUrl: config.DATABASE_URL,
  });
  try {
    police = await startPoliceConsumers({
      connection: connectionFromUrl(config.REDIS_URL),
      runtime: policeRuntime,
      logger,
      options: { ...(config.QUEUE_PREFIX === undefined ? {} : { prefix: config.QUEUE_PREFIX }) },
    });
  } catch (error) {
    await reporting.close();
    await onboarding.close();
    await started.close();
    throw error;
  }

  // Phase 20. The two provider jobs Phase 14 built, on the worker's own login
  // and the environment's adapters; a sweep whose adapter is disabled by its
  // gate is not scheduled, and the consumer says so once at startup.
  const settlementRuntime: SettlementWorkerRuntime = createSettlementWorkerRuntime({
    databaseUrl: config.DATABASE_URL,
    adapters: config.adapters,
  });
  try {
    settlement = await startSettlementConsumers({
      connection: connectionFromUrl(config.REDIS_URL),
      runtime: settlementRuntime,
      logger,
      options: { ...(config.QUEUE_PREFIX === undefined ? {} : { prefix: config.QUEUE_PREFIX }) },
    });
  } catch (error) {
    await police.close();
    await reporting.close();
    await onboarding.close();
    await started.close();
    throw error;
  }

  logger.info(
    { queues: Object.values(QUEUE_NAMES), settlementSweeps: settlement.scheduled },
    'worker started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await settlement?.close();
    await police?.close();
    await reporting?.close();
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
