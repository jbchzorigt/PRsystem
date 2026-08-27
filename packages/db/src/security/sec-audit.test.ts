import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { syntheticIdentity } from '@prsystem/testing';

/**
 * SEC-AUDIT — audit write security and append-only enforcement.
 *
 * The runtimes hold no privilege on an audit table. Everything they can do goes
 * through the SECURITY DEFINER wrapper, which derives identity from the
 * transaction context rather than trusting the caller.
 */

const HOTEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let env: ProvisionedDatabase;

/** Opens a transaction on a login pool with a full trusted context established. */
async function inContext<T>(
  pool: Pool,
  realm: string,
  run: (
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
  hotelId: string = HOTEL,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', realm]);
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', 'actor-sec-audit']);
    await client.query('SELECT set_config($1, $2, true)', ['app.correlation_id', 'corr-sec-audit']);
    return await run((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_audit');
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('runtime roles hold no direct audit privilege', () => {
  const statements: readonly [string, string][] = [
    ['SELECT', 'SELECT 1 FROM audit.platform_event'],
    [
      'INSERT',
      `INSERT INTO audit.platform_event (realm, action, outcome) VALUES ('hotel','x','allowed')`,
    ],
    ['UPDATE', `UPDATE audit.platform_event SET reason = 'x'`],
    ['DELETE', 'DELETE FROM audit.platform_event'],
    ['TRUNCATE', 'TRUNCATE audit.platform_event'],
  ];

  for (const [name, sql] of statements) {
    it(`refuses ${name} from the API login`, async () => {
      await inContext(env.api, 'hotel', async (query) => {
        await expect(query(sql)).rejects.toThrow(/permission denied/i);
      });
    });

    it(`refuses ${name} from the worker login`, async () => {
      await inContext(env.worker, 'hotel', async (query) => {
        await expect(query(sql)).rejects.toThrow(/permission denied/i);
      });
    });
  }

  it('refuses object creation in an audit schema', async () => {
    await inContext(env.api, 'hotel', async (query) => {
      await expect(query('CREATE TABLE audit.sneaky (id int)')).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it('refuses altering the append-only trigger', async () => {
    await inContext(env.api, 'hotel', async (query) => {
      await expect(
        query('ALTER TABLE audit.platform_event DISABLE TRIGGER platform_event_append_only'),
      ).rejects.toThrow(/must be owner|permission denied/i);
    });
  });

  it('leaves no audit object owned by a runtime role', async () => {
    const owned = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('audit', 'police_audit')
          AND pg_get_userbyid(c.relowner) IN
              ('prsystem_api','prsystem_worker','prsystem_police',
               'prsystem_audit_reader','prsystem_police_audit_reader')`,
    );
    expect(owned.rows[0]?.count).toBe('0');
  });
});

describe('the append wrapper derives identity from context', () => {
  it('records an event for a permitted runtime', async () => {
    const eventId = await inContext(env.api, 'hotel', async (query) => {
      const result = await query(
        `SELECT audit.append_platform_audit_event('kernel.probe', 'allowed') AS id`,
      );
      return result.rows[0]?.['id'];
    });
    expect(eventId).toBeDefined();
  });

  it('stamps the actor and realm from the transaction, not the caller', async () => {
    // Committed on purpose, so the dedicated reader can inspect what was stored.
    const client = await env.api.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      await client.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', 'actor-stamped']);
      await client.query(`SELECT audit.append_platform_audit_event('kernel.stamped', 'allowed')`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await env.auditReader.query<{
      actor_ref: string;
      realm: string;
      hotel_id: string;
    }>(
      `SELECT actor_ref, realm, hotel_id::text AS hotel_id
         FROM audit.platform_event WHERE action = 'kernel.stamped'`,
    );
    expect(rows.rows[0]).toEqual({ actor_ref: 'actor-stamped', realm: 'hotel', hotel_id: HOTEL });
  });

  it('refuses to record without an established context', async () => {
    const client = await env.api.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(`SELECT audit.append_platform_audit_event('kernel.unscoped', 'allowed')`),
      ).rejects.toThrow(/established transaction context/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('validates the outcome vocabulary', async () => {
    await inContext(env.api, 'hotel', async (query) => {
      await expect(
        query(`SELECT audit.append_platform_audit_event('kernel.bad', 'maybe')`),
      ).rejects.toThrow(/allowed, denied or failed/i);
    });
  });

  it('keeps the police login out of the platform stream entirely', async () => {
    await inContext(env.police, 'police', async (query) => {
      // Refused at the schema, before the realm check inside the function is
      // even reached — the isolation holds at two independent layers.
      await expect(
        query(`SELECT audit.append_platform_audit_event('police.leak', 'allowed')`),
      ).rejects.toThrow(/permission denied for schema audit/i);
    });
  });

  it('refuses a police-realm transaction on the platform stream', async () => {
    // The API login can reach the function, so this exercises the realm check
    // inside it rather than the schema grant.
    await inContext(env.api, 'police', async (query) => {
      await expect(
        query(`SELECT audit.append_platform_audit_event('police.leak', 'allowed')`),
      ).rejects.toThrow(/police realm must use/i);
    });
  });

  it('keeps a hotel-realm action out of the police stream', async () => {
    await inContext(env.police, 'hotel', async (query) => {
      await expect(
        query(`SELECT police_audit.append_police_security_event('hotel.leak', 'allowed')`),
      ).rejects.toThrow(/only the police realm/i);
    });
  });

  it('lets the police login write only its own stream', async () => {
    const id = await inContext(env.police, 'police', async (query) => {
      const result = await query(
        `SELECT police_audit.append_police_security_event('police.probe', 'allowed') AS id`,
      );
      return result.rows[0]?.['id'];
    });
    expect(id).toBeDefined();
  });

  it('denies the API login execute on the police append function', async () => {
    await inContext(env.api, 'hotel', async (query) => {
      await expect(
        query(`SELECT police_audit.append_police_security_event('x', 'allowed')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe('nested payload sanitisation', () => {
  const canary = syntheticIdentity(2).registrationNumber;

  const nested: readonly [string, string][] = [
    ['top-level secret', `'{"secret":"s"}'::jsonb`],
    ['nested object', `'{"guest":{"registrationNumber":"${canary}"}}'::jsonb`],
    ['deeply nested', `'{"a":{"b":{"c":{"passportNumber":"X1234567"}}}}'::jsonb`],
    ['inside an array', `'{"items":[{"ok":1},{"token":"t"}]}'::jsonb`],
    ['array of arrays', `'{"m":[[{"smsBody":"hello"}]]}'::jsonb`],
    ['snake case key', `'{"guest":{"registration_number":"${canary}"}}'::jsonb`],
    ['screaming case key', `'{"g":{"PASSPORT_NUMBER":"X1"}}'::jsonb`],
    ['hyphenated key', `'{"g":{"api-key":"k"}}'::jsonb`],
  ];

  for (const [label, payload] of nested) {
    it(`rejects a ${label} in an audit payload`, async () => {
      await inContext(env.api, 'hotel', async (query) => {
        await expect(
          query(
            `SELECT audit.append_platform_audit_event('kernel.leak', 'allowed', NULL, NULL, NULL, ${payload})`,
          ),
        ).rejects.toThrow(/denied field/i);
      });
    });

    it(`rejects a ${label} in an outbox payload`, async () => {
      await inContext(env.api, 'hotel', async (query) => {
        await expect(
          query(
            `INSERT INTO platform.outbox_event (hotel_id, aggregate_type, aggregate_id, event_type, payload)
             VALUES ($1, 'kernel_probe', 'leak', 'kernel.probe.created', ${payload})`,
            [HOTEL],
          ),
        ).rejects.toThrow(/outbox_payload_sanitised/);
      });
    });
  }

  it('accepts a payload whose nested keys are all benign', async () => {
    await inContext(env.api, 'hotel', async (query) => {
      const result = await query(
        `SELECT audit.append_platform_audit_event('kernel.clean', 'allowed', NULL, NULL, NULL,
           '{"stay":{"roomNumber":"203","amountMnt":"1000"},"items":[{"hotelId":"x"}]}'::jsonb) AS id`,
      );
      expect(result.rows[0]?.['id']).toBeDefined();
    });
  });
});

describe('reader isolation', () => {
  it('lets the platform reader read only the platform stream', async () => {
    await expect(
      env.auditReader.query('SELECT 1 FROM audit.platform_event'),
    ).resolves.toBeDefined();
    await expect(
      env.auditReader.query('SELECT 1 FROM police_audit.security_event'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets the police reader read only the police stream', async () => {
    await expect(
      env.policeAuditReader.query('SELECT 1 FROM police_audit.security_event'),
    ).resolves.toBeDefined();
    await expect(env.policeAuditReader.query('SELECT 1 FROM audit.platform_event')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('gives neither reader a write path', async () => {
    await expect(
      env.auditReader.query(
        `INSERT INTO audit.platform_event (realm, action, outcome) VALUES ('hotel','x','allowed')`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      env.auditReader.query(`SELECT audit.append_platform_audit_event('x', 'allowed')`),
    ).rejects.toThrow(/permission denied/i);
  });
});
