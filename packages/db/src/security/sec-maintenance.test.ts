import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-MAINTENANCE — a maintenance action is accountable, authorised and atomic,
 * or it does not happen.
 *
 * The audit reference is generated inside the function; `operational_alert` is
 * telemetry pointing at that record, not the record itself.
 */

const HOTEL = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const ACTOR = 'actor-maintenance';
const JOB_NAME = 'platform.maintenance.expire_idempotency_keys';

let env: ProvisionedDatabase;

interface Ctx {
  readonly realm?: string;
  readonly actor?: string | null;
  readonly correlation?: string | null;
  readonly hotel?: string;
}

/** A committed unit of work on the worker login, with a trusted context. */
async function committed<T>(
  ctx: Ctx,
  work: (
    q: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await env.worker.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', ctx.hotel ?? HOTEL]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', ctx.realm ?? 'hotel']);
    if (ctx.actor !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', ctx.actor ?? ACTOR]);
    }
    if (ctx.correlation !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.correlation_id',
        ctx.correlation ?? 'corr-maintenance',
      ]);
    }
    const result = await work((sql, values = []) => client.query(sql, values));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Rolled back regardless of outcome — for the refusal cases. */
async function attempted<T>(ctx: Ctx, work: Parameters<typeof committed<T>>[1]): Promise<T> {
  const client = await env.worker.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', ctx.hotel ?? HOTEL]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', ctx.realm ?? 'hotel']);
    if (ctx.actor !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_ref', ctx.actor ?? ACTOR]);
    }
    if (ctx.correlation !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.correlation_id',
        ctx.correlation ?? 'corr-maintenance',
      ]);
    }
    return await work((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Commits a running job of the given kind and identity, returning its id. */
async function seedJob(jobName = JOB_NAME, identity = ACTOR): Promise<string> {
  return committed({}, async (q) => {
    const job = await q(
      `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
       VALUES ($1, $2, $3) RETURNING job_run_id::text AS id`,
      [HOTEL, jobName, identity],
    );
    return String(job.rows[0]?.['id']);
  });
}

/** Commits one expired idempotency row and returns its key. */
async function seedExpired(key: string): Promise<string> {
  await committed({}, (q) =>
    q(
      `INSERT INTO platform.idempotency_key
         (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key, request_hash,
          state, response_status, completed_at, expires_at)
       VALUES ($1,'hotel','a','c','op.expire',$2, repeat('d',64),
               'succeeded', 200, now(), now() - interval '1 day')`,
      [HOTEL, key],
    ),
  );
  return key;
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
    await attempted({}, async (q) => {
      await expect(
        q(`SELECT platform.maintenance_expire_idempotency_keys($1, 'job', 'reason', 'invented')`, [
          HOTEL,
        ]),
      ).rejects.toThrow(/does not exist/i);
    });
  });
});

describe('authorisation', () => {
  it('refuses without an actor', async () => {
    const job = await seedJob();
    await attempted({ actor: null }, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
      ).rejects.toThrow(/established transaction context/i);
    });
  });

  it('refuses without a correlation id', async () => {
    const job = await seedJob();
    await attempted({ correlation: null }, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
      ).rejects.toThrow(/established transaction context/i);
    });
  });

  it('refuses the police realm', async () => {
    const job = await seedJob();
    await attempted({ realm: 'police' }, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
      ).rejects.toThrow(/police realm may not run platform maintenance/i);
    });
  });

  it('refuses a missing job identity', async () => {
    await attempted({}, async (q) => {
      await expect(q('SELECT platform.maintenance_expire_idempotency_keys(NULL)')).rejects.toThrow(
        /running job identity/i,
      );
    });
  });

  it('refuses a job belonging to another tenant', async () => {
    await attempted({}, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [
          '00000000-0000-4000-8000-000000000099',
        ]),
      ).rejects.toThrow(/no job_run/i);
    });
  });

  it('refuses a job of the wrong type', async () => {
    const job = await seedJob('platform.some.other.job');
    await attempted({}, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
      ).rejects.toThrow(/is a platform\.some\.other\.job job, not/i);
    });
  });

  it('refuses a job belonging to another actor', async () => {
    const job = await seedJob(JOB_NAME, 'someone-else');
    await attempted({}, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [job]),
      ).rejects.toThrow(/belongs to another actor/i);
    });
  });
});

