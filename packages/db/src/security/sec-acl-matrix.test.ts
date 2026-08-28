import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-ACL-MATRIX — the complete grant matrix for every tenant table across every
 * runtime login and every DML verb.
 *
 * Allowed actions use complete, valid rows and prove both same-tenant success and
 * cross-tenant refusal. Forbidden actions assert the exact PostgreSQL SQLSTATE:
 * accepting a `NOT NULL` violation or a syntax error as "proof" of a privilege
 * boundary would pass even after the boundary was removed.
 */

const A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';

/** 42501 insufficient_privilege — the grant is absent. */
const INSUFFICIENT_PRIVILEGE = '42501';

type Verb = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
type Runtime = 'api' | 'worker' | 'police';

interface TenantTable {
  readonly name: string;
  /** A complete, valid row for tenant `hotelId`, keyed for uniqueness by `n`. */
  insert(hotelId: string, n: number): { sql: string; values: unknown[] };
  /** Grants per runtime, from the migration. */
  readonly grants: Readonly<Record<Runtime, readonly Verb[]>>;
}

const TENANT_TABLES: readonly TenantTable[] = [
  {
    name: 'platform.idempotency_key',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.idempotency_key
              (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key,
               request_hash, expires_at)
            VALUES ($1,'hotel','actor-acl','client-acl','acl.probe',$2,
                    repeat('a', 64), now() + interval '1 day')`,
      values: [hotelId, `idem-acl-${String(n).padStart(8, '0')}`],
    }),
    grants: {
      api: ['SELECT', 'INSERT', 'UPDATE'],
      worker: ['SELECT', 'INSERT', 'UPDATE'],
      police: [],
    },
  },
  {
    name: 'platform.outbox_event',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.outbox_event
              (hotel_id, aggregate_type, aggregate_id, event_type, payload)
            VALUES ($1,'acl_probe',$2,'acl.probe.created','{"ok":true}'::jsonb)`,
      values: [hotelId, `acl-${String(n)}`],
    }),
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
  },
  {
    // Delivery rows are created only by the SECURITY DEFINER trigger on
    // outbox_event. No runtime holds INSERT, so the INSERT cell is a real
    // forbidden case asserting 42501 rather than one that had to be skipped.
    name: 'platform.outbox_delivery',
    insert: () => ({ sql: '', values: [] }),
    grants: {
      api: ['SELECT', 'UPDATE'],
      worker: ['SELECT', 'UPDATE'],
      police: [],
    },
  },
  {
    name: 'platform.inbox_consumption',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.inbox_consumption (hotel_id, consumer, dedup_key, source)
            VALUES ($1,'acl.consumer',$2,'outbox')`,
      values: [hotelId, `dedup-acl-${String(n)}`],
    }),
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
  },
  {
    name: 'platform.provider_event',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.provider_event
              (hotel_id, provider, provider_event_id, event_kind, payload_hash)
            VALUES ($1,'qpay',$2,'payment.succeeded', repeat('b', 64))`,
      values: [hotelId, `evt-acl-${String(n)}`],
    }),
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
  },
  {
    name: 'platform.job_run',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
            VALUES ($1, $2, 'identity-acl')`,
      values: [hotelId, `job-acl-${String(n)}`],
    }),
    grants: { api: ['SELECT'], worker: ['SELECT', 'INSERT', 'UPDATE'], police: [] },
  },
  {
    name: 'platform.export_artifact',
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.export_artifact
              (hotel_id, export_kind, storage_key, content_hash, as_of)
            VALUES ($1,'acl',$2, repeat('c', 64), now())`,
      values: [hotelId, `key-acl-${String(n)}`],
    }),
    grants: { api: ['SELECT'], worker: ['SELECT', 'INSERT', 'UPDATE'], police: [] },
  },
];

