import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';

/**
 * The account half of a Police user, from the module that owns accounts
 * (doc 13 §5.1; CLAUDE.md §3).
 *
 * doc 13 §5.1 makes creating and activating a Police account a Police Admin's
 * action, and `platform.user_account` is the IAM module's table. So this module
 * states what it needs of an account — create one in the Police realm with a
 * role and a unit, set the password the officer chose, activate it, and revoke
 * every session when a reset completes — and the IAM module answers.
 *
 * The password itself never travels further than the call: what the port stores
 * is the derived hash, under IAM's own parameters.
 */

export interface PoliceAccountRef {
  readonly accountId: string;
  readonly state: string;
  readonly revision: number;
}

export interface PoliceAccountPort {
  create(
    uow: UnitOfWork,
    input: { email: string; role: 'POLICE_OFFICER' | 'POLICE_ADMIN'; unitRef: string },
  ): Promise<PoliceAccountRef>;
  findByEmail(uow: UnitOfWork, email: string): Promise<PoliceAccountRef | undefined>;
  /** Sets the officer's chosen password and returns nothing about it. */
  setPassword(uow: UnitOfWork, accountId: string, password: string): Promise<void>;
  activate(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean>;
  /** doc 13 §5.2: a completed reset ends every live session. */
  revokeSessions(uow: UnitOfWork, accountId: string, reason: string): Promise<number>;
}

/** The default before the IAM module supplies one: fail closed, create nothing. */
export class UnprovisionedPoliceAccounts implements PoliceAccountPort {
  create(): Promise<PoliceAccountRef> {
    return Promise.reject(
      new ApiError('INTERNAL_ERROR', 'no Police account contract is provisioned'),
    );
  }

  findByEmail(): Promise<PoliceAccountRef | undefined> {
    return Promise.resolve(undefined);
  }

  setPassword(): Promise<void> {
    return Promise.reject(
      new ApiError('INTERNAL_ERROR', 'no Police account contract is provisioned'),
    );
  }

  activate(): Promise<boolean> {
    return Promise.resolve(false);
  }

  revokeSessions(): Promise<number> {
    return Promise.resolve(0);
  }
}
