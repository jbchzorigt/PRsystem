import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { readCategoryState, shareRoom } from '../../catalog/contracts/room-reads';
import { readinessBlockers } from '../domain/readiness';
import { earliestAllowedCheckIn, fitsBeforeNext, readyNotBefore } from '../domain/timing';
import type { CorrectionRow } from '../repositories/correction.repository';
import { CorrectionRepository } from '../repositories/correction.repository';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import { ShiftRepository } from '../repositories/shift.repository';
import type { StayRow } from '../repositories/stay.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, hotelTimeZone, serverNow, sqlState } from './stay-context';
import type { CorrectionView } from './stay-views';
import { correctionView, effectiveActualCheckIn } from './stay-views';

/**
 * The active-stay actual-time correction (doc 05 §20, doc 02 §3.14;
 * `STAY-DEC-010`).
 *
 * A Reception submits a corrected arrival with a reason; a Manager approves
 * or rejects it. The bound is fixed at request time on the *original*
 * recorded time, shift and local day — never on the current time, so it
 * cannot slide. One pending request per stay, held by index; a pending
 * request blocks the checkout. Approval re-validates overlap and historical
 * readiness at the corrected instant and changes nothing but the effective
 * actual start: the original row is never touched, and the price book, the
 * planned end and the recorded time are exactly what they were.
 */

const SUBMIT = 'hotel.stay.actual_time_correction_submit';
const DECIDE = 'hotel.stay.actual_time_correction_decide';

export interface SubmitCorrectionInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly correctedActualCheckInAt: Date;
  readonly reason: string;
}

export interface DecideCorrectionInput {
  readonly hotelId: string;
  readonly correctionId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly decisionReason?: string;
}

