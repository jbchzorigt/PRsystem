import type { UnitOfWork } from '@prsystem/db';
import type {
  OperationAccountPort,
  OperationAccountRef,
  OperationSessionRequest,
} from '../../operation/contracts/operation-accounts';
import { AccountRepository } from '../repositories/account.repository';
import type { AccountRow } from '../repositories/account.repository';
import {
  assertPasswordAcceptable,
  derivePassword,
  verifyPassword,
} from '../services/password.service';

/**
 * The IAM module's answer to `OperationAccountPort` (doc 14 §2).
 *
 * It is the ordinary account lifecycle with one realm's rules applied. Two
 * details are the module's own rather than the caller's:
 *
 *  - a new Operation account starts `PENDING_ACTIVATION` and holds no
 *    credential, so it cannot be signed in to until the person named on it has
 *    completed their own enrolment;
 *  - `verifyPassword` derives against a placeholder when there is no account or
 *    no credential, so a sign-in cannot be timed to discover which addresses
 *    exist.
 */

/**
 * A syntactically valid Argon2 encoding that no password produces.
 *
 * The same device Phase 04's sign-in uses, for the same reason: the derivation
 * must run whether or not a credential was found.
 */
const UNVERIFIABLE_PLACEHOLDER =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function toRef(row: AccountRow): OperationAccountRef {
  return {
    accountId: row.accountId,
    realmRole: row.realmRole,
    state: row.state,
    emailNormalized: row.emailNormalized,
    authEpoch: row.authEpoch,
    revision: row.revision,
  };
}

export class RepositoryOperationAccounts implements OperationAccountPort {
  async create(
    uow: UnitOfWork,
    input: { email: string; role: 'OPERATION_ADMIN' | 'PLATFORM_SUPER_ADMIN' },
  ): Promise<OperationAccountRef> {
    const created = await uow.query<Record<string, unknown>>(
      `INSERT INTO platform.user_account (realm, realm_role, email_normalized, state)
       VALUES ('operation', $1, $2, 'PENDING_ACTIVATION')
       RETURNING account_id, realm_role, state, email_normalized, auth_epoch, revision`,
      [input.role, input.email.trim().toLowerCase()],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('the operation account insert returned no row');
    return {
      accountId: String(row['account_id']),
      realmRole: (row['realm_role'] as string | null) ?? null,
      state: String(row['state']),
      emailNormalized: (row['email_normalized'] as string | null) ?? null,
      authEpoch: Number(row['auth_epoch']),
      revision: Number(row['revision']),
    };
  }

  async findByEmail(uow: UnitOfWork, email: string): Promise<OperationAccountRef | undefined> {
    const found = await new AccountRepository(uow).findByEmail(
      'operation',
      email.trim().toLowerCase(),
    );
    return found === undefined ? undefined : toRef(found);
  }

  async findById(uow: UnitOfWork, accountId: string): Promise<OperationAccountRef | undefined> {
    const found = await new AccountRepository(uow).findById(accountId);
    if (found === undefined || found.realm !== 'operation') return undefined;
    return toRef(found);
  }

  async lockById(uow: UnitOfWork, accountId: string): Promise<OperationAccountRef | undefined> {
    const found = await new AccountRepository(uow).lockById(accountId);
    if (found === undefined || found.realm !== 'operation') return undefined;
    return toRef(found);
  }

  async verifyPassword(
    uow: UnitOfWork,
    accountId: string | undefined,
    password: string,
  ): Promise<boolean> {
    const stored =
      accountId === undefined
        ? undefined
        : await new AccountRepository(uow).credentialFor(accountId);
    const correct = await verifyPassword(password, stored?.secretHash ?? UNVERIFIABLE_PLACEHOLDER);
    return stored !== undefined && correct;
  }

  async setPassword(uow: UnitOfWork, accountId: string, password: string): Promise<void> {
    assertPasswordAcceptable(password);
    const derived = await derivePassword(password);
    await new AccountRepository(uow).upsertPassword(
      accountId,
      derived.secretHash,
      derived.paramsVersion,
    );
  }

  activate(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean> {
    return new AccountRepository(uow).activate(accountId, expectedRevision);
  }

  setState(
    uow: UnitOfWork,
    accountId: string,
    state: 'ACTIVE' | 'SUSPENDED',
    expectedRevision: number,
    _reason: string,
  ): Promise<boolean> {
    return new AccountRepository(uow).setState(accountId, state, expectedRevision);
  }

  bumpAuthEpoch(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean> {
    return new AccountRepository(uow).bumpAuthEpoch(accountId, expectedRevision);
  }

  revokeSessions(uow: UnitOfWork, accountId: string, reason: string): Promise<number> {
    return new AccountRepository(uow).revokeAllSessions(accountId, reason);
  }

  openSession(uow: UnitOfWork, input: OperationSessionRequest): Promise<string> {
    return new AccountRepository(uow).createSession({
      accountId: input.accountId,
      realm: 'operation',
      tokenHash: input.tokenHash,
      tokenKeyVersion: input.tokenKeyVersion,
      accountEpoch: input.accountEpoch,
      idleSeconds: input.idleSeconds,
      absoluteSeconds: input.absoluteSeconds,
      // The step-up is stamped by the second factor, never by the password:
      // `signIn` sets it only after the TOTP code has verified.
      stepUp: false,
    });
  }

  /**
   * Stamps a fresh second-factor proof on a live session.
   *
   * Bound to the account as well as the session, so a session id that belonged
   * to somebody else could not be refreshed by whoever presented a valid code
   * of their own.
   */
  async refreshStepUp(uow: UnitOfWork, sessionId: string, accountId: string): Promise<boolean> {
    const result = await uow.query(
      `UPDATE platform.server_session
          SET step_up_at = now()
        WHERE session_id = $1 AND account_id = $2 AND realm = 'operation'
          AND revoked_at IS NULL
          AND idle_expires_at > now() AND absolute_expires_at > now()`,
      [sessionId, accountId],
    );
    return result.rowCount === 1;
  }

  permissionsFor(uow: UnitOfWork, accountId: string): Promise<readonly string[]> {
    return new AccountRepository(uow).permissionsFor(accountId);
  }

  async grantPermission(
    uow: UnitOfWork,
    accountId: string,
    permission: string,
    grantedBy: string,
  ): Promise<boolean> {
    const accounts = new AccountRepository(uow);
    const account = await accounts.findById(accountId);
    if (account === undefined || account.realm !== 'operation') return false;
    return accounts.grantPermission(account, permission, grantedBy);
  }

  revokePermission(
    uow: UnitOfWork,
    accountId: string,
    permission: string,
    revokedBy: string,
    reason: string,
  ): Promise<boolean> {
    return new AccountRepository(uow).revokePermission(accountId, permission, revokedBy, reason);
  }
}
