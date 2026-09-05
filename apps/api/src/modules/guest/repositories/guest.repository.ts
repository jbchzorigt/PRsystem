import type { UnitOfWork } from '@prsystem/db';
import type { LinkState, VerificationPurpose, VerificationState } from '../domain/guest';

/**
 * The Guest realm's own tables (doc 09 §6).
 *
 * `user_account`, `account_credential` and `server_session` are not among them:
 * they belong to Phase 04 and are reached through `GuestAccountsPort`
 * (CLAUDE.md §3). Nothing here reads a hotel's rows either — a guest belongs to
 * no tenant, and every table below is account-global.
 */

export interface GuestAccountRow {
  readonly accountId: string;
  readonly registeredVia: 'PHONE_OTP' | 'PROVIDER';
  readonly phoneToken: string | null;
  readonly displayName: string | null;
  readonly state: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  readonly phoneVerifiedAt: Date | null;
  readonly revision: number;
}

export interface VerificationRecord {
  readonly verificationId: string;
  readonly phoneToken: string;
  readonly purpose: VerificationPurpose;
  readonly codeHash: string;
  readonly accountId: string | null;
  readonly state: VerificationState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly sentAt: Date;
  readonly expiresAt: Date;
  readonly revision: number;
}

export interface IdentityLinkRow {
  readonly linkId: string;
  readonly provider: 'EMONGOLIA';
  readonly subjectToken: string;
  readonly accountId: string;
  readonly linkedVia: 'PROVIDER_REGISTRATION' | 'DUAL_CHANNEL_LINK';
}

export interface LinkRequestRecord {
  readonly requestId: string;
  readonly accountId: string;
  readonly provider: 'EMONGOLIA';
  readonly subjectToken: string;
  readonly subjectKeyVersion: string;
  readonly state: LinkState;
  readonly providerChannelVerifiedAt: Date | null;
  readonly phoneChannelVerifiedAt: Date | null;
  readonly verificationId: string | null;
  readonly linkId: string | null;
  readonly expiresAt: Date;
  readonly revision: number;
}

const ACCOUNT_COLUMNS = `account_id, registered_via, phone_token, display_name, state,
                         phone_verified_at, revision`;
const VERIFICATION_COLUMNS = `verification_id, phone_token, purpose, code_hash, account_id, state,
                              attempts, max_attempts, sent_at, expires_at, revision`;
const LINK_REQUEST_COLUMNS = `request_id, account_id, provider, subject_token, subject_key_version,
                              state, provider_channel_verified_at, phone_channel_verified_at,
                              verification_id, link_id, expires_at, revision`;

