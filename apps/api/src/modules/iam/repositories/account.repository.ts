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
export type ResetIntakeOutcome = 'sent' | 'ignored' | 'throttled' | 'unavailable';

export interface ResetIntakeRow {
  readonly intakeId: string;
  readonly emailNormalized: string;
  readonly attempts: number;
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

  async createReset(input: {
    accountId: string;
    tokenHash: string;
    tokenKeyVersion: string;
    ttlSeconds: number;
    initiatedBy: 'self' | 'hotel_admin';
    initiatedByAccountId: string | null;
  }): Promise<string> {
    const result = await this.uow.query<{ reset_id: string }>(
      `INSERT INTO platform.password_reset_request
         (account_id, token_hash, token_key_version, initiated_by, initiated_by_account_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING reset_id`,
      [
        input.accountId,
        input.tokenHash,
        input.tokenKeyVersion,
        input.initiatedBy,
        input.initiatedByAccountId,
        input.ttlSeconds,
      ],
    );
    const id = result.rows[0]?.reset_id;
    if (id === undefined) throw new Error('the reset insert returned no row');
    return id;
  }

  async terminaliseReset(resetId: string, state: string, reason: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_request
          SET state = $2, terminal_at = now(), terminal_reason = $3
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
  async queueResetIntake(emailNormalized: string): Promise<string> {
    const result = await this.uow.query<{ intake_id: string }>(
      `INSERT INTO platform.password_reset_intake (email_normalized)
       VALUES ($1)
       RETURNING intake_id`,
      [normaliseEmail(emailNormalized)],
    );
    const id = result.rows[0]?.intake_id;
    if (id === undefined) throw new Error('the reset intake insert returned no row');
    return id;
  }

  /**
   * Claims queued requests for processing.
   *
   * `SKIP LOCKED` so two drains never take the same row, and `FOR UPDATE` so a
   * row a drain is holding cannot be settled underneath it.
   */
  async claimResetIntake(limit: number): Promise<readonly ResetIntakeRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT intake_id, email_normalized, attempts
         FROM platform.password_reset_intake
        WHERE state = 'PENDING'
        ORDER BY requested_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return result.rows.map((row) => ({
      intakeId: String(row['intake_id']),
      emailNormalized: String(row['email_normalized']),
      attempts: Number(row['attempts']),
    }));
  }

  /** Settles one queued request. The outcome is for operators, never for callers. */
  async settleResetIntake(intakeId: string, outcome: ResetIntakeOutcome): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.password_reset_intake
          SET state = 'PROCESSED', processed_at = now(),
              attempts = attempts + 1, outcome = $2
        WHERE intake_id = $1 AND state = 'PENDING'`,
      [intakeId, outcome],
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
