/**
 * Authentication security parameters — **provisional, and versioned as such**.
 *
 * doc 19 §14 leaves the numbers open: "Invitation/reset link-ийн TTL, resend
 * interval, attempt/rate limit болон password security-ийн тоон утга нь P1
 * authentication security configuration". P1-06 is still open in
 * `assumptions-and-conflicts.md`, so nothing here is a resolved decision.
 *
 * What Phase 04 owns is the *shape*: every value is named, carried in one
 * versioned record, and stamped onto the artefacts it produced, so that when
 * the P1 values are approved the change is a new version rather than a hunt
 * through call sites. A credential stores the version it was derived under; a
 * verification reads that version rather than the current one.
 */

export interface ScryptParameters {
  /** CPU/memory cost. Must be a power of two. */
  readonly n: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
  /** Derived key length, in bytes. */
  readonly keyLength: number;
  /** Salt length, in bytes. */
  readonly saltLength: number;
  /**
   * `scrypt` needs `maxmem` at least 128 · N · r bytes. Stated rather than
   * defaulted: Node's default is 32 MiB and refuses these parameters outright.
   */
  readonly maxmem: number;
}

export interface AuthSecurityParameters {
  /**
   * The identifier stored beside every derived credential. Provisional values
   * carry a `p1-provisional` prefix so a stored credential says plainly that it
   * was derived under an unapproved parameter set.
   */
  readonly version: string;
  readonly password: ScryptParameters;
  /** doc 19 §4: an invitation is time-limited and single-use. */
  readonly invitationTtlSeconds: number;
  /** The shortest interval between two resends of the same invitation. */
  readonly invitationResendIntervalSeconds: number;
  /** doc 19 §6: a reset link is time-limited and single-use. */
  readonly passwordResetTtlSeconds: number;
  readonly passwordResetResendIntervalSeconds: number;
  /** doc 05 §1: hotel sessions are scoped per membership; idle and absolute caps. */
  readonly sessionIdleSeconds: number;
  readonly sessionAbsoluteSeconds: number;
  /** doc 05 §5: a step-up is proof of recent possession. */
  readonly stepUpWindowSeconds: number;
  /** Failed sign-in attempts before the credential path refuses. */
  readonly signInAttemptLimit: number;
  readonly signInAttemptWindowSeconds: number;
  /** Requests per account per window on the token-issuing surfaces. */
  readonly tokenRequestLimit: number;
  readonly tokenRequestWindowSeconds: number;
  /** Minimum length of a user-created password. */
  readonly passwordMinimumLength: number;
  readonly passwordMaximumLength: number;
  /**
   * How long one worker owns a claimed reset-delivery entry before another may
   * reclaim it. Long enough that an ordinary delivery finishes inside it; short
   * enough that a worker that died does not strand the entry.
   */
  readonly passwordResetLeaseSeconds: number;
  /**
   * Deliveries attempted before an entry is dead-lettered for an operator.
   * Bounded on purpose: an address the provider never accepts must stop being
   * retried and start being visible.
   */
  readonly passwordResetDeliveryMaxAttempts: number;
  /** Backoff base, doubled per attempt and capped by the ceiling below. */
  readonly passwordResetRetryBackoffSeconds: number;
  readonly passwordResetRetryBackoffCeilingSeconds: number;
}

/**
 * The current parameter set.
 *
 * `scrypt` is the memory-hard KDF: it is in the Node standard library, so the
 * platform gains no native dependency, and its cost parameters are explicit
 * rather than implied. N = 2^15 with r = 8 needs 32 MiB per derivation, which is
 * why `maxmem` is stated.
 */
export const AUTH_SECURITY_PARAMETERS: AuthSecurityParameters = {
  version: 'p1-provisional-2026-08',
  password: {
    n: 32768,
    r: 8,
    p: 1,
    keyLength: 32,
    saltLength: 16,
    maxmem: 64 * 1024 * 1024,
  },
  invitationTtlSeconds: 7 * 24 * 60 * 60,
  invitationResendIntervalSeconds: 60,
  passwordResetTtlSeconds: 60 * 60,
  passwordResetResendIntervalSeconds: 60,
  sessionIdleSeconds: 30 * 60,
  sessionAbsoluteSeconds: 8 * 60 * 60,
  stepUpWindowSeconds: 10 * 60,
  signInAttemptLimit: 5,
  signInAttemptWindowSeconds: 15 * 60,
  tokenRequestLimit: 5,
  tokenRequestWindowSeconds: 60 * 60,
  passwordMinimumLength: 12,
  passwordMaximumLength: 256,
  // Provisional like everything else here: doc 19 §14 leaves the retry and
  // lease numbers open with the rest of P1-06, and nothing below is an approved
  // customer decision.
  passwordResetLeaseSeconds: 2 * 60,
  passwordResetDeliveryMaxAttempts: 5,
  passwordResetRetryBackoffSeconds: 30,
  passwordResetRetryBackoffCeilingSeconds: 15 * 60,
};

/**
 * Every parameter set this platform has ever issued, by version.
 *
 * A credential derived under an older version must still verify, so the set it
 * was derived under is looked up here rather than assumed to be the current
 * one. Entries are added, never edited: editing one would silently change what
 * an existing stored hash means.
 */
export const AUTH_PARAMETER_HISTORY: Readonly<Record<string, ScryptParameters>> = {
  [AUTH_SECURITY_PARAMETERS.version]: AUTH_SECURITY_PARAMETERS.password,
};

/** True while the active parameter set is still an unapproved P1 placeholder. */
export function parametersAreProvisional(
  parameters: AuthSecurityParameters = AUTH_SECURITY_PARAMETERS,
): boolean {
  return parameters.version.startsWith('p1-provisional');
}
