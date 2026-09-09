import { randomBytes } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { decryptValue, encryptValue } from '@prsystem/ports';
import { SESSION_TOKEN_SUBJECT } from '../../iam/services/token.service';
import { OperationRepository } from '../repositories/operation.repository';
import { base32Encode, totpStep, verifyTotp } from '../domain/operation';
import type { OperationDependencies, RequestContext } from './operation-context';
import { OperationServiceBase } from './operation-context';

/**
 * Signing in to the Operation portal, and re-proving the second factor
 * (doc 14 §2; architecture 05 §2).
 *
 * The realm is its own population and its own credential store. Three things
 * here are the whole of what makes an Operation session different from a Hotel
 * one:
 *
 *  - **A password alone is never a session.** `signIn` verifies the password
 *    *and* a TOTP code, and issues nothing if either is wrong. The two failures
 *    are indistinguishable to the caller, and so is a missing account.
 *  - **A code is single-use.** The step it was accepted at is written to the
 *    factor row under a compare-and-set, so the same six digits presented twice
 *    inside their thirty seconds produce one session, not two.
 *  - **The step-up is the second factor, not the password.** A sign-in stamps
 *    it because the code was just verified; `stepUp` re-stamps it on a live
 *    session for the same reason, and nothing else in the process can.
 */

/** The AAD binding a stored TOTP secret to its own row (ADR-0020 §3). */
function secretAad(accountId: string): { table: string; column: string; rowRef: string } {
  return {
    table: 'platform.operation_totp_factor',
    column: 'secret_ciphertext',
    rowRef: accountId,
  };
}

/** 20 bytes: the RFC 6238 recommendation for an HMAC-SHA1 secret. */
const SECRET_BYTES = 20;

export interface OperationSignIn {
  readonly token: string;
  readonly sessionId: string;
  readonly accountId: string;
}

