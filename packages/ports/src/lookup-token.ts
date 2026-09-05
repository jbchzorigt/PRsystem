import type { HmacScope, KeyManagementPort } from './key-management.port';

/**
 * Versioned keyed-HMAC lookup tokens (ADR-0020 §6).
 *
 * Exact-match lookup never touches the plaintext identifier and never uses an
 * unkeyed digest: the identifier space for a national registration number is
 * small enough to enumerate.
 */

/**
 * Namespacing by identity type **and** country is what stops the same digits
 * producing the same token for a passport and a registration number, or across
 * two countries' numbering schemes.
 */
export interface IdentityNamespace {
  readonly identityType:
    | 'registration_number'
    | 'passport'
    | 'foreign_id'
    /** A Guest account's phone number (doc 09 §6.2). */
    | 'phone'
    /** An external identity provider's subject identifier (doc 09 §6.1). */
    | 'provider_subject';
  readonly countryCode: string;
}

export interface LookupToken {
  /** Hex digest. Safe to index and to store; not reversible without the key. */
  readonly token: string;
  readonly keyVersion: string;
}

function namespaced(namespace: IdentityNamespace, identifier: string): Buffer {
  const country = namespace.countryCode.trim().toUpperCase();
  // Length-prefixed so that ('MN', 'G12') and ('MNG', '12') cannot collide.
  const parts = [namespace.identityType, country, identifier];
  return Buffer.from(parts.map((part) => `${String(part.length)}:${part}`).join('|'), 'utf8');
}

export async function deriveLookupToken(
  kms: KeyManagementPort,
  scope: HmacScope,
  namespace: IdentityNamespace,
  identifier: string,
): Promise<LookupToken> {
  const { mac, keyVersion } = await kms.hmac(scope, namespaced(namespace, identifier));
  return { token: Buffer.from(mac).toString('hex'), keyVersion };
}
