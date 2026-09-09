import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { TABLE_CLASSIFICATION } from '../classification';
import { DATABASE_ROLES, ROLES_WITHOUT_BYPASSRLS } from '../roles';
import { PLATFORM_SCOPE, type TenantContext } from '../tenant-context';
import { withTenantTransaction } from '../unit-of-work';
import { recordPlatformAudit, recordPoliceAudit } from '../kernel/audit';
import { appendOutboxEvent } from '../kernel/outbox';
import { registerProviderEvent } from '../kernel/inbox';
import { advanceCheckpoint, readFreshness, registerProjection } from '../kernel/projections';
import { checkPartitionHorizon, readPartitionHorizons } from '../kernel/partitions';

/**
 * GATE-INTEG for the platform kernel — real PostgreSQL, never a mock or SQLite
 * (CLAUDE.md §10).
 *
 * Tenant identifiers are synthetic UUIDs; no real hotel, guest or case data
 * exists anywhere in this suite.
 */

const HOTEL_A = '11111111-1111-4111-8111-111111111111';
const HOTEL_B = '22222222-2222-4222-8222-222222222222';

let env: ProvisionedDatabase;
/** Administrative connection: superuser, used only for setup and verification. */
let pool: Pool;
/** Real LOGIN principals. RLS applies to these; it never applies to `pool`. */
let apiPool: Pool;
let policePool: Pool;

function ctx(hotelId: string, overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: 'actor-synthetic-1',
    correlationId: 'corr-integration-1',
    ...overrides,
  };
}

/** Runs a statement as a runtime role, exactly as that runtime would see it. */
async function asRole<T>(
  role: string,
  fn: (
    run: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    return await fn(async (sql, values = []) => client.query(sql, values));
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is being released either way */
    }
    client.release();
  }
}

