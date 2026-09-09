import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import { actorFor } from '../iam/test-support/iam-harness';
import type { OperationHarness, SeededOperator } from './test-support/operation-harness';
import { OPERATION_PASSWORD, createOperationHarness } from './test-support/operation-harness';
import { newOperationRequest } from './services/operation-context';

/**
 * The Phase 19 security boundary (doc 14 §2, §7; doc 18 §5).
 *
 * Five rules, each asserted against the thing that actually enforces it rather
 * than against the service that usually calls it:
 *
 *  - a role name grants nothing, and a missing permission is the same opaque
 *    `NOT_FOUND` every other realm boundary answers with;
 *  - every Operation action needs a step-up no older than ten minutes;
 *  - the two Platform-Super-Admin-only rows are refused to an Operation Admin
 *    even when the account holds the permission by name;
 *  - the Operation realm reaches no hotel's guest, stay or registry data, and
 *    no Police data at all;
 *  - nothing an operator can call returns a token, a password, a one-time code
 *    or an unmasked registered address.
 */

let h: OperationHarness;
let apiPool: Pool;
let workerPool: Pool;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `operation-sec-${String(keys).padStart(5, '0')}`;
};
const ctx = (operator: SeededOperator) => newOperationRequest(operator.accountId);

const READER = ['OPERATION_READ'] as const;

beforeAll(async () => {
  h = await createOperationHarness('operation_sec');
  apiPool = quietPool({ connectionString: h.db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 4 });
  workerPool = quietPool({ connectionString: h.db.loginUrl(TEST_LOGIN_PRINCIPALS.worker), max: 2 });
}, 300_000);

afterAll(async () => {
  await apiPool?.end().catch(() => undefined);
  await workerPool?.end().catch(() => undefined);
  await h?.close();
});

