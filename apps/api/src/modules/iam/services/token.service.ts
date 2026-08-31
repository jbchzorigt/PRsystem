import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { HmacScope, KeyManagementPort } from '@prsystem/ports';

/**
 * One-time authentication tokens (`STAFF-DEC-001`, doc 19 §4/§6, ADR-0020 §6).
 *
 * Two rules this module exists to make structural:
 *
 *  - **Nothing stores the token.** What is stored is a versioned keyed HMAC of
 *    it, so a database reader cannot mint an invitation, a reset or a session.
 *  - **The digest is purpose- and subject-bound.** The HMAC scope differs per
 *    token kind, and the subject (the invitation, the account) is part of the
 *    input, so a digest produced for one artefact cannot be replayed as another
 *    even if the token bytes were somehow reused.
 */

/** 32 bytes of CSPRNG output, base64url — no structure to guess or enumerate. */
const TOKEN_BYTES = 32;

export type TokenPurpose = 'session' | 'invitation' | 'password_reset';

const SCOPE_BY_PURPOSE: Readonly<Record<TokenPurpose, HmacScope>> = {
  session: 'auth.session_token',
  invitation: 'auth.invitation_token',
  password_reset: 'auth.password_reset_token',
};

export interface TokenDigest {
  /** Hex, 64 characters. Safe to store and to index. */
  readonly tokenHash: string;
  readonly keyVersion: string;
}

export interface IssuedToken extends TokenDigest {
  /**
   * The plaintext. Returned once, to the caller that will hand it to the
   * delivery port, and never persisted, logged or echoed in a response.
   */
  readonly token: string;
}

/**
 * Length-prefixed, so no two different subject/purpose pairs can produce the
 * same input bytes by concatenation.
 */
function bind(purpose: TokenPurpose, subject: string, token: string): Buffer {
  const parts = [purpose, subject, token];
  return Buffer.from(parts.map((part) => `${String(part.length)}:${part}`).join('|'), 'utf8');
}

export class TokenService {
  constructor(private readonly keys: KeyManagementPort) {}

  async issue(purpose: TokenPurpose, subject: string): Promise<IssuedToken> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const digest = await this.digest(purpose, subject, token);
    return { ...digest, token };
  }

  async digest(purpose: TokenPurpose, subject: string, token: string): Promise<TokenDigest> {
    const { mac, keyVersion } = await this.keys.hmac(
      SCOPE_BY_PURPOSE[purpose],
      bind(purpose, subject, token),
    );
    return { tokenHash: Buffer.from(mac).toString('hex'), keyVersion };
  }

  /**
   * Compares a presented token against a stored digest in constant time.
   *
   * The comparison is on the digests, so a mismatch tells an attacker nothing
   * about how much of the token was right.
   */
  async matches(
    purpose: TokenPurpose,
    subject: string,
    token: string,
    storedHash: string,
  ): Promise<boolean> {
    const { tokenHash } = await this.digest(purpose, subject, token);
    const a = Buffer.from(tokenHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }
}

/**
 * A session token is looked up before its subject is known, so its digest is
 * bound to the purpose alone. Everything else about the session — the account,
 * the epoch, the expiry — is then read from the row the digest identifies and
 * re-checked.
 */
export const SESSION_TOKEN_SUBJECT = 'session';
