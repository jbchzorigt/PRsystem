import { createHash } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { decryptValue, deriveLookupToken, encryptValue } from '@prsystem/ports';
import type { LookupToken } from '@prsystem/ports';
import { TokenService } from '../../iam/services/token.service';
import { establishAccountScope } from '../../iam/services/iam-context';
import { GuestRepository } from '../repositories/guest.repository';
import type { VerificationPurpose } from '../domain/guest';
import {
  OTP_DIGITS,
  SIGN_IN_REFUSAL,
  mayResend,
  normalisePhone,
  settledState,
  verificationOutcome,
} from '../domain/guest';
import type { GuestDependencies, RequestContext } from './guest-context';
import { GuestServiceBase } from './guest-context';

/**
 * Registering, signing in and recovering a Guest account by phone
 * (doc 09 §6.2, `BK-DEC-002`).
 *
 * Two rules shape every method here.
 *
 * **Nothing tells an outsider whether a number is registered.** Requesting a
 * code answers the same way for a known and an unknown number; a failed sign-in
 * returns one message; and the password derivation runs even when there is no
 * account, so the response time does not answer the question either.
 *
 * **No number and no code is ever stored in the clear.** The number is
 * encrypted with a wrapped DEK and found again by a keyed token in its own
 * scope; the code is a keyed HMAC. Neither appears in a URL, a log, an audit
 * payload or an outbox event (CLAUDE.md §8).
 */

export interface CodeRequested {
  /** Always the same shape, whether or not the number is known. */
  readonly requested: true;
  readonly expiresAt: Date;
}

export interface GuestSessionIssued {
  readonly token: string;
  readonly sessionId: string;
  readonly accountId: string;
}

export class GuestRegistrationService extends GuestServiceBase {
  private readonly tokens: TokenService;

  constructor(deps: GuestDependencies) {
    super(deps);
    this.tokens = new TokenService(deps.keys);
  }

  /**
   * Sends a one-time code to a number, for one purpose.
   *
   * The answer never depends on whether the number has an account: a caller who
   * asks to register a number that is already registered, and a caller who asks
   * to reset a password for a number that has none, get the same body.
   */
  async requestCode(
    input: { phone: string; purpose: VerificationPurpose; requestIp?: string },
    request: RequestContext,
  ): Promise<CodeRequested> {
    const phone = normalisePhone(input.phone);
    return this.inGuestScope(request, async (uow) => {
      const expiresAt = new Date(this.now(uow).getTime() + this.parameters.otpTtlSeconds * 1000);
      // A malformed number is refused after the same work a valid one costs, and
      // with the same body, so the shape rule is not an oracle either.
      if (phone === undefined) return { requested: true as const, expiresAt };

      const phoneToken = await this.phoneToken(phone);
      return this.issue(
        uow,
        phone,
        phoneToken.token,
        input.purpose,
        hashIp(input.requestIp),
        request,
      );
    });
  }

  /**
   * Issues and delivers one code. The single place a challenge is created, so
   * the resend interval, the attempt budget and the audit shape are applied
   * once rather than at every call site.
   */
  private async issue(
    uow: UnitOfWork,
    phone: string,
    phoneToken: string,
    purpose: VerificationPurpose,
    requestIpHash: string | null,
    request: RequestContext,
  ): Promise<CodeRequested> {
    const params = this.parameters;
    const now = this.now(uow);
    const expiresAt = new Date(now.getTime() + params.otpTtlSeconds * 1000);
    const guests = new GuestRepository(uow);
    const account = await guests.accountByPhoneToken(phoneToken);

    // Throttling is silent: a caller who is resending too fast gets the same
    // answer as one who is not, and no second message is sent.
    const lastSentAt = await guests.lastSentAt(phoneToken, purpose);
    if (!mayResend(lastSentAt, now, params.otpResendSeconds)) {
      return { requested: true as const, expiresAt };
    }

    // A resend supersedes rather than stacks; the partial unique index refuses
    // a second live challenge for the same number and purpose.
    await guests.supersedePending(phoneToken, purpose);

    const issued = await this.tokens.issueNumericCode(phoneToken, OTP_DIGITS, 'guest_otp');
    const verification = await guests.createVerification({
      phoneToken,
      purpose,
      codeHash: issued.tokenHash,
      codeKeyVersion: issued.keyVersion,
      accountId: account?.accountId ?? null,
      maxAttempts: params.otpMaxAttempts,
      expiresAt,
      requestIpHash,
    });

    // The message leaves through the port with the plaintext code and the
    // number. Neither reaches the audit record, which carries the challenge's
    // id and its purpose and nothing else.
    const delivery = await this.deps.otp.send(
      {
        subjectRef: verification.verificationId,
        phone,
        expiresAt,
        deliveryId: verification.verificationId,
        code: issued.token,
      },
      { correlationId: request.correlationId },
    );

    await recordPlatformAudit(uow, {
      action: 'guest.phone_verification.sent',
      outcome: delivery.ok ? 'allowed' : 'failed',
      targetType: 'guest_phone_verification',
      targetRef: verification.verificationId,
      payload: { purpose, delivered: delivery.ok },
    });

    return { requested: true as const, expiresAt };
  }

