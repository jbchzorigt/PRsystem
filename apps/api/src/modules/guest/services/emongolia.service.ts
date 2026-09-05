import { ApiError } from '@prsystem/contracts';
import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { deriveLookupToken } from '@prsystem/ports';
import type { LookupToken, PortError } from '@prsystem/ports';
import { establishAccountScope } from '../../iam/services/iam-context';
import { GuestRepository } from '../repositories/guest.repository';
import { linkDecision, normalisePhone } from '../domain/guest';
import type { GuestDependencies, RequestContext } from './guest-context';
import { GuestServiceBase } from './guest-context';
import type { GuestSessionIssued } from './registration.service';
import { GuestRegistrationService } from './registration.service';

/**
 * e-Mongolia registration, sign-in and account linking (doc 09 §6.1, §6.3;
 * `EXT-02`).
 *
 * What the provider returns is a subject: an identifier for *its* account. This
 * module never treats that as the same person as a phone account it already
 * holds — doc 09 §6.1 says so in as many words, and doc 09 §6.3 makes joining
 * them a dual-channel confirmation with its own audited row. The subject itself
 * is stored only as a keyed token in its own scope, so a database copy cannot
 * be replayed against the provider.
 *
 * The port is disabled outside local, CI and test. A disabled port is answered
 * as an unavailable channel, not an error the caller can act on — and doc 09
 * §6.1 names phone registration as the fallback when e-Mongolia is not working.
 */

export interface AuthorizationStarted {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface LinkRequired {
  /** The provider proved an identity that is not linked, and a number is. */
  readonly outcome: 'link_required';
  readonly requestId: string;
}

export type ProviderSignIn =
  ({ readonly outcome: 'signed_in' } & GuestSessionIssued) | LinkRequired;

export class GuestEMongoliaService extends GuestServiceBase {
  private readonly registrations: GuestRegistrationService;

  constructor(deps: GuestDependencies) {
    super(deps);
    this.registrations = new GuestRegistrationService(deps);
  }

  /** Hands back the provider's authorization URL. Carries no platform token. */
  async begin(
    input: { redirectUri: string; state: string },
    request: RequestContext,
  ): Promise<AuthorizationStarted> {
    const result = await this.deps.emongolia.begin(input, {
      correlationId: request.correlationId,
    });
    if (!result.ok) throw providerRefusal(result.error);
    return { authorizationUrl: result.value.authorizationUrl, state: result.value.state };
  }

  /**
   * Completes the provider exchange.
   *
   * Three outcomes, and the third is the one doc 09 §6.3 exists for:
   *
   * - the subject is already linked → that account signs in;
   * - the subject is unknown and the caller offers no number → a new account is
   *   created, registered through the provider and linked in the same
   *   transaction;
   * - the subject is unknown and the caller offers a number that already has an
   *   account → nothing is merged. A link request is opened with the provider
   *   channel proven, and the phone channel still to prove.
   */
  async complete(
    input: { code: string; state: string; redirectUri: string; phone?: string },
    request: RequestContext,
  ): Promise<ProviderSignIn> {
    const exchange = await this.deps.emongolia.complete(
      { code: input.code, state: input.state, redirectUri: input.redirectUri },
      { correlationId: request.correlationId },
    );
    if (!exchange.ok) throw providerRefusal(exchange.error);
    const identity = exchange.value;
    const subject = await this.subjectToken(identity.providerSubject);

    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);
      const existing = await guests.linkBySubject('EMONGOLIA', subject.token);
      if (existing !== undefined) {
        const account = await this.deps.accounts.byId(uow, existing.accountId);
        const profile = await guests.accountById(existing.accountId);
        if (account === undefined || account.state !== 'ACTIVE' || profile?.state !== 'ACTIVE') {
          throw new ApiError('UNAUTHENTICATED', 'that account cannot be signed in to');
        }
        await establishAccountScope(uow, account.accountId);
        const session = await this.deps.accounts.openSession(uow, account);
        await recordPlatformAudit(uow, {
          action: 'guest.session.sign_in',
          outcome: 'allowed',
          targetType: 'server_session',
          targetRef: session.sessionId,
          payload: { accountId: account.accountId, via: 'EMONGOLIA' },
        });
        return { outcome: 'signed_in' as const, ...session, accountId: account.accountId };
      }

