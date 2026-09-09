import type { UnitOfWork } from '@prsystem/db';
import type { PoliceAccountPort, PoliceAccountRef } from '../../police/contracts/police-accounts';
import { AccountRepository } from '../repositories/account.repository';
import { assertPasswordAcceptable, derivePassword } from '../services/password.service';

/**
 * The IAM module's answer to `PoliceAccountPort` (doc 13 §5.1).
 *
 * It is the ordinary account lifecycle with one realm's rules applied: the
 * realm and its column are written together, because `user_account`'s own
 * constraint refuses a Police account with no Police role and a role that
 * belongs to another realm; and the password goes through the same policy and
 * the same derivation every other account's does.
 */
export class RepositoryPoliceAccounts implements PoliceAccountPort {
  async create(
    uow: UnitOfWork,
    input: { email: string; role: 'POLICE_OFFICER' | 'POLICE_ADMIN'; unitRef: string },
  ): Promise<PoliceAccountRef> {
    const created = await uow.query<{ account_id: string; state: string; revision: number }>(
      `INSERT INTO platform.user_account
         (realm, realm_role, police_scope_ref, email_normalized, state)
       VALUES ('police', $1, $2, $3, 'PENDING_ACTIVATION')
       RETURNING account_id, state, revision`,
      [input.role, input.unitRef, input.email.trim().toLowerCase()],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('the police account insert returned no row');
    return { accountId: row.account_id, state: row.state, revision: Number(row.revision) };
  }

  async findByEmail(uow: UnitOfWork, email: string): Promise<PoliceAccountRef | undefined> {
    const found = await new AccountRepository(uow).findByEmail(
      'police',
      email.trim().toLowerCase(),
    );
    if (found === undefined) return undefined;
    return { accountId: found.accountId, state: found.state, revision: found.revision };
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

  async activate(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean> {
    return new AccountRepository(uow).activate(accountId, expectedRevision);
  }

  async revokeSessions(uow: UnitOfWork, accountId: string, reason: string): Promise<number> {
    return new AccountRepository(uow).revokeAllSessions(accountId, reason);
  }
}
