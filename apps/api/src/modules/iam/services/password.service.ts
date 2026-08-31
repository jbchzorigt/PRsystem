import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ScryptParameters } from '../contracts/security-parameters';
import { AUTH_PARAMETER_HISTORY, AUTH_SECURITY_PARAMETERS } from '../contracts/security-parameters';

/**
 * Password derivation with a memory-hard KDF (`STAFF-DEC-001`, CLAUDE.md §8).
 *
 * `scrypt` is memory-hard by construction and is in the Node standard library,
 * so the platform gains no native dependency for it. The cost parameters are
 * explicit and versioned: the stored value carries the version it was derived
 * under, and verification uses *that* version rather than whichever is current,
 * so raising the cost later cannot lock anybody out.
 *
 * The plaintext never leaves this module. Nothing here logs, and the encoded
 * form is the only thing any caller sees.
 */

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * `scrypt$v=1$n=<N>,r=<r>,p=<p>$<salt>$<hash>` — the shape the database CHECK
 * constraint also requires, so a plaintext password cannot be stored even by a
 * caller that bypassed this module.
 */
const ENCODING_VERSION = 1;
const ENCODED = /^scrypt\$v=(\d+)\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

export class PasswordPolicyError extends Error {
  override readonly name = 'PasswordPolicyError';
}

export interface DerivedCredential {
  /** The encoded value, safe to store. */
  readonly secretHash: string;
  /** The parameter-set version, stored beside it. */
  readonly paramsVersion: string;
}

/**
 * Rejects a password the policy does not accept.
 *
 * Length only, and both bounds. An upper bound matters: `scrypt` cost is
 * independent of input length, but an unbounded input is still an unbounded
 * allocation on a public surface.
 */
export function assertPasswordAcceptable(password: string): void {
  const { passwordMinimumLength, passwordMaximumLength } = AUTH_SECURITY_PARAMETERS;
  if (password.length < passwordMinimumLength) {
    throw new PasswordPolicyError(
      `a password must be at least ${String(passwordMinimumLength)} characters`,
    );
  }
  if (password.length > passwordMaximumLength) {
    throw new PasswordPolicyError(
      `a password must be at most ${String(passwordMaximumLength)} characters`,
    );
  }
}

export async function derivePassword(
  password: string,
  parameters: ScryptParameters = AUTH_SECURITY_PARAMETERS.password,
  version: string = AUTH_SECURITY_PARAMETERS.version,
): Promise<DerivedCredential> {
  assertPasswordAcceptable(password);
  const salt = randomBytes(parameters.saltLength);
  const hash = await derive(password, salt, parameters.keyLength, {
    N: parameters.n,
    r: parameters.r,
    p: parameters.p,
    maxmem: parameters.maxmem,
  });
  const encoded =
    `scrypt$v=${String(ENCODING_VERSION)}$` +
    `n=${String(parameters.n)},r=${String(parameters.r)},p=${String(parameters.p)}$` +
    `${salt.toString('base64')}$${hash.toString('base64')}`;
  return { secretHash: encoded, paramsVersion: version };
}

/**
 * Verifies a candidate against a stored value.
 *
 * The cost parameters come from the *stored* string, not from the current
 * configuration: a credential derived under an older set must keep verifying,
 * and reading them from the configuration would silently invalidate every
 * credential the moment the numbers changed.
 *
 * Returns false rather than throwing on a malformed stored value — a caller
 * cannot tell a wrong password from a corrupt record, which is the point.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = ENCODED.exec(stored);
  if (match === null) return false;
  const [, , n, r, p, saltB64, hashB64] = match;
  if (saltB64 === undefined || hashB64 === undefined) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  let candidate: Buffer;
  try {
    candidate = await derive(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: AUTH_SECURITY_PARAMETERS.password.maxmem,
    });
  } catch {
    // Parameters the stored value names but this process cannot satisfy.
    return false;
  }
  // Constant time: a byte-by-byte comparison leaks how much of the digest
  // matched, which is enough to attack it offline.
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** True when the stored value was derived under a version this build still knows. */
export function parameterVersionIsKnown(version: string): boolean {
  return Object.hasOwn(AUTH_PARAMETER_HISTORY, version);
}
