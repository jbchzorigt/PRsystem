import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXPIRING_SOON_HOURS,
  GRACE_HOURS,
  INACTIVE_APPLICATION_STATES,
  RECONCILIATION_OUTCOMES,
  SMS_LATIN_SEGMENT,
  SMS_UNICODE_SEGMENT,
  UNPAID_APPLICATION_STATES,
  applicationGroup,
  base32Encode,
  displayStatus,
  estimatedCostMnt,
  graceHoursRemaining,
  isReasonCode,
  isReconciliationOutcome,
  maskEmail,
  maskPhone,
  normaliseContactPhone,
  normaliseEmailTerm,
  remainingDays,
  smsAlphabet,
  smsCharacterCount,
  smsSegments,
  smsStateAdvances,
  smsStateFor,
  timeStatus,
  totpCode,
  totpStep,
  verifyTotp,
} from './operation';

const HOUR = 3_600_000;
const AS_OF = new Date('2026-09-09T09:00:00.000Z');
const at = (hoursFromNow: number): Date => new Date(AS_OF.getTime() + hoursFromNow * HOUR);

describe('the subscription time status', () => {
  it('is the four-way partition of doc 14 §4, on the exact boundaries', () => {
    // `Идэвхтэй` is *more* than 168 hours, so 168 exactly is already expiring.
    expect(timeStatus(at(EXPIRING_SOON_HOURS + 0.001), AS_OF)).toBe('ACTIVE');
    expect(timeStatus(at(EXPIRING_SOON_HOURS), AS_OF)).toBe('EXPIRING_SOON');
    expect(timeStatus(at(0.001), AS_OF)).toBe('EXPIRING_SOON');
    // At `expires_at` itself grace has begun; at `expires_at + 48h` it is over.
    expect(timeStatus(at(0), AS_OF)).toBe('GRACE');
    expect(timeStatus(at(-GRACE_HOURS + 0.001), AS_OF)).toBe('GRACE');
    expect(timeStatus(at(-GRACE_HOURS), AS_OF)).toBe('EXPIRED');
  });

  it('lets suspension absorb every other status, which is what makes the cards a partition', () => {
    for (const hours of [EXPIRING_SOON_HOURS + 100, 24, 0, -100]) {
      expect(displayStatus(at(hours), AS_OF, true)).toBe('SUSPENDED');
      expect(displayStatus(at(hours), AS_OF, false)).toBe(timeStatus(at(hours), AS_OF));
    }
  });

  it('counts remaining days by ceiling, and never below zero', () => {
    expect(remainingDays(at(24), AS_OF)).toBe(1);
    expect(remainingDays(at(25), AS_OF)).toBe(2);
    expect(remainingDays(at(0.5), AS_OF)).toBe(1);
    expect(remainingDays(at(0), AS_OF)).toBe(0);
    expect(remainingDays(at(-100), AS_OF)).toBe(0);
  });

  it('reports the grace hours separately, and only inside grace', () => {
    expect(graceHoursRemaining(at(-1), AS_OF)).toBe(GRACE_HOURS - 1);
    expect(graceHoursRemaining(at(1), AS_OF)).toBeUndefined();
    expect(graceHoursRemaining(at(-GRACE_HOURS), AS_OF)).toBeUndefined();
  });
});

describe('masking and normalisation', () => {
  it('keeps one character of the local part and the whole domain', () => {
    expect(maskEmail('admin@example.test')).toBe('a****@example.test');
    expect(maskEmail('a@example.test')).toBe('a*@example.test');
    // Not an address at all: nothing is revealed rather than the whole string.
    expect(maskEmail('@example.test')).toBe('*************');
  });

  it('keeps the last four digits of a phone and nothing before them', () => {
    expect(maskPhone('+97699112233')).toBe('****2233');
  });

  it('normalises every written form of one number to one stored shape', () => {
    const forms = ['99112233', '+97699112233', '976 9911 2233', '+976-9911-2233'];
    expect(new Set(forms.map(normaliseContactPhone))).toEqual(new Set(['+97699112233']));
  });

  it('refuses anything that is not eight national digits', () => {
    for (const bad of ['9911223', '991122334', '+7 999 1122333', '', 'nine-nine']) {
      expect(normaliseContactPhone(bad), bad).toBeUndefined();
    }
  });

  it('folds an email search term but not the stored address', () => {
    expect(normaliseEmailTerm('  Admin@Example.Test ')).toBe('admin@example.test');
  });
});

describe('the SMS body', () => {
  it('counts after trimming the ends and keeps everything in between', () => {
    expect(smsCharacterCount('  сайн байна уу  ')).toBe(13);
    expect(smsCharacterCount('a\nb c')).toBe(5);
  });

  it('uses the Latin capacity only when every character is ASCII', () => {
    expect(smsAlphabet('Renewal reminder')).toBe('LATIN');
    expect(smsAlphabet('Сануулга')).toBe('UNICODE');
    // One Cyrillic character is enough to make the whole body Unicode.
    expect(smsAlphabet('Renewal сануулга')).toBe('UNICODE');
  });

  it('divides by the published capacity and rounds up', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(SMS_LATIN_SEGMENT))).toBe(1);
    expect(smsSegments('a'.repeat(SMS_LATIN_SEGMENT + 1))).toBe(2);
    expect(smsSegments('я'.repeat(SMS_UNICODE_SEGMENT))).toBe(1);
    expect(smsSegments('я'.repeat(SMS_UNICODE_SEGMENT + 1))).toBe(2);
    // The 300-character maximum is five Cyrillic segments.
    expect(smsSegments('я'.repeat(300))).toBe(5);
  });

  it('has no cost to show until a tariff is configured', () => {
    expect(estimatedCostMnt(12, undefined)).toBeUndefined();
    expect(estimatedCostMnt(12, 55)).toBe(660);
  });
});

