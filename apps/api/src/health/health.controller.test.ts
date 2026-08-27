import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import type { DependencyProbe, DependencyProbeResult } from './health.types';
import type { FastifyReply } from 'fastify';

function probe(name: string, ok: boolean): DependencyProbe {
  return { name, check: async (): Promise<DependencyProbeResult> => ({ name, ok, durationMs: 1 }) };
}

function fakeReply(): { reply: FastifyReply; status: ReturnType<typeof vi.fn> } {
  const status = vi.fn();
  return { reply: { status } as unknown as FastifyReply, status };
}

describe('HealthController', () => {
  it('liveness reports ok with an uptime and performs no dependency check', () => {
    const controller = new HealthController(new ReadinessService([probe('postgres', false)]));

    const result = controller.live();

    expect(result.status).toBe('ok');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('readiness returns 200 when all dependencies are reachable', async () => {
    const controller = new HealthController(
      new ReadinessService([probe('postgres', true), probe('redis', true)]),
    );
    const { reply, status } = fakeReply();

    const report = await controller.ready(reply);

    expect(status).toHaveBeenCalledWith(200);
    expect(report.status).toBe('ok');
  });

  it('readiness returns 503 when a dependency is unreachable', async () => {
    const controller = new HealthController(
      new ReadinessService([probe('postgres', true), probe('redis', false)]),
    );
    const { reply, status } = fakeReply();

    const report = await controller.ready(reply);

    expect(status).toHaveBeenCalledWith(503);
    expect(report.status).toBe('degraded');
  });
});
