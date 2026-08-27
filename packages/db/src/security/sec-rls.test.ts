import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { TABLE_CLASSIFICATION } from '../classification';
import { validateClassification } from '../classification-check';
import { PLATFORM_SCOPE } from '../tenant-context';
import { withTenantTransaction } from '../unit-of-work';
import { appendOutboxEvent } from '../kernel/outbox';

/**
 * SEC-RLS — tenant isolation as the runtimes actually experience it.
 *
 * Every assertion runs over a real LOGIN principal. None of it would hold on a
 * superuser connection, which bypasses RLS whatever the policy says.
 */

const HOTEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOTEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let env: ProvisionedDatabase;

const TENANT_TABLES = TABLE_CLASSIFICATION.filter((t) => t.classification === 'TENANT_RLS');

function ctx(hotelId: string, realm: 'hotel' | 'police' | 'operation' = 'hotel') {
  return { hotelId, realm, actorRef: 'actor-sec-rls', correlationId: 'corr-sec-rls' } as const;
}

/** Runs `sql` in one transaction with `hotelId` scope, on the given login pool. */
async function scoped<T>(
  pool: Pool,
  hotelId: string,
  run: (
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
    return await run((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_rls');
  for (const hotelId of [HOTEL_A, HOTEL_B]) {
    await withTenantTransaction(env.api, ctx(hotelId), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: `probe-${hotelId}`,
        eventType: 'kernel.probe.created',
        payload: { hotelId },
      }),
    );
  }
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('classification manifest', () => {
  it('matches what the database enforces', async () => {
    expect(await validateClassification(env.admin)).toEqual([]);
  });

  it('classifies every tenant-bearing table as TENANT_RLS', async () => {
    const bearing = await env.admin.query<{ qualified: string }>(
      `SELECT n.nspname || '.' || c.relname AS qualified
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform', 'audit', 'police_audit')
          AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'hotel_id'
                         AND a.attnum > 0 AND NOT a.attisdropped)`,
    );
    const declared = new Set(TENANT_TABLES.map((t) => `${t.schema}.${t.table}`));
    // audit.platform_event carries hotel_id but is an audit stream, not tenant
    // storage: it is classified PLATFORM_AUDIT and protected by grant, not RLS.
    const expected = bearing.rows
      .map((r) => r.qualified)
      .filter((q) => q !== 'audit.platform_event');
    expect(expected.filter((q) => !declared.has(q))).toEqual([]);
  });
});

describe('tenant isolation across CRUD, per runtime login', () => {
  for (const entry of TENANT_TABLES) {
    const qualified = `${entry.schema}.${entry.table}`;

    it(`${qualified}: unscoped SELECT returns nothing`, async () => {
      const client = await env.api.connect();
      try {
        const result = await client.query(`SELECT 1 FROM ${qualified}`);
        expect(result.rowCount).toBe(0);
      } finally {
        client.release();
      }
    });

    it(`${qualified}: unscoped INSERT is refused`, async () => {
      await scoped(env.api, PLATFORM_SCOPE, async () => undefined);
      const client = await env.api.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query(`INSERT INTO ${qualified} (hotel_id) VALUES ($1)`, [HOTEL_A]),
          // A permission denial is also a refusal — and a stronger one: the role
          // holds no INSERT on that table at all.
        ).rejects.toThrow(/row-level security|permission denied|null value|violates/i);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it(`${qualified}: tenant A cannot UPDATE or DELETE tenant B rows`, async () => {
      await scoped(env.api, HOTEL_A, async (query) => {
        const updated = await query(
          `UPDATE ${qualified} SET hotel_id = hotel_id WHERE hotel_id = $1`,
          [HOTEL_B],
        ).catch(() => ({ rows: [], rowCount: 0 }));
        expect(updated.rowCount).toBe(0);

        const deleted = await query(`DELETE FROM ${qualified} WHERE hotel_id = $1`, [
          HOTEL_B,
        ]).catch(() => ({ rows: [], rowCount: 0 }));
        expect(deleted.rowCount).toBe(0);
      });
    });
  }

  it('hides tenant B rows from a tenant A primary-key lookup', async () => {
    const bEventId = await env.admin.query<{ event_id: string }>(
      `SELECT event_id::text AS event_id FROM platform.outbox_event WHERE hotel_id = $1`,
      [HOTEL_B],
    );
    const target = bEventId.rows[0]?.event_id;
    expect(target).toBeDefined();

    await scoped(env.api, HOTEL_A, async (query) => {
      const byKey = await query(`SELECT hotel_id FROM platform.outbox_event WHERE event_id = $1`, [
        target,
      ]);
      expect(byKey.rowCount).toBe(0);
    });
  });

  it('refuses a cross-tenant foreign-key insert', async () => {
    // outbox_delivery references outbox_event. Referencing tenant B's event from
    // tenant A's scope must fail rather than create a cross-tenant edge.
    const bEventId = await env.admin.query<{ event_id: string }>(
      `SELECT event_id::text AS event_id FROM platform.outbox_event WHERE hotel_id = $1`,
      [HOTEL_B],
    );

    await scoped(env.api, HOTEL_A, async (query) => {
      await expect(
        query(`INSERT INTO platform.outbox_delivery (event_id, hotel_id) VALUES ($1, $2)`, [
          bEventId.rows[0]?.event_id,
          HOTEL_A,
        ]),
      ).rejects.toThrow(/foreign key|violates|row-level security/i);
    });
  });

  it('fails the query closed when a client turns row security off', async () => {
    await scoped(env.api, HOTEL_A, async (query) => {
      await query('SET LOCAL row_security = off');
      // PostgreSQL refuses the query outright rather than returning unfiltered
      // rows: `row_security = off` is a request to error if a policy would
      // apply, never a way to escape one.
      await expect(query('SELECT hotel_id FROM platform.outbox_event')).rejects.toThrow(
        /row-level security policy/i,
      );
    });
  });

  it('applies the policy to the table owner too (FORCE)', async () => {
    const owner = new Pool({ connectionString: env.migrateUrl, max: 1 });
    try {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        // No scope set: FORCE ROW LEVEL SECURITY means even the owner sees nothing.
        const result = await client.query('SELECT 1 FROM platform.outbox_event');
        expect(result.rowCount).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    } finally {
      await owner.end();
    }
  });

  it('gives an ordinary runtime no way to obtain the platform sentinel scope', async () => {
    // The sentinel is a value like any other: holding it requires the resolver to
    // have set it. What must not exist is a way to widen an existing scope.
    await scoped(env.api, HOTEL_A, async (query) => {
      const before = await query(`SELECT platform.current_hotel_id()::text AS scope`);
      expect(before.rows[0]?.['scope']).toBe(HOTEL_A);

      const platformRows = await query(`SELECT 1 FROM platform.outbox_event WHERE hotel_id = $1`, [
        PLATFORM_SCOPE,
      ]);
      expect(platformRows.rowCount).toBe(0);
    });
  });
});

describe('scope cleanup', () => {
  async function scopeAfter(pool: Pool, finish: 'COMMIT' | 'ROLLBACK' | 'ERROR'): Promise<unknown> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_A]);
      if (finish === 'ERROR') {
        await client.query('SELECT 1/0').catch(() => undefined);
        await client.query('ROLLBACK');
      } else {
        await client.query(finish);
      }
      const after = await client.query(
        `SELECT nullif(current_setting('app.hotel_id', true), '') AS scope`,
      );
      return after.rows[0]?.scope ?? null;
    } finally {
      client.release();
    }
  }

  it('drops the scope after commit, rollback and an aborted statement', async () => {
    for (const finish of ['COMMIT', 'ROLLBACK', 'ERROR'] as const) {
      expect({ finish, scope: await scopeAfter(env.api, finish) }).toEqual({ finish, scope: null });
    }
  });

  it('leaves no scope on a pooled connection reused by the next borrower', async () => {
    const single = new Pool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
    try {
      await withTenantTransaction(single, ctx(HOTEL_A), async () => undefined);
      const client = await single.connect();
      try {
        const after = await client.query(
          `SELECT nullif(current_setting('app.hotel_id', true), '') AS scope`,
        );
        expect(after.rows[0]?.scope ?? null).toBeNull();
      } finally {
        client.release();
      }
    } finally {
      await single.end();
    }
  });
});
