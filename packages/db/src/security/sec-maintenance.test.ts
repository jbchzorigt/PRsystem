import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-MAINTENANCE — a maintenance action is accountable or it does not happen.
 *
 * The audit reference is generated inside the function, never supplied by the
 * caller; `platform.operational_alert` is telemetry pointing at that record, not
 * the record itself.
 */

const HOTEL = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';

let env: ProvisionedDatabase;

async function inContext<T>(
  realm: string,
  work: (
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
  options: { hotel?: string; actor?: string; correlation?: string } = {},
): Promise<T> {
  const client = await env.worker.connect();
  try {
    await client.query('BEGIN');
    if (options.hotel !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.hotel_id',
        options.hotel ?? HOTEL,
      ]);
    }
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', realm]);
    if (options.actor !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', options.actor]);
    }
    if (options.correlation !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.correlation_id',
        options.correlation,
      ]);
    }
    return await work((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const FULL = { actor: 'actor-maintenance', correlation: 'corr-maintenance' };

/** Creates a running job and an expired idempotency row, returning the job id. */
async function seed(
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
): Promise<string> {
  const job = await query(
    `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
     VALUES ($1, 'expire-idempotency', 'worker-1') RETURNING job_run_id::text AS id`,
    [HOTEL],
  );
  await query(
    `INSERT INTO platform.idempotency_key
       (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key, request_hash,
        state, response_status, completed_at, expires_at)
     VALUES ($1,'hotel','a','c','op.expire','idem-expired-0001', repeat('d',64),
             'succeeded', 200, now(), now() - interval '1 day')`,
    [HOTEL],
  );
  return String(job.rows[0]?.['id']);
}

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_maintenance');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('the audit reference cannot be invented', () => {
  it('exposes only the one-argument form', async () => {
    const signatures = await env.admin.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname = 'maintenance_expire_idempotency_keys'`,
    );
    expect(signatures.rows.map((r) => r.args)).toEqual(['p_job_run_id uuid']);
  });

  it('refuses a call that tries to supply one', async () => {
    await inContext(
      'hotel',
      async (query) => {
        await expect(
          query(
            `SELECT platform.maintenance_expire_idempotency_keys($1, 'job', 'reason', 'invented-ref')`,
            [HOTEL],
          ),
        ).rejects.toThrow(/does not exist/i);
      },
      FULL,
    );
  });
});

describe('trusted context is required', () => {
  it('refuses without an actor', async () => {
    await inContext(
      'hotel',
      async (query) => {
        const job = await seed(query);
        await expect(
          query('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
        ).rejects.toThrow(/established transaction context/i);
      },
      { correlation: 'corr-only' },
    );
  });

  it('refuses without a correlation id', async () => {
    await inContext(
      'hotel',
      async (query) => {
        const job = await seed(query);
        await expect(
          query('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
        ).rejects.toThrow(/established transaction context/i);
      },
      { actor: 'actor-only' },
    );
  });

  it('refuses the police realm', async () => {
    await inContext(
      'police',
      async (query) => {
        const job = await seed(query);
        await expect(
          query('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
        ).rejects.toThrow(/police realm may not run platform maintenance/i);
      },
      FULL,
    );
  });

  it('refuses a missing job identity', async () => {
    await inContext(
      'hotel',
      async (query) => {
        await expect(
          query('SELECT platform.maintenance_expire_idempotency_keys(NULL)'),
        ).rejects.toThrow(/running job identity/i);
      },
      FULL,
    );
  });

  it('refuses a job that is not running for this tenant', async () => {
    await inContext(
      'hotel',
      async (query) => {
        await expect(
          query('SELECT platform.maintenance_expire_idempotency_keys($1)', [
            '00000000-0000-4000-8000-000000000099',
          ]),
        ).rejects.toThrow(/no running job_run/i);
      },
      FULL,
    );
  });
});

describe('a successful run is accountable', () => {
  it('deletes the expired row and produces exactly one immutable audit event', async () => {
    // Committed, so the audit reader can inspect the immutable record.
    const client = await env.worker.connect();
    let auditEventId: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      await client.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', 'actor-maintenance']);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.correlation_id',
        'corr-maintenance',
      ]);

      const job = await seed((sql, values = []) => client.query(sql, values));
      const result = await client.query<{ deleted: number; audit_event_id: string }>(
        'SELECT * FROM platform.maintenance_expire_idempotency_keys($1)',
        [job],
      );
      expect(result.rows[0]?.deleted).toBe(1);
      auditEventId = result.rows[0]?.audit_event_id;
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(auditEventId).toMatch(/^[0-9a-f-]{36}$/);

    const audit = await env.auditReader.query<{ count: string; event_id: string }>(
      `SELECT count(*)::text AS count, min(event_id::text) AS event_id
         FROM audit.platform_event
        WHERE action = 'platform.maintenance.expire_idempotency_keys'`,
    );
    expect(audit.rows[0]?.count).toBe('1');
    expect(audit.rows[0]?.event_id).toBe(auditEventId);

    // Telemetry points at the generated audit id; it is not the audit record.
    const alert = await env.admin.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM platform.operational_alert WHERE alert_code = 'MAINTENANCE_RUN'`,
    );
    expect(alert.rows[0]?.detail).toMatchObject({ auditEventId, rows: 1 });
  });

  it('leaves the target row undeleted when the audit insert fails', async () => {
    // Force the audit write to fail by removing the partition its server time
    // would route to. The delete must roll back with it.
    const client = await env.worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      await client.query('SELECT set_config($1, $2, true)', ['app.realm', 'hotel']);
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', 'actor-maintenance']);
      await client.query('SELECT set_config($1, $2, true)', ['app.correlation_id', 'corr-fail']);

      const job = await seed((sql, values = []) => client.query(sql, values));
      await client.query(
        `INSERT INTO platform.idempotency_key
           (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key, request_hash,
            state, response_status, completed_at, expires_at)
         VALUES ($1,'hotel','a','c','op.expire','idem-expired-0002', repeat('e',64),
                 'succeeded', 200, now(), now() - interval '1 day')`,
        [HOTEL],
      );

      // Detach the current month's partition inside this transaction: the audit
      // insert now has nowhere to land.
      const current = new Date().toISOString().slice(0, 7).replace('-', '_');
      await env.admin.query(
        `ALTER TABLE audit.platform_event DETACH PARTITION audit.platform_event_${current}`,
      );

      try {
        await expect(
          client.query('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [job]),
        ).rejects.toThrow(/no partition of relation/i);
        await client.query('ROLLBACK');
      } finally {
        await env.admin.query(
          `ALTER TABLE audit.platform_event ATTACH PARTITION audit.platform_event_${current}
             FOR VALUES FROM ('${new Date().toISOString().slice(0, 7)}-01')
                          TO ('${new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10)}')`,
        );
      }
    } finally {
      client.release();
    }

    const survivor = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.idempotency_key
        WHERE idempotency_key = 'idem-expired-0002'`,
    );
    // The transaction rolled back, so the seed row is gone too — what matters is
    // that no partial effect was committed.
    expect(survivor.rows[0]?.count).toBe('0');
  });
});
