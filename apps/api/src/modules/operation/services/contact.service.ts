import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { OperationRepository } from '../repositories/operation.repository';
import type { ChangeRequestRow } from '../repositories/operation.repository';
import { CONTACT_OTP_DIGITS, maskPhone, normaliseContactPhone } from '../domain/operation';
import type { ContactChallenge } from '../domain/operation';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import {
  CONTACT_EXCEPTION,
  HOTEL_PROFILE_MANAGE,
  OperationServiceBase,
  claim,
} from './operation-context';

/**
 * Changing the one number a subscription's reminders go to (doc 14 §2.3,
 * `OPS-DEC-015`).
 *
 * The shape of this service is the security rule. The *Primary Hotel Admin*
 * opens and completes the change, in the hotel's own scope, under the doc 18 §3
 * row that already governs the hotel's owner and profile data. An Operation
 * account has no method here that writes a number, reads a code or completes a
 * challenge; the single thing it may do is approve an exception that waives the
 * **old** number's challenge — and the new number's is still outstanding
 * afterwards, which the change request's own CHECK enforces.
 *
 * The codes themselves are six digits, five minutes, five attempts and one
 * live code per challenge, all of which are columns and indexes rather than
 * service conventions. Nothing stores a code: what is stored is a versioned
 * keyed digest bound to this purpose.
 */

export interface ChangeRequestView {
  readonly requestId: string;
  readonly state: string;
  readonly oldPhoneMasked: string;
  readonly newPhoneMasked: string;
  readonly oldPhoneVerified: boolean;
  readonly newPhoneVerified: boolean;
  readonly exceptionApproved: boolean;
}

function view(row: ChangeRequestRow): ChangeRequestView {
  return {
    requestId: row.requestId,
    state: row.state,
    oldPhoneMasked: maskPhone(row.oldPhone),
    newPhoneMasked: maskPhone(row.newPhone),
    oldPhoneVerified: row.oldPhoneVerifiedAt !== null,
    newPhoneVerified: row.newPhoneVerifiedAt !== null,
    exceptionApproved: row.exceptionApprovedAt !== null,
  };
}

