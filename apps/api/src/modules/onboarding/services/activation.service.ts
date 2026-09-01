import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import { AccountRepository } from '../../iam/repositories/account.repository';
import { assertPasswordAcceptable, derivePassword } from '../../iam/services/password.service';
import type { OnboardingDependencies, RequestContext } from './onboarding-context';
import { OnboardingServiceBase } from './onboarding-context';
import { ACTIVATION_SUBJECT } from './provisioning.service';

/**
 * The first Hotel Admin's activation (`ONB-DEC-003`, doc 15 §5).
 *
 * The platform never issues a password. The link is single-use, time-limited,
 * and the user chooses their own credential — and every one of those is Phase
 * 04's existing account, credential and session model reused rather than a
 * second one. What Phase 05 adds is the activation *axis* doc 15 §6 requires to
 * be separate from the hotel, the subscription and the public listing.
 */

export interface ActivationInput {
  readonly hotelId: string;
  readonly token: string;
  readonly password: string;
}

export class ActivationService extends OnboardingServiceBase {
  constructor(deps: OnboardingDependencies) {
    super(deps);
  }

  /**
   * Redeems the link and sets the password.
   *
   * The token is the gate: there is no membership to gate with, because the
   * person has never signed in. It is compared against the stored digest and
   * nothing is read, locked or changed until it matches.
   *
   * On success the link is destroyed rather than marked used — the row's guard
   * refuses to re-attach one — and the account's `auth_epoch` is bumped, so any
   * session that somehow existed before the password did stops being valid.
   */
  async activate(
    input: ActivationInput,
    request: RequestContext,
  ): Promise<{ accountId: string; membershipId: string }> {
    assertPasswordAcceptable(input.password);
    const presented = await this.tokens.digest(
      'hotel_admin_activation',
      ACTIVATION_SUBJECT,
      input.token,
    );

    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const found = await uow.query<{
        activation_id: string;
        account_id: string;
        membership_id: string;
        email_normalized: string;
        state: string;
        revision: number;
        expired: boolean;
      }>(
        `SELECT activation_id, account_id, membership_id, email_normalized, state, revision,
                (expires_at IS NULL OR expires_at <= now()) AS expired
           FROM platform.hotel_admin_activation
          WHERE hotel_id = $1 AND token_hash = $2
            FOR UPDATE`,
        [input.hotelId, presented.tokenHash],
      );
      const activation = found.rows[0];
      // An unknown, spent or expired link is the same refusal: nothing here
      // tells a holder which of the three it was, or that the hotel exists.
      if (activation === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (activation.state !== 'PENDING_ACTIVATION') throw new ApiError('NOT_FOUND', 'not found');
      if (activation.expired) {
        await uow.query(
          `UPDATE platform.hotel_admin_activation
              SET token_hash = NULL, token_key_version = NULL, expires_at = NULL,
                  revision = revision + 1
            WHERE hotel_id = $1 AND activation_id = $2`,
          [input.hotelId, activation.activation_id],
        );
        throw new ApiError('NOT_FOUND', 'not found');
      }

      const accounts = new AccountRepository(uow);
      const account = await accounts.findById(activation.account_id);
      if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const derived = await derivePassword(input.password);
      await accounts.upsertPassword(account.accountId, derived.secretHash, derived.paramsVersion);
      await accounts.markEmailVerified(account.accountId);
      // Anything issued before the credential existed is invalidated, which is
      // the same account-wide revocation a password change performs (doc 19 §10).
      await accounts.bumpAuthEpoch(account.accountId, account.revision);

      const settled = await uow.query(
        `UPDATE platform.hotel_admin_activation
            SET state = 'ACTIVE', activated_at = now(),
                token_hash = NULL, token_key_version = NULL, expires_at = NULL,
                revision = revision + 1
          WHERE hotel_id = $1 AND activation_id = $2 AND revision = $3
            AND state = 'PENDING_ACTIVATION'`,
        [input.hotelId, activation.activation_id, activation.revision],
      );
      if (settled.rowCount !== 1) throw new ApiError('CONFLICT', 'this link was already used');

      await recordPlatformAudit(uow, {
        action: 'onboarding.activation.completed',
        outcome: 'allowed',
        targetType: 'hotel_admin_activation',
        targetRef: activation.activation_id,
        payload: { accountId: account.accountId, membershipId: activation.membership_id },
      });

      return { accountId: account.accountId, membershipId: activation.membership_id };
    });
  }

  /** The activation axis, for the Operation list and for tests. */
  async state(
    hotelId: string,
    request: RequestContext,
  ): Promise<{ state: string; hasLiveLink: boolean } | undefined> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const result = await uow.query<{ state: string; has_link: boolean }>(
        `SELECT state, (token_hash IS NOT NULL) AS has_link
           FROM platform.hotel_admin_activation WHERE hotel_id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { state: row.state, hasLiveLink: row.has_link };
    });
  }
}