describe('a successful run is accountable and atomic', () => {
  it('deletes, audits once, and closes the job', async () => {
    const job = await seedJob();
    await seedExpired('idem-expired-success');

    const result = await committed({}, (q) =>
      q<{ deleted: number; audit_event_id: string }>(
        'SELECT * FROM platform.maintenance_expire_idempotency_keys($1)',
        [job],
      ),
    );
    const auditEventId = result.rows[0]?.['audit_event_id'];
    expect(Number(result.rows[0]?.['deleted'])).toBeGreaterThanOrEqual(1);
    expect(auditEventId).toMatch(/^[0-9a-f-]{36}$/);

    const audit = await env.auditReader.query<{ count: string; event_id: string }>(
      `SELECT count(*)::text AS count, min(event_id::text) AS event_id
         FROM audit.platform_event WHERE action = $1`,
      [JOB_NAME],
    );
    expect(audit.rows[0]?.count).toBe('1');
    expect(audit.rows[0]?.event_id).toBe(auditEventId);

    const closed = await env.admin.query<{ state: string; finished_at: Date | null }>(
      'SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1',
      [job],
    );
    expect(closed.rows[0]?.state).toBe('succeeded');
    expect(closed.rows[0]?.finished_at).not.toBeNull();

    const alert = await env.admin.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM platform.operational_alert WHERE alert_code = 'MAINTENANCE_RUN'`,
    );
    expect(alert.rows[0]?.detail).toMatchObject({ auditEventId });
  });

  it('refuses to replay a completed job', async () => {
    const done = await env.admin.query<{ id: string }>(
      `SELECT job_run_id::text AS id FROM platform.job_run
        WHERE state = 'succeeded' AND job_name = $1 LIMIT 1`,
      [JOB_NAME],
    );
    await attempted({}, async (q) => {
      await expect(
        q('SELECT platform.maintenance_expire_idempotency_keys($1)', [done.rows[0]?.id]),
      ).rejects.toThrow(/already succeeded; a completed job cannot be replayed/i);
    });
  });

  it('lets only one of two concurrent invocations use a single job', async () => {
    const job = await seedJob();
    await seedExpired('idem-expired-concurrent');

    const poolA = new Pool({ connectionString: env.db.loginUrl('prsystem_worker_login'), max: 1 });
    const poolB = new Pool({ connectionString: env.db.loginUrl('prsystem_worker_login'), max: 1 });
    try {
      const invoke = async (pool: Pool): Promise<{ pid: number; ok: boolean }> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const [k, v] of [
            ['app.hotel_id', HOTEL],
            ['app.realm', 'hotel'],
            ['app.actor_ref', ACTOR],
            ['app.correlation_id', 'corr-concurrent'],
          ]) {
            await client.query('SELECT set_config($1, $2, true)', [k, v]);
          }
          const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          try {
            await client.query('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [
              job,
            ]);
            await client.query('COMMIT');
            return { pid: pid.rows[0]!.pid, ok: true };
          } catch {
            await client.query('ROLLBACK');
            return { pid: pid.rows[0]!.pid, ok: false };
          }
        } finally {
          client.release();
        }
      };

      const [a, b] = await Promise.all([invoke(poolA), invoke(poolB)]);
      expect(a.pid).not.toBe(b.pid);
      // The FOR UPDATE lock serialises them; the loser finds the job closed.
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }, 60000);
});

describe('an audit failure rolls the whole operation back', () => {
  it('leaves a pre-committed target row, the job, and telemetry untouched', async () => {
    // Seeded and COMMITTED first. The previous version of this test inserted the
    // target inside the very transaction it then rolled back, so "the row still
    // exists" was true no matter what the function did.
    const job = await seedJob();
    const key = await seedExpired('idem-expired-audit-fail');

    const before = await env.admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM platform.idempotency_key WHERE idempotency_key = $1',
      [key],
    );
    expect(before.rows[0]?.count).toBe('1');

    const alertsBefore = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.operational_alert
        WHERE alert_code = 'MAINTENANCE_RUN'`,
    );

    const month = new Date().toISOString().slice(0, 7);
    const partition = `platform_event_${month.replace('-', '_')}`;
    const nextMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
    )
      .toISOString()
      .slice(0, 10);

    // Detached in its own committed transaction, so the failure the function
    // hits is real and independent of the transaction under test.
    await env.admin.query(`ALTER TABLE audit.platform_event DETACH PARTITION audit.${partition}`);
    try {
      await attempted({}, async (q) => {
        await expect(
          q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [job]),
        ).rejects.toThrow(/no partition of relation/i);
      });
    } finally {
      await env.admin.query(
        `ALTER TABLE audit.platform_event ATTACH PARTITION audit.${partition}
           FOR VALUES FROM ('${month}-01') TO ('${nextMonth}')`,
      );
    }

    // The committed row survived, the job is still running, and nothing landed
    // in telemetry.
    const after = await env.admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM platform.idempotency_key WHERE idempotency_key = $1',
      [key],
    );
    expect(after.rows[0]?.count).toBe('1');

    const jobState = await env.admin.query<{ state: string; finished_at: Date | null }>(
      'SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1',
      [job],
    );
    expect(jobState.rows[0]?.state).toBe('running');
    expect(jobState.rows[0]?.finished_at).toBeNull();

    const alertsAfter = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.operational_alert
        WHERE alert_code = 'MAINTENANCE_RUN'`,
    );
    expect(alertsAfter.rows[0]?.count).toBe(alertsBefore.rows[0]?.count);
  }, 60000);
});
