import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-POLICE-ISOLATION — the Police boundary is a database guarantee, not a
 * module-graph convention (ADR-0017 §6, ADR-0005).
 *
 * A generic worker must not be able to reach both Hotel identity data and Police
 * data. Phase 18 is where that stops being a statement about an empty schema:
 * the worker now calls two Police functions and the Police role now signs in,
 * so each crosses the schema line — and the boundary is what each may *hold*
 * there, which is asserted below rather than assumed.
 */

let env: ProvisionedDatabase;

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_police');
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('schema reach', () => {
  it('keeps the API out of both police schemas entirely', async () => {
    for (const schema of ['police', 'police_audit']) {
      const result = await env.api.query<{ allowed: boolean }>(
        'SELECT has_schema_privilege($1, $2) AS allowed',
        [schema, 'USAGE'],
      );
      expect({ schema, allowed: result.rows[0]?.allowed }).toEqual({ schema, allowed: false });
    }
  });

  it('gives the worker the police schema and nothing inside it', async () => {
    // Phase 18: the matcher runs in the worker deployment and calls two
    // `SECURITY DEFINER` functions, so it needs to be able to name the schema.
    // What it may hold there is the point — and it is nothing: no table, no
    // sequence, no view. It cannot read a wanted person, a case or a match.
    expect(
      (
        await env.worker.query<{ allowed: boolean }>(
          `SELECT has_schema_privilege('police', 'USAGE') AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await env.worker.query<{ allowed: boolean }>(
          `SELECT has_schema_privilege('police_audit', 'USAGE') AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(false);

    const reachable = await env.admin.query<{ relname: string; privilege: string }>(
      `SELECT c.relname, p.privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                    'REFERENCES', 'TRIGGER']) AS p(privilege)
        WHERE n.nspname = 'police' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND has_table_privilege('prsystem_worker', c.oid, p.privilege)
        ORDER BY 1, 2`,
    );
    expect(reachable.rows).toEqual([]);
  });

  it('gives the police role the platform schema and only the tables it signs in with', async () => {
    // The other direction. The Police realm resolves a principal, claims an
    // idempotency key and appends an outbox event through the same kernel every
    // realm uses, so it can name the platform schema. What it must *not* hold
    // is any hotel-domain table: a stay, a guest, a folio, a booking, a room.
    expect(
      (
        await env.police.query<{ allowed: boolean }>(
          `SELECT has_schema_privilege('platform', 'USAGE') AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(true);

    const held = await env.admin.query<{ relname: string }>(
      `SELECT DISTINCT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
        WHERE n.nspname = 'platform' AND c.relkind IN ('r', 'p')
          AND has_table_privilege('prsystem_police', c.oid, p.privilege)
        ORDER BY 1`,
    );
    // The exact list, not a subset: a table appearing here is a widening of the
    // Police realm's reach into the platform schema that nobody reviewed.
    expect(held.rows.map((row) => row.relname)).toEqual([
      'account_credential',
      'account_permission_grant',
      'idempotency_key',
      'membership_role_grant',
      'outbox_event',
      'server_session',
      'staff_membership',
      'user_account',
    ]);
  });

  it('keeps the police login out of the platform audit schema', async () => {
    const result = await env.police.query<{ allowed: boolean }>(
      `SELECT has_schema_privilege('audit', 'USAGE') AS allowed`,
    );
    expect(result.rows[0]?.allowed).toBe(false);
  });

  it('gives the police login its own schemas', async () => {
    for (const schema of ['police', 'police_audit']) {
      const result = await env.police.query<{ allowed: boolean }>(
        'SELECT has_schema_privilege($1, $2) AS allowed',
        [schema, 'USAGE'],
      );
      expect({ schema, allowed: result.rows[0]?.allowed }).toEqual({ schema, allowed: true });
    }
  });
});

describe('no principal holds both realms', () => {
  it('lets a principal that spans both sides hold data on only one of them', async () => {
    // Phase 18 chose the exact-match function over a new principal: the worker
    // can *call* into the Police schema and can hold nothing in it, which the
    // test above asserts directly. What this one holds to is the older rule —
    // that spanning both sides is rare and deliberate.
    const combined = await env.admin.query<{ rolname: string }>(
      `SELECT r.rolname
         FROM pg_roles r
        WHERE r.rolname LIKE 'prsystem\\_%'
          AND r.rolname NOT LIKE '%maintenance%'
          AND has_schema_privilege(r.rolname, 'platform', 'USAGE')
          AND (has_schema_privilege(r.rolname, 'police', 'USAGE')
               OR has_schema_privilege(r.rolname, 'police_audit', 'USAGE'))
        ORDER BY 1`,
    );

    // Exactly three principals span both sides, and none of them is a runtime:
    //   - prsystem_audit_writer  appends to both streams through a wrapper whose
    //                            contents it does not choose, and reads neither;
    //   - prsystem_partition_mgr creates monthly partitions in both audit
    //                            schemas — PostgreSQL requires the parent's
    //                            owner to attach one;
    //   - prsystem_migrate and its login are the DDL principal, which by
    //                            definition builds both sides.
    // Phase 18 adds two more, each of which holds data on one side only:
    //   - prsystem_worker  may name the police schema and holds nothing in it;
    //   - prsystem_police  may name the platform schema and holds only the
    //                      account, idempotency and outbox tables it signs in
    //                      and issues commands with — no hotel-domain table.
    // Their logins inherit the same reach and nothing more. The API principal
    // is still absent from both police schemas entirely.
    expect(combined.rows.map((r) => r.rolname)).toEqual([
      'prsystem_audit_writer',
      'prsystem_migrate',
      'prsystem_migrate_login',
      'prsystem_partition_mgr',
      'prsystem_police',
      'prsystem_police_login',
      'prsystem_worker',
      'prsystem_worker_login',
    ]);
  });

  it('gives the spanning append role no read path on either stream', async () => {
    for (const table of ['audit.platform_event', 'police_audit.security_event']) {
      const result = await env.admin.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('prsystem_audit_writer', $1, 'SELECT') AS allowed`,
        [table],
      );
      expect({ table, select: result.rows[0]?.allowed }).toEqual({ table, select: false });
    }
  });

  it('gives no runtime login any privilege on either audit stream', async () => {
    for (const login of ['prsystem_api_login', 'prsystem_worker_login', 'prsystem_police_login']) {
      for (const table of ['audit.platform_event', 'police_audit.security_event']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const result = await env.admin.query<{ allowed: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS allowed',
            [login, table, privilege],
          );
          expect({ login, table, privilege, allowed: result.rows[0]?.allowed }).toEqual({
            login,
            table,
            privilege,
            allowed: false,
          });
        }
      }
    }
  });

  it('lets no runtime login connect as another realm', async () => {
    for (const [login, forbidden] of [
      ['prsystem_worker_login', 'prsystem_police'],
      ['prsystem_api_login', 'prsystem_police'],
      ['prsystem_police_login', 'prsystem_api'],
      ['prsystem_police_login', 'prsystem_worker'],
    ] as const) {
      const result = await env.admin.query<{ reachable: boolean }>(
        'SELECT pg_has_role($1, $2, $3) AS reachable',
        [login, forbidden, 'USAGE'],
      );
      expect({ login, forbidden, reachable: result.rows[0]?.reachable }).toEqual({
        login,
        forbidden,
        reachable: false,
      });
    }
  });
});
