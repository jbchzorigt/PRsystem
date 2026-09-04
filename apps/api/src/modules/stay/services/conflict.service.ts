import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { listRooms, lockRoom, readCategoryState } from '../../catalog/contracts/room-reads';
import type { RoomState } from '../../catalog/contracts/room-reads';
import type { NextBookingFacts } from '../contracts/confirmed-bookings';
import { readinessBlockers } from '../domain/readiness';
import { readyNotBefore } from '../domain/timing';
import type { ConflictRow, ConflictState } from '../repositories/conflict.repository';
import { ConflictRepository } from '../repositories/conflict.repository';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';

/**
 * The overdue conflict of a confirmed booking (doc 05 §23, doc 02 §3.15;
 * `STAY-DEC-013`, doc 18 §3.3).
 *
 * Detection is a contract the booking module and a scheduler call: for every
 * confirmed booking whose cleaning-preparation boundary has been reached, if
 * its room's stay has no actual checkout and the category has no other
 * eligible room, one conflict is opened — idempotently, by index. It closes
 * by exactly one of four outcomes: the checkout makes the room ready in time
 * (`RESOLVED_READY`, decided by the checkout), a Reception assigns another
 * room of the same category, a Manager approves a higher category at no extra
 * charge, or a Manager cancels the booking as hotel-caused — which the booking
 * module completes with the full refund obligation of `BK-DEC-014`. Nothing
 * here checks a guest out, moves one, changes a planned end or charges a fee.
 */

const SAME_CATEGORY = 'booking.same_category_room_assign';
const HIGHER_CATEGORY = 'booking.higher_category_approve';
const CANCEL_HOTEL = 'booking.cancelled_hotel';
const VIEW = [SAME_CATEGORY, HIGHER_CATEGORY, CANCEL_HOTEL];

export interface ConflictView {
  readonly conflictId: string;
  readonly bookingRef: string;
  readonly categoryId: string;
  readonly roomId: string;
  readonly overdueStayId: string;
  readonly plannedCheckInAt: string;
  readonly state: ConflictState;
  readonly assignedRoomId: string | null;
  readonly resolvedAt: string | null;
  readonly reason: string | null;
  readonly selfApproved: boolean;
  readonly detectedAt: string;
  readonly revision: number;
}

export function conflictView(row: ConflictRow): ConflictView {
  return {
    conflictId: row.conflictId,
    bookingRef: row.bookingRef,
    categoryId: row.categoryId,
    roomId: row.roomId,
    overdueStayId: row.overdueStayId,
    plannedCheckInAt: row.plannedCheckInAt.toISOString(),
    state: row.state,
    assignedRoomId: row.assignedRoomId,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    reason: row.reason,
    selfApproved: row.selfApproved,
    detectedAt: row.detectedAt.toISOString(),
    revision: row.revision,
  };
}

export interface DetectionOutcome {
  readonly opened: readonly ConflictView[];
  readonly alreadyOpen: readonly ConflictView[];
}

