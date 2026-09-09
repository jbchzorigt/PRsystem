import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFor } from '../iam/test-support/iam-harness';
import type { OperationHarness, SeededOperator } from './test-support/operation-harness';
import { OPERATION_PASSWORD, createOperationHarness } from './test-support/operation-harness';
import { newOperationRequest } from './services/operation-context';
import { totpCode, totpStep } from './domain/operation';

/**
 * What happens when two operators press the same button at the same instant.
 *
 * Every case here is a *different key* on the same row, so the idempotency
 * ledger is not what settles it — the lock, the compare-and-set or the unique
 * index is. That distinction matters: a client that retries produces one
 * effect because of the ledger, and two people who act at once produce one
 * effect because of the database.
 */

let h: OperationHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `operation-con-${String(keys).padStart(5, '0')}`;
};
const ctx = (operator: SeededOperator) => newOperationRequest(operator.accountId);

/** Everything doc 18 §5 grants to an Operation Admin column. */
const ADMIN = [
  'OPERATION_READ',
  'SUBSCRIPTION_REMINDER_SEND',
  'SUBSCRIPTION_PASSWORD_RESET_INITIATE',
  'SUBSCRIPTION_PAYMENT_RECONCILE',
] as const;

/** And the four rows the other column holds alone. */
const SUPER = [
  ...ADMIN,
  'SUBSCRIPTION_SUSPEND',
  'SUBSCRIPTION_CONTACT_CHANGE_APPROVE',
  'ACCOUNT_OWNERSHIP_RECOVERY_APPROVE',
  'PLATFORM_OPERATION_ACCESS_MANAGE',
] as const;

beforeAll(async () => {
  h = await createOperationHarness('operation_con');
}, 300_000);

afterAll(async () => {
  await h?.close();
});

/** Runs both, and says how many succeeded. */
async function race<T>(
  first: Promise<T>,
  second: Promise<T>,
): Promise<{ settled: PromiseSettledResult<T>[]; fulfilled: number }> {
  const settled = await Promise.allSettled([first, second]);
  return { settled, fulfilled: settled.filter((one) => one.status === 'fulfilled').length };
}

describe('suspension (OPS-DEC-016)', () => {
  it('writes one event when two Super Admins suspend at the same instant', async () => {
    const one = await h.operator({ role: 'PLATFORM_SUPER_ADMIN', permissions: [...SUPER] });
    const two = await h.operator({ role: 'PLATFORM_SUPER_ADMIN', permissions: [...SUPER] });
    const hotel = await h.hotel();

    const outcome = await race(
      h.subscriptions.setSuspension(
        one.actor,
        {
          hotelId: hotel.hotelId,
          suspend: true,
          reasonCode: 'RACE_ONE',
          note: 'Нэгдүгээр админы түдгэлзүүлэлт.',
          idempotencyKey: key(),
        },
        ctx(one),
      ),
      h.subscriptions.setSuspension(
        two.actor,
        {
          hotelId: hotel.hotelId,
          suspend: true,
          reasonCode: 'RACE_TWO',
          note: 'Хоёрдугаар админы түдгэлзүүлэлт.',
          idempotencyKey: key(),
        },
        ctx(two),
      ),
    );
    expect(outcome.fulfilled).toBe(1);

    const events = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.subscription_suspension_event
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(events.rows[0]?.count).toBe('1');
  }, 180_000);
});

