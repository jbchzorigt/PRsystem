import { describe, expect, it } from 'vitest';
import {
  FormFieldError,
  IDEMPOTENCY_FIELD,
  idempotencyKeyOf,
  integer,
  newIdempotencyKey,
  outcomeOf,
  requiredText,
  text,
  withOutcome,
} from './forms';

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
};

describe('form helpers', () => {
  it('reads trimmed text and refuses a missing required field by name', () => {
    expect(text(form({ a: '  x ' }), 'a')).toBe('x');
    expect(text(form({ a: '   ' }), 'a')).toBeUndefined();
    expect(() => requiredText(form({}), 'email')).toThrow(FormFieldError);
    try {
      requiredText(form({}), 'email');
    } catch (error) {
      expect((error as FormFieldError).field).toBe('email');
    }
  });

  it('parses whole numbers only', () => {
    expect(integer(form({ n: '12' }), 'n')).toBe(12);
    expect(integer(form({ n: '-3' }), 'n')).toBe(-3);
    expect(integer(form({}), 'n')).toBeUndefined();
    expect(() => integer(form({ n: '1.5' }), 'n')).toThrow(FormFieldError);
  });

  it('repeats the key the form was rendered with, and mints one only when none came', () => {
    expect(idempotencyKeyOf(form({ [IDEMPOTENCY_FIELD]: 'portal-abc' }))).toBe('portal-abc');
    const minted = idempotencyKeyOf(form({}));
    expect(minted).toMatch(/^portal-[0-9a-f-]{36}$/u);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it('round-trips an outcome through the query string, truncating the message', () => {
    const path = withOutcome('/hotels/1/check-in', {
      ok: 'checked-in',
      field: 'room',
      message: 'm'.repeat(300),
    });
    expect(path.startsWith('/hotels/1/check-in?')).toBe(true);
    const query = Object.fromEntries(new URL(path, 'http://x').searchParams.entries());
    expect(outcomeOf(query)).toEqual({ ok: 'checked-in', field: 'room', message: 'm'.repeat(200) });
    expect(outcomeOf({ ok: '', error: ['a'], message: undefined })).toEqual({});
  });
});
