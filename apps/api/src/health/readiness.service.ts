import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
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
export class ReadinessService implements OnApplicationShutdown {
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

  /**
   * Closes every probe's client on shutdown.
   *
   * The probes connect lazily and would otherwise keep a pooled connection open
   * past `app.close()`, which surfaces as a stray connection error whenever the
   * database goes away first.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await probe.close?.();
        } catch {
          // Shutdown is best effort; a probe that cannot close is not a failure.
        }
      }),
    );
  }
}
