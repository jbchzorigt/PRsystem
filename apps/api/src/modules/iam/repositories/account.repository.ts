import type { UnitOfWork } from '@prsystem/db';
import { ApiError } from '@prsystem/contracts';
import {
  isOperationRole,
  isRealmRole,
  operationGrantablePermissions,
  policeGrantablePermissions,
} from '@prsystem/authz';

/**
 * The account-scoped half of IAM: accounts, credentials, sessions, reset
 * requests and explicit permission grants.
 *
 * None of these tables carries `hotel_id`, and that is the design rather than an
 * omission: one person holds memberships in several hotels (`STAFF-DEC-002`),
 * a password change crosses all of them (`STAFF-DEC-003`), and an Operation or
 * Police permission belongs to no tenant at all (`RBAC-DEC-004`). The tenant
 * boundary sits on the membership, which is where RLS applies.
 */

export interface AccountRow {
  readonly accountId: string;
  readonly realm: string;
  /** doc 18 §5 / §6. `null` for a Hotel account, which has no matrix column. */
  readonly realmRole: string | null;
  readonly policeScopeRef: string | null;
  readonly emailNormalized: string;
  readonly state: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  readonly authEpoch: number;
  readonly emailVerifiedAt: Date | null;
  readonly revision: number;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly accountId: string;
  readonly realm: string;
  readonly accountEpoch: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly stepUpAt: Date | null;
  readonly revokedAt: Date | null;
}

/** What happened to a queued request. Recorded, never returned to the caller. */
export type ResetIntakeOutcome = 'sent' | 'ignored' | 'throttled' | 'unavailable' | 'dead_letter';

export interface ResetIntakeRow {
  readonly intakeId: string;
  readonly emailNormalized: string;
  readonly attempts: number;
  /** The lease this worker holds. Every settlement is a CAS on it. */
  readonly claimToken: string;
  readonly initiatedBy: 'self' | 'hotel_admin';
  readonly initiatedByAccountId: string | null;
}

/** The reset intent one queue entry owns, whatever state it has reached. */
export interface IntakeResetRow {
  readonly resetId: string;
  readonly deliveryId: string;
  readonly state: string;
  readonly expiresAt: Date;
  readonly deliveredAt: Date | null;
  readonly ciphertext: string | null;
  readonly wrappedDek: string | null;
  readonly keyVersion: string | null;
}

