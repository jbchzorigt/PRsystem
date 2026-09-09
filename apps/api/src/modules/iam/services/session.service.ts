import type { Principal } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { recordPlatformAudit } from '@prsystem/db';
import { AccountRepository } from '../repositories/account.repository';
import { MembershipRepository } from '../repositories/membership.repository';
import type { IamDependencies, RequestContext } from './iam-context';
import { IamServiceBase, establishAccountScope } from './iam-context';
import { resolvePrincipal } from './authorization.service';
import { verifyPassword } from './password.service';
import { SESSION_TOKEN_SUBJECT } from './token.service';

/**
 * Server-side sessions (doc 19 §10, doc 05 §1).
 *
 * A session is account-wide and holds no hotel scope: the scope of a *request*
 * is resolved from membership every time (doc 06 §2). What a session does carry
 * is the account's auth epoch, so an account-wide revocation is one write; and
 * a per-hotel `session_scope_grant`, so a role change or a suspension closes
 * that scope's session without touching the account's other hotels.
 */

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly principal: Principal;
  readonly stepUpAt: Date | null;
}

/** Everything a caller needs after signing in. The token is returned once. */
export interface SignInResult {
  readonly token: string;
  readonly sessionId: string;
  readonly accountId: string;
}

export class SessionService extends IamServiceBase {
  constructor(deps: IamDependencies) {
    super(deps);
  }

