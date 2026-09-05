/**
 * Provider-neutral key management (ADR-0020, ADR-0012).
 *
 * No KMS provider is contracted — tracked as the internal control INT-KMS-01,
 * not as an EXT gate: the EXT-01..EXT-11 namespace is fixed by docs/00 §4 and
 * EXT-10 is Police security. The production adapter is Phase 20.
 */

/** Key scopes are per realm: compromise of one does not expose the other (ADR-0020 §5). */
export type KeyScope =
  | 'pii.hotel_guest'
  | 'pii.police'
  /**
   * A one-time secret held only long enough to hand it to a provider
   * (doc 19 §6). Its own scope, for the reason every other scope has one:
   * compromise of the guest-PII key must not also open reset links, and the
   * lifetime and rotation cadence of the two have nothing in common.
   */
  | 'auth.delivery_secret'
  /**
   * Subscription-owner identifiers — a citizen registration number or an
   * organisation's state registration number (doc 15 §2.1, §2.2).
   *
   * Its own scope rather than `pii.hotel_guest`: an owner identifier is
   * collected once at onboarding and kept for the life of the ownership, while
   * guest PII is collected per stay and retired on its own schedule. Sharing a
   * key would tie two rotation cadences together and make one compromise open
   * both populations (ADR-0020 §5).
   */
  | 'pii.subscription_owner'
  /**
   * A Guest account's own phone number (doc 09 §6.2). Its own scope rather than
   * `pii.hotel_guest`: the booking account and the person who actually stays are
   * deliberately different records (doc 09 §6.4), collected by different parties
   * under different retention, and one compromise must not open both.
   */
  | 'pii.guest_account';

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
  | 'auth.password_reset_token'
  /**
   * Phase 05 artefacts, each with its own scope for the same reason.
   *
   * `auth.activation_token` is the first Hotel Admin's one-time activation link
   * (`ONB-DEC-003`); `auth.phone_otp` is the onboarding phone verification code
   * (doc 15 §2.1); `auth.onboarding_draft` is the bearer reference that binds an
   * anonymous applicant to their own pre-tenant application and to nobody
   * else's.
   */
  | 'auth.activation_token'
  | 'auth.phone_otp'
  | 'auth.onboarding_draft'
  /**
   * Phase 12 Guest artefacts. A guest's phone is looked up by a keyed token in
   * its own scope — never the hotel guest's identity scope, so the same digits
   * cannot be correlated across the two — its one-time codes are hashed under a
   * scope of their own, and an external provider's subject identifier gets a
   * third (doc 09 §§6.1–6.3, CLAUDE.md §8).
   */
  | 'lookup.guest_phone'
  | 'auth.guest_otp'
  | 'lookup.guest_identity_subject';

export const KEY_SCOPES: readonly KeyScope[] = [
  'pii.hotel_guest',
  'pii.police',
  'auth.delivery_secret',
  'pii.subscription_owner',
  'pii.guest_account',
];
export const HMAC_SCOPES: readonly HmacScope[] = [
  'lookup.identity',
  'lookup.police_identity',
  'auth.session_token',
  'auth.invitation_token',
  'auth.password_reset_token',
  'auth.activation_token',
  'auth.phone_otp',
  'auth.onboarding_draft',
  'lookup.guest_phone',
  'auth.guest_otp',
  'lookup.guest_identity_subject',
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
