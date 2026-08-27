import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { runWithCorrelation } from './correlation';
import { REDACTED } from './redaction';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', serviceName: 'test-service', destination });
  return {
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('emits structured JSON with the service name and ISO timestamp', () => {
    const { logger, records } = captureLogger();
    logger.info({ stayId: 'stay-1' }, 'checked in');

    const [record] = records();
    expect(record).toBeDefined();
    expect(record!.service).toBe('test-service');
    expect(record!.msg).toBe('checked in');
    expect(record!.stayId).toBe('stay-1');
    expect(typeof record!.time).toBe('string');
  });

  it('redacts a denied field even when the call site passes it explicitly', () => {
    const { logger, records } = captureLogger();
    logger.info({ password: 'hunter2', registrationNumber: '8801154321' }, 'attempt');

    const [record] = records();
    expect(record!.password).toBe(REDACTED);
    expect(record!.registrationNumber).toBe(REDACTED);
  });

  it('redacts a sensitive value shape hidden in an innocuous field', () => {
    const { logger, records } = captureLogger();
    logger.info({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4' }, 'note');

    expect(records()[0]!.note).toBe(REDACTED);
  });

  it('attaches the correlation context when one is bound', () => {
    const { logger, records } = captureLogger();
    runWithCorrelation({ requestId: 'req-123', realm: 'hotel' }, () => {
      logger.info('scoped');
    });

    const [record] = records();
    expect(record!.requestId).toBe('req-123');
    expect(record!.realm).toBe('hotel');
  });

  it('omits correlation fields outside a request scope', () => {
    const { logger, records } = captureLogger();
    logger.info('unscoped');
    expect(records()[0]!.requestId).toBeUndefined();
  });

  it('honours the configured level', () => {
    const { logger, records } = captureLogger();
    logger.debug('should not appear');
    expect(records()).toHaveLength(0);
  });
});