  /**
   * Signs in with an email and a password.
   *
   * Every failure is the same failure. A wrong email, a wrong password, a
   * missing credential and a suspended account are indistinguishable to the
   * caller, so the surface cannot be used to discover who has an account.
   */
  /**
   * `realm` defaults to `hotel` because Phase 04 had one population that signs
   * in. Phase 18 adds a second: doc 13 §5 gives the Police portal its own
   * password login, on accounts of the Police realm — and realms never merge
   * (doc 05 §1.1), so the realm is part of the lookup rather than something the
   * address is trusted to imply.
   */
  async signIn(
    email: string,
    password: string,
    request: RequestContext,
    realm: 'hotel' | 'police' = 'hotel',
  ): Promise<SignInResult> {
    const params = this.parameters;
    return this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      const account = await accounts.findByEmail(realm, email);
      const stored =
        account === undefined ? undefined : await accounts.credentialFor(account.accountId);

      // The derivation runs even when there is no account, so the response time
      // does not say whether the address is known.
      const candidate = stored?.secretHash ?? UNVERIFIABLE_PLACEHOLDER;
      const correct = await verifyPassword(password, candidate);

      if (account === undefined || stored === undefined || !correct || account.state !== 'ACTIVE') {
        await recordPlatformAudit(uow, {
          action: 'iam.session.sign_in',
          outcome: 'denied',
          targetType: 'user_account',
          ...(account === undefined ? {} : { targetRef: account.accountId }),
          reason: 'invalid_credentials',
        });
        throw new ApiError('UNAUTHENTICATED', 'the email address or password is incorrect');
      }

      const issued = await this.tokens.issue('session', SESSION_TOKEN_SUBJECT);
      const sessionId = await accounts.createSession({
        accountId: account.accountId,
        realm: account.realm,
        tokenHash: issued.tokenHash,
        tokenKeyVersion: issued.keyVersion,
        accountEpoch: account.authEpoch,
        idleSeconds: params.sessionIdleSeconds,
        absoluteSeconds: params.sessionAbsoluteSeconds,
        // The MVP has no separate step-up factor in the Hotel realm (doc 05 §1),
        // so a fresh sign-in is the recency proof and nothing else grants one.
        stepUp: true,
      });

      // The scope this session may act in, one row per active membership,
      // stamped with the revision it was issued against (doc 19 §10).
      //
      // Issuing them here is what makes the revocation matrix real: a role
      // change, a suspension or a termination revokes the row and bumps the
      // revision, so the authority this token carries in that hotel ends at
      // once — while the same token keeps working in the account's other
      // hotels, and while the credential itself is untouched.
      //
      // A membership that becomes active *after* this moment has no grant, so
      // the holder signs in again: a token never silently acquires a scope, or
      // a role, it was not issued with.
      await establishAccountScope(uow, account.accountId);
      const memberships = new MembershipRepository(uow);
      const scopes = await memberships.forAccount(account.accountId);
      for (const membership of scopes) {
        if (membership.state !== 'ACTIVE') continue;
        await memberships.grantScopeIn({
          hotelId: membership.hotelId,
          accountId: account.accountId,
          sessionId,
          membershipId: membership.membershipId,
          membershipRevision: membership.membershipRevision,
        });
      }

      await recordPlatformAudit(uow, {
        action: 'iam.session.sign_in',
        outcome: 'allowed',
        targetType: 'server_session',
        targetRef: sessionId,
        payload: { accountId: account.accountId },
      });

      return { token: issued.token, sessionId, accountId: account.accountId };
    });
  }

  /**
   * Resolves a bearer token into a principal, or refuses.
   *
   * Four independent conditions, all re-read from the database on every call:
   * the session exists and is not revoked, it has not idled or aged out, its
   * account epoch still matches the account's, and the account is active. A
   * stale epoch is what makes a password change close every device at once.
   */
  async authenticate(token: string, request: RequestContext): Promise<AuthenticatedSession> {
    return this.inAccountScope(request, async (uow) => {
      const session = await this.loadSession(uow, token);
      // The account is known only once the token has been verified, so the
      // scope its own membership rows are read under is established here.
      await establishAccountScope(uow, session.accountId);
      const principal = await resolvePrincipal(
        uow,
        session.accountId,
        session.stepUpAt ?? undefined,
      );
      if (principal === undefined || principal.accountState !== 'ACTIVE') {
        throw new ApiError('UNAUTHENTICATED', 'the session is no longer valid');
      }
      await new AccountRepository(uow).touchSession(
        session.sessionId,
        this.parameters.sessionIdleSeconds,
      );
      return { sessionId: session.sessionId, stepUpAt: session.stepUpAt, principal };
    });
  }

  private async loadSession(
    uow: UnitOfWork,
    token: string,
  ): Promise<{ sessionId: string; accountId: string; stepUpAt: Date | null }> {
    const { tokenHash } = await this.tokens.digest('session', SESSION_TOKEN_SUBJECT, token);
    const accounts = new AccountRepository(uow);
    const session = await accounts.findLiveSessionByHash(tokenHash);
    const invalid = new ApiError('UNAUTHENTICATED', 'the session is no longer valid');
    if (session === undefined || session.revokedAt !== null) throw invalid;

    const now = uow.serverNow;
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) throw invalid;

    const account = await accounts.findById(session.accountId);
    if (account === undefined || account.state !== 'ACTIVE') throw invalid;
    // The epoch check. A password change bumped it, so every token issued
    // before that moment stops resolving without anything having to find them.
    if (account.authEpoch !== session.accountEpoch) throw invalid;

    return {
      sessionId: session.sessionId,
      accountId: session.accountId,
      stepUpAt: session.stepUpAt,
    };
  }

  /** Signs one session out. Server-side: clearing a browser store is not logout. */
  async signOut(sessionId: string, request: RequestContext): Promise<void> {
    await this.inAccountScope(request, async (uow) => {
      const closed = await new AccountRepository(uow).revokeSession(sessionId, 'sign_out');
      await recordPlatformAudit(uow, {
        action: 'iam.session.sign_out',
        outcome: 'allowed',
        targetType: 'server_session',
        targetRef: sessionId,
        payload: { closed },
      });
    });
  }

  /**
   * `Бүх төхөөрөмжөөс гарах` — closes every session of the account.
   *
   * The epoch is bumped as well as the rows being marked, so a token that was
   * in flight when this committed cannot be used either.
   */
  async signOutEverywhere(accountId: string, request: RequestContext): Promise<number> {
    return this.inAccountScope(request, async (uow) => {
      const accounts = new AccountRepository(uow);
      const account = await accounts.lockById(accountId);
      if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const closed = await accounts.revokeAllSessions(accountId, 'all_device_logout');
      const bumped = await accounts.bumpAuthEpoch(accountId, account.revision);
      if (!bumped) throw new ApiError('REVISION_MISMATCH', 'the account changed concurrently');
      await new MembershipRepository(uow).revokeAllScopeGrantsForAccount(
        accountId,
        'all_device_logout',
      );

      await recordPlatformAudit(uow, {
        action: 'iam.session.sign_out_everywhere',
        outcome: 'allowed',
        targetType: 'user_account',
        targetRef: accountId,
        payload: { closed },
      });
      return closed;
    });
  }
}

/**
 * A well-formed encoded value that no password derives to.
 *
 * Used when the account or the credential does not exist, so the sign-in path
 * performs the same work either way and its duration says nothing.
 */
const UNVERIFIABLE_PLACEHOLDER =
  'scrypt$v=1$n=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
