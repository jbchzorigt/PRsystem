import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * SEC-SCHEDULER — D-09.
 *
 * Issuing a privileged maintenance job and executing one are different powers,
 * held by different credentials. The scheduler can create an authorisation but
 * cannot act on it; the worker can act on an authorisation but cannot create
 * one. Neither holds INSERT on `platform.job_run`, so the only way a privileged
 * job row exists is through `platform.schedule_maintenance_job`.
 *
 * Every assertion runs over a real LOGIN principal. None of it holds on a
 * superuser connection.
 */

const HOTEL = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const OTHER_HOTEL = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
const JOB_NAME = 'platform.maintenance.expire_idempotency_keys';
const SCHEDULER = 'actor-scheduler';
const EXECUTOR = 'actor-worker';

let env: ProvisionedDatabase;

interface Ctx {
  readonly hotel?: string;
  readonly realm?: string;
  readonly actor?: string;
}

/** One committed transaction on `pool`, with a trusted context applied. */
async function committed<T>(
  pool: Pool,
  ctx: Ctx,
  work: (
    q: (
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', ctx.hotel ?? HOTEL]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', ctx.realm ?? 'operation']);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.actor_ref',
      ctx.actor ?? SCHEDULER,
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.correlation_id', 'corr-sched']);
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

/** One transaction that is always rolled back, for probing refusals. */
async function attempted<T>(
  pool: Pool,
  ctx: Ctx,
  work: Parameters<typeof committed<T>>[2],
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', ctx.hotel ?? HOTEL]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', ctx.realm ?? 'operation']);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.actor_ref',
      ctx.actor ?? SCHEDULER,
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.correlation_id', 'corr-sched']);
    return await work((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Issues one job as the scheduler and returns its id. */
async function issue(hotel = HOTEL, executor = EXECUTOR): Promise<string> {
  return committed(env.jobScheduler, { hotel }, async (q) => {
    const row = await q('SELECT platform.schedule_maintenance_job($1, $2, $3)::text AS id', [
      JOB_NAME,
      hotel,
      executor,
    ]);
    return String(row.rows[0]?.['id']);
  });
}

/** Commits one expired idempotency row so the sweep has something to delete. */
async function seedExpired(key: string, hotel = HOTEL): Promise<void> {
  await committed(env.worker, { hotel, actor: EXECUTOR, realm: 'hotel' }, (q) =>
    q(
      `INSERT INTO platform.idempotency_key
         (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key, request_hash,
          state, response_status, completed_at, expires_at)
       VALUES ($1,'hotel','a','c','op.expire',$2, repeat('d',64),
               'succeeded', 200, now(), now() - interval '1 day')`,
      [hotel, key],
    ),
  );
}

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_scheduler');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('the scheduler issues, the worker executes', () => {
  it('issues one job, writes the issuer server-side and audits it', async () => {
    const id = await issue();

    const row = await env.admin.query<Record<string, unknown>>(
      `SELECT job_name, job_identity, issuer_ref, state, hotel_id::text AS hotel_id,
              finished_at, started_at
         FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    // Every authorisation-bearing column is what the function decided, not what
    // a caller supplied: the issuer is the transaction actor, the state and the
    // start time are server-side.
    expect(row.rows[0]).toMatchObject({
      job_name: JOB_NAME,
      job_identity: EXECUTOR,
      issuer_ref: SCHEDULER,
      state: 'running',
      hotel_id: HOTEL,
      finished_at: null,
    });
    expect(row.rows[0]?.['started_at']).not.toBeNull();

    const audit = await env.auditReader.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.platform_event
        WHERE target_ref = $1 AND action = 'platform.maintenance.scheduled'`,
      [id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('lets the worker execute an issued job exactly once', async () => {
    const id = await issue();
    await seedExpired('idem-sched-exec');

    const first = await committed(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );
    expect(Number(first.rows[0]?.['deleted'])).toBeGreaterThan(0);

    // The job is terminal, and a replay is refused rather than repeated.
    const after = await env.admin.query<Record<string, unknown>>(
      `SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(after.rows[0]?.['state']).toBe('succeeded');
    expect(after.rows[0]?.['finished_at']).not.toBeNull();

    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('the worker cannot issue its own authorisation', () => {
  it('holds no INSERT on job_run at all', async () => {
    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
        q(
          `INSERT INTO platform.job_run (hotel_id, job_name, job_identity, issuer_ref)
           VALUES ($1, $2, $3, $4)`,
          [HOTEL, JOB_NAME, EXECUTOR, EXECUTOR],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot execute the scheduling function', async () => {
    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('is refused categorically when it names the privileged namespace', async () => {
    // The worker's own job path exists, and rejects the whole namespace rather
    // than one job name, so a second maintenance operation added later cannot
    // become worker-creatable by omission.
    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
        q('SELECT platform.begin_worker_job($1, $2)', ['platform.maintenance.anything', HOTEL]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('can still start an ordinary, non-privileged job', async () => {
    // The positive control: the constrained path is a real replacement for the
    // INSERT grant, not a removal of the capability.
    const id = await committed(env.worker, { actor: EXECUTOR, realm: 'hotel' }, async (q) => {
      const row = await q('SELECT platform.begin_worker_job($1, $2)::text AS id', [
        'platform.projection.rebuild',
        HOTEL,
      ]);
      return String(row.rows[0]?.['id']);
    });

    const row = await env.admin.query<Record<string, unknown>>(
      `SELECT job_name, job_identity, issuer_ref, state FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    // No issuer: an ordinary job authorises nothing privileged.
    expect(row.rows[0]).toMatchObject({
      job_name: 'platform.projection.rebuild',
      job_identity: EXECUTOR,
      issuer_ref: null,
      state: 'running',
    });
  });

  it('cannot execute a privileged job that no scheduler issued', async () => {
    // Defence in depth. The table constraint already makes an issuer-less
    // privileged row impossible, so the constraint is dropped for the length of
    // this test to reach the function's own check behind it.
    await env.admin.query(
      `ALTER TABLE platform.job_run DROP CONSTRAINT job_run_privileged_has_issuer`,
    );
    try {
      const unissued = await env.admin.connect();
      let id: string;
      try {
        await unissued.query('BEGIN');
        await unissued.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
        const row = await unissued.query<{ id: string }>(
          `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
           VALUES ($1, $2, $3) RETURNING job_run_id::text AS id`,
          [HOTEL, JOB_NAME, EXECUTOR],
        );
        await unissued.query('COMMIT');
        id = String(row.rows[0]?.id);
      } finally {
        unissued.release();
      }

      await expect(
        attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
          q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // The probe row would fail the constraint being restored below, so it goes
      // first. Leaving it would silently disable the constraint for every later
      // test in this file.
      await env.admin.query(`DELETE FROM platform.job_run WHERE job_run_id = $1`, [id]);
    } finally {
      await env.admin.query(
        `ALTER TABLE platform.job_run ADD CONSTRAINT job_run_privileged_has_issuer
           CHECK (job_name NOT LIKE 'platform.maintenance.%' OR issuer_ref IS NOT NULL)`,
      );
    }
  });

  it('is refused by the table constraint when the issuer is absent', async () => {
    // The primary barrier, stated on its own.
    const client = await env.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      await expect(
        client.query(
          `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
           VALUES ($1, $2, $3)`,
          [HOTEL, JOB_NAME, EXECUTOR],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('the scheduler can do nothing but issue', () => {
  it('cannot execute the maintenance function it authorises', async () => {
    const id = await issue();
    await expect(
      attempted(env.jobScheduler, {}, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot read or write job_run directly', async () => {
    for (const [sql, values] of [
      ['SELECT job_run_id FROM platform.job_run', []],
      [`UPDATE platform.job_run SET state = 'failed'`, []],
      [`DELETE FROM platform.job_run`, []],
    ] as const) {
      await expect(
        attempted(env.jobScheduler, {}, (q) => q(sql, [...values])),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('no other principal may schedule', () => {
  const callers = [
    ['api', () => env.api] as const,
    ['police', () => env.police] as const,
    ['audit reader', () => env.auditReader] as const,
    ['police audit reader', () => env.policeAuditReader] as const,
  ];

  for (const [name, pool] of callers) {
    it(`refuses ${name}`, async () => {
      await expect(
        attempted(pool(), { realm: 'hotel' }, (q) =>
          q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  }
});

describe('the scheduling function validates what it is given', () => {
  it('refuses a job type that is not allow-listed', async () => {
    await expect(
      attempted(env.jobScheduler, {}, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [
          'platform.maintenance.something_else',
          HOTEL,
          EXECUTOR,
        ]),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses a missing executor identity', async () => {
    await expect(
      attempted(env.jobScheduler, {}, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, '']),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses the police realm', async () => {
    await expect(
      attempted(env.jobScheduler, { realm: 'police' }, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an unestablished transaction context', async () => {
    const client = await env.jobScheduler.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query('SELECT platform.schedule_maintenance_job($1, $2, $3)', [
          JOB_NAME,
          HOTEL,
          EXECUTOR,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('execution authorisation is exact', () => {
  it('refuses a worker whose identity is not the named executor', async () => {
    const id = await issue(HOTEL, 'someone-else');
    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a job issued for another tenant', async () => {
    const foreign = await issue(OTHER_HOTEL);
    await expect(
      attempted(env.worker, { actor: EXECUTOR, realm: 'hotel', hotel: HOTEL }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [foreign]),
      ),
    ).rejects.toMatchObject({ code: '22023' });

    const row = await env.admin.query<Record<string, unknown>>(
      `SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1`,
      [foreign],
    );
    expect(row.rows[0]).toMatchObject({ state: 'running', finished_at: null });
  });
});

describe('atomicity', () => {
  /**
   * Detaches the audit partition covering `now()` so an audit append fails, and
   * reattaches it with its own recorded bounds afterwards.
   *
   * The bounds come from the catalogue rather than being recomputed: attaching a
   * partition with bounds that merely look right is how a restore ends up
   * overlapping a neighbour and poisoning every later test in the file.
   */
  async function withBrokenAudit(run: () => Promise<void>): Promise<void> {
    const partition = await env.admin.query<{ name: string; bound: string }>(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = 'audit' AND p.relname = 'platform_event'
          AND c.relname = 'platform_event_' || to_char(now(), 'YYYY_MM')`,
    );
    const found = partition.rows[0];
    if (found === undefined) throw new Error('no audit partition covers now()');

    await env.admin.query(`ALTER TABLE audit.platform_event DETACH PARTITION audit.${found.name}`);
    try {
      await run();
    } finally {
      await env.admin.query(
        `ALTER TABLE audit.platform_event ATTACH PARTITION audit.${found.name} ${found.bound}`,
      );
    }
  }

  it('rolls back job creation when the scheduling audit fails', async () => {
    const before = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.job_run WHERE hotel_id = $1`,
      [HOTEL],
    );

    await withBrokenAudit(async () => {
      await expect(issue()).rejects.toThrow();
    });

    const after = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.job_run WHERE hotel_id = $1`,
      [HOTEL],
    );
    // No job row survives an audit failure: issuing and recording the issue are
    // one transaction, so an unrecorded authorisation cannot exist.
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));
  });

  it('rolls back the sweep and the terminal transition when the execution audit fails', async () => {
    const id = await issue();
    await seedExpired('idem-sched-atomic');

    await withBrokenAudit(async () => {
      await expect(
        attempted(env.worker, { actor: EXECUTOR, realm: 'hotel' }, (q) =>
          q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
        ),
      ).rejects.toThrow();
    });

    // The row it would have deleted is still there…
    const key = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.idempotency_key
        WHERE hotel_id = $1 AND idempotency_key = 'idem-sched-atomic'`,
      [HOTEL],
    );
    expect(Number(key.rows[0]?.n)).toBe(1);

    // …and the job never moved to a terminal state.
    const job = await env.admin.query<Record<string, unknown>>(
      `SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(job.rows[0]).toMatchObject({ state: 'running', finished_at: null });
  });
});
