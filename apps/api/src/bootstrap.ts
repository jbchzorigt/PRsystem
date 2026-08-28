import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { createLogger } from '@prsystem/telemetry';
import { env } from '@prsystem/config';
import { Pool } from 'pg';
import { API_PREFIX, UNVERSIONED_PATHS } from '@prsystem/contracts';
import { selectKeyManagement } from '@prsystem/ports';
import { AppModule } from './app.module';
import { registerCorrelation } from './observability/correlation.plugin';
import { ApiErrorFilter } from './observability/api-error.filter';
import { assertApiConnectionPrincipal } from './observability/connection-guard';
import { assertSchedulerConnectionPrincipal } from './security/scheduler-guard';
import { SCHEDULER_POOL } from './maintenance/maintenance.module';
import { OPENAPI_PATH, buildOpenApiDocument } from './openapi-document';

export interface BootstrapOptions {
  /** Override the listen port. `0` binds an ephemeral port, which tests rely on. */
  readonly port?: number;
  readonly serveDocs?: boolean;
}

export async function createApp(
  options: BootstrapOptions = {},
): Promise<{ app: NestFastifyApplication; port: number }> {
  const config = env();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: config.OTEL_SERVICE_NAME });

  // Security preconditions run before anything is constructed and long before a
  // port is bound. A process that cannot prove its identity, or that has no key
  // management, must never reach the point of accepting a request.
  const guardPool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    await assertApiConnectionPrincipal(guardPool, logger);
    // Throws when the adapter is `none`, when a production build asks for the
    // local simulator, or when the configuration is missing or unknown.
    selectKeyManagement({
      appEnv: config.APP_ENV,
      kmsAdapter: config.KMS_ADAPTER,
      ...(config.KMS_SEED === undefined ? {} : { seed: config.KMS_SEED }),
    });
  } finally {
    // Released whether the guard passed or threw: a refused startup must not
    // leave a connection behind.
    await guardPool.end();
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Nest's own bootstrap logging is suppressed; the redacting logger is authoritative.
    logger: false,
  });

  // D-09. The scheduler pool the *application* owns is the one validated here —
  // not a throwaway opened and closed during startup, which would verify a
  // credential and then leave nothing holding it. Still before `listen`, so a
  // wrong credential means no port is ever bound.
  const schedulerPool = app.get<Pool | undefined>(SCHEDULER_POOL, { strict: false });
  if (schedulerPool !== undefined) {
    try {
      await assertSchedulerConnectionPrincipal(schedulerPool, logger);
    } catch (error) {
      // Nest owns the pool now, so shutting the application down is what closes
      // it. Doing that here keeps a refused startup from leaking connections.
      await app.close();
      throw error;
    }
  }

  registerCorrelation(app.getHttpAdapter().getInstance());

  // Every API route is versioned. Health and the OpenAPI document are operational
  // surfaces rather than API contract, so they stay unversioned and stable.
  app.setGlobalPrefix(API_PREFIX, {
    exclude: UNVERSIONED_PATHS.map((path) => ({ path, method: RequestMethod.ALL })),
  });
  app.useGlobalFilters(new ApiErrorFilter());

  if (options.serveDocs ?? true) {
    // Only the machine-readable document is served. The Swagger UI bundle would
    // pull @fastify/static and expose a browsable console on the API deployment;
    // neither is required by Phase 02.
    SwaggerModule.setup(OPENAPI_PATH, app, buildOpenApiDocument(app), {
      swaggerUiEnabled: false,
      jsonDocumentUrl: `${OPENAPI_PATH}-json`,
    });
  }

  app.enableShutdownHooks();

  const port = options.port ?? config.API_PORT;
  await app.listen({ port, host: config.API_HOST });

  const address = app.getHttpServer().address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  logger.info({ port: boundPort, env: config.APP_ENV }, 'api started');

  return { app, port: boundPort };
}
