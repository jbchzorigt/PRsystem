import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { actorFor } from '../iam/test-support/iam-harness';
import type { OperationHarness, SeededOperator } from './test-support/operation-harness';
import { OPERATION_PASSWORD, createOperationHarness } from './test-support/operation-harness';
import { newOperationRequest } from './services/operation-context';
import { totpCode, totpStep } from './domain/operation';

/**
 * Platform Operation against a real database (doc 14).
 *
 * The gates this suite exists to run are doc 14's own: the KPI partition sums
 * to the total and the package counts sum to the total; a card's filter selects
 * exactly what the card counted; no scheduler or state transition can send an
 * SMS; a duplicate confirmation sends one message per number; and an Operation
 * account can read neither a token, nor a password, nor an unmasked address.
 */

let h: OperationHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `operation-int-${String(keys).padStart(5, '0')}`;
};
const ctx = (operator: SeededOperator) => newOperationRequest(operator.accountId);

const ALL_PERMISSIONS = [
  'OPERATION_READ',
  'SUBSCRIPTION_REMINDER_SEND',
  'SUBSCRIPTION_PASSWORD_RESET_INITIATE',
  'SUBSCRIPTION_PAYMENT_RECONCILE',
] as const;

const SUPER_PERMISSIONS = [
  ...ALL_PERMISSIONS,
  'SUBSCRIPTION_SUSPEND',
  'SUBSCRIPTION_CONTACT_CHANGE_APPROVE',
  'ACCOUNT_OWNERSHIP_RECOVERY_APPROVE',
  'PLATFORM_OPERATION_ACCESS_MANAGE',
] as const;

beforeAll(async () => {
  h = await createOperationHarness('operation_int');
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('the KPI partition (OPS-DEC-013, OPS-DEC-014)', () => {
  it('sums to the total, twice over, and keeps the application count outside it', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    // One hotel in each status, and a package that is not the default.
    await h.hotel({ expiresInHours: 24 * 30 }); // Идэвхтэй
    await h.hotel({ expiresInHours: 100, packageCode: 'P25' }); // Удахгүй дуусна
    await h.hotel({ expiresInHours: -1 }); // Grace
    await h.hotel({ expiresInHours: -100, packageCode: 'P30' }); // Дууссан
    await h.hotel({ suspended: true }); // Түдгэлзсэн
    // And two applications that are not hotels at all.
    await h.application('PENDING_PAYMENT');
    await h.application('PROVISIONING_FAILED');

    const kpi = await h.dashboard.kpi(operator.actor, ctx(operator));

    const statusSum =
      kpi.status.active +
      kpi.status.expiringSoon +
      kpi.status.grace +
      kpi.status.expired +
      kpi.status.suspended;
    const packageSum = kpi.packages.P20 + kpi.packages.P25 + kpi.packages.P30;

    expect(statusSum).toBe(kpi.totalHotels);
    expect(packageSum).toBe(kpi.totalHotels);
    expect(kpi.totalHotels).toBeGreaterThanOrEqual(5);
    // `Идэвхжээгүй` is the paid-not-provisioned application count and is not in
    // the total: exactly one of the two applications above is in it.
    expect(kpi.inactiveApplications).toBe(1);
  }, 120_000);

  it('gives every card a filter that returns exactly what the card counted', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const asOf = new Date();
    const kpi = await h.dashboard.kpi(operator.actor, ctx(operator), asOf);

    for (const [status, counted] of [
      ['ACTIVE', kpi.status.active],
      ['EXPIRING_SOON', kpi.status.expiringSoon],
      ['GRACE', kpi.status.grace],
      ['EXPIRED', kpi.status.expired],
      ['SUSPENDED', kpi.status.suspended],
    ] as const) {
      const page = await h.dashboard.subscriptions(
        operator.actor,
        { filters: { status }, limit: 100, asOf },
        ctx(operator),
      );
      expect({ status, total: page.total }).toEqual({ status, total: counted });
      expect(page.items.every((item) => item.status === status)).toBe(true);
    }

    for (const [code, counted] of [
      ['P20', kpi.packages.P20],
      ['P25', kpi.packages.P25],
      ['P30', kpi.packages.P30],
    ] as const) {
      const page = await h.dashboard.subscriptions(
        operator.actor,
        { filters: { package: code }, limit: 100, asOf },
        ctx(operator),
      );
      expect({ code, total: page.total }).toEqual({ code, total: counted });
    }

    // And the unfiltered list is the total, so the partition is over the same
    // population the cards counted.
    const all = await h.dashboard.subscriptions(
      operator.actor,
      { filters: {}, limit: 100, asOf },
      ctx(operator),
    );
    expect(all.total).toBe(kpi.totalHotels);
  }, 120_000);
});

