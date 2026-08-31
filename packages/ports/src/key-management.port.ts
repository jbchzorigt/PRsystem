/**
 * Provider-neutral key management (ADR-0020, ADR-0012).
 *
 * No KMS provider is contracted — tracked as the internal control INT-KMS-01,
 * not as an EXT gate: the EXT-01..EXT-11 namespace is fixed by docs/00 §4 and
 * EXT-10 is Police security. The production adapter is Phase 20.
 */

/** Key scopes are per realm: compromise of one does not expose the other (ADR-0020 §5). */
export type KeyScope = 'pii.hotel_guest' | 'pii.police';

/**
 * Lookup scopes are separate from encryption scopes, and Police lookup has its
 * own. An unkeyed hash of a national identifier is prohibited (ADR-0020 §6).
 */
export type HmacScope =
  | 'lookup.identity'
  | 'lookup.police_identity'
  /**
   * Phase 04 authentication artefacts. Each token kind has its own scope, so a
   * session token digest can never be replayed as an invitation or a reset —
   * the derived key differs even when the token bytes do not (`STAFF-DEC-001`,
   * doc 19 §4, §6).
   */
  | 'auth.session_token'
  | 'auth.invitation_token'
  | 'auth.password_reset_token';

export const KEY_SCOPES: readonly KeyScope[] = ['pii.hotel_guest', 'pii.police'];
export const HMAC_SCOPES: readonly HmacScope[] = [
  'lookup.identity',
  'lookup.police_identity',
  'auth.session_token',
  'auth.invitation_token',
  'auth.password_reset_token',
];

export interface WrappedKey {
  readonly wrapped: Uint8Array;
  readonly keyVersion: string;
}

export interface KeyedMac {
  readonly mac: Uint8Array;
  readonly keyVersion: string;
}

export interface KeyManagementPort {
  wrap(scope: KeyScope, dek: Uint8Array): Promise<WrappedKey>;
  unwrap(scope: KeyScope, wrapped: Uint8Array, keyVersion: string): Promise<Uint8Array>;
  currentVersion(scope: KeyScope): Promise<string>;
  hmac(scope: HmacScope, input: Uint8Array): Promise<KeyedMac>;
}

/**
 * Every failure is typed and carries no key material — only the scope and the
 * version identifier, both of which are safe to record (ADR-0020 §9).
 */
export class KeyManagementError extends Error {
  override readonly name = 'KeyManagementError';

  constructor(
    message: string,
    readonly reason:
      | 'unavailable'
      | 'unknown_key_version'
      | 'scope_not_permitted'
      | 'not_permitted_in_production'
      | 'integrity_failure',
    readonly scope?: string,
  ) {
    super(message);
  }
}