beforeAll(async () => {
  env = await provisionKernelDatabase('kernel_integ');
  pool = env.admin;
  apiPool = env.api;
  policePool = env.police;
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('database roles (ADR-0017 §5)', () => {
  it('creates every approved group role', async () => {
    const result = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'prsystem\\_%' ORDER BY rolname`,
    );
    // The cluster also carries the deployment's LOGIN principals and the narrow
    // function-owner roles; SEC-ROLE asserts that exact set. Here it is enough
    // that every role this schema grants to exists.
    const present = new Set(result.rows.map((r) => r.rolname));
    for (const role of Object.values(DATABASE_ROLES)) {
      expect({ role, present: present.has(role) }).toEqual({ role, present: true });
    }
  });

  it('gives no runtime role BYPASSRLS', async () => {
    const result = await pool.query<{ rolname: string; rolbypassrls: boolean }>(
      'SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
      [ROLES_WITHOUT_BYPASSRLS],
    );
    expect(result.rows).toHaveLength(ROLES_WITHOUT_BYPASSRLS.length);
    for (const row of result.rows) {
      expect({ role: row.rolname, bypass: row.rolbypassrls }).toEqual({
        role: row.rolname,
        bypass: false,
      });
    }
  });

  it('grants BYPASSRLS only to the maintenance role', async () => {
    const result = await pool.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      [DATABASE_ROLES.maintenance],
    );
    expect(result.rows[0]?.rolbypassrls).toBe(true);
  });

  it('keeps the API role out of the police schemas', async () => {
    await asRole(DATABASE_ROLES.api, async (run) => {
      await expect(run('SELECT 1 FROM police_audit.security_event LIMIT 1')).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});

describe('row level security (ADR-0017 §1–§3)', () => {
  beforeAll(async () => {
    for (const hotelId of [HOTEL_A, HOTEL_B]) {
      await withTenantTransaction(apiPool, ctx(hotelId), async (uow) => {
        await appendOutboxEvent(uow, {
          aggregateType: 'kernel_probe',
          aggregateId: `probe-${hotelId}`,
          eventType: 'kernel.probe.created',
          payload: { hotelId },
        });
      });
    }
  });

  it('enables and forces RLS on every tenant-scoped kernel table', async () => {
    const result = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'platform'
                         AND col.table_name = c.relname
                         AND col.column_name = 'hotel_id')
        ORDER BY c.relname`,
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of result.rows) {
      expect({
        table: row.relname,
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({ table: row.relname, enabled: true, forced: true });
    }
  });

  it('returns zero rows when no tenant scope is established', async () => {
    await asRole(DATABASE_ROLES.api, async (run) => {
      const rows = await run('SELECT event_id FROM platform.outbox_event');
      expect(rows.rowCount).toBe(0);
    });
  });

  it('refuses a write when no tenant scope is established', async () => {
    await asRole(DATABASE_ROLES.api, async (run) => {
      await expect(
        run(
          `INSERT INTO platform.outbox_event
             (hotel_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, 'kernel_probe', 'unscoped', 'kernel.probe.created', '{}'::jsonb)`,
          [HOTEL_A],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('hides tenant B rows from tenant A even without a repository predicate', async () => {
    await asRole(DATABASE_ROLES.api, async (run) => {
      await run('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_A]);

      const all = await run('SELECT hotel_id FROM platform.outbox_event');
      expect(all.rows.map((r) => r['hotel_id'])).toEqual([HOTEL_A]);

      // Even asking for B's row by name returns nothing.
      const targeted = await run('SELECT hotel_id FROM platform.outbox_event WHERE hotel_id = $1', [
        HOTEL_B,
      ]);
      expect(targeted.rowCount).toBe(0);
    });
  });

  it('refuses a write that would land in another tenant', async () => {
    await asRole(DATABASE_ROLES.api, async (run) => {
      await run('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL_A]);
      await expect(
        run(
          `INSERT INTO platform.outbox_event
             (hotel_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, 'kernel_probe', 'cross-tenant', 'kernel.probe.created', '{}'::jsonb)`,
          [HOTEL_B],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });
});

describe('audit streams (ADR-0018)', () => {
  it('records a platform event in the same transaction as its effect', async () => {
    await withTenantTransaction(apiPool, ctx(HOTEL_A), async (uow) => {
      await recordPlatformAudit(uow, {
        action: 'kernel.probe',
        outcome: 'allowed',
        targetType: 'probe',
        targetRef: 'probe-1',
      });
    });

    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit.platform_event WHERE action = 'kernel.probe'`,
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('rolls the effect back when the audit write fails', async () => {
    // A payload carrying a denied key name is refused by the check constraint.
    // The enclosing transaction must not commit its outbox row either.
    await expect(
      withTenantTransaction(apiPool, ctx(HOTEL_A), async (uow) => {
        await appendOutboxEvent(uow, {
          aggregateType: 'kernel_probe',
          aggregateId: 'fail-closed',
          eventType: 'kernel.probe.created',
          payload: { ok: true },
        });
        await recordPlatformAudit(uow, {
          action: 'kernel.high_risk',
          outcome: 'allowed',
          payload: { password: 'must-never-be-recorded' },
        });
      }),
    ).rejects.toThrow(/denied field/i);

    const orphan = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_event WHERE aggregate_id = 'fail-closed'`,
    );
    expect(orphan.rows[0]?.count).toBe('0');
  });

  it('rejects UPDATE and DELETE of an audit event', async () => {
    await expect(pool.query(`UPDATE audit.platform_event SET reason = 'edited'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM audit.platform_event')).rejects.toThrow(/append-only/);
  });

  it('rejects TRUNCATE of an audit partition', async () => {
    const partition = await pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname LIKE 'platform_event\\_%' ORDER BY c.relname LIMIT 1`,
    );
    const name = partition.rows[0]?.relname;
    expect(name).toBeDefined();
    await expect(pool.query(`TRUNCATE audit.${String(name)}`)).rejects.toThrow(/append-only/);
  });

  it('denies the platform audit reader any write', async () => {
    await asRole(DATABASE_ROLES.auditReader, async (run) => {
      await expect(
        run(
          `INSERT INTO audit.platform_event (realm, action, outcome) VALUES ('hotel','x','allowed')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('denies business runtime roles any read of the audit stream', async () => {
    for (const role of [DATABASE_ROLES.api, DATABASE_ROLES.worker]) {
      await asRole(role, async (run) => {
        await expect(run('SELECT 1 FROM audit.platform_event LIMIT 1')).rejects.toThrow(
          /permission denied/i,
        );
      });
    }
  });

  it('keeps the two audit readers on their own side of the boundary', async () => {
    await withTenantTransaction(policePool, ctx(HOTEL_A, { realm: 'police' }), async (uow) => {
      await recordPoliceAudit(uow, { action: 'police.probe', outcome: 'allowed' });
    });

    await asRole(DATABASE_ROLES.auditReader, async (run) => {
      await expect(run('SELECT 1 FROM police_audit.security_event LIMIT 1')).rejects.toThrow(
        /permission denied/i,
      );
    });
    await asRole(DATABASE_ROLES.policeAuditReader, async (run) => {
      await expect(run('SELECT 1 FROM audit.platform_event LIMIT 1')).rejects.toThrow(
        /permission denied/i,
      );
    });
    // A failed statement aborts its transaction, so the permitted read needs a
    // fresh one rather than a follow-up query.
    await asRole(DATABASE_ROLES.policeAuditReader, async (run) => {
      const own = await run('SELECT action FROM police_audit.security_event');
      expect(own.rowCount).toBe(1);
    });
  });
});

describe('audit partitioning (ADR-0018 §3–§4)', () => {
  it('routes a write by server-recorded month, not by a supplied business time', async () => {
    const result = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM audit.platform_event e
         JOIN pg_class c ON c.oid = e.tableoid
        WHERE e.action = 'kernel.probe'`,
    );
    const expected = new Date().toISOString().slice(0, 7).replace('-', '_');
    expect(result.rows[0]?.relname).toBe(`platform_event_${expected}`);
  });

  it('covers the current month and the months ahead of it', async () => {
    const horizons = await readPartitionHorizons(pool);
    for (const horizon of horizons) {
      expect({ table: horizon.table, atLeast: horizon.months >= 4 }).toEqual({
        table: horizon.table,
        atLeast: true,
      });
    }
  });

  it('accepts a write at the next month boundary', async () => {
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 30, 0, 0);

    await expect(
      pool.query(
        `INSERT INTO audit.platform_event (occurred_at, realm, action, outcome)
         VALUES ($1, 'hotel', 'kernel.next_month', 'allowed')`,
        [nextMonth.toISOString()],
      ),
    ).resolves.toBeDefined();
  });

  it('fails a write closed when the required partition is missing', async () => {
    const farFuture = new Date();
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 5);

    await expect(
      pool.query(
        `INSERT INTO audit.platform_event (occurred_at, realm, action, outcome)
         VALUES ($1, 'hotel', 'kernel.no_partition', 'allowed')`,
        [farFuture.toISOString()],
      ),
    ).rejects.toThrow(/no partition of relation/i);
  });

  it('raises an alert when the horizon falls below its threshold', async () => {
    // Ask for more headroom than exists rather than dropping a partition, so the
    // check is exercised without destroying data. 24 is the function's ceiling.
    const raised = await checkPartitionHorizon(pool, 24);
    expect(raised).toBe(2);

    const alerts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.operational_alert
        WHERE alert_code = 'AUDIT_PARTITION_HORIZON' AND resolved_at IS NULL`,
    );
    expect(alerts.rows[0]?.count).toBe('2');
  });
});

describe('outbox and provider events', () => {
  it('pairs every appended event with a delivery row', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM platform.outbox_event e
    LEFT JOIN platform.outbox_delivery d ON d.event_id = e.event_id
        WHERE d.event_id IS NULL`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('refuses to append an event whose payload carries a denied field', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(HOTEL_A), (uow) =>
        appendOutboxEvent(uow, {
          aggregateType: 'kernel_probe',
          aggregateId: 'leaky',
          eventType: 'kernel.probe.created',
          payload: { registrationNumber: '9901154321' },
        }),
      ),
    ).rejects.toThrow(/outbox_payload_sanitised/);
  });

  it('rejects UPDATE and DELETE of an outbox event', async () => {
    await expect(
      pool.query(`UPDATE platform.outbox_event SET event_type = 'edited'`),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM platform.outbox_event')).rejects.toThrow(/append-only/);
  });

  it('treats a redelivered provider event as a duplicate', async () => {
    const event = {
      provider: 'qpay',
      providerEventId: 'evt-synthetic-1',
      eventKind: 'payment.succeeded',
      rawPayload: '{"reference":"REF-1","amount":"1000"}',
      metadata: { reference: 'REF-1', amountMnt: '1000', currency: 'MNT' },
    };

    const first = await withTenantTransaction(apiPool, ctx(HOTEL_A), (uow) =>
      registerProviderEvent(uow, event),
    );
    expect(first.kind).toBe('first_delivery');

    const second = await withTenantTransaction(apiPool, ctx(HOTEL_A), (uow) =>
      registerProviderEvent(uow, event),
    );
    expect(second).toEqual({ kind: 'duplicate', payloadMatches: true });
  });

  it('flags a duplicate provider id whose payload differs', async () => {
    const outcome = await withTenantTransaction(apiPool, ctx(HOTEL_A), (uow) =>
      registerProviderEvent(uow, {
        provider: 'qpay',
        providerEventId: 'evt-synthetic-1',
        eventKind: 'payment.succeeded',
        rawPayload: '{"reference":"REF-1","amount":"9999"}',
        metadata: { reference: 'REF-1' },
      }),
    );
    expect(outcome).toEqual({ kind: 'duplicate', payloadMatches: false });
  });

  it('refuses provider metadata that carries a denied field', async () => {
    await expect(
      withTenantTransaction(apiPool, ctx(HOTEL_A), (uow) =>
        registerProviderEvent(uow, {
          provider: 'qpay',
          providerEventId: 'evt-synthetic-2',
          eventKind: 'payment.succeeded',
          rawPayload: '{}',
          metadata: { pan: '4111111111111111' },
        }),
      ),
    ).rejects.toThrow(/provider_event_metadata_sanitised/);
  });
});

describe('projection freshness (ADR-0019 §3)', () => {
  it('surfaces as_of and lag, and never authorises anything', async () => {
    await registerProjection(pool, 'kernel.probe');

    const initial = await readFreshness(pool, 'kernel.probe');
    expect(initial?.asOf).toBeNull();
    expect(initial?.lagSeconds).toBeNull();

    const advanced = await advanceCheckpoint(pool, 'kernel.probe', '42', 0);
    expect(advanced).toBe(true);

    const fresh = await readFreshness(pool, 'kernel.probe');
    expect(fresh?.lastEventId).toBe('42');
    expect(fresh?.lagSeconds).toBeGreaterThanOrEqual(0);
  });

  it('refuses a stale compare-and-swap', async () => {
    const stale = await advanceCheckpoint(pool, 'kernel.probe', '43', 0);
    expect(stale).toBe(false);
  });
});

describe('platform scope', () => {
  it('isolates platform-scoped rows from hotel-scoped ones', async () => {
    await withTenantTransaction(apiPool, ctx(PLATFORM_SCOPE, { realm: 'operation' }), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'subscription',
        aggregateId: 'platform-1',
        eventType: 'kernel.probe.created',
        payload: {},
      }),
    );

    const seen = await withTenantTransaction(apiPool, ctx(HOTEL_A), async (uow) => {
      const rows = await uow.query(
        `SELECT aggregate_id FROM platform.outbox_event WHERE aggregate_id = 'platform-1'`,
      );
      return rows.rowCount;
    });
    expect(seen).toBe(0);
  });
});

describe('no business table exists yet', () => {
  it('creates only tables a phase has declared and classified', async () => {
    // Phase 03 could state this as "no business table exists yet". Phase 04
    // creates the tenancy and IAM aggregates it owns, so the rule that still
    // holds is the stronger one: every base table is in a kernel schema **and**
    // in the classification manifest. A table nobody classified is a table
    // whose tenant isolation nobody decided.
    const result = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND NOT (table_schema = 'drizzle' AND table_name = '__drizzle_migrations')
        ORDER BY table_schema, table_name`,
    );

    const classified = new Set(
      TABLE_CLASSIFICATION.map((entry) => `${entry.schema}.${entry.table}`),
    );
    const unclassified = result.rows
      .map((row) => `${row.table_schema}.${row.table_name}`)
      // Audit partitions inherit their parent's classification.
      .filter((name) => !/_\d{4}_\d{2}$/.test(name))
      .filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);

    expect(
      result.rows.every((row) =>
        ['platform', 'audit', 'police_audit', 'police'].includes(row.table_schema),
      ),
    ).toBe(true);
  });
});
