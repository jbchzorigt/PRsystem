import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-POLICE-ISOLATION — the Police boundary is a database guarantee, not a
 * module-graph convention (ADR-0017 §6, ADR-0005).
 *
 * A generic worker must not be able to reach both Hotel identity data and Police
 * data. Phase 18 gets a dedicated matcher principal; the kernel proves that no
 * such combined reach exists today.
 */

let env: ProvisionedDatabase;

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_police');
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('schema reach', () => {
  it('keeps the API and worker out of both police schemas', async () => {
    for (const [name, pool] of [
      ['api', env.api],
      ['worker', env.worker],
    ] as const) {
      for (const schema of ['police', 'police_audit']) {
        const result = await pool.query<{ allowed: boolean }>(
          'SELECT has_schema_privilege($1, $2) AS allowed',
          [schema, 'USAGE'],
        );
        expect({ role: name, schema, allowed: result.rows[0]?.allowed }).toEqual({
          role: name,
          schema,
          allowed: false,
        });
      }
    }
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
  it('reserves a dedicated matcher principal for Phase 18 rather than widening the worker', async () => {
    // The generic worker is the role a future Police matcher would be tempted to
    // reuse. It must reach the platform side only; Phase 18 introduces its own
    // narrowly scoped principal or an exact-match function.
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
    // No API, worker or police principal appears, so no generic worker can reach
    // Hotel identity data and Police data together. Phase 18 introduces its own
    // matcher principal rather than widening any of these.
    expect(combined.rows.map((r) => r.rolname)).toEqual([
      'prsystem_audit_writer',
      'prsystem_migrate',
      'prsystem_migrate_login',
      'prsystem_partition_mgr',
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
