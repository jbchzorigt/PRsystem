import { createApp } from './bootstrap';
import { createLogger } from '@prsystem/telemetry';
import { env } from '@prsystem/config';

async function main(): Promise<void> {
  const { app } = await createApp();

  const shutdown = async (signal: string): Promise<void> => {
    const logger = createLogger({
      level: env().LOG_LEVEL,
      serviceName: env().OTEL_SERVICE_NAME,
    });
    logger.info({ signal }, 'api shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error', serviceName: 'prsystem-api' });
  logger.error(
    { err: error instanceof Error ? error : new Error(String(error)) },
    'api failed to start',
  );
  process.exitCode = 1;
});
