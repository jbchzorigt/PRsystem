/**
 * Redaction — docs/architecture/13-telemetry-and-redaction.md §3.
 *
 * Redaction is a property of the logger, not a discipline of the caller: a developer
 * who passes a forbidden value must still be unable to leak it. Two independent
 * mechanisms run:
 *
 *   1. a deny-list of field names;
 *   2. a deny-list of value shapes, applied even when the field name looks innocuous.
 *
 * `*_id` fields are references, not content, and are deliberately allowed.
 */

export const REDACTED = '[REDACTED]';

/** Field names whose values are never emitted, in any signal. */
export const DENIED_FIELD_NAMES: readonly string[] = [
  'password',
  'passwordhash',
  'passwordconfirmation',
  'otp',
  'code',
  'accesscode',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessionid',
  'secret',
  'clientsecret',
  'apikey',
  'webhooksecret',
  'signature',
  'authorization',
  'cookie',
  'setcookie',
  'registrationnumber',
  'passportnumber',
  'documentnumber',
  'identifier',
  'identifierciphertext',
  'identifierlookuptoken',
  'pan',
  'cvv',
  'cardnumber',
  'smsbody',
  'messagebody',
  'email',
  'phone',
  'address',
  'dek',
  'kek',
  'keymaterial',
];

const deniedFieldSet = new Set(DENIED_FIELD_NAMES);

/** Value shapes that must be redacted wherever they appear. */
const DENIED_VALUE_SHAPES: readonly RegExp[] = [
  /^\d{2}[01]\d[0-3]\d\d{4}$/, // Mongolian-style registration number: YYMMDD + 4 digits
  /^[А-ЯӨҮ]{2}\d{8}$/u, // Mongolian registration number with Cyrillic prefix
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/, // JWT
  /^-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, // PEM private key
  /^(?:\d[ -]?){13,19}$/, // PAN-like digit run
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // long base64 blob (wrapped key, high-entropy secret)
];

/** True when a field name is on the deny-list. Case- and separator-insensitive. */
export function isDeniedFieldName(name: string): boolean {
  const normalised = name.toLowerCase().replace(/[-_\s]/g, '');
  if (deniedFieldSet.has(normalised)) return true;
  // `*_id` is an allowed reference; anything ending in `secret`/`token`/`password` is not.
  if (normalised.endsWith('id') && !normalised.endsWith('sessionid')) return false;
  return (
    normalised.endsWith('secret') ||
    normalised.endsWith('token') ||
    normalised.endsWith('password') ||
    normalised.endsWith('apikey')
  );
}

/** True when a value's shape marks it as sensitive regardless of its field name. */
export function isDeniedValueShape(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return DENIED_VALUE_SHAPES.some((pattern) => pattern.test(trimmed));
}

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

/**
 * Recursively redact a value. Applied by the logger to every payload it emits, so
 * redaction cannot be bypassed by passing a forbidden value explicitly.
 */
export function redact(input: unknown, depth = 0): Json {
  if (depth > 8) return REDACTED;

  if (input === null || input === undefined) return input as Json;
  if (typeof input === 'string') return isDeniedValueShape(input) ? REDACTED : input;
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (typeof input === 'bigint') return input.toString();
  if (input instanceof Error) {
    return { name: input.name, message: String(redact(input.message, depth + 1)) };
  }
  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1));

  if (typeof input === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = isDeniedFieldName(key) ? REDACTED : redact(value, depth + 1);
    }
    return out;
  }

  return REDACTED;
}