      // An unlinked subject, offered alongside a number that already has an
      // account. doc 09 §6.3: never merged automatically.
      const phone = input.phone === undefined ? undefined : normalisePhone(input.phone);
      if (phone !== undefined) {
        const phoneToken = await this.registrations.phoneToken(phone);
        const claimed = await guests.accountByPhoneToken(phoneToken.token);
        if (claimed !== undefined) {
          const now = this.now(uow);
          const requested = await guests.createLinkRequest({
            accountId: claimed.accountId,
            provider: 'EMONGOLIA',
            subjectToken: subject.token,
            subjectKeyVersion: subject.keyVersion,
            expiresAt: new Date(now.getTime() + this.parameters.linkTtlSeconds * 1000),
          });
          // The provider channel is proven — the person just authenticated with
          // it. The phone channel is not, and the row cannot reach CONFIRMED
          // until it is.
          await guests.advanceLinkRequest({
            requestId: requested.requestId,
            expectedRevision: requested.revision,
            state: 'PENDING',
            providerVerifiedAt: now,
          });
          await recordPlatformAudit(uow, {
            action: 'guest.account_link.requested',
            outcome: 'allowed',
            targetType: 'guest_account_link_request',
            targetRef: requested.requestId,
            payload: { accountId: claimed.accountId, provider: 'EMONGOLIA' },
          });
          return { outcome: 'link_required' as const, requestId: requested.requestId };
        }
      }

