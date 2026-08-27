import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-PARTITION — audit partition renewal without DDL rights.
 *
 * The worker must be able to create next month's partition and must not be able
 * to create anything else. Both halves are asserted.
 */

let env: ProvisionedDatabase;

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_partition');
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('the worker has no schema DDL', () => {
  const forbidden: readonly [string, string][] = [
    ['create a table in audit', 'CREATE TABLE audit.sneaky (id int)'],
    ['create a table in platform', 'CREATE TABLE platform.sneaky (id int)'],
    ['create a table in police_audit', 'CREATE TABLE police_audit.sneaky (id int)'],
    ['drop an audit partition', 'DROP TABLE audit.platform_event_2026_08'],
    ['alter the audit parent', 'ALTER TABLE audit.platform_event ADD COLUMN sneaky int'],
  ];

  for (const [label, sql] of forbidden) {
    it(`cannot ${label}`, async () => {
      await expect(env.worker.query(sql)).rejects.toThrow(/permission denied|must be owner/i);
    });
  }
});

describe('the worker can still renew coverage', () => {
  it('creates the next partition through the wrapper', async () => {
    const before = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname LIKE 'platform\\_event\\_%' AND c.relkind = 'r'`,
    );

    const created = await env.worker.query<{ created: number }>(
      `SELECT platform.ensure_month_partitions('audit', 'platform_event', now(), 6) AS created`,
    );
    expect(created.rows[0]?.created).toBeGreaterThan(0);

    const after = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname LIKE 'platform\\_event\\_%' AND c.relkind = 'r'`,
    );
    expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));
  });

  it('stamps a newly created partition with the same owner, grants and protection', async () => {
    const partitions = await env.admin.query<{
      relname: string;
      owner: string;
      acl: string;
      truncate_triggers: string;
    }>(
      `SELECT c.relname,
              pg_get_userbyid(c.relowner) AS owner,
              coalesce(array_to_string(c.relacl, ' '), '') AS acl,
              (SELECT count(*)::text FROM pg_trigger t
                WHERE t.tgrelid = c.oid AND t.tgname LIKE '%no_truncate') AS truncate_triggers
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname LIKE 'platform\\_event\\_%' AND c.relkind = 'r'
        ORDER BY 1`,
    );

    expect(partitions.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of partitions.rows) {
      expect({
        partition: row.relname,
        owner: row.owner,
        writer: row.acl.includes('prsystem_audit_writer=a'),
        reader: row.acl.includes('prsystem_audit_reader=r'),
        truncateProtected: row.truncate_triggers,
      }).toEqual({
        partition: row.relname,
        owner: 'prsystem_partition_mgr',
        writer: true,
        reader: true,
        truncateProtected: '1',
      });
    }
  });

  it('refuses TRUNCATE of a newly created partition', async () => {
    const newest = await env.admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname LIKE 'platform\\_event\\_%' AND c.relkind = 'r'
        ORDER BY c.relname DESC LIMIT 1`,
    );
    await expect(
      env.admin.query(`TRUNCATE audit.${String(newest.rows[0]?.relname)}`),
    ).rejects.toThrow(/append-only/);
  });
});

describe('the partition wrapper is an allow-list', () => {
  const rejected: readonly [string, string][] = [
    ['another schema', `SELECT platform.ensure_month_partitions('public', 'anything', now(), 1)`],
    [
      'another table',
      `SELECT platform.ensure_month_partitions('audit', 'not_an_audit_stream', now(), 1)`,
    ],
    [
      'a platform table',
      `SELECT platform.ensure_month_partitions('platform', 'outbox_event', now(), 1)`,
    ],
  ];

  for (const [label, sql] of rejected) {
    it(`refuses ${label}`, async () => {
      await expect(env.worker.query(sql)).rejects.toThrow(/only the two audit streams|refuses/i);
    });
  }

  it('bounds the month count', async () => {
    for (const months of [0, -1, 25, 1000]) {
      await expect(
        env.worker.query(
          `SELECT platform.ensure_month_partitions('audit', 'platform_event', now(), $1)`,
          [months],
        ),
      ).rejects.toThrow(/between 1 and 24/);
    }
  });

  it('fixes its search_path and runs as a definer', async () => {
    const result = await env.admin.query<{ proname: string; prosecdef: boolean; config: string }>(
      `SELECT p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ' '), '') AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname IN
              ('ensure_month_partitions', 'check_partition_horizon', 'maintenance_expire_idempotency_keys')
        ORDER BY 1`,
    );

    expect(result.rows.length).toBe(3);
    for (const row of result.rows) {
      expect({
        fn: row.proname,
        secdef: row.prosecdef,
        fixedPath: row.config.includes('search_path='),
      }).toEqual({ fn: row.proname, secdef: true, fixedPath: true });
    }
  });

  it('revokes PUBLIC execute on every SECURITY DEFINER function', async () => {
    const result = await env.admin.query<{ proname: string; acl: string }>(
      `SELECT p.proname, coalesce(array_to_string(p.proacl, ' '), '(default)') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('platform', 'audit', 'police_audit') AND p.prosecdef
        ORDER BY 1`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect({ fn: row.proname, publicExecute: /(^|\s)=X\//.test(row.acl) }).toEqual({
        fn: row.proname,
        publicExecute: false,
      });
    }
  });
});

// Cross-tenant maintenance accountability moved to sec-maintenance.test.ts when
// the caller-supplied audit reference was removed: the audit id is now generated
// inside the function, so the assertions belong with the audit evidence.
