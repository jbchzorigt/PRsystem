import { Pool } from 'pg';
import Redis from 'ioredis';
import type { DependencyProbe, DependencyProbeResult } from './health.types';

const PROBE_TIMEOUT_MS = 2000;

async function timed(
  name: string,
  operation: () => Promise<unknown>,
): Promise<DependencyProbeResult> {
  const startedAt = Date.now();
  try {
    await operation();
    return { name, ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    // The detail carries an error name only — never a URL, host or credential.
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.name : 'unknown error',
    };
  }
}

/**
 * Probes PostgreSQL reachability with a trivial query. Creates no schema.
 *
 * The client is built on the first probe, not at construction, so an unreachable
 * or unconfigured dependency surfaces as a not-ready report instead of aborting
 * process start or OpenAPI document generation.
 */
export class PostgresProbe implements DependencyProbe {
  readonly name = 'postgres';

  private pool: Pool | undefined;

  constructor(private readonly create: () => Pool) {}

  static fromUrl(connectionString: string): PostgresProbe {
    return PostgresProbe.deferred(() => connectionString);
  }

  static deferred(connectionString: () => string): PostgresProbe {
    return new PostgresProbe(
      () =>
        new Pool({
          connectionString: connectionString(),
          max: 1,
          connectionTimeoutMillis: PROBE_TIMEOUT_MS,
          idleTimeoutMillis: PROBE_TIMEOUT_MS,
        }),
    );
  }

  check(): Promise<DependencyProbeResult> {
    return timed(this.name, () => {
      this.pool ??= this.create();
      return this.pool.query('SELECT 1');
    });
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}

/** Probes Redis reachability with PING. */
export class RedisProbe implements DependencyProbe {
  readonly name = 'redis';

  private client: Redis | undefined;

  constructor(private readonly create: () => Redis) {}

  static fromUrl(url: string): RedisProbe {
    return RedisProbe.deferred(() => url);
  }

  static deferred(url: () => string): RedisProbe {
    return new RedisProbe(
      () =>
        new Redis(url(), {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: PROBE_TIMEOUT_MS,
          enableOfflineQueue: false,
          retryStrategy: () => null,
        }),
    );
  }

  check(): Promise<DependencyProbeResult> {
    return timed(this.name, async () => {
      const client = (this.client ??= this.create());
      if (client.status !== 'ready') {
        await client.connect();
      }
      await client.ping();
    });
  }

  async close(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
  }
}
