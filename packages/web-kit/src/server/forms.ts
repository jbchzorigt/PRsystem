import { randomUUID } from 'node:crypto';

/**
 * Form helpers for server actions.
 *
 * An idempotency key is minted when the form is *rendered*, not when it is
 * submitted, so a double click or a retried request repeats the same key and
 * the API answers the same result instead of acting twice (CLAUDE.md §6).
 */

export const IDEMPOTENCY_FIELD = 'idempotencyKey';

export function newIdempotencyKey(): string {
  return `portal-${randomUUID()}`;
}

export function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function requiredText(form: FormData, name: string): string {
  const value = text(form, name);
  if (value === undefined) throw new FormFieldError(name, 'заавал бөглөнө');
  return value;
}

export function integer(form: FormData, name: string): number | undefined {
  const value = text(form, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new FormFieldError(name, 'бүхэл тоо байх ёстой');
  return Number(value);
}

export function idempotencyKeyOf(form: FormData): string {
  const value = text(form, IDEMPOTENCY_FIELD);
  return value ?? newIdempotencyKey();
}

export class FormFieldError extends Error {
  override readonly name = 'FormFieldError';

  constructor(
    readonly field: string,
    readonly issue: string,
  ) {
    super(`${field}: ${issue}`);
  }
}

/**
 * Where an action sends the person back, with the outcome in the query string
 * so the page — a server component — can render it without client state.
 */
export function withOutcome(
  path: string,
  outcome: {
    readonly ok?: string;
    readonly error?: string;
    readonly field?: string;
    readonly message?: string;
  },
): string {
  const url = new URL(path, 'http://portal.invalid');
  if (outcome.ok !== undefined) url.searchParams.set('ok', outcome.ok);
  if (outcome.error !== undefined) url.searchParams.set('error', outcome.error);
  if (outcome.field !== undefined) url.searchParams.set('field', outcome.field);
  if (outcome.message !== undefined) url.searchParams.set('message', outcome.message.slice(0, 200));
  return `${url.pathname}${url.search}`;
}

/** The outcome a page reads back from its query string. */
export interface Outcome {
  readonly ok?: string;
  readonly error?: string;
  readonly field?: string;
  readonly message?: string;
}

export function outcomeOf(query: Readonly<Record<string, string | string[] | undefined>>): Outcome {
  const outcome: { ok?: string; error?: string; field?: string; message?: string } = {};
  for (const name of ['ok', 'error', 'field', 'message'] as const) {
    const value = query[name];
    if (typeof value === 'string' && value !== '') outcome[name] = value;
  }
  return outcome;
}
