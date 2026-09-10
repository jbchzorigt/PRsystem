import type { FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  newRequestId,
  runWithCorrelation,
  sanitiseRequestId,
} from '@prsystem/telemetry';
import type { Logger } from '@prsystem/telemetry';

/**
 * Binds a correlation context to every request and echoes the id back to the caller
 * (docs/architecture/13-telemetry-and-redaction.md §2).
 *
 * An inbound id is accepted only when it is a plausible opaque token; anything else
 * is replaced with a freshly generated one, so a client cannot inject arbitrary text
 * into log output.
 *
 * When a logger is given, every completed request leaves one line under its
 * correlation id: method, path (never the query string — a search term is a
 * person's), status and duration. That line is what an operator reads first and
 * what the leakage scan reads last (Phase 22, `A-P22-5`).
 */
export function registerCorrelation(app: FastifyInstance, logger?: Logger): void {
  app.addHook('onRequest', (request, reply, done) => {
    const inbound = sanitiseRequestId(request.headers[CORRELATION_HEADER]);
    const requestId = inbound ?? newRequestId();

    reply.header(CORRELATION_HEADER, requestId);
    runWithCorrelation({ requestId }, done);
  });
  if (logger !== undefined) {
    app.addHook('onResponse', (request, reply, done) => {
      logger.info(
        {
          method: request.method,
          path: request.url.split('?')[0],
          statusCode: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime * 10) / 10,
        },
        'request completed',
      );
      done();
    });
  }
}
