import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';

/**
 * The account half of an Operation user, from the module that owns accounts
 * (doc 14 §2; CLAUDE.md §3).
 *
 * `platform.user_account`, its credential, its sessions and its explicit
 * permission grants are the IAM module's tables. Phase 19 states what it needs
 * of them — create a named account in the Operation realm, verify a password,
 * open and revoke sessions, refresh a step-up, and grant or revoke one named
 * permission — and the IAM module answers. The second factor is *not* here: the
 * TOTP secret is this module's own table, because it exists only for this realm.
 *
 * A password never travels further than the call that carries it, and no method
 * returns one, a digest of one, or a session token that was not just minted.
 */

export interface OperationAccountRef {
  readonly accountId: string;
  readonly realmRole: string | null;
  readonly state: string;
  readonly emailNormalized: string | null;
  readonly authEpoch: number;
  readonly revision: number;
}

export interface OperationSessionRequest {
  readonly accountId: string;
  readonly tokenHash: string;
  readonly tokenKeyVersion: string;
  readonly accountEpoch: number;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

export interface OperationAccountPort {
  create(
    uow: UnitOfWork,
    input: { email: string; role: 'OPERATION_ADMIN' | 'PLATFORM_SUPER_ADMIN' },
  ): Promise<OperationAccountRef>;
  findByEmail(uow: UnitOfWork, email: string): Promise<OperationAccountRef | undefined>;
  findById(uow: UnitOfWork, accountId: string): Promise<OperationAccountRef | undefined>;
  lockById(uow: UnitOfWork, accountId: string): Promise<OperationAccountRef | undefined>;
  /**
   * Whether the presented password is the account's.
   *
   * Answers `false` for an account with no credential rather than throwing, and
   * takes the same time either way — the sign-in above it must not become an
   * oracle for which addresses exist.
   */
  verifyPassword(
    uow: UnitOfWork,
    accountId: string | undefined,
    password: string,
  ): Promise<boolean>;
  setPassword(uow: UnitOfWork, accountId: string, password: string): Promise<void>;
  activate(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean>;
  setState(
    uow: UnitOfWork,
    accountId: string,
    state: 'ACTIVE' | 'SUSPENDED',
    expectedRevision: number,
    reason: string,
  ): Promise<boolean>;
  /** doc 14 §2: a suspension or a permission change ends every live session at once. */
  bumpAuthEpoch(uow: UnitOfWork, accountId: string, expectedRevision: number): Promise<boolean>;
  revokeSessions(uow: UnitOfWork, accountId: string, reason: string): Promise<number>;
  openSession(uow: UnitOfWork, input: OperationSessionRequest): Promise<string>;
  /** A fresh second-factor proof on an existing session (doc 14 §2). */
  refreshStepUp(uow: UnitOfWork, sessionId: string, accountId: string): Promise<boolean>;
  permissionsFor(uow: UnitOfWork, accountId: string): Promise<readonly string[]>;
  grantPermission(
    uow: UnitOfWork,
    accountId: string,
    permission: string,
    grantedBy: string,
  ): Promise<boolean>;
  revokePermission(
    uow: UnitOfWork,
    accountId: string,
    permission: string,
    revokedBy: string,
    reason: string,
  ): Promise<boolean>;
}

const UNPROVISIONED = 'no Operation account contract is provisioned';

/** The default before the IAM module supplies one: fail closed, create nothing. */
export class UnprovisionedOperationAccounts implements OperationAccountPort {
  create(): Promise<OperationAccountRef> {
    return Promise.reject(new ApiError('INTERNAL_ERROR', UNPROVISIONED));
  }

  findByEmail(): Promise<OperationAccountRef | undefined> {
    return Promise.resolve(undefined);
  }

  findById(): Promise<OperationAccountRef | undefined> {
    return Promise.resolve(undefined);
  }

  lockById(): Promise<OperationAccountRef | undefined> {
    return Promise.resolve(undefined);
  }

  verifyPassword(): Promise<boolean> {
    return Promise.resolve(false);
  }

  setPassword(): Promise<void> {
    return Promise.reject(new ApiError('INTERNAL_ERROR', UNPROVISIONED));
  }

  activate(): Promise<boolean> {
    return Promise.resolve(false);
  }

  setState(): Promise<boolean> {
    return Promise.resolve(false);
  }

  bumpAuthEpoch(): Promise<boolean> {
    return Promise.resolve(false);
  }

  revokeSessions(): Promise<number> {
    return Promise.resolve(0);
  }

  openSession(): Promise<string> {
    return Promise.reject(new ApiError('INTERNAL_ERROR', UNPROVISIONED));
  }

  refreshStepUp(): Promise<boolean> {
    return Promise.resolve(false);
  }

  permissionsFor(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }

  grantPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }

  revokePermission(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