describe('the delivery state of one recipient message', () => {
  it('treats a queued message as still pending, and an unknown status as no news', () => {
    expect(smsStateFor('QUEUED')).toBe('PENDING');
    expect(smsStateFor('SENT')).toBe('SENT');
    expect(smsStateFor('DELIVERED')).toBe('DELIVERED');
    expect(smsStateFor('FAILED')).toBe('FAILED');
    expect(smsStateFor('UNKNOWN')).toBeUndefined();
  });

  it('moves forward only, so a repeated callback cannot rewrite a history', () => {
    expect(smsStateAdvances('PENDING', 'SENT')).toBe(true);
    expect(smsStateAdvances('SENT', 'DELIVERED')).toBe(true);
    expect(smsStateAdvances('SENT', 'FAILED')).toBe(true);
    expect(smsStateAdvances('SENT', 'SENT')).toBe(false);
    expect(smsStateAdvances('DELIVERED', 'SENT')).toBe(false);
    expect(smsStateAdvances('FAILED', 'DELIVERED')).toBe(false);
  });
});

describe('the closed vocabularies', () => {
  it('names the four reconciliation outcomes of doc 14 §4.2 and no others', () => {
    expect(RECONCILIATION_OUTCOMES).toEqual([
      'PROVIDER_STATUS_CORRECTED_NOT_PAID',
      'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL',
      'CHARGEBACK_LINKED',
      'FINANCE_EXCEPTION_CLOSED',
    ]);
    expect(isReconciliationOutcome('CHARGEBACK_LINKED')).toBe(true);
    expect(isReconciliationOutcome('APPLIED_TO_SUBSCRIPTION')).toBe(false);
  });

  it('checks the shape of a suspension reason code without inventing the list', () => {
    expect(isReasonCode('FRAUD_INVESTIGATION')).toBe(true);
    expect(isReasonCode('lowercase')).toBe(false);
    expect(isReasonCode('AB')).toBe(false);
    expect(isReasonCode('A'.repeat(41))).toBe(false);
  });

  it('puts an application in one queue group, and a provisioned one in neither', () => {
    for (const state of UNPAID_APPLICATION_STATES) expect(applicationGroup(state)).toBe('UNPAID');
    for (const state of INACTIVE_APPLICATION_STATES)
      expect(applicationGroup(state)).toBe('INACTIVE');
    expect(applicationGroup('PROVISIONED')).toBeUndefined();
    // The two groups do not overlap, which is what keeps one application from
    // being counted twice (`OPS-DEC-013`).
    const both = UNPAID_APPLICATION_STATES.filter((state) =>
      (INACTIVE_APPLICATION_STATES as readonly string[]).includes(state),
    );
    expect(both).toEqual([]);
  });
});

describe('TOTP', () => {
  // RFC 6238 appendix B, with the ASCII secret the document uses for SHA-1.
  const RFC_SECRET = Buffer.from('12345678901234567890', 'utf8');

  it('reproduces the RFC 6238 test vectors', () => {
    const vectors: readonly [number, string][] = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
    ];
    for (const [seconds, expected] of vectors) {
      const step = totpStep(new Date(seconds * 1000));
      expect(totpCode(RFC_SECRET, step, 6), String(seconds)).toBe(expected);
    }
  });

  it('accepts the current code and one step either side', () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const outcome = verifyTotp({
        secret: RFC_SECRET,
        code: totpCode(RFC_SECRET, step + offset),
        at: now,
        lastAcceptedStep: null,
      });
      expect(outcome, String(offset)).toEqual({ ok: true, step: step + offset });
    }
    expect(
      verifyTotp({
        secret: RFC_SECRET,
        code: totpCode(RFC_SECRET, step + 2),
        at: now,
        lastAcceptedStep: null,
      }).ok,
    ).toBe(false);
  });

  it('refuses a code that has already been accepted, which is the whole point', () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp({ secret: RFC_SECRET, code, at: now, lastAcceptedStep: null }).ok).toBe(true);
    expect(verifyTotp({ secret: RFC_SECRET, code, at: now, lastAcceptedStep: step }).ok).toBe(
      false,
    );
  });

  it('refuses anything that is not six digits before it computes anything', () => {
    const now = new Date();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp({ secret: RFC_SECRET, code, at: now, lastAcceptedStep: null }).ok).toBe(
        false,
      );
    }
  });

  it('encodes a secret the way an authenticator expects to be handed one', () => {
    expect(base32Encode(Buffer.from('12345678901234567890', 'utf8'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
    // Round length: twenty random bytes are thirty-two base32 characters.
    expect(base32Encode(randomBytes(20))).toHaveLength(32);
  });
});
