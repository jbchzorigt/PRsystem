import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS, createTestDatabase } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';
import { runMigrations } from '../migrate';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';
import { appendOutboxEvent, claimOutboxBatch, markOutboxPublished } from '../kernel/outbox';
import { withTenantTransaction } from '../unit-of-work';
import type { TenantContext } from '../tenant-context';

/**
 * Regression tests for the defects found in the second Phase 03 review.
 *
 * Each one reproduces a specific defect and fails against the code as it stood
 * before this repair. They are kept afterwards as the standing proof.
 */

const HOTEL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    hotelId: HOTEL,
    realm: 'hotel',
    actorRef: 'actor-regression',
    correlationId: 'corr-regression',
    ...overrides,
  };
}

const logins = (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
  principal,
  password: TEST_LOGIN_PASSWORD,
}));

describe('R1 — the migration CLI must require MIGRATION_DATABASE_URL', () => {
  const cli = readFileSync(resolve(__dirname, '..', 'cli.ts'), 'utf8');

  it('never reads DATABASE_URL', () => {
    // A migration CLI that falls back to the runtime connection string would run
    // as the API principal — which the guard then rejects, or worse, silently
    // accepts where that principal happens to be over-privileged.
    //
    // Comments are stripped first: the file explains *why* it does not fall
    // back, and a check that cannot tell prose from code would forbid saying so.
    const code = cli.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Two precise checks on how a value could actually be read. A blunt
    // "the string never appears" check would also forbid the error message that
    // tells an operator why the fallback does not exist.
    expect(code).not.toMatch(/process\.env\[['"]DATABASE_URL['"]\]/);
    expect(code).not.toMatch(/\benv\(\)\.DATABASE_URL\b/);
  });

  it('reads MIGRATION_DATABASE_URL', () => {
    expect(cli).toMatch(/MIGRATION_DATABASE_URL/);
  });
});

describe('R2 — two runners against a completely empty database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('regr_fresh_race');
    await bootstrapCluster({ adminUrl: db.url, database: db.name, logins });
  }, 120000);

  afterAll(async () => {
    await db.drop();
  }, 30000);

  it('both exit successfully: one applies the journal, the other observes it', async () => {
    const url = db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate);

    // The real race: nothing has been applied yet, so both runners believe they
    // must apply everything. Without a migration advisory lock they collide on
    // CREATE SCHEMA / CREATE TABLE.
    const [first, second] = await Promise.all([runMigrations(url), runMigrations(url)]);

    // The whole journal: 0000_baseline, 0001_kernel, 0002_iam_rbac_staff.
    expect(first.appliedAfter).toBe(3);
    expect(second.appliedAfter).toBe(3);
    // Exactly one of them did the applying.
    const applied = [first, second].filter((r) => r.appliedBefore === 0 && r.appliedAfter === 3);
    expect(applied).toHaveLength(1);
  }, 120000);
});

describe('R3 — kernel object ownership', () => {
  let env: ProvisionedDatabase;

  beforeAll(async () => {
    env = await provisionKernelDatabase('regr_ownership');
  }, 120000);

  afterAll(async () => {
    await env.close();
  }, 30000);

  it('never lets a *_login role own a kernel or ledger object', async () => {
    const owned = await env.admin.query<{ kind: string; name: string; owner: string }>(
      `SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS name,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform','audit','police_audit','police','drizzle')
          AND pg_get_userbyid(c.relowner) LIKE '%\\_login'
        UNION ALL
       SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('platform','audit','police_audit')
          AND pg_get_userbyid(p.proowner) LIKE '%\\_login'
        UNION ALL
       SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner)
         FROM pg_namespace n
        WHERE n.nspname IN ('platform','audit','police_audit','police','drizzle')
          AND pg_get_userbyid(n.nspowner) LIKE '%\\_login'`,
    );
    expect(owned.rows).toEqual([]);
  });
});