      // A person the platform has not met. The provider registration creates
      // the account; the number, if there is one, is proven separately later.
      const account = await this.deps.accounts.createAccount(uow);
      await establishAccountScope(uow, account.accountId);
      await guests.createProviderAccount({
        accountId: account.accountId,
        displayName: identity.claims.displayName ?? null,
      });
      const link = await guests.createLink({
        provider: 'EMONGOLIA',
        subjectToken: subject.token,
        subjectKeyVersion: subject.keyVersion,
        accountId: account.accountId,
        linkedVia: 'PROVIDER_REGISTRATION',
      });
      await recordPlatformAudit(uow, {
        action: 'guest.account.registered',
        outcome: 'allowed',
        targetType: 'guest_account',
        targetRef: account.accountId,
        payload: { registeredVia: 'PROVIDER', linkId: link.linkId },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'guest_account',
        aggregateId: account.accountId,
        eventType: 'guest.account.registered',
        payload: { accountId: account.accountId, registeredVia: 'PROVIDER' },
      });
      const session = await this.deps.accounts.openSession(uow, account);
      return { outcome: 'signed_in' as const, ...session, accountId: account.accountId };
    });
  }

  /**
   * Sends the second channel's code, on the number the account already holds
   * (doc 09 §6.3). The code goes to the account's number, never to one the
   * caller supplies — otherwise the second channel would prove nothing.
   */
  async requestLinkCode(
    input: { requestId: string },
    request: RequestContext,
  ): Promise<{ requested: true }> {
    const accountId = await this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);
      const pending = await guests.lockLinkRequest(input.requestId);
      if (pending === undefined) throw new ApiError('NOT_FOUND', 'no such link request');
      const decision = linkDecision(pending, this.now(uow));
      if (decision.kind === 'expired' || decision.kind === 'settled') {
        throw new ApiError('CONFLICT', 'that link request is closed');
      }
      return pending.accountId;
    });
    // Issued against the number the account holds — the request body never
    // named it, and could not have chosen a different one.
    const issued = await this.registrations.requestCodeForAccount(
      { accountId, purpose: 'ACCOUNT_LINK' },
      request,
    );
    return { requested: issued.requested };
  }

  /**
   * Confirms both channels and creates the link (doc 09 §6.3).
   *
   * The database refuses `CONFIRMED` without both timestamps, the verification
   * and the link; this refuses it before the constraint has to.
   */
  async confirmLink(
    input: { requestId: string; code: string },
    request: RequestContext,
  ): Promise<GuestSessionIssued> {
    // The account's number, then the code, then the link. The redemption
    // commits on its own so a wrong guess costs an attempt (doc 09 §6.2).
    const phoneToken = await this.inGuestScope(request, async (uow) => {
      const pending = await new GuestRepository(uow).lockLinkRequest(input.requestId);
      if (pending === undefined) throw new ApiError('NOT_FOUND', 'no such link request');
      const profile = await new GuestRepository(uow).accountById(pending.accountId);
      if (profile?.phoneToken == null) {
        throw new ApiError('CONFLICT', 'that account holds no phone number to confirm on');
      }
      return profile.phoneToken;
    });
    const redeemed = await this.registrations.redeem(
      phoneToken,
      'ACCOUNT_LINK',
      input.code,
      request,
    );
    return this.inGuestScope(request, async (uow) => {
      const guests = new GuestRepository(uow);
      const pending = await guests.lockLinkRequest(input.requestId);
      if (pending === undefined) throw new ApiError('NOT_FOUND', 'no such link request');
      const now = this.now(uow);
      const decision = linkDecision(pending, now);
      if (decision.kind === 'expired') {
        await guests.advanceLinkRequest({
          requestId: pending.requestId,
          expectedRevision: pending.revision,
          state: 'EXPIRED',
          reason: 'the confirmation window closed',
        });
        throw new ApiError('CONFLICT', 'that link request has expired');
      }
      if (decision.kind === 'settled') {
        throw new ApiError('CONFLICT', 'that link request is closed');
      }
      if (decision.kind === 'await' && decision.missing === 'provider') {
        throw new ApiError('CONFLICT', 'the provider channel is not confirmed');
      }

      const profile = await guests.lockAccount(pending.accountId);
      if (profile?.phoneToken == null) {
        throw new ApiError('CONFLICT', 'that account holds no phone number to confirm on');
      }

      const account = await this.deps.accounts.byId(uow, pending.accountId);
      if (account === undefined || account.state !== 'ACTIVE') {
        throw new ApiError('CONFLICT', 'that account cannot be linked');
      }
      await establishAccountScope(uow, account.accountId);
      const link = await guests.createLink({
        provider: pending.provider,
        subjectToken: pending.subjectToken,
        subjectKeyVersion: pending.subjectKeyVersion,
        accountId: pending.accountId,
        linkedVia: 'DUAL_CHANNEL_LINK',
      });
      const confirmed = await guests.advanceLinkRequest({
        requestId: pending.requestId,
        expectedRevision: pending.revision,
        state: 'CONFIRMED',
        phoneVerifiedAt: now,
        verificationId: redeemed.verificationId,
        linkId: link.linkId,
      });
      if (!confirmed) throw new ApiError('CONFLICT', 'that link request changed under this one');

      await recordPlatformAudit(uow, {
        action: 'guest.account_link.confirmed',
        outcome: 'allowed',
        targetType: 'guest_account_link_request',
        targetRef: pending.requestId,
        payload: { accountId: pending.accountId, linkId: link.linkId, provider: pending.provider },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'guest_account',
        aggregateId: pending.accountId,
        eventType: 'guest.identity.linked',
        payload: { accountId: pending.accountId, provider: pending.provider },
      });

      const session = await this.deps.accounts.openSession(uow, account);
      return { ...session, accountId: account.accountId };
    });
  }

  private async subjectToken(providerSubject: string): Promise<LookupToken> {
    return deriveLookupToken(
      this.deps.keys,
      'lookup.guest_identity_subject',
      { identityType: 'provider_subject', countryCode: 'MN' },
      providerSubject,
    );
  }
}

/**
 * A provider refusal, translated without leaking the provider's own words.
 *
 * A disabled gate and an outage are both "the channel is not available" to the
 * caller, whose remedy is the same either way: register by phone (doc 09 §6.1).
 */
function providerRefusal(error: PortError): ApiError {
  if (error.kind === 'REJECTED') {
    return new ApiError('VALIDATION_FAILED', 'that authorization could not be completed');
  }
  return new ApiError('DEPENDENCY_UNAVAILABLE', 'e-Mongolia is not available; register by phone');
}
