import { inspect } from 'node:util';

/**
 * A credential a production adapter holds (CLAUDE.md §8, architecture 08 §6).
 *
 * The value is reachable through `expose()` and through nothing else: string
 * coercion, JSON serialisation and `util.inspect` — the three ways a value
 * reaches a log line, an error message or a trace attribute by accident — all
 * answer the redaction marker. An adapter keeps its secret in one of these and
 * exposes it only at the point of signing.
 */
export const REDACTED_SECRET = '[redacted]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new Error('a secret cannot be empty');
    this.#value = value;
  }

  /** The value, for the one call that needs it. Never store what this returns. */
  expose(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED_SECRET;
  }

  toJSON(): string {
    return REDACTED_SECRET;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED_SECRET})`;
  }
}