export class SubscriptionContactService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /** The number reminders currently go to, masked, for the hotel's own screen. */
  async current(
    actor: CommandActor,
    hotelId: string,
    request: RequestContext,
  ): Promise<{ phoneMasked: string | null; open: ChangeRequestView | undefined }> {
    return this.runHotelCommand(
      actor,
      { hotelId },
      HOTEL_PROFILE_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new OperationRepository(uow);
        const subscription = await repository.lockSubscription(hotelId);
        if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const contact = await repository.currentContact(subscription.subscriptionId);
        const open = await repository.openChangeRequest(subscription.subscriptionId);
        return {
          phoneMasked: contact === undefined ? null : maskPhone(contact.phone),
          open: open === undefined ? undefined : view(open),
        };
      },
    );
  }

  /**
   * Opens a change and challenges the **old** number first.
   *
   * One non-terminal request per subscription is a partial unique index, so a
   * second attempt while one is open is refused by the database rather than by
   * a check that could be raced past.
   */
  async open(
    actor: CommandActor,
    input: { hotelId: string; newPhone: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<ChangeRequestView> {
    const newPhone = normaliseContactPhone(input.newPhone);
    if (newPhone === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
        { field: 'newPhone', issue: 'not a Mongolian eight-digit number' },
      ]);
    }
    return this.runHotelCommand(
      actor,
      { hotelId: input.hotelId },
      HOTEL_PROFILE_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const claimed = await claim(uow, 'operation.contact.open', input.idempotencyKey, {
          hotelId: input.hotelId,
          newPhone,
        });
        if (claimed.kind === 'replay') return claimed.body as ChangeRequestView;

        const repository = new OperationRepository(uow);
        const subscription = await repository.lockSubscription(input.hotelId);
        if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if ((await repository.openChangeRequest(subscription.subscriptionId)) !== undefined) {
          throw new ApiError('CONFLICT', 'a contact change is already in progress');
        }
        const contact = await repository.currentContact(subscription.subscriptionId);
        if (contact === undefined) {
          throw new ApiError('CONFLICT', 'this subscription has no confirmed contact number');
        }
        if (contact.phone === newPhone) {
          throw new ApiError('CONFLICT', 'that is already the subscription contact');
        }

        const requestId = await repository.createChangeRequest({
          hotelId: input.hotelId,
          subscriptionId: subscription.subscriptionId,
          oldPhone: contact.phone,
          newPhone,
          requestedBy: actor.principal.accountId,
        });
        await this.issueCode(uow, repository, {
          hotelId: input.hotelId,
          requestId,
          challenge: 'OLD_PHONE',
          phone: contact.phone,
        });

        await this.audit(uow, {
          action: 'operation.contact.change_opened',
          outcome: 'allowed',
          targetType: 'subscription_contact_change_request',
          targetRef: requestId,
          payload: {
            hotelId: input.hotelId,
            oldPhone: maskPhone(contact.phone),
            newPhone: maskPhone(newPhone),
          },
        });

        const result: ChangeRequestView = {
          requestId,
          state: 'AWAITING_OLD_PHONE',
          oldPhoneMasked: maskPhone(contact.phone),
          newPhoneMasked: maskPhone(newPhone),
          oldPhoneVerified: false,
          newPhoneVerified: false,
          exceptionApproved: false,
        };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /** doc 14 §2.3: a new code every sixty seconds, and it invalidates the last. */
  async resend(
    actor: CommandActor,
    input: { hotelId: string; requestId: string; challenge: ContactChallenge },
    request: RequestContext,
  ): Promise<{ resent: true }> {
    return this.runHotelCommand(
      actor,
      { hotelId: input.hotelId },
      HOTEL_PROFILE_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new OperationRepository(uow);
        const change = await this.expectRequest(repository, input.requestId, input.hotelId);
        this.expectChallengeIsDue(change, input.challenge);

        const live = await repository.currentCode(input.requestId, input.challenge);
        if (live !== undefined) {
          const age = this.now(uow).getTime() - live.issuedAt.getTime();
          if (age < this.parameters.contactCodeResendSeconds * 1000) {
            throw new ApiError('RATE_LIMITED', 'a code was sent less than a minute ago');
          }
          await repository.supersedeCode(live.codeId);
        }
        await this.issueCode(uow, repository, {
          hotelId: input.hotelId,
          requestId: input.requestId,
          challenge: input.challenge,
          phone: input.challenge === 'OLD_PHONE' ? change.oldPhone : change.newPhone,
        });
        return { resent: true as const };
      },
    );
  }

  /**
   * Redeems a code, and — when it is the new number's — applies the change.
   *
   * An attempt is counted before the digest is compared, so a wrong guess costs
   * a budget entry whether or not the caller waits for the answer, and the
   * budget is a column the database enforces rather than a counter this service
   * keeps.
   */
  async verify(
    actor: CommandActor,
    input: {
      hotelId: string;
      requestId: string;
      challenge: ContactChallenge;
      code: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<ChangeRequestView> {
    const notice = await this.runHotelCommand(
      actor,
      { hotelId: input.hotelId },
      HOTEL_PROFILE_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new OperationRepository(uow);
        const change = await this.expectRequest(repository, input.requestId, input.hotelId);
        this.expectChallengeIsDue(change, input.challenge);

        const live = await repository.currentCode(input.requestId, input.challenge);
        if (live === undefined) throw new ApiError('CONFLICT', 'no code is outstanding');
        if (live.expiresAt.getTime() <= this.now(uow).getTime()) {
          await repository.supersedeCode(live.codeId);
          throw new ApiError('CONFLICT', 'the code has expired');
        }
        const attempts = await repository.countAttempt(live.codeId);
        if (attempts < 0) {
          await repository.supersedeCode(live.codeId);
          throw new ApiError('RATE_LIMITED', 'too many attempts on this code');
        }
        const matches = await this.tokens.matches(
          'contact_otp',
          `${input.requestId}:${input.challenge}`,
          input.code,
          live.codeHash,
        );
        if (!matches) {
          await this.audit(uow, {
            action: 'operation.contact.code_refused',
            outcome: 'denied',
            targetType: 'subscription_contact_change_request',
            targetRef: input.requestId,
            reason: 'code_mismatch',
            payload: { challenge: input.challenge, attempts },
          });
          // Returned rather than thrown, so the attempt this consumed commits.
          // A refusal that rolled back its own budget entry would be a code an
          // attacker could guess without limit.
          return { refused: true as const, result: undefined, deliver: undefined };
        }

        // The idempotency key is claimed only once the code is right. A wrong
        // guess must not burn a key, and a key left `in_progress` by a refusal
        // would block the next legitimate attempt.
        const claimed = await claim(uow, 'operation.contact.verify', input.idempotencyKey, {
          requestId: input.requestId,
          challenge: input.challenge,
        });
        if (claimed.kind === 'replay') {
          return {
            refused: false as const,
            result: claimed.body as ChangeRequestView,
            deliver: undefined,
          };
        }
        await repository.consumeCode(live.codeId);

        if (input.challenge === 'OLD_PHONE') {
          if (
            !(await repository.markChallengePassed({
              requestId: input.requestId,
              challenge: 'OLD_PHONE',
              expectedRevision: change.revision,
            }))
          ) {
            throw new ApiError('CONFLICT', 'the change moved while it was being verified');
          }
          await this.issueCode(uow, repository, {
            hotelId: input.hotelId,
            requestId: input.requestId,
            challenge: 'NEW_PHONE',
            phone: change.newPhone,
          });
          const result: ChangeRequestView = {
            ...view(change),
            state: 'AWAITING_NEW_PHONE',
            oldPhoneVerified: true,
          };
          await this.complete(uow, claimed.idempotencyId, result);
          return { refused: false as const, result, deliver: undefined };
        }

        // The new number is verified: supersede the current contact and insert
        // the new revision in the same transaction, so there is no instant at
        // which a subscription has two current numbers or none.
        if (
          !(await repository.markChallengePassed({
            requestId: input.requestId,
            challenge: 'NEW_PHONE',
            expectedRevision: change.revision,
          }))
        ) {
          throw new ApiError('CONFLICT', 'the change moved while it was being verified');
        }
        const current = await repository.currentContact(change.subscriptionId);
        const applied = await repository.applyChange({
          requestId: input.requestId,
          hotelId: input.hotelId,
          subscriptionId: change.subscriptionId,
          newPhone: change.newPhone,
          actorAccountId: actor.principal.accountId,
          currentContactId: current?.contactId,
          expectedRevision: change.revision + 1,
        });
        if (applied === undefined) {
          throw new ApiError('CONFLICT', 'the change moved while it was being applied');
        }

        await this.audit(uow, {
          action: 'operation.contact.changed',
          outcome: 'allowed',
          targetType: 'subscription_contact',
          targetRef: applied,
          payload: {
            hotelId: input.hotelId,
            requestId: input.requestId,
            from: maskPhone(change.oldPhone),
            to: maskPhone(change.newPhone),
            byException: change.exceptionApprovedAt !== null,
          },
        });

        const result: ChangeRequestView = {
          ...view(change),
          state: 'APPLIED',
          newPhoneVerified: true,
        };
        await this.complete(uow, claimed.idempotencyId, result);

        // doc 14 §2.3: when the old number's challenge was waived, the
        // registered address is told that the number moved. The address is read
        // here, in the hotel's own scope — the Operation realm that approved the
        // waiver cannot reach it at all.
        if (change.exceptionApprovedAt === null) {
          return { refused: false as const, result, deliver: undefined };
        }
        const email = await uow.query<{ email_normalized: string }>(
          `SELECT email_normalized FROM platform.hotel_admin_activation
            WHERE hotel_id = $1 ORDER BY created_at, activation_id LIMIT 1`,
          [input.hotelId],
        );
        const address = email.rows[0]?.email_normalized;
        return {
          refused: false as const,
          result,
          deliver:
            address === undefined
              ? undefined
              : {
                  kind: 'subscription_contact_changed' as const,
                  deliveryId: randomUUID(),
                  hotelId: input.hotelId,
                  emailNormalized: address,
                  oldPhoneMasked: maskPhone(change.oldPhone),
                  newPhoneMasked: maskPhone(change.newPhone),
                  approvedByException: true,
                  changedAt: this.wallClock(),
                },
        };
      },
    );

    if (notice.refused) throw new ApiError('UNAUTHENTICATED', 'the code is incorrect');
    if (notice.deliver !== undefined) {
      await this.deps.notifications.send(notice.deliver, { correlationId: request.correlationId });
    }
    return notice.result as ChangeRequestView;
  }

  /** Ends an open change without applying it. */
  async cancel(
    actor: CommandActor,
    input: { hotelId: string; requestId: string; reason: string },
    request: RequestContext,
  ): Promise<{ cancelled: true }> {
    return this.runHotelCommand(
      actor,
      { hotelId: input.hotelId },
      HOTEL_PROFILE_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new OperationRepository(uow);
        const change = await this.expectRequest(repository, input.requestId, input.hotelId);
        const live = await repository.currentCode(input.requestId, 'OLD_PHONE');
        if (live !== undefined) await repository.supersedeCode(live.codeId);
        const newLive = await repository.currentCode(input.requestId, 'NEW_PHONE');
        if (newLive !== undefined) await repository.supersedeCode(newLive.codeId);
        if (
          !(await repository.terminateChangeRequest({
            requestId: input.requestId,
            state: 'CANCELLED',
            reason: input.reason,
            expectedRevision: change.revision,
          }))
        ) {
          throw new ApiError('CONFLICT', 'the change moved while it was being cancelled');
        }
        await this.audit(uow, {
          action: 'operation.contact.change_cancelled',
          outcome: 'allowed',
          targetType: 'subscription_contact_change_request',
          targetRef: input.requestId,
          reason: input.reason,
        });
        return { cancelled: true as const };
      },
    );
  }

  /**
   * `SUBSCRIPTION_CONTACT_CHANGE_APPROVE`: waives the **old** number's
   * challenge and nothing else (doc 14 §2.3).
   *
   * Three things this cannot do, by construction. It cannot set a number — the
   * new one is already on the request, put there by the Hotel Admin. It cannot
   * skip the new number's challenge — the row's CHECK refuses an `APPLIED`
   * state without `new_phone_verified_at`. And it cannot be used on a request
   * whose old number was already verified, because a waiver is not a pass.
   */
  async approveException(
    actor: CommandActor,
    input: {
      requestId: string;
      reference: string;
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<ChangeRequestView> {
    const outcome = await this.runOperationCommand(
      actor,
      CONTACT_EXCEPTION,
      { targetType: 'subscription_contact_change_request', targetRef: input.requestId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.contact.exception', input.idempotencyKey, {
          requestId: input.requestId,
        });
        if (claimed.kind === 'replay') {
          return { result: claimed.body as ChangeRequestView, notify: undefined };
        }

        const repository = new OperationRepository(uow);
        const change = await repository.lockChangeRequest(input.requestId);
        if (change === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (change.state !== 'AWAITING_OLD_PHONE') {
          throw new ApiError('CONFLICT', 'this change is not awaiting the old number');
        }

        if (
          !(await repository.approveException({
            requestId: input.requestId,
            approvedBy: actor.principal.accountId,
            reference: input.reference,
            reason: input.reason,
            expectedRevision: change.revision,
          }))
        ) {
          throw new ApiError('CONFLICT', 'the change moved while it was being approved');
        }
        // The new number's code is *not* issued here. Issuing it would mean the
        // Operation realm writing to the challenge table, and the whole point
        // of `OPS-DEC-015` is that an Operation account never touches a code:
        // the Hotel Admin asks for it from their own side once the waiver has
        // moved the request on.

        await this.audit(uow, {
          action: 'operation.contact.exception_approved',
          outcome: 'allowed',
          targetType: 'subscription_contact_change_request',
          targetRef: input.requestId,
          reason: input.reference,
          payload: {
            hotelId: change.hotelId,
            oldPhone: maskPhone(change.oldPhone),
            newPhone: maskPhone(change.newPhone),
          },
        });

        const result: ChangeRequestView = {
          ...view(change),
          state: 'AWAITING_NEW_PHONE',
          exceptionApproved: true,
        };
        await this.complete(uow, claimed.idempotencyId, result);
        return { result, notify: { phone: change.oldPhone, hotelId: change.hotelId } };
      },
    );

    // doc 14 §2.3: the old number is told that its challenge was waived. The
    // SMS carries no code and no new number — only that a change is in progress.
    if (outcome.notify !== undefined) {
      await this.deps.sms.send(
        {
          jobId: `contact-exception-${input.requestId}`,
          recipients: [{ recipientRef: input.requestId, phone: outcome.notify.phone }],
          body: 'Захиалгын холбоо барих дугаар солих хүсэлт батлагдлаа. Та мэдээгүй бол платформ руу нэн даруй хандана уу.',
        },
        { correlationId: request.correlationId },
      );
    }
    return outcome.result;
  }

  /**
   * Mints a code, stores its digest, and hands the plaintext to the SMS port.
   *
   * The plaintext exists only for the length of the send. `EXT-05` keeps the
   * production adapter disabled, so in production the send answers `DISABLED`
   * and the challenge stands unsatisfiable rather than being quietly waived —
   * which is the fail-closed behaviour CLAUDE.md §9 requires.
   */
  private async issueCode(
    uow: UnitOfWork,
    repository: OperationRepository,
    input: { hotelId: string; requestId: string; challenge: ContactChallenge; phone: string },
  ): Promise<void> {
    const subject = `${input.requestId}:${input.challenge}`;
    const issued = await this.tokens.issueNumericCode(subject, CONTACT_OTP_DIGITS, 'contact_otp');
    await repository.issueCode({
      hotelId: input.hotelId,
      requestId: input.requestId,
      challenge: input.challenge,
      phone: input.phone,
      codeHash: issued.tokenHash,
      codeKeyVersion: issued.keyVersion,
      ttlSeconds: this.parameters.contactCodeTtlSeconds,
    });
    await this.deps.sms.send(
      {
        jobId: `contact-otp-${input.requestId}-${input.challenge}-${String(uow.serverNow.getTime())}`,
        recipients: [{ recipientRef: input.requestId, phone: input.phone }],
        body: `Захиалгын холбоо барих дугаар баталгаажуулах код: ${issued.token}`,
      },
      { correlationId: uow.context.correlationId },
    );
  }

  private async expectRequest(
    repository: OperationRepository,
    requestId: string,
    hotelId: string,
  ): Promise<ChangeRequestRow> {
    const change = await repository.lockChangeRequest(requestId);
    if (change === undefined || change.hotelId !== hotelId) {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    return change;
  }

  private expectChallengeIsDue(change: ChangeRequestRow, challenge: ContactChallenge): void {
    const due =
      change.state === 'AWAITING_OLD_PHONE'
        ? 'OLD_PHONE'
        : change.state === 'AWAITING_NEW_PHONE'
          ? 'NEW_PHONE'
          : undefined;
    if (due !== challenge) {
      throw new ApiError('CONFLICT', 'that challenge is not the one outstanding');
    }
  }
}