export class GuestRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ------------------------------------------------------------------ account
  async accountByPhoneToken(phoneToken: string): Promise<GuestAccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS} FROM platform.guest_account WHERE phone_token = $1`,
      [phoneToken],
    );
    return mapAccount(result.rows[0]);
  }

  async accountById(accountId: string): Promise<GuestAccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS} FROM platform.guest_account WHERE account_id = $1`,
      [accountId],
    );
    return mapAccount(result.rows[0]);
  }

  /** Locks the profile, so two confirmations cannot both attach a number. */
  async lockAccount(accountId: string): Promise<GuestAccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS} FROM platform.guest_account
        WHERE account_id = $1 FOR UPDATE`,
      [accountId],
    );
    return mapAccount(result.rows[0]);
  }

  /**
   * The sealed number an account holds.
   *
   * Read only by the flow that has to *send* to it — the second channel of a
   * link confirmation (doc 09 §6.3) — and decrypted for the length of that
   * call. No other caller has a reason to see the digits.
   */
  async phoneSecret(accountId: string): Promise<
    | {
        readonly ciphertext: Uint8Array;
        readonly wrappedDek: Uint8Array;
        readonly keyVersion: string;
      }
    | undefined
  > {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT phone_ciphertext, phone_wrapped_dek, phone_key_version
         FROM platform.guest_account
        WHERE account_id = $1 AND phone_ciphertext IS NOT NULL`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      ciphertext: Uint8Array.from(row['phone_ciphertext'] as Buffer),
      wrappedDek: Uint8Array.from(row['phone_wrapped_dek'] as Buffer),
      keyVersion: String(row['phone_key_version']),
    };
  }

  async createPhoneAccount(input: {
    accountId: string;
    phoneToken: string;
    phoneTokenKeyVersion: string;
    phoneCiphertext: Uint8Array;
    phoneWrappedDek: Uint8Array;
    phoneKeyVersion: string;
    verifiedAt: Date;
  }): Promise<GuestAccountRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.guest_account
         (account_id, registered_via, phone_token, phone_token_key_version, phone_ciphertext,
          phone_wrapped_dek, phone_key_version, phone_verified_at)
       VALUES ($1, 'PHONE_OTP', $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.accountId,
        input.phoneToken,
        input.phoneTokenKeyVersion,
        Buffer.from(input.phoneCiphertext),
        Buffer.from(input.phoneWrappedDek),
        input.phoneKeyVersion,
        input.verifiedAt,
      ],
    );
    const row = mapAccount(result.rows[0]);
    if (row === undefined) throw new Error('the guest profile insert returned no row');
    return row;
  }

  /** doc 09 §6.1: an account the provider vouched for, holding no number yet. */
  async createProviderAccount(input: {
    accountId: string;
    displayName: string | null;
  }): Promise<GuestAccountRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.guest_account (account_id, registered_via, display_name)
       VALUES ($1, 'PROVIDER', $2::text)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [input.accountId, input.displayName],
    );
    const row = mapAccount(result.rows[0]);
    if (row === undefined) throw new Error('the guest profile insert returned no row');
    return row;
  }

  // ------------------------------------------------------------ verifications
  /** The live challenge for a number and purpose, if there is one. */
  async pendingVerification(
    phoneToken: string,
    purpose: VerificationPurpose,
  ): Promise<VerificationRecord | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERIFICATION_COLUMNS} FROM platform.guest_phone_verification
        WHERE phone_token = $1 AND purpose = $2 AND state = 'PENDING'
        FOR UPDATE`,
      [phoneToken, purpose],
    );
    return mapVerification(result.rows[0]);
  }

  async lastSentAt(phoneToken: string, purpose: VerificationPurpose): Promise<Date | undefined> {
    const result = await this.uow.query<{ sent_at: Date }>(
      `SELECT sent_at FROM platform.guest_phone_verification
        WHERE phone_token = $1 AND purpose = $2
        ORDER BY sent_at DESC LIMIT 1`,
      [phoneToken, purpose],
    );
    return result.rows[0]?.sent_at;
  }

  async createVerification(input: {
    phoneToken: string;
    purpose: VerificationPurpose;
    codeHash: string;
    codeKeyVersion: string;
    accountId: string | null;
    maxAttempts: number;
    expiresAt: Date;
    requestIpHash: string | null;
  }): Promise<VerificationRecord> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.guest_phone_verification
         (phone_token, purpose, code_hash, code_key_version, account_id, max_attempts,
          expires_at, request_ip_hash)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7::timestamptz, $8::text)
       RETURNING ${VERIFICATION_COLUMNS}`,
      [
        input.phoneToken,
        input.purpose,
        input.codeHash,
        input.codeKeyVersion,
        input.accountId,
        input.maxAttempts,
        input.expiresAt,
        input.requestIpHash,
      ],
    );
    const row = mapVerification(result.rows[0]);
    if (row === undefined) throw new Error('the verification insert returned no row');
    return row;
  }

  /**
   * Records an attempt, and settles the challenge when the attempt settles it.
   *
   * One statement, guarded by the revision: two callers presenting a code at
   * the same moment cannot both spend the last attempt, and neither can consume
   * a challenge the other has already consumed.
   */
  async recordAttempt(input: {
    verificationId: string;
    expectedRevision: number;
    attempts: number;
    state: VerificationState | undefined;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.guest_phone_verification
          SET attempts = $3,
              state = COALESCE($4::text, state),
              consumed_at = CASE WHEN $4::text = 'CONSUMED' THEN now() ELSE consumed_at END,
              revision = revision + 1
        WHERE verification_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [input.verificationId, input.expectedRevision, input.attempts, input.state ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Supersedes the live challenge for a number and purpose, so a resend does
   * not stack (the partial unique index refuses a second PENDING row). */
  async supersedePending(phoneToken: string, purpose: VerificationPurpose): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.guest_phone_verification
          SET state = 'EXPIRED', revision = revision + 1
        WHERE phone_token = $1 AND purpose = $2 AND state = 'PENDING'`,
      [phoneToken, purpose],
    );
    return result.rowCount ?? 0;
  }

  // -------------------------------------------------------------------- links
  async linkBySubject(
    provider: 'EMONGOLIA',
    subjectToken: string,
  ): Promise<IdentityLinkRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT link_id, provider, subject_token, account_id, linked_via
         FROM platform.guest_identity_link
        WHERE provider = $1 AND subject_token = $2`,
      [provider, subjectToken],
    );
    return mapLink(result.rows[0]);
  }

  async linkForAccount(
    provider: 'EMONGOLIA',
    accountId: string,
  ): Promise<IdentityLinkRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT link_id, provider, subject_token, account_id, linked_via
         FROM platform.guest_identity_link
        WHERE provider = $1 AND account_id = $2`,
      [provider, accountId],
    );
    return mapLink(result.rows[0]);
  }

  async createLink(input: {
    provider: 'EMONGOLIA';
    subjectToken: string;
    subjectKeyVersion: string;
    accountId: string;
    linkedVia: 'PROVIDER_REGISTRATION' | 'DUAL_CHANNEL_LINK';
  }): Promise<IdentityLinkRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.guest_identity_link
         (provider, subject_token, subject_key_version, account_id, linked_via)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING link_id, provider, subject_token, account_id, linked_via`,
      [
        input.provider,
        input.subjectToken,
        input.subjectKeyVersion,
        input.accountId,
        input.linkedVia,
      ],
    );
    const row = mapLink(result.rows[0]);
    if (row === undefined) throw new Error('the identity link insert returned no row');
    return row;
  }

  async createLinkRequest(input: {
    accountId: string;
    provider: 'EMONGOLIA';
    subjectToken: string;
    subjectKeyVersion: string;
    expiresAt: Date;
  }): Promise<LinkRequestRecord> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.guest_account_link_request
         (account_id, provider, subject_token, subject_key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       RETURNING ${LINK_REQUEST_COLUMNS}`,
      [
        input.accountId,
        input.provider,
        input.subjectToken,
        input.subjectKeyVersion,
        input.expiresAt,
      ],
    );
    const row = mapLinkRequest(result.rows[0]);
    if (row === undefined) throw new Error('the link request insert returned no row');
    return row;
  }

  async lockLinkRequest(requestId: string): Promise<LinkRequestRecord | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LINK_REQUEST_COLUMNS} FROM platform.guest_account_link_request
        WHERE request_id = $1 FOR UPDATE`,
      [requestId],
    );
    return mapLinkRequest(result.rows[0]);
  }

  /**
   * Advances a link request. Guarded by the revision, and by the state the
   * caller believed it was in — the database trigger refuses to reopen a
   * decided request, and this refuses to race one.
   */
  async advanceLinkRequest(input: {
    requestId: string;
    expectedRevision: number;
    state: LinkState;
    providerVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    verificationId?: string;
    linkId?: string;
    reason?: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.guest_account_link_request
          SET state = $3::text,
              provider_channel_verified_at =
                COALESCE(provider_channel_verified_at, $4::timestamptz),
              phone_channel_verified_at = COALESCE(phone_channel_verified_at, $5::timestamptz),
              verification_id = COALESCE(verification_id, $6::uuid),
              link_id = COALESCE(link_id, $7::uuid),
              reason = COALESCE($8::text, reason),
              decided_at = CASE WHEN $3::text = 'PENDING' THEN decided_at ELSE now() END,
              revision = revision + 1
        WHERE request_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [
        input.requestId,
        input.expectedRevision,
        input.state,
        input.providerVerifiedAt ?? null,
        input.phoneVerifiedAt ?? null,
        input.verificationId ?? null,
        input.linkId ?? null,
        input.reason ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

function mapAccount(row: Record<string, unknown> | undefined): GuestAccountRow | undefined {
  if (row === undefined) return undefined;
  return {
    accountId: String(row['account_id']),
    registeredVia: row['registered_via'] as GuestAccountRow['registeredVia'],
    phoneToken: (row['phone_token'] as string | null) ?? null,
    displayName: (row['display_name'] as string | null) ?? null,
    state: row['state'] as GuestAccountRow['state'],
    phoneVerifiedAt: (row['phone_verified_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapVerification(row: Record<string, unknown> | undefined): VerificationRecord | undefined {
  if (row === undefined) return undefined;
  return {
    verificationId: String(row['verification_id']),
    phoneToken: String(row['phone_token']),
    purpose: row['purpose'] as VerificationPurpose,
    codeHash: String(row['code_hash']),
    accountId: (row['account_id'] as string | null) ?? null,
    state: row['state'] as VerificationState,
    attempts: Number(row['attempts']),
    maxAttempts: Number(row['max_attempts']),
    sentAt: row['sent_at'] as Date,
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapLink(row: Record<string, unknown> | undefined): IdentityLinkRow | undefined {
  if (row === undefined) return undefined;
  return {
    linkId: String(row['link_id']),
    provider: row['provider'] as 'EMONGOLIA',
    subjectToken: String(row['subject_token']),
    accountId: String(row['account_id']),
    linkedVia: row['linked_via'] as IdentityLinkRow['linkedVia'],
  };
}

function mapLinkRequest(row: Record<string, unknown> | undefined): LinkRequestRecord | undefined {
  if (row === undefined) return undefined;
  return {
    requestId: String(row['request_id']),
    accountId: String(row['account_id']),
    provider: row['provider'] as 'EMONGOLIA',
    subjectToken: String(row['subject_token']),
    subjectKeyVersion: String(row['subject_key_version']),
    state: row['state'] as LinkState,
    providerChannelVerifiedAt: (row['provider_channel_verified_at'] as Date | null) ?? null,
    phoneChannelVerifiedAt: (row['phone_channel_verified_at'] as Date | null) ?? null,
    verificationId: (row['verification_id'] as string | null) ?? null,
    linkId: (row['link_id'] as string | null) ?? null,
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}
