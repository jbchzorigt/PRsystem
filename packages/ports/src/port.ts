/**
 * The port contract every external system follows
 * (docs/architecture/16-external-port-catalog.md §1).
 *
 * A port translates; it never decides a business outcome. It never throws
 * across the boundary — every failure is a typed result the domain reads — and
 * an adapter whose gate is uncleared answers `DISABLED` without a network call.
 * Idempotency belongs to the caller: the domain supplies the key and the port
 * forwards it.
 */

export type PortMode = 'simulator' | 'adapter';

export type PortError =
  /** Fail closed: the production adapter exists but its gate has not cleared. */
  | { readonly kind: 'DISABLED'; readonly gate: string }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: true }
  | { readonly kind: 'TIMEOUT'; readonly retryable: true }
  | { readonly kind: 'REJECTED'; readonly providerCode: string }
  | { readonly kind: 'INVALID_SIGNATURE' }
  | { readonly kind: 'MISMATCH'; readonly field: 'reference' | 'amount' | 'currency' | 'merchant' };

export type PortResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PortError };

export interface PortContext {
  /** Correlates the provider exchange with the request or job that made it. */
  readonly correlationId: string;
}

export interface Port<Cmd, Res> {
  readonly id: string;
  readonly mode: PortMode;
  execute(cmd: Cmd, ctx: PortContext): Promise<PortResult<Res>>;
}

export function ok<T>(value: T): PortResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: PortError): PortResult<T> {
  return { ok: false, error };
}

/** True when a port error is worth another attempt rather than an operator. */
export function isRetryable(error: PortError): boolean {
  return error.kind === 'UNAVAILABLE' || error.kind === 'TIMEOUT';
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

/**
 * The one environment rule every selector applies: a simulator is reachable in
 * local, CI and test and nowhere else. The same rule the key-management
 * selector applies, for the same reason (ADR-0020 §7).
 */
export function isNonProductionEnv(appEnv: string): boolean {
  return NON_PRODUCTION.has(appEnv);
}