  /**
   * Sends a code to the number an account already holds (doc 09 §6.3).
   *
   * The number comes from the account, never from the request: a second channel
   * the caller could choose would prove nothing. It is decrypted for the length
   * of the delivery call and never returned.
   */
  async requestCodeForAccount(
    input: { accountId: string; purpose: VerificationPurpose },
    request: RequestContext,
  ): Promise<CodeRequested> {
    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);
      const profile = await guests.accountById(input.accountId);
      const sealed = await guests.phoneSecret(input.accountId);
      if (profile?.phoneToken == null || sealed === undefined) {
        throw new ApiError('CONFLICT', 'that account holds no phone number to confirm on');
      }
      const phone = await decryptValue(this.deps.keys, 'pii.guest_account', sealed, {
        table: 'guest_account',
        column: 'phone_ciphertext',
        rowRef: input.accountId,
      });
      return this.issue(uow, phone, profile.phoneToken, input.purpose, null, request);
    });
  }

  /**
   * Registers a new Guest: proves the number, then creates the account, the
   * credential and the profile in one transaction (doc 09 §6.2 steps 3–5).
   */
  async register(
    input: { phone: string; code: string; password: string },
    request: RequestContext,
  ): Promise<GuestSessionIssued> {
    const phone = normalisePhone(input.phone);
    if (phone === undefined) throw new ApiError('VALIDATION_FAILED', SIGN_IN_REFUSAL);
    const phoneToken = await this.phoneToken(phone);
    // Committed before anything else happens, so a wrong guess costs an
    // attempt whether or not the rest of this command succeeds.
    await this.redeem(phoneToken.token, 'REGISTER', input.code, request);
    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);

      // The number is proven. Whether it is *free* is the unique index's
      // answer, taken under the same transaction that just consumed the code.
      if ((await guests.accountByPhoneToken(phoneToken.token)) !== undefined) {
        throw new ApiError('CONFLICT', 'that number already has an account');
      }

      const account = await this.deps.accounts.createAccount(uow);
      await establishAccountScope(uow, account.accountId);
      await this.deps.accounts.setPassword(uow, account.accountId, input.password);
      const sealed = await encryptValue(this.deps.keys, 'pii.guest_account', phone, {
        table: 'guest_account',
        column: 'phone_ciphertext',
        rowRef: account.accountId,
      });
      await guests.createPhoneAccount({
        accountId: account.accountId,
        phoneToken: phoneToken.token,
        phoneTokenKeyVersion: phoneToken.keyVersion,
        phoneCiphertext: sealed.ciphertext,
        phoneWrappedDek: sealed.wrappedDek,
        phoneKeyVersion: sealed.keyVersion,
        verifiedAt: this.now(uow),
      });

      await recordPlatformAudit(uow, {
        action: 'guest.account.registered',
        outcome: 'allowed',
        targetType: 'guest_account',
        targetRef: account.accountId,
        payload: { registeredVia: 'PHONE_OTP' },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'guest_account',
        aggregateId: account.accountId,
        eventType: 'guest.account.registered',
        // The number is not in this payload, and no consumer needs it: a guest
        // is an account id everywhere outside this module (CLAUDE.md §8).
        payload: { accountId: account.accountId, registeredVia: 'PHONE_OTP' },
      });

      const session = await this.deps.accounts.openSession(uow, account);
      return { ...session, accountId: account.accountId };
    });
  }

  /**
   * Signs in with a number and a password.
   *
   * Every failure is the same failure (doc 09 §6.3). The account lookup, the
   * derivation and the state check all run before anything is refused, so
   * neither the body nor the timing separates an unknown number from a wrong
   * password.
   */
  async signIn(
    input: { phone: string; password: string },
    request: RequestContext,
  ): Promise<GuestSessionIssued> {
    const phone = normalisePhone(input.phone);
    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);
      const profile =
        phone === undefined
          ? undefined
          : await guests.accountByPhoneToken((await this.phoneToken(phone)).token);
      const account =
        profile === undefined ? undefined : await this.deps.accounts.byId(uow, profile.accountId);

      const correct = await this.deps.accounts.verifyPassword(
        uow,
        account?.accountId,
        input.password,
      );

      if (
        profile === undefined ||
        account === undefined ||
        !correct ||
        account.state !== 'ACTIVE' ||
        profile.state !== 'ACTIVE'
      ) {
        await recordPlatformAudit(uow, {
          action: 'guest.session.sign_in',
          outcome: 'denied',
          targetType: 'guest_account',
          ...(profile === undefined ? {} : { targetRef: profile.accountId }),
          reason: 'invalid_credentials',
        });
        throw new ApiError('UNAUTHENTICATED', SIGN_IN_REFUSAL);
      }

      await establishAccountScope(uow, account.accountId);
      const session = await this.deps.accounts.openSession(uow, account);
      await recordPlatformAudit(uow, {
        action: 'guest.session.sign_in',
        outcome: 'allowed',
        targetType: 'server_session',
        targetRef: session.sessionId,
        payload: { accountId: account.accountId },
      });
      return { ...session, accountId: account.accountId };
    });
  }

  /**
   * Sets a new password against a fresh code, and closes every session
   * (doc 09 §6.2 step 6; doc 19 §10 for what a password change means).
   */
  async resetPassword(
    input: { phone: string; code: string; password: string },
    request: RequestContext,
  ): Promise<{ reset: true }> {
    const phone = normalisePhone(input.phone);
    if (phone === undefined) throw new ApiError('VALIDATION_FAILED', SIGN_IN_REFUSAL);
    const phoneToken = await this.phoneToken(phone);
    const redeemed = await this.redeem(phoneToken.token, 'PASSWORD_RESET', input.code, request);
    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);

      const profile = await guests.accountByPhoneToken(phoneToken.token);
      // A code was issued for a number with no account — the same silence the
      // request answered with. The challenge is spent either way, so a caller
      // learns nothing by observing which branch ran.
      if (profile === undefined || redeemed.accountId === null) return { reset: true as const };

      const account = await this.deps.accounts.byId(uow, profile.accountId);
      if (account === undefined) return { reset: true as const };

      await establishAccountScope(uow, account.accountId);
      await this.deps.accounts.setPassword(uow, account.accountId, input.password);
      await this.deps.accounts.revokeEverySession(uow, account, 'password_reset');
      await recordPlatformAudit(uow, {
        action: 'guest.password.reset',
        outcome: 'allowed',
        targetType: 'guest_account',
        targetRef: account.accountId,
      });
      return { reset: true as const };
    });
  }

  /**
   * Spends a code against its challenge, or refuses.
   *
   * Shared by registration, password reset and account linking, so the attempt
   * budget, the expiry and the settling are applied once rather than three
   * times. The refusal message never distinguishes a wrong code from an expired
   * one; both mean "present a fresh code".
   *
   * **It runs in its own transaction, and commits before the caller's work
   * begins.** A wrong guess recorded inside the caller's transaction would be
   * rolled back by the very refusal it caused, and the attempt budget would
   * never decrease — an unbounded number of guesses against a six-digit code.
   * The cost is that a code is spent even if the command that follows fails;
   * that is the right trade, and the remedy is a fresh code.
   */
  async redeem(
    phoneToken: string,
    purpose: VerificationPurpose,
    code: string,
    request: RequestContext,
  ): Promise<{ verificationId: string; accountId: string | null }> {
    const spent = await this.inGuestScope(request, (uow) =>
      this.spend(uow, phoneToken, purpose, code),
    );
    // Thrown *after* the transaction commits. A refusal raised inside it would
    // roll back the attempt it just recorded, and the budget would never
    // decrease — an unbounded number of guesses against six digits.
    if (spent.kind === 'raced') {
      throw new ApiError('CONFLICT', 'that code is being used already');
    }
    if (spent.kind === 'refused') {
      throw new ApiError('VALIDATION_FAILED', 'that code is not usable');
    }
    return { verificationId: spent.verificationId, accountId: spent.accountId };
  }

  /**
   * Records the attempt and settles the challenge. Returns what happened; it
   * never throws for a business refusal, because the transaction it runs in has
   * to commit before the caller is told.
   */
  private async spend(
    uow: UnitOfWork,
    phoneToken: string,
    purpose: VerificationPurpose,
    code: string,
  ): Promise<
    | { kind: 'accepted'; verificationId: string; accountId: string | null }
    | { kind: 'refused' }
    | { kind: 'raced' }
  > {
    const guests = new GuestRepository(uow);
    const row = await guests.pendingVerification(phoneToken, purpose);
    if (row === undefined) return { kind: 'refused' };

    const correct = await this.tokens.matches('guest_otp', phoneToken, code, row.codeHash);
    const outcome = verificationOutcome(row, correct, this.now(uow));
    const settled = settledState(outcome);
    const attempts = outcome.kind === 'wrong' ? outcome.attempts : row.attempts;
    const advanced = await guests.recordAttempt({
      verificationId: row.verificationId,
      expectedRevision: row.revision,
      attempts,
      state: settled,
    });
    if (!advanced) return { kind: 'raced' };
    if (outcome.kind !== 'accepted') return { kind: 'refused' };
    return { kind: 'accepted', verificationId: row.verificationId, accountId: row.accountId };
  }

  /** The keyed lookup token for a number, in the Guest realm's own scope. */
  async phoneToken(phone: string): Promise<LookupToken> {
    return deriveLookupToken(
      this.deps.keys,
      'lookup.guest_phone',
      { identityType: 'phone', countryCode: 'MN' },
      phone,
    );
  }
}

/**
 * A caller's address, reduced to a digest for rate limiting.
 *
 * The address is a personal identifier, and doc 09 §6.2 asks for limits by IP
 * without asking for a log of who searched from where; a digest counts without
 * recording.
 */
function hashIp(ip: string | undefined): string | null {
  if (ip === undefined || ip.trim() === '') return null;
  return createHash('sha256').update(ip).digest('hex');
}