export interface ResetRow {
  readonly resetId: string;
  readonly accountId: string;
  readonly state: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const ACCOUNT_COLUMNS = `account_id, realm, realm_role, police_scope_ref, email_normalized,
                         state, auth_epoch, email_verified_at, revision`;

/** Lower-cased and trimmed. The stored form, and the only form compared. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AccountRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async findByEmail(realm: string, email: string): Promise<AccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM platform.user_account
        WHERE realm = $1 AND email_normalized = $2`,
      [realm, normaliseEmail(email)],
    );
    return mapAccount(result.rows[0]);
  }

  async findById(accountId: string): Promise<AccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM platform.user_account
        WHERE account_id = $1`,
      [accountId],
    );
    return mapAccount(result.rows[0]);
  }

  /** Locks the row, so an epoch bump and a session issue cannot interleave. */
  async lockById(accountId: string): Promise<AccountRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM platform.user_account
        WHERE account_id = $1
          FOR UPDATE`,
      [accountId],
    );
    return mapAccount(result.rows[0]);
  }

  async create(realm: string, email: string, verified: boolean): Promise<AccountRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.user_account (realm, email_normalized, email_verified_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [realm, normaliseEmail(email), verified],
    );
    const row = mapAccount(result.rows[0]);
    if (row === undefined) throw new Error('the account insert returned no row');
    return row;
  }

  /**
   * Bumps the account-wide revocation marker.
   *
   * doc 19 §10: a successful password reset or change closes every session on
   * every device and in every membership. The epoch is what makes that one
   * write rather than a fan-out that could partly fail.
   */
  async bumpAuthEpoch(accountId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.user_account
          SET auth_epoch = auth_epoch + 1, revision = revision + 1
        WHERE account_id = $1 AND revision = $2`,
      [accountId, expectedRevision],
    );
    return result.rowCount === 1;
  }

  async setState(
    accountId: string,
    state: AccountRow['state'],
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.user_account
          SET state = $2, revision = revision + 1
        WHERE account_id = $1 AND revision = $3`,
      [accountId, state, expectedRevision],
    );
    return result.rowCount === 1;
  }

  async markEmailVerified(accountId: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.user_account
          SET email_verified_at = coalesce(email_verified_at, now()), revision = revision + 1
        WHERE account_id = $1`,
      [accountId],
    );
  }

  // -------------------------------------------------------------- credentials
  async credentialFor(accountId: string): Promise<{ secretHash: string } | undefined> {
    const result = await this.uow.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM platform.account_credential
        WHERE account_id = $1 AND kind = 'password'`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { secretHash: row.secret_hash };
  }

  /** Creates or replaces the one password credential an account may hold. */
  async upsertPassword(
    accountId: string,
    secretHash: string,
    paramsVersion: string,
  ): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.account_credential (account_id, kind, secret_hash, params_version)
       VALUES ($1, 'password', $2, $3)
       ON CONFLICT (account_id, kind) DO UPDATE
          SET secret_hash = EXCLUDED.secret_hash,
              params_version = EXCLUDED.params_version,
              updated_at = now(),
              revision = platform.account_credential.revision + 1`,
      [accountId, secretHash, paramsVersion],
    );
  }

  // ----------------------------------------------------------------- sessions
  async createSession(input: {
    accountId: string;
    realm: string;
    tokenHash: string;
    tokenKeyVersion: string;
    accountEpoch: number;
    idleSeconds: number;
    absoluteSeconds: number;
    stepUp: boolean;
  }): Promise<string> {
    const result = await this.uow.query<{ session_id: string }>(
      `INSERT INTO platform.server_session
         (account_id, realm, token_hash, token_key_version, account_epoch,
          idle_expires_at, absolute_expires_at, step_up_at)
       VALUES ($1, $2, $3, $4, $5,
               now() + make_interval(secs => $6),
               now() + make_interval(secs => $7),
               CASE WHEN $8 THEN now() ELSE NULL END)
       RETURNING session_id`,
      [
        input.accountId,
        input.realm,
        input.tokenHash,
        input.tokenKeyVersion,
        input.accountEpoch,
        input.idleSeconds,
        input.absoluteSeconds,
        input.stepUp,
      ],
    );
    const id = result.rows[0]?.session_id;
    if (id === undefined) throw new Error('the session insert returned no row');
    return id;
  }

  async findLiveSessionByHash(tokenHash: string): Promise<SessionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT session_id, account_id, realm, account_epoch, idle_expires_at,
              absolute_expires_at, step_up_at, revoked_at
         FROM platform.server_session
        WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: String(row['session_id']),
      accountId: String(row['account_id']),
      realm: String(row['realm']),
      accountEpoch: Number(row['account_epoch']),
      idleExpiresAt: row['idle_expires_at'] as Date,
      absoluteExpiresAt: row['absolute_expires_at'] as Date,
      stepUpAt: (row['step_up_at'] as Date | null) ?? null,
      revokedAt: (row['revoked_at'] as Date | null) ?? null,
    };
  }

  /**
   * Extends the idle window, never past the absolute one.
   *
   * doc 19 §10 gives a session two independent limits, and the absolute limit is
   * the one activity cannot move. `LEAST` is not a convenience here: without it
   * a request arriving inside the last idle-window before the absolute expiry
   * writes `idle > absolute`, which the row's own CHECK refuses — so an ordinary
   * request near the end of a long session failed with a constraint violation
   * rather than being served.
   */
  async touchSession(sessionId: string, idleSeconds: number): Promise<void> {
    await this.uow.query(
      `UPDATE platform.server_session
          SET last_seen_at = now(),
              idle_expires_at = LEAST(now() + make_interval(secs => $2), absolute_expires_at)
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, idleSeconds],
    );
  }

  /** Revokes every live session of one account. Returns how many were closed. */
  async revokeAllSessions(accountId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.server_session
          SET revoked_at = now(), revoked_reason = $2, revision = revision + 1
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, reason],
    );
    return result.rowCount;
  }

  async revokeSession(sessionId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.server_session
          SET revoked_at = now(), revoked_reason = $2, revision = revision + 1
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    return result.rowCount;
  }

  // ----------------------------------------------------------- password reset
  async activeResetFor(accountId: string): Promise<ResetRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT reset_id, account_id, state, token_hash, expires_at, created_at
         FROM platform.password_reset_request
        WHERE account_id = $1 AND state = 'ACTIVE'
          FOR UPDATE`,
      [accountId],
    );
    return mapReset(result.rows[0]);
  }

  async findResetByHash(tokenHash: string): Promise<ResetRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT reset_id, account_id, state, token_hash, expires_at, created_at
         FROM platform.password_reset_request
        WHERE token_hash = $1
          FOR UPDATE`,
      [tokenHash],
    );
    return mapReset(result.rows[0]);
  }

  /**
   * Records the reset **and its delivery intent**, before any provider is
   * contacted.
   *
   * `resetId` is chosen by the caller rather than the database because the
   * one-time secret's AAD is bound to it: the ciphertext is tied to this row,
   * this column and this id, so moving it anywhere else makes decryption fail
   * instead of quietly succeeding (ADR-0020 §4).
   */
  async createReset(input: {
    resetId: string;
    intakeId: string;
    accountId: string;
    tokenHash: string;
    tokenKeyVersion: string;
    ttlSeconds: number;
    initiatedBy: 'self' | 'hotel_admin';
    initiatedByAccountId: string | null;
    secret?: { ciphertext: string; wrappedDek: string; keyVersion: string };
  }): Promise<{ resetId: string; deliveryId: string; expiresAt: Date }> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.password_reset_request
         (reset_id, intake_id, account_id, token_hash, token_key_version, initiated_by,
          initiated_by_account_id, expires_at,
          secret_ciphertext, secret_wrapped_dek, secret_key_version)
       VALUES ($1, $11, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9, $10)
       RETURNING reset_id, delivery_id, expires_at`,
      [
        input.resetId,
        input.accountId,
        input.tokenHash,
        input.tokenKeyVersion,
        input.initiatedBy,
        input.initiatedByAccountId,
        input.ttlSeconds,
        input.secret?.ciphertext ?? null,
        input.secret?.wrappedDek ?? null,
        input.secret?.keyVersion ?? null,
        input.intakeId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the reset insert returned no row');
    return {
      resetId: String(row['reset_id']),
      deliveryId: String(row['delivery_id']),
      expiresAt: row['expires_at'] as Date,
    };
  }

  /**
   * The reset intent this queue entry owns.
   *
   * Resolved **by intake**, never by "any undelivered reset for this account".
   * Two entries can exist for one address — a self-service request and a Hotel
   * Admin sending the link — and an account-wide lookup let the second adopt the
   * first's delivery identity and, with it, the wrong attribution. It is also
   * what makes a retry after a lost acknowledgement recover the *same* intent
   * rather than mint a second link.
   */
  async resetForIntake(intakeId: string): Promise<IntakeResetRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT reset_id, delivery_id, state, expires_at, delivered_at,
              secret_ciphertext, secret_wrapped_dek, secret_key_version
         FROM platform.password_reset_request
        WHERE intake_id = $1
        ORDER BY created_at DESC
        LIMIT 1
          FOR UPDATE`,
      [intakeId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      resetId: String(row['reset_id']),
      deliveryId: String(row['delivery_id']),
      state: String(row['state']),
      expiresAt: row['expires_at'] as Date,
      deliveredAt: (row['delivered_at'] as Date | null) ?? null,
      ciphertext: (row['secret_ciphertext'] as string | null) ?? null,
      wrappedDek: (row['secret_wrapped_dek'] as string | null) ?? null,
      keyVersion: (row['secret_key_version'] as string | null) ?? null,
    };
  }

  /**
   * Records the hand-over and destroys the stored secret.
   *
   * The ciphertext exists only to survive the gap between committing the intent
   * and the provider accepting it. Once that has happened it is not needed
   * again, and a secret that is not needed is not kept.
   */
  async markResetDelivered(resetId: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_request
          SET delivered_at = now(),
              secret_ciphertext = NULL, secret_wrapped_dek = NULL, secret_key_version = NULL
        WHERE reset_id = $1 AND state = 'ACTIVE' AND delivered_at IS NULL`,
      [resetId],
    );
    return result.rowCount === 1;
  }

  /**
   * Terminalises a reset and destroys any secret it was still holding.
   *
   * The two belong together: a terminal row has no delivery left to make, and a
   * table CHECK refuses to let it keep one.
   */
  async terminaliseReset(resetId: string, state: string, reason: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_request
          SET state = $2, terminal_at = now(), terminal_reason = $3,
              secret_ciphertext = NULL, secret_wrapped_dek = NULL, secret_key_version = NULL
        WHERE reset_id = $1 AND state = 'ACTIVE'`,
      [resetId, state, reason],
    );
    return result.rowCount === 1;
  }

  // ------------------------------------------------------ reset intake queue
  /**
   * Queues one public reset request.
   *
   * The whole of what the public endpoint does. It is one insert of one bounded
   * value, identical for every address, and it looks nothing up: the moment this
   * path did more work for an address that exists than for one that does not,
   * the endpoint became an account oracle whatever its status code said.
   */
  async queueResetIntake(
    emailNormalized: string,
    initiator: { by: 'self' | 'hotel_admin'; accountId: string | null } = {
      by: 'self',
      accountId: null,
    },
  ): Promise<string> {
    const result = await this.uow.query<{ intake_id: string }>(
      `INSERT INTO platform.password_reset_intake
         (email_normalized, initiated_by, initiated_by_account_id)
       VALUES ($1, $2, $3)
       RETURNING intake_id`,
      [normaliseEmail(emailNormalized), initiator.by, initiator.accountId],
    );
    const id = result.rows[0]?.intake_id;
    if (id === undefined) throw new Error('the reset intake insert returned no row');
    return id;
  }

  /**
   * Takes ownership of queued requests.
   *
   * One statement, and it *writes*: the entry moves to `CLAIMED` with a token
   * only this caller has and a lease that expires. `SELECT … FOR UPDATE SKIP
   * LOCKED` alone was not ownership — the lock lasted only as long as the
   * selecting transaction, which committed before any delivery was attempted,
   * so a second worker could take the same entry and both would send.
   *
   * An entry whose lease has run out is reclaimable, which is what makes a
   * worker that died a delay rather than a lost link.
   */
  async claimResetIntake(limit: number, leaseSeconds: number): Promise<readonly ResetIntakeRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      // The claimed set comes back in the order it was claimed in. `RETURNING`
      // has no order of its own, and processing two entries for one address in
      // an arbitrary order decides which of them is the throttled one — a
      // coin-flip an operator reading the outcomes would have to explain.
      `WITH claimed AS (
         UPDATE platform.password_reset_intake AS target
            SET state = 'CLAIMED',
                claim_token = gen_random_uuid(),
                lease_expires_at = now() + make_interval(secs => $2),
                attempts = target.attempts + 1
          WHERE target.intake_id IN (
                  SELECT candidate.intake_id
                    FROM platform.password_reset_intake AS candidate
                   WHERE (candidate.state = 'PENDING' AND candidate.next_attempt_at <= now())
                      OR (candidate.state = 'CLAIMED' AND candidate.lease_expires_at <= now())
                   ORDER BY candidate.next_attempt_at, candidate.requested_at
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
         RETURNING intake_id, email_normalized, attempts, claim_token,
                   initiated_by, initiated_by_account_id, next_attempt_at, requested_at)
       SELECT intake_id, email_normalized, attempts, claim_token,
              initiated_by, initiated_by_account_id
         FROM claimed
        ORDER BY next_attempt_at, requested_at`,
      [limit, leaseSeconds],
    );
    return result.rows.map((row) => ({
      intakeId: String(row['intake_id']),
      emailNormalized: String(row['email_normalized']),
      attempts: Number(row['attempts']),
      claimToken: String(row['claim_token']),
      initiatedBy: row['initiated_by'] as 'self' | 'hotel_admin',
      initiatedByAccountId: (row['initiated_by_account_id'] as string | null) ?? null,
    }));
  }

  /**
   * Settles one entry this worker owns. Terminal.
   *
   * The compare-and-set on the claim token is the whole guarantee: a worker
   * whose lease was reclaimed while it was working affects no row here, and
   * learns that it no longer owns the entry rather than writing a second
   * settlement for it.
   */
  async settleResetIntake(
    intakeId: string,
    claimToken: string,
    outcome: ResetIntakeOutcome,
    state: 'PROCESSED' | 'DEAD_LETTER' = 'PROCESSED',
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_intake
          SET state = $4, processed_at = now(), outcome = $3,
              claim_token = NULL, lease_expires_at = NULL
        WHERE intake_id = $1 AND claim_token = $2 AND state = 'CLAIMED'`,
      [intakeId, claimToken, outcome, state],
    );
    return result.rowCount === 1;
  }

  /**
   * Returns one entry to the queue for a later attempt.
   *
   * A provider that could not be reached is not a decision about the request,
   * so the entry goes back to `PENDING` behind a backoff rather than to a
   * terminal state nothing will ever revisit.
   */
  async retryResetIntake(
    intakeId: string,
    claimToken: string,
    outcome: ResetIntakeOutcome,
    backoffSeconds: number,
    reason: string,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_intake
          SET state = 'PENDING', claim_token = NULL, lease_expires_at = NULL,
              next_attempt_at = now() + make_interval(secs => $4),
              outcome = $3, last_error = $5
        WHERE intake_id = $1 AND claim_token = $2 AND state = 'CLAIMED'`,
      [intakeId, claimToken, outcome, backoffSeconds, reason.slice(0, 500)],
    );
    return result.rowCount === 1;
  }

  // ------------------------------------------------- explicit permission grants
  async permissionsFor(accountId: string): Promise<readonly string[]> {
    const result = await this.uow.query<{ permission: string }>(
      `SELECT permission FROM platform.account_permission_grant
        WHERE account_id = $1 AND revoked_at IS NULL
        ORDER BY permission`,
      [accountId],
    );
    return result.rows.map((row) => row.permission);
  }

  /**
   * Grants one explicitly named permission (doc 18 §5, §6).
   *
   * Checked twice, deliberately. Here against the canonical matrix, so the
   * refusal names what is wrong; and again by the table's own CHECK and its
   * composite foreign key, so a permission the document refuses to a column is
   * unrepresentable however the row is written — by this method, by a later
   * phase, or by a direct statement.
   */
  async grantPermission(
    account: AccountRow,
    permission: string,
    grantedBy: string,
  ): Promise<boolean> {
    const role = account.realmRole;
    if (role === null || !isRealmRole(role)) {
      throw new ApiError('FORBIDDEN', 'this account holds no realm role to grant against');
    }
    const grantable = isOperationRole(role)
      ? operationGrantablePermissions(role)
      : policeGrantablePermissions(role);
    if (!grantable.includes(permission)) {
      throw new ApiError('FORBIDDEN', 'the matrix does not grant that permission to this role');
    }
    const result = await this.uow.query(
      `INSERT INTO platform.account_permission_grant
         (account_id, realm, realm_role, permission, granted_by_account_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [account.accountId, account.realm, role, permission, grantedBy],
    );
    return result.rowCount === 1;
  }

  async revokePermission(
    accountId: string,
    permission: string,
    revokedBy: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.account_permission_grant
          SET revoked_at = now(), revoked_by_account_id = $3, revoked_reason = $4
        WHERE account_id = $1 AND permission = $2 AND revoked_at IS NULL`,
      [accountId, permission, revokedBy, reason],
    );
    return result.rowCount === 1;
  }
}

function mapAccount(row: Record<string, unknown> | undefined): AccountRow | undefined {
  if (row === undefined) return undefined;
  return {
    accountId: String(row['account_id']),
    realm: String(row['realm']),
    realmRole: (row['realm_role'] as string | null) ?? null,
    policeScopeRef: (row['police_scope_ref'] as string | null) ?? null,
    emailNormalized: String(row['email_normalized']),
    state: row['state'] as AccountRow['state'],
    authEpoch: Number(row['auth_epoch']),
    emailVerifiedAt: (row['email_verified_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapReset(row: Record<string, unknown> | undefined): ResetRow | undefined {
  if (row === undefined) return undefined;
  return {
    resetId: String(row['reset_id']),
    accountId: String(row['account_id']),
    state: String(row['state']),
    tokenHash: String(row['token_hash']),
    expiresAt: row['expires_at'] as Date,
    createdAt: row['created_at'] as Date,
  };
}
