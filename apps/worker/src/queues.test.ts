import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, connectionFromUrl, workerOptions } from './queues';

describe('connectionFromUrl', () => {
  it('parses host and port from a redis URL', () => {
    const connection = connectionFromUrl('redis://cache.internal:6380') as Record<string, unknown>;

    expect(connection.host).toBe('cache.internal');
    expect(connection.port).toBe(6380);
  });

  it('defaults to port 6379 when the URL omits it', () => {
    const connection = connectionFromUrl('redis://localhost') as Record<string, unknown>;
    expect(connection.port).toBe(6379);
  });

  it('carries credentials when the URL supplies them', () => {
    const connection = connectionFromUrl('redis://user:pass@localhost:6379') as Record<
      string,
      unknown
    >;

    expect(connection.username).toBe('user');
    expect(connection.password).toBe('pass');
  });

  it('omits credential keys entirely when the URL has none', () => {
    const connection = connectionFromUrl('redis://localhost:6379') as Record<string, unknown>;

    expect('username' in connection).toBe(false);
    expect('password' in connection).toBe(false);
  });

  it('sets maxRetriesPerRequest to null as BullMQ requires', () => {
    const connection = connectionFromUrl('redis://localhost:6379') as Record<string, unknown>;
    expect(connection.maxRetriesPerRequest).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(() => connectionFromUrl('not-a-url')).toThrow();
  });
});

describe('workerOptions', () => {
  it('applies the requested concurrency', () => {
    const options = workerOptions(connectionFromUrl('redis://localhost'), {
      concurrency: 4,
      attempts: 3,
    });

    expect(options.concurrency).toBe(4);
    expect(options.connection).toBeDefined();
  });
});

describe('QUEUE_NAMES', () => {
  it('registers the kernel queues, the four Phase 05 operations and the three Phase 17 sweeps', () => {
    // An exact list, not a subset: a queue that appears without being declared
    // here is a background operation nobody reviewed.
    expect(Object.values(QUEUE_NAMES)).toEqual([
      'system.heartbeat',
      'kernel.outbox.relay',
      'kernel.audit.partition_maintenance',
      'onboarding.provisioning',
      'subscription.upgrade.boundary',
      'onboarding.activation.delivery',
      'subscription.ebarimt.issuance',
      'reporting.export.run',
      'reporting.export.expiry',
      'reporting.retention.purge',
    ]);
  });

  it('namespaces every queue name', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });
});