describe('R4 — a stale claimant must not acknowledge a reclaimed delivery', () => {
  let env: ProvisionedDatabase;

  beforeAll(async () => {
    env = await provisionKernelDatabase('regr_fencing');
  }, 120000);

  afterAll(async () => {
    await env.close();
  }, 30000);

  it('rejects worker A after worker B reclaims the lease', async () => {
    await withTenantTransaction(env.worker, ctx(), (uow) =>
      appendOutboxEvent(uow, {
        aggregateType: 'kernel_probe',
        aggregateId: 'fencing-1',
        eventType: 'kernel.probe.created',
        payload: { n: 1 },
      }),
    );

    const claimA = await withTenantTransaction(env.worker, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-A', 1, 1),
    );
    expect(claimA).toHaveLength(1);

    // A's lease expires.
    await withTenantTransaction(env.worker, ctx(), (uow) =>
      uow.query(
        `UPDATE platform.outbox_delivery SET claimed_until = now() - interval '1 minute'
          WHERE event_id = $1`,
        [claimA[0]?.eventId],
      ),
    );

    const claimB = await withTenantTransaction(env.worker, ctx(), (uow) =>
      claimOutboxBatch(uow, 'worker-B', 10),
    );
    const reclaimed = claimB.find((e) => e.eventId === claimA[0]?.eventId);
    expect(reclaimed).toBeDefined();

    // A now finishes its publish and tries to acknowledge. Without fencing it
    // would mark B's claim published and B's later acknowledgement would be a
    // second effect on the same delivery.
    const staleAck = await withTenantTransaction(env.worker, ctx(), (uow) =>
      markOutboxPublished(uow, claimA[0]!),
    );
    expect(staleAck).toEqual({ outcome: 'stale_claim' });

    const state = await withTenantTransaction(env.worker, ctx(), (uow) =>
      uow.query<{ state: string; claimed_by: string }>(
        `SELECT state, claimed_by FROM platform.outbox_delivery WHERE event_id = $1`,
        [claimA[0]?.eventId],
      ),
    );
    expect(state.rows[0]).toMatchObject({ state: 'claimed', claimed_by: 'worker-B' });

    const freshAck = await withTenantTransaction(env.worker, ctx(), (uow) =>
      markOutboxPublished(uow, reclaimed!),
    );
    expect(freshAck).toEqual({ outcome: 'acknowledged' });
  }, 60000);
});

describe('R5 — maintenance must not accept an invented audit reference', () => {
  let env: ProvisionedDatabase;

  beforeAll(async () => {
    env = await provisionKernelDatabase('regr_maintenance');
  }, 120000);

  afterAll(async () => {
    await env.close();
  }, 30000);

  it('exposes no four-argument form taking a caller-supplied audit reference', async () => {
    const signatures = await env.admin.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname = 'maintenance_expire_idempotency_keys'`,
    );
    expect(signatures.rows.length).toBeGreaterThan(0);
    for (const row of signatures.rows) {
      // An audit reference the caller chooses is not an audit reference.
      expect(row.args).not.toMatch(/text[^,]*,\s*\w*\s*text[^,]*,\s*\w*\s*text/);
    }
  });
});

describe('R6 — startup guards must have real callers', () => {
  it('wires the API principal and KMS guards into bootstrap', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'apps', 'api', 'src', 'bootstrap.ts'),
      'utf8',
    );
    expect(source).toMatch(/assertApiConnectionPrincipal/);
    expect(source).toMatch(/selectKeyManagement/);
  });

  it('wires the worker principal and KMS guards into its entrypoint', () => {
    // The guards moved into `startup.ts`, the orchestration boundary, so that the
    // *ordering* could be executed rather than asserted by regex. This check is
    // supplementary: the evidence that a refused startup never reaches Redis or
    // BullMQ is `apps/worker/src/startup.test.ts`, which runs the boundary and
    // asserts the factories were never invoked.
    const workerSrc = resolve(__dirname, '..', '..', '..', '..', 'apps', 'worker', 'src');
    const startup = readFileSync(resolve(workerSrc, 'startup.ts'), 'utf8');
    expect(startup).toMatch(/assertWorkerConnectionPrincipal/);
    expect(startup).toMatch(/verifyKeyManagement/);

    // The entrypoint must actually go through that boundary rather than around it.
    const main = readFileSync(resolve(workerSrc, 'main.ts'), 'utf8');
    expect(main).toMatch(/startWorker/);
    expect(main).toMatch(/selectKeyManagement/);
  });
});

describe('R7 — bootstrap must hold one coordination lock for the whole operation', () => {
  it('acquires a session-level lock on a designated coordination database', () => {
    const source = readFileSync(resolve(__dirname, '..', 'bootstrap.ts'), 'utf8');
    // A transaction-scoped lock ends at COMMIT, long before the database grants
    // and login changes that follow it.
    expect(source).toMatch(/pg_advisory_lock\b/);
    expect(source).toMatch(/pg_advisory_unlock\b/);
    expect(source).toMatch(/coordinationDatabase/);
  });
});