export class OperationAuthService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /**
   * Redeems the one-time enrolment link: sets the password, mints the second
   * factor, and returns the shared secret exactly once.
   *
   * The secret is returned to the person enrolling, because their authenticator
   * needs the same bytes and there is no other moment at which it could reach
   * them. It is not returned again, not by this method and not by any other:
   * a lost authenticator is a new enrolment, which is a Platform Super Admin's
   * decision rather than a self-service one.
   */
  async completeEnrolment(
    input: { token: string; password: string },
    request: RequestContext,
  ): Promise<{ accountId: string; secret: string; digits: number; periodSeconds: number }> {
    const digest = await this.tokens.digest('operation_enrolment', ENROLMENT_SUBJECT, input.token);
    return this.inAnonymousScope(request, async (uow) => {
      const enrolment = await new OperationRepository(uow).lockEnrolmentByHash(digest.tokenHash);
      const now = this.now(uow);
      if (
        enrolment === undefined ||
        enrolment.state !== 'PENDING' ||
        enrolment.expiresAt === null ||
        enrolment.expiresAt.getTime() <= now.getTime()
      ) {
        // The same refusal for a wrong token, a spent one and an expired one.
        throw new ApiError('NOT_FOUND', 'not found');
      }

      const accounts = this.deps.accounts;
      const account = await accounts.lockById(uow, enrolment.accountId);
      if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await accounts.setPassword(uow, account.accountId, input.password);

      const secret = randomBytes(SECRET_BYTES);
      const sealed = await encryptValue(
        this.deps.keys,
        'auth.operation_totp',
        secret.toString('base64'),
        secretAad(account.accountId),
      );
      const repository = new OperationRepository(uow);
      await repository.insertFactor({
        accountId: account.accountId,
        ciphertext: sealed.ciphertext,
        wrappedDek: sealed.wrappedDek,
        keyVersion: sealed.keyVersion,
      });

      if (!(await repository.completeEnrolment(enrolment.enrolmentId, enrolment.revision))) {
        throw new ApiError('CONFLICT', 'the enrolment moved while it was being completed');
      }
      if (!(await accounts.activate(uow, account.accountId, account.revision))) {
        throw new ApiError('CONFLICT', 'the account moved while it was being activated');
      }

      await this.audit(uow, {
        action: 'operation.account.enrolled',
        outcome: 'allowed',
        targetType: 'user_account',
        targetRef: account.accountId,
      });

      return {
        accountId: account.accountId,
        secret: base32Encode(secret),
        digits: 6,
        periodSeconds: 30,
      };
    });
  }

  /**
   * Password plus TOTP, in one indistinguishable failure.
   *
   * The password derivation runs whether or not the address exists, and the
   * code is checked whether or not the password was right, so neither the
   * response nor its timing says which half was wrong.
   */
  async signIn(
    input: { email: string; password: string; code: string },
    request: RequestContext,
  ): Promise<OperationSignIn> {
    return this.inAnonymousScope(request, async (uow) => {
      const accounts = this.deps.accounts;
      const account = await accounts.findByEmail(uow, input.email);
      const passwordCorrect = await accounts.verifyPassword(
        uow,
        account?.accountId,
        input.password,
      );

      const repository = new OperationRepository(uow);
      const factor =
        account === undefined ? undefined : await repository.lockFactor(account.accountId);
      const codeCorrect =
        factor === undefined
          ? false
          : await this.verifyCode(uow, repository, factor, input.code, account?.accountId);

      if (
        account === undefined ||
        account.state !== 'ACTIVE' ||
        factor === undefined ||
        !passwordCorrect ||
        !codeCorrect
      ) {
        await this.audit(uow, {
          action: 'operation.session.sign_in',
          outcome: 'denied',
          targetType: 'user_account',
          ...(account === undefined ? {} : { targetRef: account.accountId }),
          reason: 'invalid_credentials',
        });
        throw new ApiError('UNAUTHENTICATED', 'the credentials are incorrect');
      }

      const issued = await this.tokens.issue('session', SESSION_TOKEN_SUBJECT);
      const sessionId = await accounts.openSession(uow, {
        accountId: account.accountId,
        tokenHash: issued.tokenHash,
        tokenKeyVersion: issued.keyVersion,
        accountEpoch: account.authEpoch,
        idleSeconds: this.parameters.sessionIdleSeconds,
        absoluteSeconds: this.parameters.sessionAbsoluteSeconds,
      });
      // The code was just verified, so this session carries a recent step-up.
      // It is stamped here rather than by `openSession` so that the one place a
      // step-up can come from is a successful second factor.
      await accounts.refreshStepUp(uow, sessionId, account.accountId);

      await this.audit(uow, {
        action: 'operation.session.sign_in',
        outcome: 'allowed',
        targetType: 'server_session',
        targetRef: sessionId,
        payload: { accountId: account.accountId },
      });

      return { token: issued.token, sessionId, accountId: account.accountId };
    });
  }

  /**
   * Re-proves the second factor on a live session (doc 14 §2).
   *
   * doc 18 §5 makes every Operation action step-up gated, and the window is ten
   * minutes, so a working session needs this regularly. It takes a code and
   * nothing else: a password is not a step-up.
   */
  async stepUp(
    input: { accountId: string; sessionId: string; code: string },
    request: RequestContext,
  ): Promise<{ steppedUp: true }> {
    return this.inAnonymousScope(request, async (uow) => {
      const repository = new OperationRepository(uow);
      const factor = await repository.lockFactor(input.accountId);
      const correct =
        factor === undefined
          ? false
          : await this.verifyCode(uow, repository, factor, input.code, input.accountId);
      if (
        !correct ||
        !(await this.deps.accounts.refreshStepUp(uow, input.sessionId, input.accountId))
      ) {
        await this.audit(uow, {
          action: 'operation.session.step_up',
          outcome: 'denied',
          targetType: 'server_session',
          targetRef: input.sessionId,
          reason: 'invalid_code',
        });
        throw new ApiError('UNAUTHENTICATED', 'the code is incorrect');
      }
      await this.audit(uow, {
        action: 'operation.session.step_up',
        outcome: 'allowed',
        targetType: 'server_session',
        targetRef: input.sessionId,
      });
      return { steppedUp: true };
    });
  }

  /**
   * Verifies one code and consumes the step it belonged to.
   *
   * Both halves matter. `verifyTotp` refuses a step at or below the last
   * accepted one, and `consumeStep` is a compare-and-set on the factor's
   * revision — so two concurrent requests carrying the same digits cannot both
   * succeed even though both read the same `last_accepted_step`.
   */
  private async verifyCode(
    uow: UnitOfWork,
    repository: OperationRepository,
    factor: {
      accountId: string;
      secretCiphertext: Buffer;
      secretWrappedDek: Buffer;
      secretKeyVersion: string;
      digits: number;
      periodSeconds: number;
      lastAcceptedStep: number | null;
      revision: number;
    },
    code: string,
    accountId: string | undefined,
  ): Promise<boolean> {
    if (accountId === undefined || accountId !== factor.accountId) return false;
    const secret = Buffer.from(
      await decryptValue(
        this.deps.keys,
        'auth.operation_totp',
        {
          ciphertext: factor.secretCiphertext,
          wrappedDek: factor.secretWrappedDek,
          keyVersion: factor.secretKeyVersion,
        },
        secretAad(factor.accountId),
      ),
      'base64',
    );
    const outcome = verifyTotp({
      secret,
      code,
      at: this.now(uow),
      lastAcceptedStep: factor.lastAcceptedStep,
      digits: factor.digits,
      periodSeconds: factor.periodSeconds,
    });
    secret.fill(0);
    if (!outcome.ok || outcome.step === undefined) return false;
    return repository.consumeStep(factor.accountId, outcome.step, factor.revision);
  }

  /** The step an authenticator would be showing now, for a test to read. */
  static stepFor(at: Date): number {
    return totpStep(at);
  }
}

/**
 * The subject every enrolment digest is bound to.
 *
 * The token is looked up before its account is known, so — like a session token
 * — the digest binds the purpose and a constant rather than a row that has not
 * been read yet. Everything else about the enrolment comes from the row the
 * digest identifies.
 */
export const ENROLMENT_SUBJECT = 'operation-enrolment';
