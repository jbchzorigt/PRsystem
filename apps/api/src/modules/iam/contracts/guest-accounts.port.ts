import type { KeyManagementPort } from '@prsystem/ports';
import type { UnitOfWork } from '@prsystem/db';
import type { AuthSecurityParameters } from './security-parameters';
import { AUTH_SECURITY_PARAMETERS } from './security-parameters';
import { AccountRepository } from '../repositories/account.repository';
import { TokenService, SESSION_TOKEN_SUBJECT } from '../services/token.service';
import { derivePassword, verifyPassword } from '../services/password.service';

/**
 * The account kernel, for the module that owns the Guest but not the account
 * (doc 09 §6.2, §6.4; CLAUDE.md §3).
 *
 * `user_account`, `account_credential` and `server_session` belong to Phase 04.
 * A Guest is an account in that kernel — realms never merge (ADR-0005), but
 * they do share the table that issues and revokes sessions — so the guest
 * module reaches them through this contract rather than selecting them itself.
 *
 * Every method takes the caller's unit of work: registering a guest writes the
 * account, the credential and the guest profile in one transaction, or none of
 * them.
 */

export interface GuestAccount {
  readonly accountId: string;
  readonly state: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  readonly authEpoch: number;
  readonly revision: number;
}

export interface GuestSession {
  /** Returned once, to the caller that hands it to the browser. */
  readonly token: string;
  readonly sessionId: string;
}

export interface GuestAccountsPort {
  /** A new account in the Guest realm, holding no email address. */
  createAccount(uow: UnitOfWork): Promise<GuestAccount>;

  byId(uow: UnitOfWork, accountId: string): Promise<GuestAccount | undefined>;

  /** Sets or replaces the guest's password. The plaintext is never stored. */
  setPassword(uow: UnitOfWork, accountId: string, password: string): Promise<void>;

  /**
   * Whether the password is this account's.
   *
   * `accountId` is optional on purpose: the caller passes `undefined` when no
   * account matched the phone number, and the derivation still runs against a
   * placeholder. Without that, the response time would say whether a number is
   * registered — the disclosure doc 09 §6.3 forbids.
   */
  verifyPassword(
    uow: UnitOfWork,
    accountId: string | undefined,
    password: string,
  ): Promise<boolean>;

  /** Opens a Guest session. Carries no hotel scope: a guest has no membership. */
  openSession(uow: UnitOfWork, account: GuestAccount): Promise<GuestSession>;

  /** Closes every session on every device — what a password change means. */
  revokeEverySession(uow: UnitOfWork, account: GuestAccount, reason: string): Promise<void>;
}

/**
 * A hash of the right shape that no password produces, so a sign-in against an
 * unknown number costs the same as one against a known number.
 */
const UNVERIFIABLE_PLACEHOLDER =
  'scrypt$v=1$n=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The implementation, over the IAM module's own repository. */
export class IamGuestAccounts implements GuestAccountsPort {
  private readonly tokens: TokenService;

  constructor(
    keys: KeyManagementPort,
    private readonly parameters: AuthSecurityParameters = AUTH_SECURITY_PARAMETERS,
  ) {
    this.tokens = new TokenService(keys);
  }

  async createAccount(uow: UnitOfWork): Promise<GuestAccount> {
    const row = await new AccountRepository(uow).createGuest();
    return {
      accountId: row.accountId,
      state: row.state,
      authEpoch: row.authEpoch,
      revision: row.revision,
    };
  }

  async byId(uow: UnitOfWork, accountId: string): Promise<GuestAccount | undefined> {
    const row = await new AccountRepository(uow).findById(accountId);
    if (row === undefined || row.realm !== 'guest') return undefined;
    return {
      accountId: row.accountId,
      state: row.state,
      authEpoch: row.authEpoch,
      revision: row.revision,
    };
  }

  async setPassword(uow: UnitOfWork, accountId: string, password: string): Promise<void> {
    // The policy check lives inside `derivePassword`, so a guest's chosen
    // password meets the same rule a staff password does (doc 09 §6.2 step 4).
    const derived = await derivePassword(
      password,
      this.parameters.password,
      this.parameters.version,
    );
    await new AccountRepository(uow).upsertPassword(
      accountId,
      derived.secretHash,
      derived.paramsVersion,
    );
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

  async openSession(uow: UnitOfWork, account: GuestAccount): Promise<GuestSession> {
    const issued = await this.tokens.issue('session', SESSION_TOKEN_SUBJECT);
    const sessionId = await new AccountRepository(uow).createSession({
      accountId: account.accountId,
      realm: 'guest',
      tokenHash: issued.tokenHash,
      tokenKeyVersion: issued.keyVersion,
      accountEpoch: account.authEpoch,
      idleSeconds: this.parameters.sessionIdleSeconds,
      absoluteSeconds: this.parameters.sessionAbsoluteSeconds,
      // Proving the number or the provider identity a moment ago is the
      // recency proof; the Guest realm has no second factor of its own.
      stepUp: true,
    });
    return { token: issued.token, sessionId };
  }

  async revokeEverySession(uow: UnitOfWork, account: GuestAccount, reason: string): Promise<void> {
    const accounts = new AccountRepository(uow);
    await accounts.revokeAllSessions(account.accountId, reason);
    // The epoch is what makes the revocation one write rather than a fan-out
    // that could partly fail (doc 19 §10).
    await accounts.bumpAuthEpoch(account.accountId, account.revision);
  }
}
