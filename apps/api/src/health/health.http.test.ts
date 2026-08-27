import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@prsystem/config';
import { CORRELATION_HEADER } from '@prsystem/telemetry';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Boots the real Nest + Fastify application on an ephemeral port and exercises it
 * over HTTP. This is the Phase 02 "API health E2E" gate.
 *
 * The readiness endpoint is intentionally not asserted here: its verdict depends on
 * whether Postgres and Redis happen to be running, which would make the test
 * environment-dependent. Readiness logic is covered deterministically in
 * readiness.service.test.ts, and the live-dependency check is a separate compose gate.
 */

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://prsystem_api:local@127.0.0.1:59999/prsystem',
    REDIS_URL: 'redis://127.0.0.1:59998',
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_BUCKET: 'prsystem-local',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();

  const { createApp } = await import('../bootstrap');
  const started = await createApp({ port: 0 });
  app = started.app;
  baseUrl = `http://127.0.0.1:${started.port}`;
}, 30000);

afterAll(async () => {
  await app?.close();
  resetEnvCache();
});

describe('GET /health/live', () => {
  it('returns 200 with a liveness report', async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('echoes a correlation id on every response', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.headers.get(CORRELATION_HEADER)).toBeTruthy();
  });
});

describe('GET /health/ready', () => {
  it('responds with a readiness report and a 200 or 503 status', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect([200, 503]).toContain(response.status);
    const body = (await response.json()) as { status: string; checks: Array<{ name: string }> };
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.checks.map((c) => c.name).sort()).toEqual(['postgres', 'redis']);
  }, 20000);

  it('never leaks a connection string in the report', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const raw = await response.text();

    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('redis://');
    expect(raw).not.toContain('test-secret-key');
  }, 20000);
});

describe('GET /docs', () => {
  it('serves the OpenAPI JSON document', async () => {
    const response = await fetch(`${baseUrl}/docs-json`);

    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toContain('/health/live');
    expect(Object.keys(doc.paths)).toContain('/health/ready');
  });
});
