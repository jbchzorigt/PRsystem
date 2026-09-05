import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { TABLE_CLASSIFICATION } from '../classification';
import { validateClassification } from '../classification-check';
import { PLATFORM_SCOPE, assertTenantContext } from '../tenant-context';
import { withTenantTransaction } from '../unit-of-work';
import { appendOutboxEvent } from '../kernel/outbox';
import { STRUCTURAL_SQLSTATES, TENANT_ROW_SPECS } from '../test-support/tenant-rows';
import { quietPool } from '@prsystem/testing';

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

/** Keeps unscoped-INSERT probes from colliding with each other. */
let unscopedSeq = 9000;

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

  // Every TENANT_RLS table gets real rows for both tenants.
  //
  // Without this, "tenant A affected zero of tenant B's rows" was true because
  // tenant B had no rows: the assertion passed on an empty table and would have
  // passed just as happily with no policy at all.
  let seq = 0;
  for (const hotelId of [HOTEL_A, HOTEL_B]) {
    const client = await env.admin.connect();
    try {
      await client.query('BEGIN');
      // The definer trigger on outbox_event is RLS-subject, so the seeding
      // connection needs a tenant scope of its own.
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
      for (const spec of TENANT_ROW_SPECS) {
        // Only a row something else creates is skipped. Seeding runs as the
        // superuser, so a table no *runtime* may insert into is still seeded —
        // otherwise "tenant B has rows" would be false for exactly the tables
        // whose isolation matters most.
        if (spec.seedByAdmin === false) continue;
        seq += 1;
        const { sql, values } = spec.insert(hotelId, seq);
        await client.query(sql, values);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    const spec = TENANT_ROW_SPECS.find((t) => t.name === qualified);
    if (spec === undefined) throw new Error(`no row fixture for ${qualified}`);

    it(`${qualified}: unscoped SELECT is confined or refused`, async () => {
      const client = await env.api.connect();
      try {
        if (spec.grants.api.includes('SELECT')) {
          // The policy supplies the predicate: no scope, no rows.
          const result = await client.query(`SELECT 1 FROM ${qualified}`);
          expect(result.rowCount).toBe(0);
        } else {
          // The API holds no SELECT here at all, so the refusal is the grant.
          await expect(client.query(`SELECT 1 FROM ${qualified}`)).rejects.toMatchObject({
            code: '42501',
          });
        }
      } finally {
        client.release();
      }
    });

    it(`${qualified}: unscoped INSERT is refused for the policy's own reason`, async () => {
      // A **complete** row. The previous shape inserted only `hotel_id` and
      // accepted `null value violates not-null constraint` as evidence of tenant
      // isolation, which is a statement about the column definitions and not
      // about RLS at all.
      const client = await env.api.connect();
      try {
        await client.query('BEGIN');

        // One probe for every table, whether the refusal comes from the policy
        // or from a missing grant: both are 42501, and the fixture — not the
        // test — knows what a complete row for this table looks like.
        const { sql, values } = spec.insert(HOTEL_A, unscopedSeq++);
        // No app.hotel_id is set, so the WITH CHECK predicate cannot be satisfied.
        const error = await client.query(sql, values).then(
          () => undefined,
          (e: unknown) => e as { code?: string; message?: string },
        );

        expect(error, 'a complete row must still be refused without tenant scope').toBeDefined();
        // The exact SQLSTATE, and never a structural one: a malformed row would
        // be refused by any database, policy or not.
        expect(STRUCTURAL_SQLSTATES).not.toContain(error?.code);
        expect(error?.code).toBe('42501');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it(`${qualified}: tenant A cannot UPDATE or DELETE tenant B rows`, async () => {
      // Tenant B's rows must genuinely exist, or "zero rows affected" is a
      // statement about an empty table.
      const present = await env.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${qualified} WHERE hotel_id = $1`,
        [HOTEL_B],
      );
      expect(Number(present.rows[0]?.n)).toBeGreaterThan(0);

      const column = spec.updateColumn ?? 'hotel_id';
      await scoped(env.api, HOTEL_A, async (query) => {
        // No catch, and no single expectation for both cases. Where the API
        // holds the verb, the policy must make the rows invisible and the exact
        // affected count must be zero. Where it does not, the refusal is the
        // grant and the exact SQLSTATE is 42501. Collapsing the two — which is
        // what `.catch(() => rowCount: 0)` did — lets a broken policy pass as a
        // missing privilege.
        for (const [verb, sql] of [
          ['UPDATE', `UPDATE ${qualified} SET ${column} = ${column} WHERE hotel_id = $1`],
          ['DELETE', `DELETE FROM ${qualified} WHERE hotel_id = $1`],
        ] as const) {
          if (spec.grants.api.includes(verb)) {
            const affected = await query(sql, [HOTEL_B]);
            expect(affected.rowCount).toBe(0);
          } else {
            const error = await query(sql, [HOTEL_B]).then(
              () => undefined,
              (e: unknown) => e as { code?: string },
            );
            expect(error, `${verb} on ${qualified} must be refused`).toBeDefined();
            expect(STRUCTURAL_SQLSTATES).not.toContain(error?.code);
            expect(error?.code).toBe('42501');
          }
          // A failed statement aborts the transaction; reopen for the next verb.
          await query('ROLLBACK');
          await query('BEGIN');
          await query(`SELECT set_config('app.hotel_id', $1, true)`, [HOTEL_A]);
        }
      });

      // And tenant B still has every row it had.
      const after = await env.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${qualified} WHERE hotel_id = $1`,
        [HOTEL_B],
      );
      expect(after.rows[0]?.n).toBe(present.rows[0]?.n);
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

  it('refuses a direct delivery insert from a runtime login', async () => {
    // Delivery rows are created only by the SECURITY DEFINER trigger on
    // outbox_event. No runtime holds INSERT, so the attempt is refused on the
    // grant, before RLS is even consulted.
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
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('refuses a cross-tenant delivery row even for the table owner', async () => {
    // The previous shape of this test inserted tenant B's event id under tenant
    // A's scope and accepted any error matching /violates/. That passed on the
    // primary key — the trigger had already created a delivery row for that
    // event — so it proved nothing about tenant isolation.
    //
    // The real cross-tenant write is a row carrying *another tenant's* hotel_id,
    // and it must be refused by the policy itself. The owner is used because
    // FORCE ROW LEVEL SECURITY means even it cannot escape, and because no
    // runtime login holds INSERT at all.
    const owner = quietPool({ connectionString: env.migrateUrl, max: 1 });
    try {
      // Seeded in tenant B's own scope and committed. The delivery row the
      // definer trigger creates is removed here, so the insert below must fail
      // on the policy rather than on the primary key.
      const seed = await env.admin.connect();
      let eventId: string | undefined;
      try {
        await seed.query('BEGIN');
        await seed.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_B]);
        const created = await seed.query<{ event_id: string }>(
          `INSERT INTO platform.outbox_event
             (hotel_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, 'rls_probe', 'cross-tenant-check', 'rls.probe', '{}'::jsonb)
           RETURNING event_id::text AS event_id`,
          [HOTEL_B],
        );
        eventId = created.rows[0]?.event_id;
        await seed.query(`DELETE FROM platform.outbox_delivery WHERE event_id = $1`, [eventId]);
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        seed.release();
      }

      await scoped(owner, HOTEL_A, async (query) => {
        const attempt = query(
          `INSERT INTO platform.outbox_delivery (event_id, hotel_id) VALUES ($1, $2)`,
          [eventId, HOTEL_B],
        );
        // The intended SQLSTATE, not an unrelated integrity error.
        await expect(attempt).rejects.toMatchObject({ code: '42501' });
        await expect(attempt).rejects.toThrow(/row-level security policy/i);
      });
    } finally {
      await owner.end();
    }
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
    const owner = quietPool({ connectionString: env.migrateUrl, max: 1 });
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

  it('states honestly what the custom-GUC scope does and does not prevent', async () => {
    // The previous version of this test was titled "gives an ordinary runtime no
    // way to obtain the platform sentinel scope" and proved nothing of the sort:
    // it selected rows for the sentinel from an unseeded table and found none.
    //
    // A custom GUC is writable by the session that holds the connection. The
    // mechanism is not unforgeable and this test does not pretend it is; it
    // records the actual boundary, so nobody later mistakes the absence of a
    // check for the presence of one.
    const client = await env.api.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_A]);
      const before = await client.query<{ scope: string }>(
        `SELECT platform.current_hotel_id()::text AS scope`,
      );
      expect(before.rows[0]?.scope).toBe(HOTEL_A);

      // A runtime connection *can* rewrite its own scope. Asserting this is the
      // point: the protection lives above the database, and claiming otherwise
      // would be claiming a control that is not implemented.
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_B]);
      const after = await client.query<{ scope: string }>(
        `SELECT platform.current_hotel_id()::text AS scope`,
      );
      expect(after.rows[0]?.scope).toBe(HOTEL_B);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('confines a query that carries no tenant predicate at all', async () => {
    // This *is* what the mechanism buys: a forgotten `WHERE hotel_id = …` is not
    // a cross-tenant read, because the policy supplies the predicate.
    const total = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox_event`,
    );
    expect(Number(total.rows[0]?.n)).toBeGreaterThan(0);

    await scoped(env.api, HOTEL_A, async (query) => {
      const rows = await query(
        `SELECT DISTINCT hotel_id::text AS hotel_id FROM platform.outbox_event`,
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      expect(rows.rows.map((r) => r['hotel_id'])).toEqual([HOTEL_A]);
    });
  });

  it('refuses the platform sentinel in a realm that has no platform-wide work', async () => {
    // The application context boundary, where the pairing rule lives. Phase 04
    // added the account-scoped half of the Hotel realm — signing in, changing a
    // password, logging out of every device — which belongs to an account
    // rather than to one hotel. Phase 12 added the Guest realm on the same
    // terms: a guest belongs to no hotel, and registration, sign-in and
    // recovery are that same account-scoped work. The Police realm has no
    // platform-wide work and is still refused.
    for (const realm of ['police'] as const) {
      expect(() =>
        assertTenantContext({
          hotelId: PLATFORM_SCOPE,
          realm,
          actorRef: 'actor-sec-rls',
          correlationId: 'corr-sec-rls',
        }),
      ).toThrow(/platform scope is valid only in the operation realm/);
    }

    for (const realm of ['operation', 'hotel', 'guest'] as const) {
      expect(() =>
        assertTenantContext({
          hotelId: PLATFORM_SCOPE,
          realm,
          actorRef: 'actor-sec-rls',
          correlationId: 'corr-sec-rls',
        }),
      ).not.toThrow();
    }
  });

  it('reaches no tenant row at all under the platform sentinel', async () => {
    // The sentinel widens nothing. No hotel carries it as its id, so every
    // tenant policy matches zero rows there — which is what makes it safe for
    // the account-scoped work that has no hotel.
    //
    // Both tenants have real rows in every one of these tables, seeded above, so
    // "zero rows" is a statement about the policy rather than about an empty
    // table.
    await scoped(env.api, PLATFORM_SCOPE, async (query) => {
      for (const entry of TENANT_TABLES) {
        const qualified = `${entry.schema}.${entry.table}`;
        const spec = TENANT_ROW_SPECS.find((row) => row.name === qualified);
        if (spec === undefined || !spec.grants.api.includes('SELECT')) continue;
        const rows = await query(`SELECT 1 FROM ${qualified}`);
        expect(rows.rowCount, qualified).toBe(0);
      }
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
    const single = quietPool({ connectionString: env.db.loginUrl('prsystem_api_login'), max: 1 });
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
