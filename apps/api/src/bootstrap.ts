import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { createLogger } from '@prsystem/telemetry';
import { apiEnv } from '@prsystem/config';
import { Pool } from 'pg';
import { API_PREFIX, UNVERSIONED_PATHS } from '@prsystem/contracts';
import { selectKeyManagement } from '@prsystem/ports';
import { AppModule } from './app.module';
import { DatabaseSubscriptionState } from './modules/onboarding/contracts/subscription-state.adapter';
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
  const config = apiEnv();
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

  // The subscription-state adapter's own pool. Small: it serves one short read
  // per authorization check, and giving it its own handle keeps an entitlement
  // lookup from queueing behind a long-running command.
  const subscriptionPool = new Pool({ connectionString: config.DATABASE_URL, max: 4 });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      scheduler: config.scheduler,
      iam: {
        config: {
          databaseUrl: config.DATABASE_URL,
          appEnv: config.APP_ENV,
          kmsAdapter: config.KMS_ADAPTER,
          ...(config.KMS_SEED === undefined ? {} : { kmsSeed: config.KMS_SEED }),
        },
        // Phase 05's authoritative source, replacing the Phase 04 port that
        // answered nothing. It reads `platform.hotel_subscription` at request
        // time under the hotel's own scope — the authoritative row, never a
        // projection (ADR-0019 §4, `OPS-DEC-016`) — and still answers
        // `undefined` for a hotel with no subscription, so the pipeline goes on
        // failing closed for a tenant that was never provisioned.
        subscription: new DatabaseSubscriptionState(subscriptionPool),
      },
      onboarding: {
        config: {
          databaseUrl: config.DATABASE_URL,
          appEnv: config.APP_ENV,
          kmsAdapter: config.KMS_ADAPTER,
          ...(config.KMS_SEED === undefined ? {} : { kmsSeed: config.KMS_SEED }),
          // The provisioning signal (R3). Best-effort by contract: a Redis
          // that is down costs the worker a sweep interval, never a payment.
          redisUrl: config.REDIS_URL,
          ...(config.QUEUE_PREFIX === undefined ? {} : { queuePrefix: config.QUEUE_PREFIX }),
        },
      },
      catalog: { config: { databaseUrl: config.DATABASE_URL } },
      ownedPools: [subscriptionPool],
    }),
    new FastifyAdapter(),
    // Nest's own bootstrap logging is suppressed; the redacting logger is authoritative.
    { logger: false },
  );

  // Everything from here on happens with the application — and therefore the
  // privileged scheduler pool — already alive. A failure in any of it used to
  // propagate with nothing closing either: correlation setup, the OpenAPI
  // document and `app.listen()` all ran outside any cleanup, so an ordinary
  // `EADDRINUSE` on a deploy left a process that had not started still holding a
  // scheduler connection.
  try {
    // D-09. The scheduler pool the *application* owns is the one validated here
    // — not a throwaway opened and closed during startup, which would verify a
    // credential and then leave nothing holding it. Still before `listen`, so a
    // wrong credential means no port is ever bound.
    if (config.scheduler.enabled) {
      const schedulerPool = app.get<Pool | undefined>(SCHEDULER_POOL, { strict: false });
      if (schedulerPool === undefined) {
        throw new Error('the scheduler capability is enabled but no pool was registered');
      }
      await assertSchedulerConnectionPrincipal(schedulerPool, logger);
    }

    registerCorrelation(app.getHttpAdapter().getInstance());

    // Every API route is versioned. Health and the OpenAPI document are
    // operational surfaces rather than API contract, so they stay unversioned
    // and stable.
    app.setGlobalPrefix(API_PREFIX, {
      exclude: UNVERSIONED_PATHS.map((path) => ({ path, method: RequestMethod.ALL })),
    });
    app.useGlobalFilters(new ApiErrorFilter());

    if (options.serveDocs ?? true) {
      // Only the machine-readable document is served. The Swagger UI bundle
      // would pull @fastify/static and expose a browsable console on the API
      // deployment; neither is required by Phase 02.
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
  } catch (error) {
    // Nest owns the scheduler pool, so closing the application is what closes
    // it. A failure here is reported as itself: swallowing the original error in
    // favour of a shutdown error would send an operator looking in the wrong
    // place, so a cleanup failure is deliberately discarded.
    await app.close().catch(() => undefined);
    throw error;
  }
}
