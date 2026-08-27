import type { FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  newRequestId,
  runWithCorrelation,
  sanitiseRequestId,
} from '@prsystem/telemetry';

/**
 * Binds a correlation context to every request and echoes the id back to the caller
 * (docs/architecture/13-telemetry-and-redaction.md §2).
 *
 * An inbound id is accepted only when it is a plausible opaque token; anything else
 * is replaced with a freshly generated one, so a client cannot inject arbitrary text
 * into log output.
 */
export function registerCorrelation(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const inbound = sanitiseRequestId(request.headers[CORRELATION_HEADER]);
    const requestId = inbound ?? newRequestId();

    reply.header(CORRELATION_HEADER, requestId);
    runWithCorrelation({ requestId }, done);
  });
}
