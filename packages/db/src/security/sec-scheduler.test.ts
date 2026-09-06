import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { TEST_LOGIN_PASSWORD, quietPool } from '@prsystem/testing';
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
/** Correlation metadata only. Authorisation compares `session_user`. */
const WORKER_ACTOR = 'actor_worker';
/** The authenticated principals. The scheduler issues; the worker executes. */
const SCHEDULER = 'prsystem_job_scheduler_login';
const EXECUTOR = 'prsystem_worker_login';
/**
 * A second job identity, for the cross-executor cases.
 *
 * A name on a controlled row, not a provisioned login. Phase 03 supports one
 * Worker login shared by every worker process, so creating a second one here
 * would be asserting against an arrangement the platform does not support.
 */
const OTHER_EXECUTOR = 'prsystem_worker_other_identity';

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
  await committed(env.worker, { hotel, actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
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

/**
 * A running job belonging to some other identity, written directly.
 *
 * Deliberately not scheduled and not begun through a second login: only the
 * canonical Worker login may do either. What these cases need is a job whose
 * `job_identity` is not this connection's, and a controlled row gives exactly
 * that without implying a second Worker login is supported.
 */
async function seedControlledJob(
  identity: string,
  jobName: string = JOB_NAME,
  hotel: string = HOTEL,
): Promise<string> {
  const privileged = jobName.startsWith('platform.maintenance.');
  const row = await env.admin.query<{ id: string }>(
    `INSERT INTO platform.job_run (hotel_id, job_name, job_identity, issuer_ref, state, started_at)
     VALUES ($1, $2, $3, $4, 'running', pg_catalog.now())
     RETURNING job_run_id::text AS id`,
    [hotel, jobName, identity, privileged ? SCHEDULER : null],
  );
  return String(row.rows[0]?.id);
}

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

    const first = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
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
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('the worker cannot issue its own authorisation', () => {
  it('holds no INSERT on job_run at all', async () => {
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
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
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('is refused categorically when it names the privileged namespace', async () => {
    // The worker's own job path exists, and rejects the whole namespace rather
    // than one job name, so a second maintenance operation added later cannot
    // become worker-creatable by omission.
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT platform.begin_worker_job($1, $2)', ['platform.maintenance.anything', HOTEL]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('can still start an ordinary, non-privileged job', async () => {
    // The positive control: the constrained path is a real replacement for the
    // INSERT grant, not a removal of the capability.
    const id = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, async (q) => {
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
        attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
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
    const id = await seedControlledJob(OTHER_EXECUTOR);
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a job issued for another tenant', async () => {
    const foreign = await issue(OTHER_HOTEL);
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel', hotel: HOTEL }, (q) =>
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
        attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
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

describe('authorisation is bound to the credential, not to a claim', () => {
  it('cannot impersonate an issuer by rewriting app.actor_ref', async () => {
    // `app.actor_ref` is a custom GUC the connection can set to anything. The
    // issuer recorded must be the authenticated principal regardless.
    const id = await committed(env.jobScheduler, { actor: 'somebody_else_entirely' }, async (q) => {
      const row = await q('SELECT platform.schedule_maintenance_job($1, $2, $3)::text AS id', [
        JOB_NAME,
        HOTEL,
        EXECUTOR,
      ]);
      return String(row.rows[0]?.['id']);
    });

    const stored = await env.admin.query<{ issuer_ref: string }>(
      `SELECT issuer_ref FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(stored.rows[0]?.issuer_ref).toBe(SCHEDULER);
    expect(stored.rows[0]?.issuer_ref).not.toBe('somebody_else_entirely');
  });

  it('cannot impersonate an executor by rewriting app.actor_ref', async () => {
    const id = await seedControlledJob(OTHER_EXECUTOR);
    await seedExpired('idem_impersonation_probe');

    // The worker connection claims to be the named executor. It is not: its
    // session_user is prsystem_worker_login, and that is what is compared.
    await expect(
      attempted(env.worker, { actor: OTHER_EXECUTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the canonical worker a job assigned to another identity', async () => {
    // The job names one principal, and only that principal may execute it.
    // Being the canonical Worker login is necessary, not sufficient.
    const id = await seedControlledJob(OTHER_EXECUTOR);
    await seedExpired('idem_cross_executor');

    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // And the job is untouched, still awaiting its own executor.
    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(state.rows[0]?.state).toBe('running');
  });

  it('refuses to schedule for a tenant other than the established scope', async () => {
    // The insert would also be refused by FORCE RLS; the function states the
    // rule so the failure is diagnosable rather than a policy violation.
    await expect(
      attempted(env.jobScheduler, { hotel: HOTEL }, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [
          JOB_NAME,
          OTHER_HOTEL,
          EXECUTOR,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an executor that is not a Worker principal at all', async () => {
    for (const candidate of ['prsystem_api_login', 'prsystem_job_scheduler_login', 'not_a_role']) {
      await expect(
        attempted(env.jobScheduler, {}, (q) =>
          q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, candidate]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

/** Runs one statement as the table owner, where the trigger and CHECKs apply. */
async function asOwner(sql: string, values: unknown[] = []): Promise<unknown> {
  const client = await env.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
    const result = await client.query(sql, values);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('terminal jobs and their evidence are frozen', () => {
  it('refuses to rewrite the finish time of a completed job', async () => {
    const id = await issue();
    await seedExpired('idem_freeze_probe');
    await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );

    // The worker has no UPDATE at all now, so it is refused on the grant …
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q(`UPDATE platform.job_run SET finished_at = now() WHERE job_run_id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // … and the freeze still holds for a principal that *can* write the table.
    await expect(
      asOwner(`UPDATE platform.job_run SET finished_at = now() WHERE job_run_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses to attach an error name to a succeeded job', async () => {
    const id = await issue();
    await seedExpired('idem_freeze_probe_2');
    await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );

    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q(`UPDATE platform.job_run SET error_name = 'rewritten' WHERE job_run_id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asOwner(`UPDATE platform.job_run SET error_name = 'rewritten' WHERE job_run_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('bounded shapes', () => {
  it('refuses an over-long or malformed job name', async () => {
    const client = await env.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      for (const name of ['x', 'Platform.Bad.Case', 'a'.repeat(200)]) {
        await expect(
          client.query(
            `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
             VALUES ($1, $2, 'prsystem_worker_login')`,
            [HOTEL, name],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', HOTEL]);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('refuses an over-long error name', async () => {
    // Exercised as the table owner: the worker cannot write the column at all
    // now, so the CHECK would never be reached through it.
    const id = await issue();
    await expect(
      asOwner(
        `UPDATE platform.job_run SET state = 'failed', finished_at = now(), error_name = $2
          WHERE job_run_id = $1`,
        [id, 'e'.repeat(200)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('R7 — the role graph is validated at invocation time', () => {
  const DUAL = 'prsystem_dual_role_login';
  const OVERPRIVILEGED = 'prsystem_overprivileged_login';

  it('refuses a login holding both Scheduler and Worker powers', async () => {
    // Bootstrap normalises memberships, but nothing stopped an operator adding a
    // second group afterwards: the functions trusted the graph as of the last
    // bootstrap rather than as of the call.
    await env.admin.query(`DROP ROLE IF EXISTS ${DUAL}`);
    await env.admin.query(`CREATE ROLE ${DUAL} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT`);
    await env.admin.query(
      `GRANT prsystem_job_scheduler TO ${DUAL} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
    await env.admin.query(
      `GRANT prsystem_worker TO ${DUAL} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
    const dual = quietPool({ connectionString: env.db.loginUrl(DUAL), max: 1 }, 'dual');
    try {
      // It can reach both powers, which is the separation D-09 exists to make
      // impossible. Issuing is refused …
      await expect(
        attempted(dual, {}, (q) =>
          q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // … and so is executing a job that a legitimate scheduler issued.
      const id = await issue();
      await expect(
        attempted(dual, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await dual.end();
      await env.admin.query(`DROP OWNED BY ${DUAL}`).catch(() => undefined);
      await env.admin.query(`DROP ROLE IF EXISTS ${DUAL}`).catch(() => undefined);
    }
  }, 60000);

  it('refuses a Worker login that also reaches a predefined role', async () => {
    await env.admin.query(`DROP ROLE IF EXISTS ${OVERPRIVILEGED}`);
    await env.admin.query(
      `CREATE ROLE ${OVERPRIVILEGED} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT`,
    );
    await env.admin.query(
      `GRANT prsystem_worker TO ${OVERPRIVILEGED} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
    const over = quietPool({ connectionString: env.db.loginUrl(OVERPRIVILEGED), max: 1 }, 'over');
    try {
      // Issued while the login is still clean, then escalated. The execution
      // check must see the graph as it is *now*, not as it was at issue time.
      const id = await seedControlledJob(OVERPRIVILEGED);
      await env.admin.query(`GRANT pg_read_all_data TO ${OVERPRIVILEGED}`);
      await expect(
        attempted(over, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await over.end();
      await env.admin.query(`DROP OWNED BY ${OVERPRIVILEGED}`).catch(() => undefined);
      await env.admin.query(`DROP ROLE IF EXISTS ${OVERPRIVILEGED}`).catch(() => undefined);
    }
  }, 60000);

  it('refuses to schedule for an executor that is over-privileged', async () => {
    await env.admin.query(`DROP ROLE IF EXISTS ${OVERPRIVILEGED}`);
    await env.admin.query(
      `CREATE ROLE ${OVERPRIVILEGED} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT`,
    );
    await env.admin.query(
      `GRANT prsystem_worker TO ${OVERPRIVILEGED} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
    await env.admin.query(`ALTER ROLE ${OVERPRIVILEGED} BYPASSRLS`);
    try {
      await expect(
        attempted(env.jobScheduler, {}, (q) =>
          q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [
            JOB_NAME,
            HOTEL,
            OVERPRIVILEGED,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await env.admin.query(`ALTER ROLE ${OVERPRIVILEGED} NOBYPASSRLS`).catch(() => undefined);
      await env.admin.query(`DROP OWNED BY ${OVERPRIVILEGED}`).catch(() => undefined);
      await env.admin.query(`DROP ROLE IF EXISTS ${OVERPRIVILEGED}`).catch(() => undefined);
    }
  }, 60000);

  it('still accepts the canonical principals', async () => {
    // The positive control: the checks above must reject drift, not everything.
    const id = await issue();
    await seedExpired('idem_invocation_control');
    const result = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );
    expect(Number(result.rows[0]?.['deleted'])).toBeGreaterThan(0);
  }, 60000);
});

describe('R7 — a Worker cannot forge job completion', () => {
  it("cannot terminalize another identity's ordinary job", async () => {
    // A controlled row: job_identity is immutable, so what matters is only that
    // it is not this connection's principal.
    {
      const id = await seedControlledJob(OTHER_EXECUTOR, 'platform.projection.other_identity');

      // Direct UPDATE is refused on the grant …
      await expect(
        attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q(
            `UPDATE platform.job_run SET state = 'succeeded', finished_at = now()
              WHERE job_run_id = $1`,
            [id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // … and the narrow function refuses it too, because the job is not this
      // principal's. Without this, revoking UPDATE would only move the hole.
      await expect(
        attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT platform.finish_worker_job($1, $2, $3)', [id, 'succeeded', null]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const state = await env.admin.query<{ state: string }>(
        `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
        [id],
      );
      expect(state.rows[0]?.state).toBe('running');
    }
  }, 60000);

  it('cannot mark a privileged job succeeded without running its maintenance function', async () => {
    const id = await issue();
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q(
          `UPDATE platform.job_run SET state = 'succeeded', finished_at = now()
            WHERE job_run_id = $1`,
          [id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(state.rows[0]?.state).toBe('running');
  }, 60000);

  it('can finish its own ordinary job through the narrow function', async () => {
    // The positive control: ordinary transitions remain possible, through a
    // path that records who did them.
    const id = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, async (q) => {
      const row = await q('SELECT platform.begin_worker_job($1, $2)::text AS id', [
        'platform.projection.own_job',
        HOTEL,
      ]);
      return String(row.rows[0]?.['id']);
    });

    await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT platform.finish_worker_job($1, $2, $3)', [id, 'succeeded', null]),
    );

    const state = await env.admin.query<Record<string, unknown>>(
      `SELECT state, finished_at FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(state.rows[0]?.['state']).toBe('succeeded');
    expect(state.rows[0]?.['finished_at']).not.toBeNull();
  }, 60000);
});

describe('R8 — the expected group is validated, not only the login', () => {
  /**
   * A clean login inside a compromised group is still a compromised principal.
   *
   * The invocation-time check validated the *login* — LOGIN set, no privileged
   * attribute, exactly one membership — and then took the group on trust. An
   * operator who altered `prsystem_worker` or `prsystem_job_scheduler` itself
   * changed what every member could do, and nothing in the scheduling or
   * execution path noticed. Attributes are not inherited in PostgreSQL, so the
   * member's own catalogue row looks untouched: the group has to be inspected
   * directly or the drift is invisible.
   */
  const GROUP_MUTATIONS = [
    { attribute: 'LOGIN', reset: 'NOLOGIN' },
    { attribute: 'BYPASSRLS', reset: 'NOBYPASSRLS' },
    { attribute: 'CREATEROLE', reset: 'NOCREATEROLE' },
  ] as const;

  for (const { attribute, reset } of GROUP_MUTATIONS) {
    it(`refuses scheduling when prsystem_job_scheduler holds ${attribute}`, async () => {
      await env.admin.query(`ALTER ROLE prsystem_job_scheduler ${attribute}`);
      try {
        await expect(
          attempted(env.jobScheduler, {}, (q) =>
            q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await env.admin.query(`ALTER ROLE prsystem_job_scheduler ${reset}`);
      }
    }, 60000);

    it(`refuses scheduling and execution when prsystem_worker holds ${attribute}`, async () => {
      // Issued while the graph is still clean, so the refusal below is the
      // execution-time check seeing the group as it is now.
      const id = await issue();
      await env.admin.query(`ALTER ROLE prsystem_worker ${attribute}`);
      try {
        await expect(
          attempted(env.jobScheduler, {}, (q) =>
            q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
          ),
        ).rejects.toMatchObject({ code: '42501' });

        await expect(
          attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
            q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await env.admin.query(`ALTER ROLE prsystem_worker ${reset}`);
      }
    }, 60000);
  }

  it('refuses when the expected group has acquired a membership of its own', async () => {
    // A group that reaches a predefined role hands that reach to every member.
    await env.admin.query(`GRANT pg_read_all_data TO prsystem_worker`);
    try {
      await expect(
        attempted(env.jobScheduler, {}, (q) =>
          q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXECUTOR]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await env.admin.query(`REVOKE pg_read_all_data FROM prsystem_worker`);
    }
  }, 60000);

  it('still accepts the canonical groups once the drift is reverted', async () => {
    // The positive control: every mutation above is reverted in its own
    // `finally`, so a green run here proves the checks reject drift rather
    // than rejecting everything.
    const id = await issue();
    await seedExpired('idem_group_control');
    const result = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );
    expect(Number(result.rows[0]?.['deleted'])).toBeGreaterThan(0);
  }, 60000);
});

describe('R8 — only the canonical Worker login may execute', () => {
  /**
   * Phase 03 supports one Worker login, shared by every worker process.
   *
   * Membership in `prsystem_worker` was the whole test, so any login an
   * operator granted the group became a schedulable executor. That made the
   * supported set open-ended: the runbook claimed arbitrary deployment-managed
   * Worker logins were supported, while nothing bootstrapped, rotated or
   * audited them.
   */
  const EXTRA_WORKER = 'prsystem_worker_extra_login';

  beforeAll(async () => {
    await env.admin.query(`DROP ROLE IF EXISTS ${EXTRA_WORKER}`);
    await env.admin.query(
      `CREATE ROLE ${EXTRA_WORKER} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT`,
    );
    await env.admin.query(
      `GRANT prsystem_worker TO ${EXTRA_WORKER} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
  }, 60000);

  afterAll(async () => {
    await env.admin.query(`DROP OWNED BY ${EXTRA_WORKER}`).catch(() => undefined);
    await env.admin.query(`DROP ROLE IF EXISTS ${EXTRA_WORKER}`).catch(() => undefined);
  }, 30000);

  it('refuses to schedule for a Worker-group login that is not the canonical one', async () => {
    await expect(
      attempted(env.jobScheduler, {}, (q) =>
        q('SELECT platform.schedule_maintenance_job($1, $2, $3)', [JOB_NAME, HOTEL, EXTRA_WORKER]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 60000);

  it('refuses to start an ordinary job as a non-canonical Worker-group login', async () => {
    const extra = quietPool(
      { connectionString: env.db.loginUrl(EXTRA_WORKER), max: 1 },
      'extra-worker',
    );
    try {
      await expect(
        attempted(extra, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT platform.begin_worker_job($1, $2)', ['platform.projection.extra', HOTEL]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await extra.end();
    }
  }, 60000);

  it('still accepts the canonical Worker login', async () => {
    const id = await issue();
    await seedExpired('idem_canonical_control');
    const result = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT * FROM platform.maintenance_expire_idempotency_keys($1)', [id]),
    );
    expect(Number(result.rows[0]?.['deleted'])).toBeGreaterThan(0);
  }, 60000);
});

describe('R9 — finish_worker_job revalidates the canonical Worker closure', () => {
  /**
   * `finish_worker_job` checked the realm and `job_identity = session_user`, and
   * never called `platform.assert_exact_role_closure`. Identity alone is not
   * authorisation: a login that had acquired extra reach since its job began, or
   * a non-canonical login that had created a row naming itself, still satisfied
   * `job_identity = session_user` and could terminalise the job.
   */
  const EXTRA_WORKER = 'prsystem_worker_extra2_login';

  beforeAll(async () => {
    await env.admin.query(`DROP ROLE IF EXISTS ${EXTRA_WORKER}`);
    await env.admin.query(
      `CREATE ROLE ${EXTRA_WORKER} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' INHERIT`,
    );
    await env.admin.query(
      `GRANT prsystem_worker TO ${EXTRA_WORKER} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`,
    );
  }, 60000);

  afterAll(async () => {
    await env.admin.query(`DROP OWNED BY ${EXTRA_WORKER}`).catch(() => undefined);
    await env.admin.query(`DROP ROLE IF EXISTS ${EXTRA_WORKER}`).catch(() => undefined);
  }, 30000);

  it('refuses a non-canonical Worker-group login finishing a job assigned to itself', async () => {
    // The row is controlled, so `job_identity = session_user` genuinely holds:
    // the only thing standing between this login and a completed job is the
    // closure check.
    const id = await seedControlledJob(EXTRA_WORKER, 'platform.projection.extra_finish');
    const extra = quietPool(
      { connectionString: env.db.loginUrl(EXTRA_WORKER), max: 1 },
      'extra-finisher',
    );
    try {
      await expect(
        attempted(extra, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT platform.finish_worker_job($1, $2, $3)', [id, 'succeeded', null]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const state = await env.admin.query<{ state: string }>(
        `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
        [id],
      );
      expect(state.rows[0]?.state).toBe('running');
    } finally {
      await extra.end();
    }
  }, 60000);

  it('refuses the canonical Worker once it has gained a predefined role', async () => {
    const id = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, async (q) => {
      const row = await q('SELECT platform.begin_worker_job($1, $2)::text AS id', [
        'platform.projection.escalated',
        HOTEL,
      ]);
      return String(row.rows[0]?.['id']);
    });

    // Started clean, escalated afterwards. The finish check must see the graph
    // as it is now, not as it was when the job began.
    await env.admin.query(`GRANT pg_read_all_data TO ${EXECUTOR}`);
    try {
      await expect(
        attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
          q('SELECT platform.finish_worker_job($1, $2, $3)', [id, 'succeeded', null]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await env.admin.query(`REVOKE pg_read_all_data FROM ${EXECUTOR}`).catch(() => undefined);
    }

    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(state.rows[0]?.state).toBe('running');
  }, 60000);

  it('still lets the clean canonical Worker finish its own ordinary job', async () => {
    const id = await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, async (q) => {
      const row = await q('SELECT platform.begin_worker_job($1, $2)::text AS id', [
        'platform.projection.clean_finish',
        HOTEL,
      ]);
      return String(row.rows[0]?.['id']);
    });

    await committed(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
      q('SELECT platform.finish_worker_job($1, $2, $3)', [id, 'succeeded', null]),
    );

    const state = await env.admin.query<{ state: string }>(
      `SELECT state FROM platform.job_run WHERE job_run_id = $1`,
      [id],
    );
    expect(state.rows[0]?.state).toBe('succeeded');
  }, 60000);
});

describe('R9 — every Worker or Scheduler entry point states its invocation-time guard', () => {
  /**
   * The complete catalogue of SECURITY DEFINER functions a Worker or Scheduler
   * credential can execute, and what each one checks when it is called.
   *
   * `finish_worker_job` was the gap: it checked the realm and
   * `job_identity = session_user` and validated no closure at all. Enumerating
   * the whole set here means a definer added later, or a grant widened later,
   * fails this test instead of arriving unguarded and unnoticed.
   *
   * Three of the seven deliberately do *not* run the role-closure check, and
   * saying which is the point of the catalogue. Requiring a Worker closure of
   * the shared audit wrapper would break the API and Police runtimes that also
   * hold it; requiring one of the partition helpers would say the guard is
   * something it is not. Each of those states the guard it actually applies.
   */
  const ENTRY_POINTS = [
    {
      signature:
        'platform.schedule_maintenance_job(p_job_name text, p_hotel_id uuid, p_executor_identity text)',
      grantee: 'prsystem_job_scheduler',
      closure: true,
      guard:
        'role closure for prsystem_job_scheduler, plus a closure check on the named executor ' +
        'and p_hotel_id = current_hotel_id()',
    },
    {
      signature: 'platform.begin_worker_job(p_job_name text, p_hotel_id uuid)',
      grantee: 'prsystem_worker',
      closure: true,
      guard: 'role closure for prsystem_worker; refuses the platform.maintenance.% namespace',
    },
    {
      signature: 'platform.finish_worker_job(p_job_run_id uuid, p_state text, p_error_name text)',
      grantee: 'prsystem_worker',
      closure: true,
      guard:
        'role closure for prsystem_worker, then job_identity = session_user, the privileged ' +
        'namespace refused, and the job still running',
    },
    {
      signature: 'platform.maintenance_expire_idempotency_keys(p_job_run_id uuid)',
      grantee: 'prsystem_worker',
      closure: true,
      guard:
        'role closure for prsystem_worker, then the exact job name, the assigned identity, the ' +
        'established tenant, and a running job locked FOR UPDATE',
    },
    {
      signature:
        'audit.append_platform_audit_event(p_action text, p_outcome text, p_target_type text, p_target_ref text, p_reason text, p_payload jsonb)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure by design — the shared audit wrapper is also held by the API and Police ' +
        'runtimes. It takes no identity or tenant argument and derives realm, actor and hotel from ' +
        'the transaction context server-side; it can only append',
    },
    {
      signature:
        'platform.ensure_month_partitions(p_schema text, p_table text, p_from timestamp with time zone, p_months integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — an allow-list of exactly the two audit streams, so it cannot become a ' +
        'general CREATE TABLE primitive, plus bounded p_months and a per-stream advisory lock',
    },
    {
      signature: 'platform.check_partition_horizon(p_threshold integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — reads the horizon of the two audit streams and raises an operational ' +
        'alert; writes nothing else and takes only a bounded threshold',
    },
    {
      // Phase 13. The expiry sweep has to see lapsed holds across every hotel
      // before it can settle any of them in one, so the discovery crosses the
      // tenant boundary the same narrow way Phase 05's wrappers do.
      signature: 'platform.lapsed_booking_holds(p_limit integer, p_now timestamp with time zone)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — it reads only bookings whose ten-minute hold has already lapsed and ' +
        'answers two identifiers per row. It writes nothing, and the settling it feeds happens ' +
        "in the hotel's own scope on the booking's own lock",
    },
    {
      // Phase 14. Both jobs have the same shape as the expiry sweep: work
      // waiting in every hotel has to be found before any of it can be done in
      // one, and each answers identifiers and nothing else.
      signature: 'platform.open_booking_refunds(p_limit integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — it reads only refunds still REQUIRED or PENDING, confined to exactly ' +
        'those by a policy on the owner, and answers two identifiers per row. The execution ' +
        "happens in the hotel's own scope on the refund's own lock",
    },
    {
      signature: 'platform.due_payout_batches(p_limit integer, p_now timestamp with time zone)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — it reads only payables that are ELIGIBLE or ADJUSTMENT_DUE, confined ' +
        'by a policy on the owner, and answers a hotel and a batch date. The batch is assembled ' +
        "in the hotel's own scope on the payables' own locks",
    },
    {
      // Phase 15. The two restaurant sweeps, in the same shape: waiting work in
      // every hotel has to be found before any of it can be settled in one.
      signature:
        'platform.lapsed_restaurant_invoices(p_limit integer, p_now timestamp with time zone)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — it reads only payment attempts still ACTIVE whose window has closed, ' +
        'confined to those by a policy on the owner, and answers two identifiers per row. The ' +
        "settling happens in the hotel's own scope on the order's own lock",
    },
    {
      signature:
        'platform.unresolved_refund_requests(p_limit integer, p_now timestamp with time zone)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — it reads only orders whose refund request is still OPEN or APPROVED, ' +
        'confined to those by a policy on the owner, and answers three identifiers per row. The ' +
        "escalation and the link pause happen in the hotel's own scope on their own locks",
    },
    // Phase 05's three boundary-worker discovery wrappers. Each exists for the
    // same reason: the rows a worker must find live behind a tenant policy, and
    // a worker outside any tenant scope cannot see them to find out which tenant
    // to enter. They are the narrowest possible answer to that — read-only, and
    // they return identifiers and nothing else.
    {
      signature: 'platform.due_upgrade_boundaries(p_limit integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a STABLE reader that returns only (hotel_id, subscription_id) for a ' +
        'pending upgrade already due on the server clock, with a bounded limit. It writes ' +
        'nothing: the entitlement is applied afterwards under the hotel scope and a row lock',
    },
    {
      signature: 'platform.pending_activation_deliveries(p_limit integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a STABLE reader that returns only (hotel_id, delivery_id) for an ' +
        'unclaimed or lease-expired delivery, with a bounded limit. It exposes no address, no ' +
        'token and no payload, and the claim itself is a CAS under the hotel scope',
    },
    {
      signature: 'platform.pending_ebarimt_issuances(p_limit integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a STABLE reader that returns only (hotel_id, issuance_id) for an ' +
        'unclaimed or lease-expired issuance, with a bounded limit. It exposes no receipt field ' +
        'and no amount, and the claim itself is a CAS under the hotel scope',
    },
    // Phase 05 remediation 2: the receipt's email is its own durable job.
    {
      signature: 'platform.pending_ebarimt_deliveries(p_limit integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a STABLE reader that returns only (hotel_id, issuance_id) for an ' +
        'issued receipt whose delivery is due and unclaimed, with a bounded limit. It exposes ' +
        'no address and no receipt field, and the claim itself is a CAS under the hotel scope',
    },
    // Phase 05 remediation 1: the durable provisioning job runs in the worker
    // deployment, so the worker holds the provisioning boundary and the two
    // probes the claim step needs, plus its own discovery wrapper.
    {
      signature:
        'platform.provision_paid_hotel(p_application_id uuid, p_idempotency_key text, p_owner_id uuid, p_owner_ciphertext bytea, p_owner_wrapped_dek bytea, p_owner_key_version text, p_activation_id uuid, p_token_hash text, p_token_key_version text, p_token_expires_at timestamp with time zone, p_secret_ciphertext bytea, p_secret_wrapped_dek bytea, p_secret_key_version text, p_claim_token uuid)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — the boundary re-derives every authorising fact from the rows it ' +
        'locks: a claimed PROVISIONING application, a PAID attempt matching its terms, a proved ' +
        'owner or a fresh registration number, a proved active account or a free email. It binds ' +
        'the tenant scope it mints and every row it writes satisfies the ordinary policy',
    },
    {
      signature:
        'platform.pending_provisioning_applications(p_limit integer, p_max_attempts integer)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a STABLE reader that returns only application ids whose job is due: ' +
        'unclaimed, lease-expired or unsettled, below the attempt cap, with a bounded limit. It ' +
        'writes nothing; the claim is a CAS on the row under the application scope',
    },
    {
      signature: 'platform.probe_subscription_owner(p_application_id uuid)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — answers an opaque owner reference, a masked destination and whether ' +
        'that owner holds another hotel; never the identifier and never the stored contact',
    },
    {
      signature: 'platform.probe_existing_hotel_account(p_application_id uuid)',
      grantee: 'prsystem_worker',
      closure: false,
      guard:
        'no role closure — a boolean, whether an account already holds the application’s admin ' +
        'email, so the claim step can route the application to proof; no account row is exposed',
    },
  ] as const;

  it('grants EXECUTE to a Worker or Scheduler on exactly the catalogued definers', async () => {
    const granted = await env.admin.query<{ signature: string; grantee: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' ||
                pg_get_function_identity_arguments(p.oid) || ')' AS signature,
              g.rolname AS grantee
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
         JOIN pg_roles g ON g.oid = acl.grantee
        WHERE p.prosecdef
          AND acl.privilege_type = 'EXECUTE'
          AND g.rolname IN ('prsystem_worker', 'prsystem_job_scheduler')
        ORDER BY 1, 2`,
    );

    // assert_exact_role_closure is granted to both so the wrappers can call it.
    // It is the guard itself, not a guarded entry point.
    const guarded = granted.rows.filter(
      (row) => !row.signature.startsWith('platform.assert_exact_role_closure'),
    );
    expect(guarded.map((row) => `${row.signature} -> ${row.grantee}`).sort()).toEqual(
      ENTRY_POINTS.map((entry) => `${entry.signature} -> ${entry.grantee}`).sort(),
    );
  });

  it('each catalogued definer matches the guard the catalogue claims for it', async () => {
    for (const entry of ENTRY_POINTS) {
      const open = entry.signature.indexOf('(');
      const name = entry.signature.slice(0, open);
      const args = entry.signature.slice(open + 1, entry.signature.lastIndexOf(')'));
      const body = await env.admin.query<{ src: string }>(
        `SELECT p.prosrc AS src
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname || '.' || p.proname = $1
            AND pg_get_function_identity_arguments(p.oid) = $2`,
        [name, args],
      );
      const src = body.rows[0]?.src ?? '';
      expect({
        signature: entry.signature,
        closure: /assert_exact_role_closure/.test(src),
      }).toEqual({ signature: entry.signature, closure: entry.closure });
    }
  });

  it('the two partition helpers really are confined to the audit streams', async () => {
    // The catalogue says the allow-list is the guard, so the allow-list is held
    // to that rather than taken on the comment's word.
    await expect(
      attempted(env.worker, { actor: WORKER_ACTOR, realm: 'hotel' }, (q) =>
        q('SELECT platform.ensure_month_partitions($1, $2, now(), 1)', ['platform', 'job_run']),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 60000);
});
