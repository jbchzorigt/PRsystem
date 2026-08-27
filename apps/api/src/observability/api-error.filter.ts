import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiError, errorEnvelope, httpStatusForErrorCode } from '@prsystem/contracts';
import type { ErrorCode } from '@prsystem/contracts';
import { currentCorrelationId } from '@prsystem/telemetry';

/**
 * Translates every failure into the canonical error envelope.
 *
 * An unexpected error becomes a bare `INTERNAL_ERROR`: the message, the stack and
 * any value it closed over stay server-side, because an exception message is one
 * of the easiest places for a connection string or a provider payload to escape
 * (CLAUDE.md §8).
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = currentCorrelationId() ?? 'unknown';

    if (exception instanceof ApiError) {
      void reply.status(exception.status).send(errorEnvelope(exception, correlationId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR';
      void reply
        .status(httpStatusForErrorCode(code))
        .send(errorEnvelope(new ApiError(code, exception.message), correlationId));
      return;
    }

    void reply
      .status(500)
      .send(errorEnvelope(new ApiError('INTERNAL_ERROR', 'internal error'), correlationId));
  }
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  429: 'RATE_LIMITED',
  503: 'DEPENDENCY_UNAVAILABLE',
};
