import { describe, expect, it } from 'vitest';
import { REDACTED, isDeniedFieldName, isDeniedValueShape, redact } from './redaction';

describe('isDeniedFieldName', () => {
  it.each([
    'password',
    'passwordHash',
    'otp',
    'accessCode',
    'token',
    'refreshToken',
    'sessionId',
    'apiKey',
    'webhookSecret',
    'registrationNumber',
    'passportNumber',
    'identifierLookupToken',
    'cvv',
    'smsBody',
    'email',
    'phone',
    'address',
  ])('denies %s', (field) => {
    expect(isDeniedFieldName(field)).toBe(true);
  });

  it.each(['hotel_id', 'stayId', 'requestId', 'roomNumber', 'amountMnt', 'keyVersion'])(
    'allows the reference field %s',
    (field) => {
      expect(isDeniedFieldName(field)).toBe(false);
    },
  );

  it('is insensitive to case and separators', () => {
    expect(isDeniedFieldName('ACCESS_TOKEN')).toBe(true);
    expect(isDeniedFieldName('access-token')).toBe(true);
    expect(isDeniedFieldName('Refresh Token')).toBe(true);
  });
});

describe('isDeniedValueShape', () => {
  it('detects a JWT in an innocuous field', () => {
    expect(
      isDeniedValueShape('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K'),
    ).toBe(true);
  });

  it('detects a PEM private key header', () => {
    expect(isDeniedValueShape('-----BEGIN PRIVATE KEY-----MIIEvQ')).toBe(true);
  });

  it('detects a registration-number shape', () => {
    expect(isDeniedValueShape('8801154321')).toBe(true);
  });

  it('detects a PAN-like digit run', () => {
    expect(isDeniedValueShape('4111 1111 1111 1111')).toBe(true);
  });

  it('detects a long base64 blob', () => {
    expect(isDeniedValueShape('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbg==')).toBe(
      true,
    );
  });

  it('leaves ordinary values alone', () => {
    expect(isDeniedValueShape('Room 203')).toBe(false);
    expect(isDeniedValueShape('checked_in')).toBe(false);
    expect(isDeniedValueShape('')).toBe(false);
  });
});

describe('redact', () => {
  it('redacts by field name at any depth', () => {
    const out = redact({
      stayId: 'stay-1',
      guest: { name: 'A', registrationNumber: '8801154321', nested: { password: 'hunter2' } },
    }) as Record<string, never>;

    expect(out).toMatchObject({
      stayId: 'stay-1',
      guest: { name: 'A', registrationNumber: REDACTED, nested: { password: REDACTED } },
    });
  });

  it('redacts by value shape even when the field name is innocuous', () => {
    const out = redact({ note: '8801154321' }) as { note: string };
    expect(out.note).toBe(REDACTED);
  });

  it('redacts inside arrays', () => {
    const out = redact({ items: [{ token: 'abc' }, { roomNumber: '203' }] }) as {
      items: Array<Record<string, string>>;
    };
    expect(out.items[0]!.token).toBe(REDACTED);
    expect(out.items[1]!.roomNumber).toBe('203');
  });

  it('reduces an Error to name and message', () => {
    const out = redact(new Error('boom')) as { name: string; message: string };
    expect(out).toEqual({ name: 'Error', message: 'boom' });
  });

  it('stops at a depth bound rather than recursing without limit', () => {
    type Deep = { next?: Deep; leaf?: string };
    let deep: Deep = { leaf: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('preserves primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});