export class ConflictService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /**
   * doc 05 §23.1, as a transaction-bound contract: given the bookings the
   * booking module says are due, open the conflicts that are real now.
   * Repeated calls open nothing twice.
   */
  async detect(
    uow: UnitOfWork,
    now: Date,
    due?: readonly NextBookingFacts[],
  ): Promise<DetectionOutcome> {
    const stays = new StayRepository(uow);
    const conflicts = new ConflictRepository(uow);
    const opened: ConflictView[] = [];
    const alreadyOpen: ConflictView[] = [];
    let candidates: readonly NextBookingFacts[];
    if (due !== undefined) {
      candidates = due;
    } else {
      const categories = [...new Set((await listRooms(uow)).map((room) => room.categoryId))];
      const lists = await Promise.all(
        categories.map((categoryId) => this.deps.bookings.dueForCategory(uow, categoryId, now)),
      );
      candidates = lists.flat();
    }
    for (const booking of candidates) {
      if (booking.assignedRoomId === null) continue;
      const live = await stays.liveOfRoom(booking.assignedRoomId);
      if (live === undefined) continue;
      if (live.bookingRef === booking.bookingRef) continue;
      const eligible = await this.eligibleRooms(uow, booking.categoryId, now, booking);
      if (eligible.length > 0) continue;
      const outcome = await conflicts.open({
        bookingRef: booking.bookingRef,
        categoryId: booking.categoryId,
        roomId: booking.assignedRoomId,
        overdueStayId: live.stayId,
        plannedCheckInAt: booking.plannedCheckInAt,
        cleaningBufferMinutes: booking.cleaningBufferMinutes,
        detectedAt: now,
      });
      (outcome.opened ? opened : alreadyOpen).push(conflictView(outcome.conflict));
      if (outcome.opened) {
        await appendOutboxEvent(uow, {
          aggregateType: 'booking_fulfillment_conflict',
          aggregateId: outcome.conflict.conflictId,
          eventType: 'stay.conflict.opened',
          payload: {
            conflictId: outcome.conflict.conflictId,
            bookingRef: booking.bookingRef,
            roomId: booking.assignedRoomId,
            overdueStayId: live.stayId,
            plannedCheckInAt: booking.plannedCheckInAt.toISOString(),
          },
        });
      }
    }
    return { opened, alreadyOpen };
  }

  /** A command surface over `detect`, for a Reception or Manager refreshing the board. */
  async refresh(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<DetectionOutcome & { readonly open: readonly ConflictView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const outcome = await this.detect(uow, serverNow(this.deps, uow));
        const open = (await new ConflictRepository(uow).listOpen()).map(conflictView);
        return { ...outcome, open };
      },
    );
  }

  async listOpen(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly ConflictView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        return (await new ConflictRepository(uow).listOpen()).map(conflictView);
      },
    );
  }

  /** doc 05 §23.2 (2): a Reception assigns another eligible room of the same category. */
  async reassignSameCategory(
    input: {
      hotelId: string;
      conflictId: string;
      idempotencyKey: string;
      expectedRevision: number;
      roomId: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ConflictView> {
    return this.resolve(input, SAME_CATEGORY, 'RESOLVED_REASSIGNED', actor, request, 'same');
  }

  /** doc 05 §23.2 (3): a Manager approves a higher-category room at no extra charge. */
  async approveHigherCategory(
    input: {
      hotelId: string;
      conflictId: string;
      idempotencyKey: string;
      expectedRevision: number;
      roomId: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ConflictView> {
    return this.resolve(
      input,
      HIGHER_CATEGORY,
      'RESOLVED_HIGHER_CATEGORY',
      actor,
      request,
      'higher',
    );
  }

  /** doc 05 §23.2 (4): no eligible room at all — the booking is cancelled by the hotel. */
  async cancelHotel(
    input: {
      hotelId: string;
      conflictId: string;
      idempotencyKey: string;
      expectedRevision: number;
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ConflictView> {
    return this.resolve({ ...input }, CANCEL_HOTEL, 'CANCELLED_HOTEL', actor, request, 'none');
  }

  private async resolve(
    input: {
      hotelId: string;
      conflictId: string;
      idempotencyKey: string;
      expectedRevision: number;
      roomId?: string;
      reason?: string;
    },
    permission: string,
    state: Exclude<ConflictState, 'OPEN' | 'RESOLVED_READY'>,
    actor: CommandActor,
    request: RequestContext,
    category: 'same' | 'higher' | 'none',
  ): Promise<ConflictView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      permission,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(
          uow,
          `stay.conflict_${state.toLowerCase()}`,
          input.idempotencyKey,
          {
            conflictId: input.conflictId,
            expectedRevision: input.expectedRevision,
            roomId: input.roomId ?? null,
          },
        );
        if (claimed.kind === 'replay') return claimed.body as ConflictView;
        const conflicts = new ConflictRepository(uow);
        const peek = await conflicts.byId(input.conflictId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        // The target room is taken `FOR UPDATE`: a check-in racing this
        // assignment waits on its share lock and then sees the assignment.
        const target = input.roomId === undefined ? undefined : await lockRoom(uow, input.roomId);
        const locked = await conflicts.lock(input.conflictId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (locked.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the conflict changed; reload and retry');
        }
        if (locked.state !== 'OPEN')
          throw new ApiError('CONFLICT', `the conflict is already ${locked.state}`);
        const now = serverNow(this.deps, uow);
        if (category !== 'none') {
          if (target === undefined) throw new ApiError('NOT_FOUND', 'not found');
          await this.requireEligible(uow, target, locked, now, category);
        } else {
          // Cancellation is the last resort: refused while an eligible room of
          // the category exists (doc 05 §23.2).
          const eligible = await this.eligibleRooms(uow, locked.categoryId, now, {
            bookingRef: locked.bookingRef,
            plannedCheckInAt: locked.plannedCheckInAt,
            plannedCheckoutAt: locked.plannedCheckInAt,
            cleaningBufferMinutes: locked.cleaningBufferMinutes,
            categoryId: locked.categoryId,
            assignedRoomId: locked.roomId,
          });
          if (eligible.length > 0) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'ELIGIBLE_ROOM_EXISTS: an eligible room of the category can still be assigned',
              eligible.map((room) => ({ field: 'roomId', issue: room.roomId })),
            );
          }
        }
        // doc 05 §23.2 (3): a Reception + Manager multi-role account deciding
        // its own reassignment is allowed and named for what it is.
        const selfApproved =
          category === 'higher' &&
          gate.membership.roles.includes('RECEPTION') &&
          (gate.membership.roles.includes('MANAGER') ||
            gate.membership.roles.includes('MANAGER_PLUS'));
        const resolved = await conflicts.resolve({
          conflictId: locked.conflictId,
          expectedRevision: locked.revision,
          state,
          assignedRoomId: target?.roomId ?? null,
          resolvedByAccountId: gate.principal.accountId,
          resolvedAt: now,
          reason: input.reason ?? null,
          selfApproved,
        });
        if (resolved === undefined)
          throw new ApiError('CONFLICT', 'the conflict changed; reload and retry');
        await recordPlatformAudit(uow, {
          action: `stay.conflict.${state.toLowerCase()}`,
          outcome: 'allowed',
          targetType: 'booking_fulfillment_conflict',
          targetRef: locked.conflictId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: {
            bookingRef: locked.bookingRef,
            fromRoomId: locked.roomId,
            assignedRoomId: target?.roomId ?? null,
            selfApproved,
          },
        });
        // The booking module applies the assignment or the cancellation and
        // its refund obligation; this module only decides.
        await appendOutboxEvent(uow, {
          aggregateType: 'booking_fulfillment_conflict',
          aggregateId: locked.conflictId,
          eventType: 'stay.conflict.resolved',
          payload: {
            conflictId: locked.conflictId,
            bookingRef: locked.bookingRef,
            state,
            assignedRoomId: target?.roomId ?? null,
            assignedCategoryId: target?.categoryId ?? null,
            reason: input.reason ?? null,
            selfApproved,
          },
        });
        const result = conflictView(resolved);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 05 §23.2: an eligible room is active, vacant now and at the booking's
   * start, ready — buffer passed, `Цэвэр`, minibar clear — and not committed
   * to another booking before this one's end.
   */
  private async eligibleRooms(
    uow: UnitOfWork,
    categoryId: string,
    now: Date,
    booking: NextBookingFacts,
  ): Promise<readonly RoomState[]> {
    const rooms = (await listRooms(uow)).filter(
      (room) =>
        room.categoryId === categoryId &&
        room.state === 'ACTIVE' &&
        room.roomId !== booking.assignedRoomId,
    );
    const eligible: RoomState[] = [];
    for (const room of rooms) {
      if (await this.isEligible(uow, room, now, booking)) eligible.push(room);
    }
    return eligible;
  }

  private async isEligible(
    uow: UnitOfWork,
    room: RoomState,
    now: Date,
    booking: NextBookingFacts,
  ): Promise<boolean> {
    const stays = new StayRepository(uow);
    const categoryState = (await readCategoryState(uow, room.categoryId)) ?? 'INACTIVE';
    const live = await stays.liveOfRoom(room.roomId);
    const previous = await stays.lastCompletedOfRoom(room.roomId);
    const anchor =
      previous?.actualCheckoutAt === null || previous === undefined
        ? null
        : readyNotBefore(previous.actualCheckoutAt as Date, previous.cleaningBufferMinutes);
    const cleaning = await new HousekeepingRepository(uow).state(room.roomId);
    const pin = await this.deps.minibar.checkInPin(uow, room.roomId);
    const at = new Date(Math.max(now.getTime(), booking.plannedCheckInAt.getTime()));
    const blockers = readinessBlockers({
      at,
      roomState: room.state,
      categoryState,
      cleaningStateAt: cleaning?.state ?? null,
      occupied: live !== undefined,
      readyNotBefore: anchor,
      minibarBlockers: pin.blockers,
    });
    if (blockers.length > 0) return false;
    const next = (await this.deps.bookings.nextForRoom(uow, room.roomId, at)).find(
      (other) => other.bookingRef !== booking.bookingRef,
    );
    if (next !== undefined && next.plannedCheckInAt.getTime() < booking.plannedCheckoutAt.getTime())
      return false;
    const conflicts = new ConflictRepository(uow);
    if ((await conflicts.openForRoom(room.roomId)).length > 0) return false;
    // An assignment this module recorded is a commitment of the room until
    // the booking module applies it.
    const assignments = await conflicts.assignedToRoom(room.roomId, now);
    return !assignments.some(
      (assignment) =>
        assignment.bookingRef !== booking.bookingRef &&
        assignment.plannedCheckInAt.getTime() < booking.plannedCheckoutAt.getTime(),
    );
  }

  private async requireEligible(
    uow: UnitOfWork,
    target: RoomState,
    conflict: ConflictRow,
    now: Date,
    category: 'same' | 'higher',
  ): Promise<void> {
    if (category === 'same' && target.categoryId !== conflict.categoryId) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'DIFFERENT_CATEGORY: a Reception assigns a room of the booked category',
      );
    }
    if (category === 'higher' && target.categoryId === conflict.categoryId) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'SAME_CATEGORY: a higher-category approval names a room of another category',
      );
    }
    const booking: NextBookingFacts = {
      bookingRef: conflict.bookingRef,
      categoryId: conflict.categoryId,
      assignedRoomId: conflict.roomId,
      plannedCheckInAt: conflict.plannedCheckInAt,
      plannedCheckoutAt: conflict.plannedCheckInAt,
      cleaningBufferMinutes: conflict.cleaningBufferMinutes,
    };
    if (!(await this.isEligible(uow, target, now, booking))) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'ROOM_NOT_ELIGIBLE: the room is not ready for the booking',
      );
    }
  }
}
