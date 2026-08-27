import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { syntheticIdentity } from '@prsystem/testing';
import { redact } from '@prsystem/telemetry';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import type { TenantContext } from '../tenant-context';
import { withTenantTransaction } from '../unit-of-work';
import { recordPlatformAudit } from '../kernel/audit';
import { appendOutboxEvent } from '../kernel/outbox';
import { registerProviderEvent } from '../kernel/inbox';

/**
 * Kernel GATE-SEC — planted canaries must not survive into any durable record
 * (CLAUDE.md §8, ADR-0020 §9).
 *
 * Every canary is synthetic: the registration number comes from the reserved `99`
 * range and the key material is a test fixture. No real identifier or credential
 * exists anywhere in this suite.
 */

const HOTEL = '55555555-5555-4555-8555-555555555555';

const CANARIES = {
  registrationNumber: syntheticIdentity(1).registrationNumber,
  sessionToken: 'canary-session-token-0001',
  providerSecret: 'canary-provider-secret-0001',
  keyMaterial: 'canary-key-material-0001',
} as const;

let env: ProvisionedDatabase;
let pool: Pool;
let apiPool: Pool;

function ctx(): TenantContext {
  return {
    hotelId: HOTEL,
    realm: 'hotel',
    actorRef: 'actor-synthetic-leak',
    correlationId: 'corr-leak-1',
  };
}

beforeAll(async () => {
  env = await provisionKernelDatabase('kernel_leak');
  pool = env.admin;
  apiPool = env.api;
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('the canaries are what they claim to be', () => {
  it('uses a synthetic registration number from the reserved range', () => {
    expect(CANARIES.registrationNumber).toMatch(/^99/);
  });
});

describe('durable records reject a planted canary', () => {
  it('refuses an outbox payload carrying an identifier field', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(), (uow) =>
        appendOutboxEvent(uow, {
          aggregateType: 'kernel_probe',
          aggregateId: 'leak-1',
          eventType: 'kernel.probe.created',
          payload: { registrationNumber: CANARIES.registrationNumber },
        }),
      ),
    ).rejects.toThrow(/outbox_payload_sanitised/);
  });

  it('refuses an outbox payload carrying a token or secret field', async () => {
    for (const payload of [
      { token: CANARIES.sessionToken },
      { secret: CANARIES.providerSecret },
      { apiKey: CANARIES.keyMaterial },
    ]) {
      await expect(
        withTenantTransaction(apiPool, ctx(), (uow) =>
          appendOutboxEvent(uow, {
            aggregateType: 'kernel_probe',
            aggregateId: 'leak-2',
            eventType: 'kernel.probe.created',
            payload,
          }),
        ),
      ).rejects.toThrow(/outbox_payload_sanitised/);
    }
  });

  it('refuses an audit payload carrying a canary field', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(), (uow) =>
        recordPlatformAudit(uow, {
          action: 'kernel.leak',
          outcome: 'allowed',
          payload: { passportNumber: CANARIES.registrationNumber },
        }),
      ),
    ).rejects.toThrow(/denied field/i);
  });

  it('refuses an audit payload hiding a canary in a nested object', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(), (uow) =>
        recordPlatformAudit(uow, {
          action: 'kernel.leak.nested',
          outcome: 'allowed',
          payload: { guest: { identity: { registrationNumber: CANARIES.registrationNumber } } },
        }),
      ),
    ).rejects.toThrow(/denied field/i);
  });

  it('refuses provider metadata carrying a canary field', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(), (uow) =>
        registerProviderEvent(uow, {
          provider: 'qpay',
          providerEventId: 'evt-leak-1',
          eventKind: 'payment.succeeded',
          rawPayload: `{"secret":"${CANARIES.providerSecret}"}`,
          metadata: { signature: CANARIES.providerSecret },
        }),
      ),
    ).rejects.toThrow(/provider_event_metadata_sanitised/);
  });

  it('stores only a digest of a provider body, never the body', async () => {
    const rawPayload = `{"reference":"REF-9","secret":"${CANARIES.providerSecret}"}`;

    await withTenantTransaction(apiPool, ctx(), (uow) =>
      registerProviderEvent(uow, {
        provider: 'qpay',
        providerEventId: 'evt-leak-2',
        eventKind: 'payment.succeeded',
        rawPayload,
        metadata: { reference: 'REF-9' },
      }),
    );

    const stored = await pool.query<{ row: string }>(
      `SELECT row_to_json(p)::text AS row FROM platform.provider_event p
        WHERE provider_event_id = 'evt-leak-2'`,
    );
    expect(stored.rows[0]?.row).not.toContain(CANARIES.providerSecret);
    expect(stored.rows[0]?.row).toMatch(/[0-9a-f]{64}/);
  });
});

describe('no canary reaches the whole database', () => {
  it('finds no planted value in any kernel table', async () => {
    // Sweep every text-bearing kernel column rather than the ones the tests
    // happened to touch: a leak that only appears in a column nobody thought to
    // check is exactly the one worth catching.
    const tables = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema IN ('platform', 'audit', 'police_audit')
          AND table_name NOT LIKE '%\\_20%'`,
    );

    for (const table of tables.rows) {
      const qualified = `${table.table_schema}.${table.table_name}`;
      for (const canary of Object.values(CANARIES)) {
        const found = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${qualified} t
            WHERE row_to_json(t)::text LIKE '%' || $1 || '%'`,
          [canary],
        );
        expect({ table: qualified, canaryRows: found.rows[0]?.count }).toEqual({
          table: qualified,
          canaryRows: '0',
        });
      }
    }
  });
});

describe('logs redact a planted canary', () => {
  it('redacts every canary field name before it can be written', () => {
    const redacted = JSON.stringify(
      redact({
        registrationNumber: CANARIES.registrationNumber,
        token: CANARIES.sessionToken,
        secret: CANARIES.providerSecret,
        nested: { apiKey: CANARIES.keyMaterial },
      }),
    );

    for (const canary of Object.values(CANARIES)) {
      expect(redacted).not.toContain(canary);
    }
  });

  it('redacts a registration number hiding in an innocuous field', () => {
    const redacted = JSON.stringify(redact({ note: CANARIES.registrationNumber }));
    expect(redacted).not.toContain(CANARIES.registrationNumber);
  });
});
