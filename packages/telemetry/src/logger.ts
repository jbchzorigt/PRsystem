import pino, { type Logger, type LoggerOptions } from 'pino';
import { currentCorrelation } from './correlation';
import { redact } from './redaction';

export type { Logger };

export interface LoggerConfig {
  readonly level: string;
  readonly serviceName: string;
  readonly pretty?: boolean;
  /** Test seam: pino destination stream. */
  readonly destination?: pino.DestinationStream;
}

/**
 * Structured logger with mandatory redaction.
 *
 * The redacting formatter is applied to every log object, so a forbidden value cannot
 * be emitted even if a call site passes it explicitly
 * (docs/architecture/13-telemetry-and-redaction.md §5).
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: config.serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const correlation = currentCorrelation();
        const redacted = redact(object) as Record<string, unknown>;
        return correlation
          ? {
              ...redacted,
              requestId: correlation.requestId,
              ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
              ...(correlation.realm ? { realm: correlation.realm } : {}),
              ...(correlation.actorId ? { actorId: correlation.actorId } : {}),
            }
          : redacted;
      },
    },
  };

  return config.destination ? pino(options, config.destination) : pino(options);
}
