import { ApiError } from '@prsystem/contracts';
import { OperationRepository } from '../repositories/operation.repository';
import type { ReconciliationRow } from '../repositories/operation.repository';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import {
  OPERATION_READ,
  PAYMENT_RECONCILE,
  RESET_INITIATE,
  SUSPEND,
  OperationServiceBase,
  claim,
} from './operation-context';

/**
 * The three things an Operation account may do *to* a subscription
 * (`OPS-DEC-008`, `OPS-DEC-016`, `OPS-DEC-017`).
 *
 * None of them changes what the customer bought. There is no method here that
 * writes a package, a term, a `starts_at`, an `expires_at`, a pending target or
 * a provisioning state — and that is the point of the phase rather than an
 * omission from it.
 */

export interface SuspensionOutcome {
  readonly hotelId: string;
  readonly suspended: boolean;
  readonly eventId: string;
  readonly sessionsRevoked: number;
  /** Returned so a caller can see for itself that the calendar did not move. */
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

export class OperationSubscriptionService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /**
   * `OPS-DEC-008`: initiates a reset on the hotel's primary subscription
   * account.
   *
   * The operator names the hotel and nothing else. The registered address is
   * read, queued and masked inside the resolver, so what comes back — and what
   * is audited, logged and returned — is `a****@example.test` and a queue id.
   * No parameter of this method could redirect the link.
   */
  async initialisePasswordReset(
    actor: CommandActor,
    input: { hotelId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ queued: boolean; emailMasked: string }> {
    return this.runOperationCommand(
      actor,
      RESET_INITIATE,
      { targetType: 'hotel', targetRef: input.hotelId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.reset.initiate', input.idempotencyKey, {
          hotelId: input.hotelId,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as { queued: boolean; emailMasked: string };
        }

        const queued = await new OperationRepository(uow).queuePasswordReset(
          input.hotelId,
          actor.principal.accountId,
        );
        if (queued === undefined) throw new ApiError('NOT_FOUND', 'not found');

        await this.audit(uow, {
          action: 'operation.subscription.reset_queued',
          outcome: 'allowed',
          targetType: 'user_account',
          targetRef: queued.accountId,
          payload: {
            hotelId: input.hotelId,
            // The masked destination doc 14 §2.1 requires in the audit, and the
            // only form of the address that exists on this side of the resolver.
            destination: queued.emailMasked,
            intakeId: queued.intakeId,
          },
        });

        const result = { queued: true, emailMasked: queued.emailMasked };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /**
   * `OPS-DEC-016`: suspends or reactivates a provisioned hotel.
   *
   * Three properties the append-only event exists to make checkable. The
   * calendar is snapshotted on both the suspension and the reactivation, so a
   * test can compare them and see that nothing moved. `suspended_before` and
   * `suspended_after` must differ, so a repeated suspend writes no event rather
   * than a second one that claims a transition. And reactivation is its own
   * decision with its own reason — nothing here schedules one.
   */
  async setSuspension(
    actor: CommandActor,
    input: {
      hotelId: string;
      suspend: boolean;
      reasonCode: string;
      note: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<SuspensionOutcome> {
    return this.runOperationCommand(
      actor,
      SUSPEND,
      { targetType: 'hotel_subscription', targetRef: input.hotelId },
      request,
      async (uow) => {
        const claimed = await claim(
          uow,
          'operation.subscription.suspension',
          input.idempotencyKey,
          {
            hotelId: input.hotelId,
            suspend: input.suspend,
          },
        );
        if (claimed.kind === 'replay') return claimed.body as SuspensionOutcome;

        const repository = new OperationRepository(uow);
        const subscription = await repository.lockSubscription(input.hotelId);
        if (subscription === undefined) throw new ApiError('NOT_FOUND', 'not found');

        const suspendedBefore = subscription.suspendedAt !== null;
        if (suspendedBefore === input.suspend) {
          throw new ApiError(
            'CONFLICT',
            input.suspend
              ? 'the subscription is already suspended'
              : 'the subscription is not suspended',
          );
        }

        if (
          !(await repository.setSuspension({
            hotelId: input.hotelId,
            suspend: input.suspend,
            reason: input.reasonCode,
            expectedRevision: subscription.revision,
          }))
        ) {
          throw new ApiError('CONFLICT', 'the subscription moved while it was being changed');
        }

        // Only a suspension closes the hotel's staff authority. Reactivating
        // grants none back: doc 19 §10 makes a scope grant something a session
        // is issued with, so the staff sign in again.
        const sessionsRevoked = input.suspend
          ? await repository.revokeHotelScope(input.hotelId)
          : 0;

        const eventId = await repository.recordSuspensionEvent({
          hotelId: input.hotelId,
          subscriptionId: subscription.subscriptionId,
          action: input.suspend ? 'SUSPEND' : 'REACTIVATE',
          reasonCode: input.reasonCode,
          note: input.note,
          actorAccountId: actor.principal.accountId,
          suspendedBefore,
          startsAt: subscription.startsAt,
          expiresAt: subscription.expiresAt,
          sessionsRevoked,
        });

        await this.audit(uow, {
          action: input.suspend
            ? 'operation.subscription.suspended'
            : 'operation.subscription.reactivated',
          outcome: 'allowed',
          targetType: 'hotel_subscription',
          targetRef: subscription.subscriptionId,
          reason: input.reasonCode,
          payload: { hotelId: input.hotelId, eventId, sessionsRevoked },
        });

        const result: SuspensionOutcome = {
          hotelId: input.hotelId,
          suspended: input.suspend,
          eventId,
          sessionsRevoked,
          startsAt: subscription.startsAt,
          expiresAt: subscription.expiresAt,
        };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /** doc 14 §4.2: the paid records that did not apply themselves. */
  async reconciliationQueue(
    actor: CommandActor,
    request: RequestContext,
    limit = 50,
  ): Promise<readonly ReconciliationRow[]> {
    return this.runOperationCommand(
      actor,
      PAYMENT_RECONCILE,
      { targetType: 'reconciliation_queue', targetRef: 'paid' },
      request,
      async (uow) => {
        const rows = await new OperationRepository(uow).reconciliationQueue(limit);
        await this.audit(uow, {
          action: 'operation.reconciliation.queue_read',
          outcome: 'allowed',
          targetType: 'reconciliation_queue',
          targetRef: 'paid',
          payload: { items: rows.length },
        });
        return rows;
      },
    );
  }

  /**
   * The suspension history of one hotel, for the detail screen.
   *
   * Read under `OPERATION_READ` rather than `SUBSCRIPTION_SUSPEND`: seeing that
   * a hotel was suspended, by whom and why is part of the approved subscription
   * information of doc 14 §2, and deciding it is not.
   */
  async suspensionHistory(
    actor: CommandActor,
    hotelId: string,
    request: RequestContext,
  ): Promise<
    readonly {
      eventId: string;
      action: string;
      reasonCode: string;
      note: string;
      occurredAt: Date;
      startsAtSnapshot: Date;
      expiresAtSnapshot: Date;
      sessionsRevoked: number;
    }[]
  > {
    return this.runOperationCommand(
      actor,
      OPERATION_READ,
      { targetType: 'subscription_suspension_event', targetRef: hotelId },
      request,
      async (uow) => {
        const result = await uow.query<Record<string, unknown>>(
          `SELECT event_id, action, reason_code, note, occurred_at,
                  starts_at_snapshot, expires_at_snapshot, sessions_revoked
             FROM platform.subscription_suspension_event
            WHERE hotel_id = $1
            ORDER BY occurred_at DESC, event_id`,
          [hotelId],
        );
        return result.rows.map((row) => ({
          eventId: String(row['event_id']),
          action: String(row['action']),
          reasonCode: String(row['reason_code']),
          note: String(row['note']),
          occurredAt: row['occurred_at'] as Date,
          startsAtSnapshot: row['starts_at_snapshot'] as Date,
          expiresAtSnapshot: row['expires_at_snapshot'] as Date,
          sessionsRevoked: Number(row['sessions_revoked']),
        }));
      },
    );
  }
}