export class CorrectionService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  async submit(
    input: SubmitCorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CorrectionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      SUBMIT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.correction_submit', input.idempotencyKey, {
          stayId: input.stayId,
          correctedActualCheckInAt: input.correctedActualCheckInAt.toISOString(),
        });
        if (claimed.kind === 'replay') return claimed.body as CorrectionView;
        const stays = new StayRepository(uow);
        const corrections = new CorrectionRepository(uow);
        const peek = await stays.byId(input.stayId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const stay = await stays.lock(input.stayId);
        await authorize();
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (stay.state !== 'ACTIVE') {
          throw new ApiError(
            'CONFLICT',
            'CHECKOUT_STARTED: a correction is only for an active stay before its checkout',
          );
        }
        // doc 05 §20.2: the bound on the original recorded time, shift and day.
        const shift = await new ShiftRepository(uow).byId(stay.shiftId);
        const timeZone = await hotelTimeZone(uow);
        const booking =
          stay.bookingRef === null
            ? undefined
            : await this.deps.bookings.byReference(uow, stay.bookingRef);
        const earliest = earliestAllowedCheckIn({
          serverNow: stay.checkInRecordedAt,
          shiftOpenedAt: shift?.openedAt ?? stay.checkInRecordedAt,
          timeZone,
          ...(booking === undefined ? {} : { bookingPlannedCheckInAt: booking.plannedCheckInAt }),
        });
        const latest = stay.checkInRecordedAt;
        const corrected = input.correctedActualCheckInAt;
        if (corrected.getTime() < earliest.getTime() || corrected.getTime() > latest.getTime()) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'CORRECTION_OUT_OF_BOUND: the corrected time is outside the fixed window',
            [
              {
                field: 'correctedActualCheckInAt',
                issue: `between ${earliest.toISOString()} and ${latest.toISOString()}`,
              },
            ],
          );
        }
        const previousEffective = effectiveActualCheckIn(
          stay,
          await corrections.latestApproved(stay.stayId),
        );
        const now = serverNow(this.deps, uow);
        let row: CorrectionRow;
        try {
          row = await corrections.create({
            stayId: stay.stayId,
            previousEffectiveAt: previousEffective,
            correctedActualCheckInAt: corrected,
            earliestAllowedAt: earliest,
            latestAllowedAt: latest,
            reason: input.reason,
            requestedByAccountId: gate.principal.accountId,
            requestedAt: now,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'CORRECTION_PENDING: the stay already has a pending correction',
            );
          }
          throw error;
        }
        await stays.appendEvent({
          stayId: stay.stayId,
          eventType: 'CORRECTION_REQUESTED',
          reason: input.reason,
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: {
            correctionId: row.correctionId,
            previousEffectiveAt: previousEffective.toISOString(),
            correctedActualCheckInAt: corrected.toISOString(),
            earliestAllowedAt: earliest.toISOString(),
            latestAllowedAt: latest.toISOString(),
          },
        });
        await recordPlatformAudit(uow, {
          action: 'stay.correction.submit',
          outcome: 'allowed',
          targetType: 'stay_time_correction',
          targetRef: row.correctionId,
          reason: input.reason,
          payload: { stayId: stay.stayId, correctedActualCheckInAt: corrected.toISOString() },
        });
        const result = correctionView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  async approve(
    input: DecideCorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CorrectionView> {
    return this.decide(input, 'APPROVED', actor, request);
  }

  async reject(
    input: DecideCorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CorrectionView> {
    return this.decide(input, 'REJECTED', actor, request);
  }

  private async decide(
    input: DecideCorrectionInput,
    decision: 'APPROVED' | 'REJECTED',
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CorrectionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DECIDE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(
          uow,
          `stay.correction_${decision.toLowerCase()}`,
          input.idempotencyKey,
          {
            correctionId: input.correctionId,
            expectedRevision: input.expectedRevision,
          },
        );
        if (claimed.kind === 'replay') return claimed.body as CorrectionView;
        const corrections = new CorrectionRepository(uow);
        const stays = new StayRepository(uow);
        const peek = await corrections.byId(input.correctionId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        // Lock order: the stay, then the correction.
        const stay = await stays.lock(peek.stayId);
        const correction = await corrections.lock(input.correctionId);
        await authorize();
        if (stay === undefined || correction === undefined)
          throw new ApiError('NOT_FOUND', 'not found');
        if (correction.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the correction changed; reload and retry');
        }
        if (correction.state !== 'PENDING') {
          throw new ApiError('CONFLICT', `the correction is already ${correction.state}`);
        }
        if (stay.state !== 'ACTIVE') {
          throw new ApiError('CONFLICT', 'CHECKOUT_STARTED: the stay is no longer active');
        }
        const now = serverNow(this.deps, uow);
        if (decision === 'APPROVED') await this.revalidate(uow, stay, correction);
        // doc 05 §20.1: the same account requesting and approving is allowed
        // and named for what it is.
        const selfApproved =
          decision === 'APPROVED' && correction.requestedByAccountId === gate.principal.accountId;
        const decided = await corrections.decide({
          correctionId: correction.correctionId,
          expectedRevision: correction.revision,
          state: decision,
          decidedByAccountId: gate.principal.accountId,
          decidedAt: now,
          decisionReason: input.decisionReason ?? null,
          selfApproved,
        });
        if (decided === undefined)
          throw new ApiError('CONFLICT', 'the correction changed; reload and retry');
        await stays.appendEvent({
          stayId: stay.stayId,
          eventType: decision === 'APPROVED' ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED',
          ...(input.decisionReason === undefined ? {} : { reason: input.decisionReason }),
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: {
            correctionId: correction.correctionId,
            previousEffectiveAt: correction.previousEffectiveAt.toISOString(),
            correctedActualCheckInAt: correction.correctedActualCheckInAt.toISOString(),
            effectiveActualCheckInAt: (decision === 'APPROVED'
              ? correction.correctedActualCheckInAt
              : correction.previousEffectiveAt
            ).toISOString(),
            requestedByAccountId: correction.requestedByAccountId,
            selfApproved,
          },
        });
        await recordPlatformAudit(uow, {
          action: `stay.correction.${decision.toLowerCase()}`,
          outcome: 'allowed',
          targetType: 'stay_time_correction',
          targetRef: correction.correctionId,
          ...(input.decisionReason === undefined ? {} : { reason: input.decisionReason }),
          payload: {
            stayId: stay.stayId,
            selfApproved,
            requestedByAccountId: correction.requestedByAccountId,
          },
        });
        if (decision === 'APPROVED') {
          // doc 13 §8.5: the amendment is announced once; matching neither
          // reruns nor duplicates an alert on it.
          await appendOutboxEvent(uow, {
            aggregateType: 'stay',
            aggregateId: stay.stayId,
            eventType: 'stay.actual_time_corrected',
            payload: {
              stayId: stay.stayId,
              correctionId: correction.correctionId,
              previousEffectiveAt: correction.previousEffectiveAt.toISOString(),
              effectiveActualCheckInAt: correction.correctedActualCheckInAt.toISOString(),
              checkInRecordedAt: stay.checkInRecordedAt.toISOString(),
              selfApproved,
            },
          });
        }
        const result = correctionView(decided);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 05 §20.4: `[corrected, unchanged planned_checkout)` against the
   * previous stay's anchor, the historical `Цэвэр` at the corrected instant,
   * the room and category lifecycle, and the next booking plus buffer. The
   * minibar's configuration must not have changed since the corrected
   * instant either, as at a backdated check-in.
   */
  private async revalidate(
    uow: UnitOfWork,
    stay: StayRow,
    correction: CorrectionRow,
  ): Promise<void> {
    const at = correction.correctedActualCheckInAt;
    const room = await shareRoom(uow, stay.roomId);
    if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
    const categoryState = (await readCategoryState(uow, stay.categoryId)) ?? 'INACTIVE';
    const stays = new StayRepository(uow);
    const previous = await stays.lastCompletedOfRoom(stay.roomId);
    const anchor =
      previous?.actualCheckoutAt === null || previous === undefined
        ? null
        : readyNotBefore(previous.actualCheckoutAt as Date, previous.cleaningBufferMinutes);
    const cleaningAt = await new HousekeepingRepository(uow).stateAt(stay.roomId, at);
    const pin = await this.deps.minibar.checkInPin(uow, stay.roomId);
    const blockers = [
      ...readinessBlockers({
        at,
        roomState: room.state,
        categoryState,
        cleaningStateAt: cleaningAt,
        occupied: false,
        readyNotBefore: anchor,
        minibarBlockers: stay.minibarApplicable ? pin.blockers : [],
      }),
    ];
    if (
      stay.minibarApplicable &&
      pin.configuration !== null &&
      pin.configuration.updatedAt.getTime() > at.getTime() &&
      pin.configuration.updatedAt.getTime() <= stay.checkInRecordedAt.getTime()
    ) {
      blockers.push('MINIBAR_CONFIGURATION_CHANGED_AFTER');
    }
    const next = (await this.deps.bookings.commitmentsForRoom(uow, stay.roomId, at)).find(
      (booking) => booking.bookingRef !== stay.bookingRef,
    );
    if (
      !fitsBeforeNext(stay.plannedCheckoutAt, stay.cleaningBufferMinutes, next?.plannedCheckInAt)
    ) {
      blockers.push('NEXT_BOOKING_CONFLICT');
    }
    // The room's own current occupant is this stay; readiness at `at` is about
    // what came before it, so `ROOM_OCCUPIED` never applies here and
    // `MINIBAR_STATUS_*` describes the room as it is now, after this stay
    // began — only the historical facts refuse.
    const historical = blockers.filter((code) => !code.startsWith('MINIBAR_STATUS'));
    if (historical.length > 0) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `HISTORICAL_READINESS_UNPROVEN: ${historical.join(', ')}`,
        historical.map((code) => ({ field: 'correctedActualCheckInAt', issue: code })),
      );
    }
  }

  async history(
    target: { hotelId: string; stayId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly CorrectionView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      [SUBMIT, DECIDE],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const stay = await new StayRepository(uow).byId(target.stayId);
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return (await new CorrectionRepository(uow).history(stay.stayId)).map(correctionView);
      },
    );
  }
}
