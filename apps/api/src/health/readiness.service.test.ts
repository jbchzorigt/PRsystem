import { describe, expect, it } from 'vitest';
import { ReadinessService } from './readiness.service';
import type { DependencyProbe, DependencyProbeResult } from './health.types';

function probe(name: string, ok: boolean): DependencyProbe {
  return {
    name,
    check: async (): Promise<DependencyProbeResult> => ({ name, ok, durationMs: 1 }),
  };
}

function throwingProbe(name: string): DependencyProbe {
  return {
    name,
    check: (): Promise<DependencyProbeResult> => Promise.reject(new TypeError('connection lost')),
  };
}

describe('ReadinessService', () => {
  it('reports ok when every probe succeeds', async () => {
    const report = await new ReadinessService([
      probe('postgres', true),
      probe('redis', true),
    ]).check();

    expect(report.status).toBe('ok');
    expect(report.checks).toHaveLength(2);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails closed when any single probe fails', async () => {
    const report = await new ReadinessService([
      probe('postgres', true),
      probe('redis', false),
    ]).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.find((c) => c.name === 'redis')?.ok).toBe(false);
  });

  it('fails closed when a probe throws rather than returning', async () => {
    const report = await new ReadinessService([throwingProbe('postgres')]).check();

    expect(report.status).toBe('degraded');
    expect(report.checks[0]!.ok).toBe(false);
  });

  it('reports only an error name, never a connection detail', async () => {
    const report = await new ReadinessService([throwingProbe('postgres')]).check();

    const detail = report.checks[0]!.detail ?? '';
    expect(detail).toBe('TypeError');
    expect(detail).not.toContain('connection lost');
  });

  it('reports every probe, not just the first failure', async () => {
    const report = await new ReadinessService([
      probe('a', false),
      probe('b', false),
      probe('c', true),
    ]).check();

    expect(report.checks).toHaveLength(3);
    expect(report.checks.filter((c) => !c.ok)).toHaveLength(2);
  });

  it('treats an empty probe list as ok', async () => {
    const report = await new ReadinessService([]).check();
    expect(report.status).toBe('ok');
  });
});
