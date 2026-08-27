import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { createLogger } from '@prsystem/telemetry';
import { env } from '@prsystem/config';
import { API_PREFIX, UNVERSIONED_PATHS } from '@prsystem/contracts';
import { AppModule } from './app.module';
import { registerCorrelation } from './observability/correlation.plugin';
import { ApiErrorFilter } from './observability/api-error.filter';
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

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Nest's own bootstrap logging is suppressed; the redacting logger is authoritative.
    logger: false,
  });

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
