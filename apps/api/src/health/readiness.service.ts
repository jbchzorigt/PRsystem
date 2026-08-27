import { Injectable } from '@nestjs/common';
import type { DependencyProbe, ReadinessReport } from './health.types';

export const DEPENDENCY_PROBES = Symbol('DEPENDENCY_PROBES');

/**
 * Aggregates dependency probes into a readiness verdict.
 *
 * Fails closed: any probe that fails, throws or is missing makes the service
 * not-ready. Probes are injected so readiness logic is testable without a live
 * database or cache.
 */
@Injectable()
export class ReadinessService {
  constructor(private readonly probes: readonly DependencyProbe[]) {}

  async check(): Promise<ReadinessReport> {
    const checks = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          return await probe.check();
        } catch (error) {
          return {
            name: probe.name,
            ok: false,
            durationMs: 0,
            detail: error instanceof Error ? error.name : 'probe threw',
          };
        }
      }),
    );

    return {
      status: checks.every((check) => check.ok) ? 'ok' : 'degraded',
      checks,
    };
  }
}