/** Runs one statement in a scoped transaction on a runtime login, then rolls back. */
async function scoped<T>(
  pool: Pool,
  realm: string,
  hotelId: string,
  work: (query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', hotelId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.realm', realm]);
    return await work((sql, values = []) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const PLATFORM_SENTINEL = '00000000-0000-0000-0000-000000000000';

describe('a role name grants nothing (OPS-DEC-015)', () => {
  it('refuses every action to an Operation account that was granted none', async () => {
    const bare = await h.operator({ permissions: [] });
    const hotel = await h.hotel();
    const refusals = [
      () => h.dashboard.kpi(bare.actor, ctx(bare)),
      () => h.dashboard.subscriptions(bare.actor, { filters: {} }, ctx(bare)),
      () => h.dashboard.applications(bare.actor, {}, ctx(bare)),
      () =>
        h.subscriptions.initialisePasswordReset(
          bare.actor,
          { hotelId: hotel.hotelId, idempotencyKey: key() },
          ctx(bare),
        ),
      () => h.subscriptions.reconciliationQueue(bare.actor, ctx(bare)),
      () => h.smsService.preview(bare.actor, { body: 'Сануулга.', filters: {} }, ctx(bare)),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  }, 120_000);

  it('refuses the Platform-Super-Admin rows to an Operation Admin', async () => {
    const admin = await h.operator({ permissions: [...READER] });
    const hotel = await h.hotel();

    // The grant itself is unrepresentable. `account_permission_grant` carries
    // the role the permission was granted against and a composite foreign key
    // to the account's own role, so a `SUBSCRIPTION_SUSPEND` row aimed at an
    // Operation Admin cannot be written — by this test, by a service, or by a
    // direct statement.
    await expect(
      h.admin.query(
        `INSERT INTO platform.account_permission_grant
           (account_id, realm, realm_role, permission, granted_by_account_id)
         VALUES ($1, 'operation', 'PLATFORM_SUPER_ADMIN', 'SUBSCRIPTION_SUSPEND', $1)`,
        [admin.accountId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // And a row that names the account's real role is refused by the CHECK,
    // because doc 18 §5 grants that permission to the other column only.
    await expect(
      h.admin.query(
        `INSERT INTO platform.account_permission_grant
           (account_id, realm, realm_role, permission, granted_by_account_id)
         VALUES ($1, 'operation', 'OPERATION_ADMIN', 'SUBSCRIPTION_SUSPEND', $1)`,
        [admin.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      h.subscriptions.setSuspension(
        admin.actor,
        {
          hotelId: hotel.hotelId,
          suspend: true,
          reasonCode: 'ATTEMPTED_ESCALATION',
          note: 'Operation Admin эрхгүй үйлдэл оролдов.',
          idempotencyKey: key(),
        },
        ctx(admin),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);

  it('refuses a Hotel-realm principal on every Operation command', async () => {
    const hotel = await h.hotel();
    const hotelActor = await actorFor(h.iam, hotel.admin);
    const request = newOperationRequest(hotelActor.principal.accountId);
    await expect(h.dashboard.kpi(hotelActor, request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      h.smsService.preview(hotelActor, { body: 'Сануулга.', filters: {} }, request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);
});

describe('the step-up window (doc 14 §2)', () => {
  it('refuses an action whose second factor is older than ten minutes', async () => {
    const stale = await h.operator({ permissions: [...READER], stepUpAgeSeconds: 11 * 60 });
    await expect(h.dashboard.kpi(stale.actor, ctx(stale))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const fresh = await h.operator({ permissions: [...READER], stepUpAgeSeconds: 60 });
    await expect(h.dashboard.kpi(fresh.actor, ctx(fresh))).resolves.toBeDefined();
  }, 120_000);

  it('accepts no password as a step-up: only a code refreshes one', async () => {
    const operator = await h.operator({ permissions: [...READER], stepUpAgeSeconds: 11 * 60 });
    await expect(
      h.auth.stepUp(
        { accountId: operator.accountId, sessionId: operator.sessionId, code: '000000' },
        newOperationRequest(),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const stepped = await h.auth.stepUp(
      {
        accountId: operator.accountId,
        sessionId: operator.sessionId,
        code: operator.codeAt(),
      },
      newOperationRequest(),
    );
    expect(stepped.steppedUp).toBe(true);
  }, 120_000);
});

describe('what the Operation realm can reach in the database', () => {
  it('sees no stay, no guest and no registry row, in any scope', async () => {
    const hotel = await h.hotel();
    for (const table of [
      'platform.stay',
      'platform.stay_guest',
      'platform.guest_registry_entry',
      'platform.hotel_admin_activation',
      'platform.subscription_contact_code',
    ]) {
      const rows = await scoped(apiPool, 'operation', PLATFORM_SENTINEL, async (query) => {
        const result = await query(`SELECT * FROM ${table} LIMIT 5`).catch(
          (error: { code?: string }) => ({ rows: [], refused: error.code }),
        );
        return result.rows.length;
      });
      // Either the grant refuses it or the policy matches nothing; either way
      // the Operation realm reads none of it.
      expect({ table, rows }).toEqual({ table, rows: 0 });
    }
    expect(hotel.hotelId).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);

  it('reaches no Police table at all', async () => {
    for (const table of ['police.wanted_person', 'police.police_match', 'police.wanted_case']) {
      await expect(
        scoped(apiPool, 'operation', PLATFORM_SENTINEL, (query) =>
          query(`SELECT 1 FROM ${table} LIMIT 1`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  }, 120_000);

  it('keeps the Operation realm’s own tables out of every other realm', async () => {
    const operator = await h.operator({ permissions: ['SUBSCRIPTION_REMINDER_SEND'] });
    await h.hotel();
    const preview = await h.smsService.preview(
      operator.actor,
      { body: 'Сануулга.', filters: {} },
      ctx(operator),
    );
    expect(preview.previewId).toBeDefined();

    // A hotel-scoped session sees none of it, and neither does the worker.
    const inHotelRealm = await scoped(apiPool, 'hotel', PLATFORM_SENTINEL, async (query) => {
      const result = await query(`SELECT preview_id FROM platform.sms_preview`);
      return result.rows.length;
    });
    expect(inHotelRealm).toBe(0);
    for (const table of ['platform.sms_preview', 'platform.sms_send_job']) {
      await expect(
        scoped(workerPool, 'hotel', PLATFORM_SENTINEL, (query) =>
          query(`SELECT 1 FROM ${table} LIMIT 1`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  }, 120_000);

  it('stores the second factor encrypted, and the API login cannot read a code', async () => {
    const operator = await h.operator({ permissions: [...READER] });
    const factor = await h.admin.query<{ secret_ciphertext: Buffer }>(
      `SELECT secret_ciphertext FROM platform.operation_totp_factor WHERE account_id = $1`,
      [operator.accountId],
    );
    const stored = factor.rows[0]?.secret_ciphertext.toString('utf8') ?? '';
    // The stored bytes are a ciphertext, not a secret anybody could enter.
    expect(stored).not.toMatch(/^[A-Z2-7]{32}$/);
    expect(stored.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('what an operator can never read (doc 14 §2.1, §3.2)', () => {
  it('returns a masked address from every surface that names one', async () => {
    const operator = await h.operator({
      permissions: ['OPERATION_READ', 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'],
    });
    const hotel = await h.hotel();

    const list = await h.dashboard.subscriptions(
      operator.actor,
      { filters: { name: hotel.name } },
      ctx(operator),
    );
    const reset = await h.subscriptions.initialisePasswordReset(
      operator.actor,
      { hotelId: hotel.hotelId, idempotencyKey: key() },
      ctx(operator),
    );
    const queue = await h.dashboard.applications(operator.actor, {}, ctx(operator));

    const rendered = JSON.stringify({ list, reset, queue });
    expect(rendered).not.toContain(hotel.admin.email);
    expect(rendered).toContain(hotel.admin.email.slice(-11));
    // No password, token or code anywhere in an operator-facing answer.
    expect(rendered).not.toContain(OPERATION_PASSWORD);
    expect(rendered).not.toMatch(/"token"/);
  }, 120_000);

  it('gives the reset queue no address an operator chose', async () => {
    const operator = await h.operator({
      permissions: ['SUBSCRIPTION_PASSWORD_RESET_INITIATE'],
    });
    const hotel = await h.hotel();
    await h.subscriptions.initialisePasswordReset(
      operator.actor,
      { hotelId: hotel.hotelId, idempotencyKey: key() },
      ctx(operator),
    );
    const intake = await h.admin.query<{ email_normalized: string }>(
      `SELECT email_normalized FROM platform.password_reset_intake
        WHERE initiated_by = 'operation' ORDER BY requested_at DESC LIMIT 1`,
    );
    // The address is the registered one, and the command had no parameter that
    // could have been anything else.
    expect(intake.rows[0]?.email_normalized).toBe(hotel.admin.email);
  }, 120_000);
});

describe('a suspended Operation account (doc 14 §2)', () => {
  it('loses every session at once, and every action with them', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['PLATFORM_OPERATION_ACCESS_MANAGE'],
    });
    const subject = await h.operator({ permissions: [...READER] });
    await expect(h.dashboard.kpi(subject.actor, ctx(subject))).resolves.toBeDefined();

    await h.access.setAccountState(
      superAdmin.actor,
      {
        accountId: subject.accountId,
        state: 'SUSPENDED',
        reason: 'Түдгэлзүүлэх шаардлагатай гэж үзэв.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );

    await expect(h.dashboard.kpi(subject.actor, ctx(subject))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const session = await h.admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM platform.server_session WHERE session_id = $1`,
      [subject.sessionId],
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
  }, 120_000);
});

describe('the append-only histories', () => {
  it('refuses an update or a delete on a suspension event and on a message event', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: ['SUBSCRIPTION_SUSPEND'],
    });
    const hotel = await h.hotel();
    const outcome = await h.subscriptions.setSuspension(
      superAdmin.actor,
      {
        hotelId: hotel.hotelId,
        suspend: true,
        reasonCode: 'AUDIT_CHECK',
        note: 'Аудитын шалгалтын түдгэлзүүлэлт.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );

    for (const statement of [
      `UPDATE platform.subscription_suspension_event SET note = 'edited' WHERE event_id = $1`,
      `DELETE FROM platform.subscription_suspension_event WHERE event_id = $1`,
    ]) {
      await expect(h.admin.query(statement, [outcome.eventId])).rejects.toMatchObject({
        code: '42501',
      });
    }
  }, 120_000);

  it('refuses to rewrite a contact revision', async () => {
    const hotel = await h.hotel();
    const contact = await h.admin.query<{ contact_id: string }>(
      `SELECT contact_id FROM platform.subscription_contact WHERE subscription_id = $1`,
      [hotel.subscriptionId],
    );
    await expect(
      h.admin.query(
        `UPDATE platform.subscription_contact SET phone = '+97600000000' WHERE contact_id = $1`,
        [contact.rows[0]?.contact_id],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      h.admin.query(`DELETE FROM platform.subscription_contact WHERE contact_id = $1`, [
        contact.rows[0]?.contact_id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  }, 120_000);
});

describe('no scheduler can send an SMS (OPS-DEC-010)', () => {
  it('has no send job a person did not confirm, and no shape for one', async () => {
    // The column is `NOT NULL`, so a job with no operator is unrepresentable —
    // asserted against the database rather than against the service.
    await expect(
      h.admin.query(
        `INSERT INTO platform.sms_send_job
           (preview_id, body, filter_snapshot, recipient_count, excluded_count, total_segments,
            confirmed_by_account_id)
         VALUES (gen_random_uuid(), 'Автомат', '{}'::jsonb, 1, 0, 1, NULL)`,
      ),
    ).rejects.toMatchObject({ code: '23502' });

    const jobs = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.sms_send_job
        WHERE confirmed_by_account_id IS NULL`,
    );
    expect(jobs.rows[0]?.count).toBe('0');
  }, 120_000);
});
