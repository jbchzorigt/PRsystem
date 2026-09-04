import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { checkoutStartBlockers } from '../domain/checkout';
import { CorrectionRepository } from '../repositories/correction.repository';
import { RefillRepository } from '../repositories/refill.repository';
import { ReportRepository } from '../repositories/report.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';
import type { CheckoutView } from './checkout-views';
import { checkoutView } from './checkout-views';

/**
 * Starting and calling off a checkout (doc 21 §2, doc 04 §5.2).
 *
 * `Check-out эхлүүлэх` does not close anything: it moves the stay to
 * `CHECKOUT_IN_PROGRESS` and, for a minibar-enabled room, opens the usage
 * report the Cleaner will fill in — which is the obligation the actual
 * checkout of Phase 08 already refuses to pass while it is unsettled
 * (`CHK-DEC-001`). A pending actual-time correction and an unfinished
 * active-stay refill both refuse the start (doc 21 §2.1, doc 25 §6.1).
 *
 * Calling it off returns the stay to the guests still in the room and leaves
 * the report and the tasks behind as cancelled history — nothing is deleted
 * (doc 04 §8).
 */

const CHECKOUT = 'hotel.stay.checkout_record';

export interface StartCheckoutInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface CancelCheckoutInput extends StartCheckoutInput {
  readonly reason: string;
}

export class CheckoutService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /** doc 21 §2 (1)–(2): the start, and the report it opens. */
  async start(
    input: StartCheckoutInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CheckoutView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.checkout_start', input.idempotencyKey, {
          stayId: input.stayId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as CheckoutView;
        const stays = new StayRepository(uow);
        const peek = await stays.byId(input.stayId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const stay = await stays.lock(input.stayId);
        await authorize();
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (stay.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        }
        const correction = await new CorrectionRepository(uow).pendingOf(stay.stayId);
        const refills = new RefillRepository(uow);
        const open = await refills.openOfStay(stay.stayId);
        const blockers = checkoutStartBlockers({
          stayState: stay.state,
          correctionPending: correction !== undefined,
          openRefillTasks: open.length,
        });
        if (blockers.length > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            `CHECKOUT_REFUSED: ${blockers.join(', ')}`,
            blockers.map((blocker) => ({ field: 'stayId', issue: blocker })),
          );
        }
        const now = serverNow(this.deps, uow);
        const started = await stays.transition({
          stayId: stay.stayId,
          expectedRevision: stay.revision,
          toState: 'CHECKOUT_IN_PROGRESS',
        });
        if (started === undefined) {
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        }
        // `CHK-DEC-001`: the report exists for a minibar-enabled room, and only
        // for one. A room whose minibar is off closes its checkout without it.
        const reports = new ReportRepository(uow);
        const report = stay.minibarApplicable
          ? (await reports.open({ stayId: stay.stayId, roomId: stay.roomId, openedAt: now })).report
          : undefined;
        await stays.appendEvent({
          stayId: stay.stayId,
          eventType: 'CHECKOUT_STARTED',
          fromState: stay.state,
          toState: 'CHECKOUT_IN_PROGRESS',
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: {
            reportId: report?.reportId ?? null,
            minibarApplicable: stay.minibarApplicable,
          },
        });
        await recordPlatformAudit(uow, {
          action: 'stay.checkout_start',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: stay.stayId,
          payload: { roomId: stay.roomId, reportId: report?.reportId ?? null },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'stay',
          aggregateId: stay.stayId,
          eventType: 'stay.checkout_started',
          payload: {
            stayId: stay.stayId,
            roomId: stay.roomId,
            reportId: report?.reportId ?? null,
            startedAt: now.toISOString(),
          },
        });
        const result = checkoutView(started, report);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** doc 04 §8: the checkout is called off; nothing it produced is deleted. */
  async cancel(
    input: CancelCheckoutInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CheckoutView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.checkout_cancel', input.idempotencyKey, {
          stayId: input.stayId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as CheckoutView;
        const stays = new StayRepository(uow);
        const peek = await stays.byId(input.stayId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const stay = await stays.lock(input.stayId);
        await authorize();
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (stay.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        }
        if (stay.state !== 'CHECKOUT_IN_PROGRESS') {
          throw new ApiError('CONFLICT', 'CHECKOUT_NOT_STARTED: no checkout is in progress');
        }
        const reports = new ReportRepository(uow);
        const report = await reports.liveOfStay(stay.stayId);
        if (report !== undefined) {
          // A locked or settled report means money is or was in play: the
          // checkout is not something a Reception may simply call off.
          if (report.state === 'LOCKED') {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'PAYMENT_LOCKED: reconcile the payment attempt before calling the checkout off',
            );
          }
          const locked = await reports.lock(report.reportId);
          if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
          const cancelled = await reports.transition({
            reportId: locked.reportId,
            expectedRevision: locked.revision,
            toState: 'CANCELLED',
            reason: input.reason,
          });
          if (cancelled === undefined) {
            throw new ApiError('CONFLICT', 'the report changed; reload and retry');
          }
        }
        const now = serverNow(this.deps, uow);
        const reverted = await stays.transition({
          stayId: stay.stayId,
          expectedRevision: stay.revision,
          toState: 'ACTIVE',
        });
        if (reverted === undefined) {
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        }
        await stays.appendEvent({
          stayId: stay.stayId,
          eventType: 'CHECKOUT_CANCELLED',
          fromState: stay.state,
          toState: 'ACTIVE',
          reason: input.reason,
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: { reportId: report?.reportId ?? null },
        });
        await recordPlatformAudit(uow, {
          action: 'stay.checkout_cancel',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: stay.stayId,
          reason: input.reason,
          payload: { roomId: stay.roomId, reportId: report?.reportId ?? null },
        });
        const result = checkoutView(reverted, undefined);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** The report a stay's checkout opened, for the Reception's screen. */
  async reportOfStay(uow: UnitOfWork, stayId: string): Promise<string | null> {
    const report = await new ReportRepository(uow).liveOfStay(stayId);
    return report?.reportId ?? null;
  }
}