const VERBS: readonly Verb[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

let env: ProvisionedDatabase;
let pools: Record<Runtime, Pool>;
let seq = 0;

/** Runs `work` in a scoped transaction on a runtime login, always rolling back. */
async function scoped<T>(
  runtime: Runtime,
  hotelId: string,
  work: (
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await pools[runtime].connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.realm',
      runtime === 'police' ? 'police' : 'hotel',
    ]);
    return await work((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Asserts the statement fails with exactly one SQLSTATE, never anything else. */
async function expectSqlState(
  promise: Promise<unknown>,
  expected: string,
  context: string,
): Promise<void> {
  let code: string | undefined;
  let message = '';
  try {
    await promise;
  } catch (error) {
    code = (error as { code?: string }).code;
    message = (error as Error).message;
  }
  expect({ context, code, message: code === expected ? '' : message }).toEqual({
    context,
    code: expected,
    message: '',
  });
}

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_acl');
  pools = { api: env.api, worker: env.worker, police: env.police };

  // Seed complete rows for both tenants so every read and write case below has
  // real data on both sides of the boundary.
  //
  // The scope is set even on the administrative connection: the outbox trigger
  // is SECURITY DEFINER and runs as a non-superuser, so it is subject to the
  // policy and needs a tenant context to insert the delivery row.
  for (const table of TENANT_TABLES) {
    if (table.name === 'platform.outbox_delivery') continue;
    for (const hotelId of [A, B]) {
      const client = await env.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
        // Two rows per tenant per table: an UPDATE/DELETE cell that affects one
        // row proves less than one that affects the exact number visible.
        for (let n = 0; n < 2; n += 1) {
          seq += 1;
          const { sql, values } = table.insert(hotelId, seq);
          await client.query(sql, values);
        }
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
  }
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

describe.each(TENANT_TABLES)('$name', (table) => {
  describe.each(['api', 'worker', 'police'] as const)('as %s', (runtime) => {
    const allowed = new Set(table.grants[runtime]);

    for (const verb of VERBS) {
      if (allowed.has(verb)) {
        it(`${verb} succeeds within the tenant`, async () => {
          await scoped(runtime, A, async (query) => {
            if (verb === 'SELECT') {
              const rows = await query(`SELECT hotel_id FROM ${table.name}`);
              // At least one seeded row must come back, and only tenant A's. A
              // policy that hid everything would otherwise pass this cell.
              expect(rows.rowCount).toBeGreaterThan(0);
              expect([...new Set(rows.rows.map((r) => r['hotel_id']))]).toEqual([A]);
              return;
            }
            if (verb === 'INSERT') {
              seq += 1;
              const { sql, values } = table.insert(A, seq);
              const result = await query(sql, values);
              expect(result.rowCount).toBe(1);
              return;
            }
            // UPDATE and DELETE must actually affect the rows seeded for tenant
            // A. A false predicate would prove only that the parser ran.
            const visible = await query(`SELECT count(*)::int AS n FROM ${table.name}`);
            const expected = Number(visible.rows[0]?.['n']);
            expect(expected).toBeGreaterThan(0);

            const verbSql =
              verb === 'UPDATE'
                ? `UPDATE ${table.name} SET hotel_id = hotel_id`
                : `DELETE FROM ${table.name}`;
            const affected = await query(verbSql);
            expect(affected.rowCount).toBe(expected);
          });
        });

        it(`${verb} cannot reach another tenant`, async () => {
          await scoped(runtime, A, async (query) => {
            if (verb === 'SELECT') {
              const rows = await query(`SELECT hotel_id FROM ${table.name} WHERE hotel_id = $1`, [
                B,
              ]);
              expect(rows.rowCount).toBe(0);
              return;
            }
            if (verb === 'INSERT') {
              seq += 1;
              const { sql, values } = table.insert(B, seq);
              // RLS WITH CHECK rejects a write aimed at another tenant: 42501.
              await expectSqlState(
                query(sql, values),
                INSUFFICIENT_PRIVILEGE,
                `${table.name} ${runtime} cross-tenant INSERT`,
              );
              return;
            }
            const verbSql =
              verb === 'UPDATE'
                ? `UPDATE ${table.name} SET hotel_id = hotel_id WHERE hotel_id = $1`
                : `DELETE FROM ${table.name} WHERE hotel_id = $1`;
            const result = await query(verbSql, [B]);
            // Invisible, so nothing matches. Not an error — simply no such row.
            expect(result.rowCount).toBe(0);
          });
        });
      } else {
        it(`${verb} is refused with SQLSTATE ${INSUFFICIENT_PRIVILEGE}`, async () => {
          await scoped(runtime, A, async (query) => {
            const sql =
              verb === 'SELECT'
                ? `SELECT 1 FROM ${table.name}`
                : verb === 'INSERT'
                  ? `INSERT INTO ${table.name} (hotel_id) VALUES ($1)`
                  : verb === 'UPDATE'
                    ? `UPDATE ${table.name} SET hotel_id = hotel_id`
                    : `DELETE FROM ${table.name}`;
            await expectSqlState(
              query(sql, verb === 'INSERT' ? [A] : []),
              INSUFFICIENT_PRIVILEGE,
              `${table.name} ${runtime} ${verb}`,
            );
          });
        });
      }
    }
  });
});