describe('the subscription list (OPS-DEC-011, OPS-DEC-012)', () => {
  it('orders by expiry ascending, masks the address, and derives the remaining days', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const soon = await h.hotel({ name: 'Захын буудал', expiresInHours: 12 });
    const asOf = new Date();
    const page = await h.dashboard.subscriptions(
      operator.actor,
      { filters: {}, limit: 100, asOf },
      ctx(operator),
    );

    const expiries = page.items.map((item) => item.expiresAt.getTime());
    expect([...expiries].sort((a, b) => a - b)).toEqual(expiries);

    for (const item of page.items) {
      // doc 14 §3.2 column 6: masked, in the list and in every other answer.
      expect(item.emailMasked).toMatch(/^.\*+@/);
      expect(item.emailMasked).not.toContain('admin-');
    }

    const row = page.items.find((item) => item.hotelId === soon.hotelId);
    expect(row?.remainingDays).toBe(1);
    expect(row?.graceHoursRemaining).toBeUndefined();
    expect(row?.contactPhone).toBe(soon.contactPhone);
    expect(row?.district).toBe(soon.district);
  }, 120_000);

  it('reports grace as zero days plus the hours that are left', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const inGrace = await h.hotel({ expiresInHours: -2 });
    const page = await h.dashboard.subscriptions(
      operator.actor,
      { filters: { status: 'GRACE' }, limit: 100 },
      ctx(operator),
    );
    const row = page.items.find((item) => item.hotelId === inGrace.hotelId);
    expect(row?.remainingDays).toBe(0);
    expect(row?.graceHoursRemaining).toBe(46);
  }, 120_000);

  it('combines filters, and answers an exact address search without revealing one', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const hotel = await h.hotel({
      name: 'Тусгай нэртэй буудал',
      district: 'Сүхбаатар',
      packageCode: 'P30',
      termMonths: 12,
    });

    const combined = await h.dashboard.subscriptions(
      operator.actor,
      {
        filters: {
          name: 'тусгай нэртэй',
          district: 'Сүхбаатар',
          package: 'P30',
          termMonths: 12,
        },
        limit: 100,
      },
      ctx(operator),
    );
    expect(combined.items.map((item) => item.hotelId)).toEqual([hotel.hotelId]);

    // The operator already holds the address; the search confirms it and the
    // answer is still masked.
    const byEmail = await h.dashboard.subscriptions(
      operator.actor,
      { filters: { email: hotel.admin.email.toUpperCase() }, limit: 100 },
      ctx(operator),
    );
    expect(byEmail.items.map((item) => item.hotelId)).toEqual([hotel.hotelId]);
    expect(byEmail.items[0]?.emailMasked).not.toBe(hotel.admin.email);

    // doc 14 §3.3: an exact search is audited with its user, and the raw term
    // is not what is recorded.
    const audit = await h.admin.query<{ payload: Record<string, unknown>; actor_ref: string }>(
      `SELECT payload, actor_ref FROM audit.platform_event
        WHERE action = 'operation.dashboard.exact_search'
        ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.payload['filters']).toEqual(['email']);
    expect(audit.rows[0]?.actor_ref).toBe(operator.accountId);
    expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain(hotel.admin.email);

    const byPhone = await h.dashboard.subscriptions(
      operator.actor,
      { filters: { phone: hotel.contactPhone }, limit: 100 },
      ctx(operator),
    );
    expect(byPhone.items.map((item) => item.hotelId)).toEqual([hotel.hotelId]);
  }, 120_000);
});

describe('the onboarding queue (OPS-DEC-013)', () => {
  it('groups paid-but-unprovisioned as Идэвхжээгүй and excludes provisioned hotels', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const provisioned = await h.hotel();
    const unpaid = await h.application('PAYMENT_FAILED');
    const inactive = await h.application('PROVISIONING');

    const all = await h.dashboard.applications(operator.actor, { limit: 100 }, ctx(operator));
    const ids = all.items.map((item) => item.applicationId);
    expect(ids).toContain(unpaid);
    expect(ids).toContain(inactive);

    const inactiveOnly = await h.dashboard.applications(
      operator.actor,
      { group: 'INACTIVE', limit: 100 },
      ctx(operator),
    );
    expect(inactiveOnly.items.map((item) => item.applicationId)).toContain(inactive);
    expect(inactiveOnly.items.map((item) => item.applicationId)).not.toContain(unpaid);
    expect(inactiveOnly.items.every((item) => item.queueGroup === 'INACTIVE')).toBe(true);

    // The provisioned hotel's own application is in neither group.
    const provisionedApplication = await h.admin.query<{ application_id: string }>(
      `SELECT application_id FROM platform.onboarding_application WHERE provisioned_hotel_id = $1`,
      [provisioned.hotelId],
    );
    expect(ids).not.toContain(provisionedApplication.rows[0]?.application_id);
  }, 120_000);
});

describe('the Operation-initiated password reset (OPS-DEC-008)', () => {
  it('queues a link the operator can neither read nor redirect', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const hotel = await h.hotel();

    const outcome = await h.subscriptions.initialisePasswordReset(
      operator.actor,
      { hotelId: hotel.hotelId, idempotencyKey: key() },
      ctx(operator),
    );
    expect(outcome.queued).toBe(true);
    expect(outcome.emailMasked).toMatch(/^.\*+@hotel\.test$/);
    expect(outcome.emailMasked).not.toBe(hotel.admin.email);

    // The queue entry exists, is attributed to the operator, and carries the
    // registered address rather than one the operator chose.
    const intake = await h.admin.query<{
      email_normalized: string;
      initiated_by: string;
      initiated_by_account_id: string;
    }>(
      `SELECT email_normalized, initiated_by, initiated_by_account_id
         FROM platform.password_reset_intake ORDER BY requested_at DESC LIMIT 1`,
    );
    expect(intake.rows[0]).toEqual({
      email_normalized: hotel.admin.email,
      initiated_by: 'operation',
      initiated_by_account_id: operator.accountId,
    });

    // And nothing anywhere in the audit carries the address in full.
    const audit = await h.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.platform_event
        WHERE action = 'operation.subscription.reset_queued'
        ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain(hotel.admin.email);
    expect(audit.rows[0]?.payload['destination']).toBe(outcome.emailMasked);
  }, 120_000);
});

describe('suspension (OPS-DEC-016)', () => {
  it('closes the hotel’s staff authority and moves neither date', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    const hotel = await h.hotel();
    // A live staff session, so the revocation has something to revoke.
    await actorFor(h.iam, hotel.admin);

    const before = await h.admin.query<{ starts_at: Date; expires_at: Date }>(
      `SELECT starts_at, expires_at FROM platform.hotel_subscription WHERE hotel_id = $1`,
      [hotel.hotelId],
    );

    const suspended = await h.subscriptions.setSuspension(
      superAdmin.actor,
      {
        hotelId: hotel.hotelId,
        suspend: true,
        reasonCode: 'FRAUD_INVESTIGATION',
        note: 'Мөрдөн шалгах ажиллагааны улмаас түр хаав.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );
    expect(suspended.suspended).toBe(true);
    expect(suspended.sessionsRevoked).toBeGreaterThanOrEqual(1);

    const after = await h.admin.query<{ starts_at: Date; expires_at: Date; suspended_at: Date }>(
      `SELECT starts_at, expires_at, suspended_at FROM platform.hotel_subscription
        WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    // The whole of "never pauses or extends".
    expect(after.rows[0]?.starts_at).toEqual(before.rows[0]?.starts_at);
    expect(after.rows[0]?.expires_at).toEqual(before.rows[0]?.expires_at);
    expect(after.rows[0]?.suspended_at).not.toBeNull();

    // A second suspend is refused rather than writing a second event.
    await expect(
      h.subscriptions.setSuspension(
        superAdmin.actor,
        {
          hotelId: hotel.hotelId,
          suspend: true,
          reasonCode: 'FRAUD_INVESTIGATION',
          note: 'Дахин түдгэлзүүлэх оролдлого.',
          idempotencyKey: key(),
        },
        ctx(superAdmin),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const reactivated = await h.subscriptions.setSuspension(
      superAdmin.actor,
      {
        hotelId: hotel.hotelId,
        suspend: false,
        reasonCode: 'INVESTIGATION_CLOSED',
        note: 'Шалгалт дууссан тул сэргээв.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );
    expect(reactivated.suspended).toBe(false);

    const history = await h.subscriptions.suspensionHistory(
      superAdmin.actor,
      hotel.hotelId,
      ctx(superAdmin),
    );
    expect(history.map((event) => event.action)).toEqual(['REACTIVATE', 'SUSPEND']);
    // The calendar snapshotted on both events is the same one.
    expect(history[0]?.expiresAtSnapshot).toEqual(history[1]?.expiresAtSnapshot);
  }, 120_000);
});

describe('the offline ownership recovery (OPS-DEC-009)', () => {
  it('is a handoff two different people complete, and changes no address', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    const hotel = await h.hotel();

    const escalated = await h.recovery.escalate(
      operator.actor,
      {
        hotelId: hotel.hotelId,
        caseReference: 'SUP-2026-0001',
        note: 'Бүртгэлтэй хаяг руу хандах боломжгүй болсон гэж мэдэгдсэн.',
        idempotencyKey: key(),
      },
      ctx(operator),
    );

    const pending = await h.recovery.pending(superAdmin.actor, ctx(superAdmin));
    expect(pending.map((item) => item.requestId)).toContain(escalated.requestId);

    // The operator who escalated may not decide it.
    await expect(
      h.recovery.decide(
        operator.actor,
        {
          requestId: escalated.requestId,
          decision: 'APPROVED',
          reason: 'Өөрөө шийдэх оролдлого.',
          idempotencyKey: key(),
        },
        ctx(operator),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    const decided = await h.recovery.decide(
      superAdmin.actor,
      {
        requestId: escalated.requestId,
        decision: 'APPROVED',
        reason: 'Гэрээ болон эзэмшигчийн баримтыг офлайнаар шалгав.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );
    expect(decided.decision).toBe('APPROVED');

    // And the address is exactly where it was: an approval records a decision,
    // it does not perform one.
    const account = await h.admin.query<{ email_normalized: string }>(
      `SELECT email_normalized FROM platform.user_account WHERE account_id = $1`,
      [escalated.accountId],
    );
    expect(account.rows[0]?.email_normalized).toBe(hotel.admin.email);
  }, 120_000);
});

describe('the subscription contact change (OPS-DEC-015)', () => {
  it('needs both numbers, and applies atomically', async () => {
    const hotel = await h.hotel();
    const admin = await actorFor(h.iam, hotel.admin);
    const request = newOperationRequest(admin.principal.accountId);
    const newPhone = '+97688776655';

    const current = await h.contacts.current(admin, hotel.hotelId, request);
    expect(current.phoneMasked).toBe(`****${hotel.contactPhone.slice(-4)}`);

    const change = await h.contacts.open(
      admin,
      { hotelId: hotel.hotelId, newPhone, idempotencyKey: key() },
      request,
    );
    expect(change.state).toBe('AWAITING_OLD_PHONE');

    const oldCode = codeFrom(h.sms.bodyFor(hotel.contactPhone));
    const afterOld = await h.contacts.verify(
      admin,
      {
        hotelId: hotel.hotelId,
        requestId: change.requestId,
        challenge: 'OLD_PHONE',
        code: oldCode,
        idempotencyKey: key(),
      },
      request,
    );
    expect(afterOld.state).toBe('AWAITING_NEW_PHONE');

    // The contact has not moved yet: both challenges are required.
    const midway = await h.admin.query<{ phone: string }>(
      `SELECT phone FROM platform.subscription_contact
        WHERE subscription_id = $1 AND is_current IS TRUE`,
      [hotel.subscriptionId],
    );
    expect(midway.rows[0]?.phone).toBe(hotel.contactPhone);

    const newCode = codeFrom(h.sms.bodyFor(newPhone));
    const applied = await h.contacts.verify(
      admin,
      {
        hotelId: hotel.hotelId,
        requestId: change.requestId,
        challenge: 'NEW_PHONE',
        code: newCode,
        idempotencyKey: key(),
      },
      request,
    );
    expect(applied.state).toBe('APPLIED');

    const revisions = await h.admin.query<{ phone: string; is_current: boolean }>(
      `SELECT phone, is_current FROM platform.subscription_contact
        WHERE subscription_id = $1 ORDER BY effective_from`,
      [hotel.subscriptionId],
    );
    expect(revisions.rows).toEqual([
      { phone: hotel.contactPhone, is_current: false },
      { phone: newPhone, is_current: true },
    ]);
  }, 120_000);

  it('refuses a wrong code, counts the attempt, and never stores the code', async () => {
    const hotel = await h.hotel();
    const admin = await actorFor(h.iam, hotel.admin);
    const request = newOperationRequest(admin.principal.accountId);
    const change = await h.contacts.open(
      admin,
      { hotelId: hotel.hotelId, newPhone: '+97677665544', idempotencyKey: key() },
      request,
    );
    const real = codeFrom(h.sms.bodyFor(hotel.contactPhone));
    const wrong = real === '000000' ? '000001' : '000000';

    await expect(
      h.contacts.verify(
        admin,
        {
          hotelId: hotel.hotelId,
          requestId: change.requestId,
          challenge: 'OLD_PHONE',
          code: wrong,
          idempotencyKey: key(),
        },
        request,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const stored = await h.admin.query<{ code_hash: string; attempts: number }>(
      `SELECT code_hash, attempts FROM platform.subscription_contact_code
        WHERE request_id = $1 AND is_current IS TRUE`,
      [change.requestId],
    );
    expect(stored.rows[0]?.attempts).toBe(1);
    expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.code_hash).not.toContain(real);
  }, 120_000);

  it('lets a Super Admin waive the old number and no more than that', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    const hotel = await h.hotel();
    const admin = await actorFor(h.iam, hotel.admin);
    const request = newOperationRequest(admin.principal.accountId);
    const newPhone = '+97655443322';

    const change = await h.contacts.open(
      admin,
      { hotelId: hotel.hotelId, newPhone, idempotencyKey: key() },
      request,
    );
    const approved = await h.contacts.approveException(
      superAdmin.actor,
      {
        requestId: change.requestId,
        reference: 'OWNER-2026-0007',
        reason: 'Эзэмшигчийн бичгээр батлагдсан хүсэлт, хуучин дугаар ашиглалтгүй.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );
    expect(approved.state).toBe('AWAITING_NEW_PHONE');
    expect(approved.exceptionApproved).toBe(true);

    // The waiver is not a pass: the row records no old-phone verification.
    const row = await h.admin.query<{ old_phone_verified_at: Date | null }>(
      `SELECT old_phone_verified_at FROM platform.subscription_contact_change_request
        WHERE request_id = $1`,
      [change.requestId],
    );
    expect(row.rows[0]?.old_phone_verified_at).toBeNull();

    // And the new number's challenge still has to pass — asked for by the
    // Hotel Admin, because the Operation realm issues no codes.
    await h.contacts.resend(
      admin,
      { hotelId: hotel.hotelId, requestId: change.requestId, challenge: 'NEW_PHONE' },
      request,
    );
    const newCode = codeFrom(h.sms.bodyFor(newPhone));
    const applied = await h.contacts.verify(
      admin,
      {
        hotelId: hotel.hotelId,
        requestId: change.requestId,
        challenge: 'NEW_PHONE',
        code: newCode,
        idempotencyKey: key(),
      },
      request,
    );
    expect(applied.state).toBe('APPLIED');

    // doc 14 §2.3: the registered address is told, and the notice carries the
    // masked numbers only.
    const notice = h.notifications.lastContactNoticeFor(hotel.hotelId);
    expect(notice?.emailNormalized).toBe(hotel.admin.email);
    expect(notice?.newPhoneMasked).toBe(`****${newPhone.slice(-4)}`);
    expect(notice?.approvedByException).toBe(true);
  }, 120_000);
});

describe('reminder SMS (OPS-DEC-002, OPS-DEC-010)', () => {
  it('previews, confirms once, and sends one message per number', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const one = await h.hotel({ packageCode: 'P25', expiresInHours: 100 });
    const two = await h.hotel({ packageCode: 'P25', expiresInHours: 90 });

    const preview = await h.smsService.preview(
      operator.actor,
      {
        body: 'Таны эрхийн хугацаа удахгүй дуусна. Сунгалт хийнэ үү.',
        filters: { hotelIds: [one.hotelId, two.hotelId, one.hotelId] },
      },
      ctx(operator),
    );
    expect(preview.recipientCount).toBe(2);
    expect(preview.alphabet).toBe('UNICODE');
    expect(preview.segmentsPerRecipient).toBe(1);
    expect(preview.totalSegments).toBe(2);
    // No tariff is configured, so there is no estimate to show.
    expect(preview.estimatedCostMnt).toBeUndefined();

    const before = h.sms.size;
    const job = await h.smsService.confirm(
      operator.actor,
      { previewId: preview.previewId, idempotencyKey: key() },
      ctx(operator),
    );
    expect(job.recipientCount).toBe(2);
    expect(job.dispatched).toBe(true);
    expect(h.sms.size).toBe(before + 1);

    const messages = await h.admin.query<{ phone: string; state: string }>(
      `SELECT phone, state FROM platform.sms_recipient_message WHERE job_id = $1 ORDER BY phone`,
      [job.jobId],
    );
    expect(messages.rows.map((row) => row.state)).toEqual(['SENT', 'SENT']);
    expect(new Set(messages.rows.map((row) => row.phone)).size).toBe(2);

    // A repeated confirmation of the same preview is the same job, and sends
    // nothing further (doc 14 §5.5).
    const repeated = await h.smsService.confirm(
      operator.actor,
      { previewId: preview.previewId, idempotencyKey: key() },
      ctx(operator),
    );
    expect(repeated.jobId).toBe(job.jobId);
    expect(h.sms.size).toBe(before + 1);
  }, 120_000);

  it('refuses a confirmation whose audience has moved', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const preview = await h.smsService.preview(
      operator.actor,
      { body: 'Сануулга.', filters: { package: 'P30' } },
      ctx(operator),
    );
    // A new P30 hotel appears after the preview was taken.
    await h.hotel({ packageCode: 'P30' });
    await expect(
      h.smsService.confirm(
        operator.actor,
        { previewId: preview.previewId, idempotencyKey: key() },
        ctx(operator),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);

  it('shows an estimate once a tariff is configured, and not before', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    await h.admin.query(
      `INSERT INTO platform.sms_tariff
         (provider, price_per_segment_mnt, agreement_reference, effective_from)
       VALUES ('CALLPRO', 55, 'CALLPRO-2026-0001', now() - interval '1 day')`,
    );
    const preview = await h.smsService.preview(
      operator.actor,
      { body: 'Тарифтай сануулга.', filters: { package: 'P25' } },
      ctx(operator),
    );
    expect(preview.estimatedCostMnt).toBe(String(preview.totalSegments * 55));
    // Closed rather than deleted: a preview references the tariff it priced
    // against, and an estimate whose tariff could vanish would be one nobody
    // could reconstruct.
    await h.admin.query(`UPDATE platform.sms_tariff SET effective_to = now()`);
  }, 120_000);

  it('records a delivery status the provider reports, and refuses to go backwards', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const hotel = await h.hotel({ packageCode: 'P30', expiresInHours: 50 });
    const preview = await h.smsService.preview(
      operator.actor,
      { body: 'Хүргэлтийн төлөв.', filters: { hotelIds: [hotel.hotelId] } },
      ctx(operator),
    );
    const job = await h.smsService.confirm(
      operator.actor,
      { previewId: preview.previewId, idempotencyKey: key() },
      ctx(operator),
    );
    const message = await h.admin.query<{ message_id: string; provider_message_id: string }>(
      `SELECT message_id, provider_message_id FROM platform.sms_recipient_message
        WHERE job_id = $1`,
      [job.jobId],
    );
    await h.sms.verifyCallback({
      providerMessageId: message.rows[0]?.provider_message_id,
      status: 'DELIVERED',
    });

    const refreshed = await h.smsService.refreshDeliveryStatus(operator.actor, ctx(operator));
    expect(refreshed.advanced).toBeGreaterThanOrEqual(1);

    const settled = await h.admin.query<{ state: string }>(
      `SELECT state FROM platform.sms_recipient_message WHERE message_id = $1`,
      [message.rows[0]?.message_id],
    );
    expect(settled.rows[0]?.state).toBe('DELIVERED');

    // The database refuses a backwards move even to a direct writer.
    await expect(
      h.admin.query(
        `UPDATE platform.sms_recipient_message SET state = 'SENT' WHERE message_id = $1`,
        [message.rows[0]?.message_id],
      ),
    ).rejects.toMatchObject({ code: '22023' });

    const events = await h.admin.query<{ state: string; source: string }>(
      `SELECT state, source FROM platform.sms_message_event
        WHERE message_id = $1 ORDER BY event_id`,
      [message.rows[0]?.message_id],
    );
    expect(events.rows.map((row) => row.state)).toEqual(['PENDING', 'SENT', 'DELIVERED']);
  }, 120_000);
});

describe('the reconciliation queue (OPS-DEC-017)', () => {
  it('lists the paid records that did not apply themselves', async () => {
    const operator = await h.operator({ permissions: [...ALL_PERMISSIONS] });
    const applicationId = await h.application('PAYMENT_UNCERTAIN');
    await h.admin.query(
      `UPDATE platform.onboarding_payment_attempt
          SET state = 'PAID_REQUIRES_RECONCILIATION', confirmed_at = now(),
              provider_payment_id = 'pay-recon-1', terminal_at = now()
        WHERE application_id = $1`,
      [applicationId],
    );
    await h.admin.query(
      `INSERT INTO platform.onboarding_payment_attempt
         (application_id, provider, merchant_ref, provider_invoice_id, provider_payment_id,
          state, amount_mnt, package_code, term_months, monthly_price_mnt, vat_rate_bp,
          price_book_version, tax_config_version, package_feature_version,
          expires_at, confirmed_at, terminal_at)
       VALUES ($1, 'QPAY', 'recon-merch', 'recon-inv', 'recon-pay',
               'PAID_REQUIRES_RECONCILIATION', 20000, 'P20', 1, 20000, 1000,
               'pb-1', 'tax-1', 'pkg-1', now() + interval '1 hour', now(), now())`,
      [applicationId],
    );

    const queue = await h.subscriptions.reconciliationQueue(operator.actor, ctx(operator));
    expect(queue.some((row) => row.providerInvoiceId === 'recon-inv')).toBe(true);
    expect(queue.every((row) => row.state === 'PAID_REQUIRES_RECONCILIATION')).toBe(true);
  }, 120_000);
});

describe('Operation authentication (doc 14 §2)', () => {
  it('enrols an account, signs it in with two factors, and steps it up', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    const email = `enrolled-${String(Date.now())}@operation.test`;

    const created = await h.access.createAccount(
      superAdmin.actor,
      {
        email,
        role: 'OPERATION_ADMIN',
        permissions: ['OPERATION_READ'],
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );

    // Before enrolment the account cannot be signed in to at all.
    const link = h.notifications.lastEnrolmentFor(created.accountId);
    expect(link?.emailNormalized).toBe(email);
    await expect(
      h.auth.signIn({ email, password: OPERATION_PASSWORD, code: '000000' }, newOperationRequest()),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const enrolled = await h.auth.completeEnrolment(
      { token: link?.token ?? '', password: OPERATION_PASSWORD },
      newOperationRequest(),
    );
    expect(enrolled.secret).toMatch(/^[A-Z2-7]{32}$/);
    const secret = decodeBase32(enrolled.secret);

    // A password with no code is refused.
    await expect(
      h.auth.signIn({ email, password: OPERATION_PASSWORD, code: '000000' }, newOperationRequest()),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const now = new Date();
    const signedIn = await h.auth.signIn(
      { email, password: OPERATION_PASSWORD, code: totpCode(secret, totpStep(now)) },
      newOperationRequest(),
    );
    expect(signedIn.accountId).toBe(created.accountId);

    const session = await h.admin.query<{ step_up_at: Date | null; realm: string }>(
      `SELECT step_up_at, realm FROM platform.server_session WHERE session_id = $1`,
      [signedIn.sessionId],
    );
    expect(session.rows[0]?.realm).toBe('operation');
    expect(session.rows[0]?.step_up_at).not.toBeNull();

    // The same code cannot be used twice.
    await expect(
      h.auth.stepUp(
        {
          accountId: created.accountId,
          sessionId: signedIn.sessionId,
          code: totpCode(secret, totpStep(now)),
        },
        newOperationRequest(),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // The next step's code works.
    const stepped = await h.auth.stepUp(
      {
        accountId: created.accountId,
        sessionId: signedIn.sessionId,
        code: totpCode(secret, totpStep(now) + 1),
      },
      newOperationRequest(),
    );
    expect(stepped.steppedUp).toBe(true);
  }, 180_000);

  it('revokes an account’s sessions when its permissions move', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    const subject = await h.operator({ permissions: ['OPERATION_READ'] });

    const revoked = await h.access.setPermission(
      superAdmin.actor,
      {
        accountId: subject.accountId,
        permission: 'OPERATION_READ',
        granted: false,
        reason: 'Ажлаас чөлөөлөгдсөн тул эрхийг цуцлав.',
        idempotencyKey: key(),
      },
      ctx(superAdmin),
    );
    expect(revoked.permissions).not.toContain('OPERATION_READ');
    expect(revoked.sessionsRevoked).toBeGreaterThanOrEqual(1);

    const session = await h.admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM platform.server_session WHERE session_id = $1`,
      [subject.sessionId],
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
  }, 120_000);

  it('refuses an operator administering their own account', async () => {
    const superAdmin = await h.operator({
      role: 'PLATFORM_SUPER_ADMIN',
      permissions: [...SUPER_PERMISSIONS],
    });
    await expect(
      h.access.setPermission(
        superAdmin.actor,
        {
          accountId: superAdmin.accountId,
          permission: 'SUBSCRIPTION_SUSPEND',
          granted: true,
          reason: 'Өөртөө эрх нэмэх оролдлого.',
          idempotencyKey: key(),
        },
        ctx(superAdmin),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 120_000);
});

describe('the provisioning seed', () => {
  it('gives every new subscription its confirmed contact', async () => {
    const hotel = await h.hotel();
    const contact = await h.admin.query<{ phone: string; source: string }>(
      `SELECT phone, source FROM platform.subscription_contact
        WHERE subscription_id = $1 AND is_current IS TRUE`,
      [hotel.subscriptionId],
    );
    expect(contact.rows[0]).toEqual({ phone: hotel.contactPhone, source: 'PROVISIONING' });
  }, 120_000);
});

/** The six digits an SMS body carries, for a test that reads it as a recipient would. */
function codeFrom(body: string | undefined): string {
  const match = /([0-9]{6})/.exec(body ?? '');
  if (match === null) throw new Error(`no code in ${String(body)}`);
  return match[1] as string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of encoded) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