describe('the SMS confirmation (doc 14 §5.5)', () => {
  it('creates one job and one message per number when a preview is confirmed twice at once', async () => {
    const operator = await h.operator({ permissions: [...ADMIN] });
    const hotel = await h.hotel({ packageCode: 'P25' });
    const preview = await h.smsService.preview(
      operator.actor,
      { body: 'Зэрэгцээ баталгаажуулалт.', filters: { hotelIds: [hotel.hotelId] } },
      ctx(operator),
    );

    const before = h.sms.size;
    const outcome = await race(
      h.smsService.confirm(
        operator.actor,
        { previewId: preview.previewId, idempotencyKey: key() },
        ctx(operator),
      ),
      h.smsService.confirm(
        operator.actor,
        { previewId: preview.previewId, idempotencyKey: key() },
        ctx(operator),
      ),
    );
    // Both may return — the second finds the job the first created — but there
    // is one job, one message per number, and one provider send.
    expect(outcome.fulfilled).toBeGreaterThanOrEqual(1);

    const jobs = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.sms_send_job WHERE preview_id = $1`,
      [preview.previewId],
    );
    expect(jobs.rows[0]?.count).toBe('1');

    const messages = await h.admin.query<{ phone: string; count: string }>(
      `SELECT m.phone, count(*)::text AS count
         FROM platform.sms_recipient_message m
         JOIN platform.sms_send_job j ON j.job_id = m.job_id
        WHERE j.preview_id = $1
        GROUP BY m.phone`,
      [preview.previewId],
    );
    expect(messages.rows.map((row) => row.count)).toEqual(['1']);
    expect(h.sms.size).toBe(before + 1);
  }, 180_000);
});

describe('the second factor (doc 14 §2)', () => {
  it('accepts one of two simultaneous uses of the same code', async () => {
    const operator = await h.operator({ permissions: [...ADMIN], stepUpAgeSeconds: 11 * 60 });
    const code = operator.codeAt();
    const outcome = await race(
      h.auth.stepUp(
        { accountId: operator.accountId, sessionId: operator.sessionId, code },
        newOperationRequest(),
      ),
      h.auth.stepUp(
        { accountId: operator.accountId, sessionId: operator.sessionId, code },
        newOperationRequest(),
      ),
    );
    expect(outcome.fulfilled).toBe(1);
  }, 180_000);

  it('issues one session when the same code signs in twice at once', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER],
    });
    const email = `race-${String(Date.now())}@operation.test`;
    const created = await h.access.createAccount(
      superAdmin.actor,
      { email, role: 'OPERATION_ADMIN', permissions: ['OPERATION_READ'], idempotencyKey: key() },
      ctx(superAdmin),
    );
    const link = h.notifications.lastEnrolmentFor(created.accountId);
    const enrolled = await h.auth.completeEnrolment(
      { token: link?.token ?? '', password: OPERATION_PASSWORD },
      newOperationRequest(),
    );
    const code = codeFor(enrolled.secret);

    const outcome = await race(
      h.auth.signIn({ email, password: OPERATION_PASSWORD, code }, newOperationRequest()),
      h.auth.signIn({ email, password: OPERATION_PASSWORD, code }, newOperationRequest()),
    );
    expect(outcome.fulfilled).toBe(1);

    const sessions = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.server_session WHERE account_id = $1`,
      [created.accountId],
    );
    expect(sessions.rows[0]?.count).toBe('1');
  }, 180_000);
});

describe('the contact change (doc 14 §2.3)', () => {
  it('opens one request when the same hotel asks twice at once', async () => {
    const hotel = await h.hotel();
    const admin = await actorFor(h.iam, hotel.admin);
    const request = newOperationRequest(admin.principal.accountId);

    const outcome = await race(
      h.contacts.open(
        admin,
        { hotelId: hotel.hotelId, newPhone: '+97611112222', idempotencyKey: key() },
        request,
      ),
      h.contacts.open(
        admin,
        { hotelId: hotel.hotelId, newPhone: '+97633334444', idempotencyKey: key() },
        request,
      ),
    );
    expect(outcome.fulfilled).toBe(1);

    const open = await h.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.subscription_contact_change_request
        WHERE subscription_id = $1
          AND state = ANY (ARRAY['AWAITING_OLD_PHONE', 'AWAITING_NEW_PHONE'])`,
      [hotel.subscriptionId],
    );
    expect(open.rows[0]?.count).toBe('1');
  }, 180_000);
});

describe('the recovery decision (OPS-DEC-009)', () => {
  it('closes a case once when two Super Admins decide at the same instant', async () => {
    const operator = await h.operator({ permissions: [...ADMIN] });
    const one = await h.operator({ role: 'PLATFORM_SUPER_ADMIN', permissions: [...SUPER] });
    const two = await h.operator({ role: 'PLATFORM_SUPER_ADMIN', permissions: [...SUPER] });
    const hotel = await h.hotel();

    const escalated = await h.recovery.escalate(
      operator.actor,
      {
        hotelId: hotel.hotelId,
        caseReference: 'SUP-RACE-0001',
        note: 'Зэрэгцээ шийдвэрийн сорил.',
        idempotencyKey: key(),
      },
      ctx(operator),
    );

    const outcome = await race(
      h.recovery.decide(
        one.actor,
        {
          requestId: escalated.requestId,
          decision: 'APPROVED',
          reason: 'Нэгдүгээр админы шийдвэр.',
          idempotencyKey: key(),
        },
        ctx(one),
      ),
      h.recovery.decide(
        two.actor,
        {
          requestId: escalated.requestId,
          decision: 'REFUSED',
          reason: 'Хоёрдугаар админы шийдвэр.',
          idempotencyKey: key(),
        },
        ctx(two),
      ),
    );
    expect(outcome.fulfilled).toBe(1);

    const decided = await h.admin.query<{ state: string; decided_by_account_id: string }>(
      `SELECT state, decided_by_account_id FROM platform.account_recovery_request
        WHERE request_id = $1`,
      [escalated.requestId],
    );
    expect(['APPROVED', 'REFUSED']).toContain(decided.rows[0]?.state);
    expect([one.accountId, two.accountId]).toContain(decided.rows[0]?.decided_by_account_id);
  }, 180_000);
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function codeFor(secret: string): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return totpCode(Buffer.from(bytes), totpStep(new Date()));
}
