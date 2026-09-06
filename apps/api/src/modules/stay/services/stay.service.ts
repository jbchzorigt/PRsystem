import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { listRooms, readRoom } from '../../catalog/contracts/room-reads';
import type { DependencySource } from '../../catalog/contracts/dependency-sources';
import { probeSources } from '../../catalog/contracts/dependency-probe';
import { readyNotBefore, timeState, overdueMinutes } from '../domain/timing';
import type { CleaningState } from '../domain/readiness';
import { ConflictRepository } from '../repositories/conflict.repository';
import { CorrectionRepository } from '../repositories/correction.repository';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import type { StayRow } from '../repositories/stay.repository';
import { StayRepository } from '../repositories/stay.repository';
import { CleaningTaskService } from './cleaning-task.service';
import { HousekeepingService } from './housekeeping.service';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';
import type { StayView } from './stay-views';
import { effectiveActualCheckIn, loadStayView } from './stay-views';

/**
 * Reading a stay and the room board, and recording the actual checkout
 * (doc 05 §§4–5, §22.2, doc 06 §2; `RC-DEC-013`, `RC-DEC-015`,
 * `STAY-DEC-003`, `STAY-DEC-012`).
 *
 * The room board derives every axis on read — occupancy from the live stay,
 * the time state from the clock, cleaning from its row, the minibar from the
 * Phase 07 view — and stores none of it (doc 06 §1). An actual checkout
 * records an immutable `actual_checkout_at`, never touches the planned end,
 * creates no fee and no reprice, and hands the room to housekeeping, the
 * minibar's scheduled changes and the catalog's lifecycle in one transaction.
 */

const CHECKOUT_RECORD = 'hotel.stay.checkout_record';
const CHECK_IN = 'hotel.stay.check_in';
const BOARD_VIEW = [
  CHECK_IN,
  'hotel.tariff.snapshot_view',
  'hotel.tariff.snapshot_view.read',
  'hotel.catalog.lifecycle_view',
  'hotel.catalog.lifecycle_view.read',
];

/**
 * doc 02 §3.2, doc 05 §5: what still holds a checkout open once later phases
 * exist — the folio and its payment (Phase 10), the minibar usage report
 * (Phase 09). Probed like every other cross-phase dependency: absent is
 * evidence, present-and-open refuses, unreadable refuses.
 */
export const CHECKOUT_OBLIGATION_SOURCES: readonly DependencySource[] = [
  {
    id: 'stay.open_folio',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '10',
    relation: 'platform.stay_folio',
    column: 'stay_id',
    predicate: "state <> ALL (ARRAY['SETTLED', 'VOID'])",
    detail: 'the folio of this stay is not settled',
  },
  {
    id: 'stay.open_minibar_report',
    entityKinds: ['ROOM'],
    kind: 'operational',
    owningPhase: '09',
    relation: 'platform.minibar_usage_report',
    column: 'stay_id',
    predicate: "state <> ALL (ARRAY['SETTLED', 'CANCELLED'])",
    detail: 'the minibar usage report of this stay is not settled',
  },
];

export interface RoomCard {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly lifecycle: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly occupancy: 'VACANT' | 'CHECKED_IN' | 'CHECKOUT_IN_PROGRESS';
  readonly source: 'NOT_APPLICABLE' | 'WALK_IN' | 'ONLINE';
  readonly stayType: 'HOURLY' | 'NIGHTLY' | null;
  readonly stayId: string | null;
  readonly effectiveActualCheckInAt: string | null;
  readonly plannedCheckoutAt: string | null;
  readonly timeState: 'UPCOMING' | 'IN_PROGRESS' | 'ENDING_SOON' | 'OVERDUE' | null;
  readonly overdueMinutes: number;
  readonly readyNotBefore: string | null;
  readonly cleaningState: CleaningState | null;
  readonly minibarStatus: string;
  readonly minibarBlockers: readonly string[];
  readonly openConflicts: number;
  readonly pendingCorrection: boolean;
}

export class StayService extends StayServiceBase {
  private readonly housekeeping: HousekeepingService;
  private readonly cleaningTasks: CleaningTaskService;

  constructor(deps: StayDependencies) {
    super(deps);
    this.housekeeping = new HousekeepingService(deps);
    this.cleaningTasks = new CleaningTaskService(deps);
  }

  async view(
    target: { hotelId: string; stayId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<StayView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      BOARD_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const stay = await new StayRepository(uow).byId(target.stayId);
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return loadStayView(uow, stay, serverNow(this.deps, uow));
      },
    );
  }

  /** doc 06 §2–§3: every axis of every room, derived on read. */
  async board(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly RoomCard[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      BOARD_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const now = serverNow(this.deps, uow);
        const rooms = await listRooms(uow);
        const stays = new StayRepository(uow);
        const corrections = new CorrectionRepository(uow);
        const conflicts = new ConflictRepository(uow);
        const housekeeping = new HousekeepingRepository(uow);
        const live = new Map((await stays.liveStays()).map((stay) => [stay.roomId, stay]));
        const roomIds = rooms.map((room) => room.roomId);
        const previous = await stays.lastCompletedOfRooms(roomIds);
        const cleaning = await housekeeping.statesOf(roomIds);
        const approved = await corrections.latestApprovedOf(
          [...live.values()].map((s) => s.stayId),
        );
        const cards: RoomCard[] = [];
        for (const room of rooms) {
          const stay = live.get(room.roomId);
          const pin = await this.deps.minibar.checkInPin(uow, room.roomId);
          const open = await conflicts.openForRoom(room.roomId);
          const pending = stay === undefined ? undefined : await corrections.pendingOf(stay.stayId);
          const effective =
            stay === undefined ? null : effectiveActualCheckIn(stay, approved.get(stay.stayId));
          const last = previous.get(room.roomId);
          cards.push({
            roomId: room.roomId,
            roomNumber: room.roomNumber,
            categoryId: room.categoryId,
            categoryName: room.categoryName,
            lifecycle: room.state,
            occupancy:
              stay === undefined
                ? 'VACANT'
                : stay.state === 'CHECKOUT_IN_PROGRESS'
                  ? 'CHECKOUT_IN_PROGRESS'
                  : 'CHECKED_IN',
            source: stay?.source ?? 'NOT_APPLICABLE',
            stayType: stay?.stayType ?? null,
            stayId: stay?.stayId ?? null,
            effectiveActualCheckInAt: effective === null ? null : effective.toISOString(),
            plannedCheckoutAt: stay === undefined ? null : stay.plannedCheckoutAt.toISOString(),
            timeState:
              stay === undefined || effective === null
                ? null
                : timeState(now, effective, stay.plannedCheckoutAt),
            overdueMinutes: stay === undefined ? 0 : overdueMinutes(now, stay.plannedCheckoutAt),
            readyNotBefore:
              last?.actualCheckoutAt === null || last === undefined
                ? null
                : readyNotBefore(
                    last.actualCheckoutAt as Date,
                    last.cleaningBufferMinutes,
                  ).toISOString(),
            cleaningState: cleaning.get(room.roomId)?.state ?? null,
            minibarStatus: pin.configuration?.minibarStatus ?? 'NOT_APPLICABLE',
            minibarBlockers: pin.blockers,
            openConflicts: open.length,
            pendingCorrection: pending !== undefined,
          });
        }
        return cards;
      },
    );
  }

  /**
   * doc 05 §22.2, doc 02 §3.2: the actual checkout. Refused while a pending
   * correction blocks it (doc 05 §20.1) or while a later-phase obligation —
   * an unsettled folio, an open minibar report — holds it, as evidenced by
   * those relations once they exist. Records the immutable time, completes
   * the stay, marks the room for cleaning, tells the minibar a scheduled
   * change may proceed, tells the catalog a retiring room may finalize, and
   * closes an overdue conflict that the checkout resolves.
   */
  async recordActualCheckout(
    input: { hotelId: string; stayId: string; idempotencyKey: string; expectedRevision: number },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<StayView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHECKOUT_RECORD,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.checkout_record', input.idempotencyKey, {
          stayId: input.stayId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as StayView;
        const stays = new StayRepository(uow);
        const peek = await stays.byId(input.stayId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const room = await readRoom(uow, peek.roomId);
        const stay = await stays.lock(input.stayId);
        await authorize();
        if (stay === undefined || room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (stay.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        }
        if (stay.state === 'COMPLETED')
          throw new ApiError('CONFLICT', 'the stay is already completed');
        const pending = await new CorrectionRepository(uow).pendingOf(stay.stayId);
        if (pending !== undefined) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'CORRECTION_PENDING: decide the actual-time correction before the checkout',
          );
        }
        await this.refuseOpenObligations(uow, stay);
        // doc 08 §§8, 18–19: the unfinished food orders are re-read *here*,
        // under the stay's own lock, and not taken from the list the checkout
        // screen drew earlier. An unfinished order does not block the checkout;
        // one Reception has not yet recorded a handoff choice for does, and the
        // refusal names them so the desk knows what to acknowledge.
        const unacknowledged = await this.deps.restaurantOrders.unacknowledgedAtCheckout(
          uow,
          stay.stayId,
        );
        if (unacknowledged.length > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'RESTAURANT_ORDERS_UNACKNOWLEDGED: record a handoff choice for each unfinished order',
            unacknowledged.map((order) => ({
              field: 'orderId',
              issue: `${order.orderId} (${order.orderNo}) is ${order.fulfillmentState}`,
            })),
          );
        }

        const now = serverNow(this.deps, uow);
        const completed = await stays.transition({
          stayId: stay.stayId,
          expectedRevision: stay.revision,
          toState: 'COMPLETED',
          actualCheckoutAt: now,
          checkoutRecordedByAccountId: gate.principal.accountId,
        });
        if (completed === undefined)
          throw new ApiError('CONFLICT', 'the stay changed; reload and retry');
        await stays.appendEvent({
          stayId: stay.stayId,
          eventType: 'CHECKED_OUT',
          fromState: stay.state,
          toState: 'COMPLETED',
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: {
            actualCheckoutAt: now.toISOString(),
            plannedCheckoutAt: stay.plannedCheckoutAt.toISOString(),
            overdueMinutes: overdueMinutes(now, stay.plannedCheckoutAt),
            readyNotBefore: readyNotBefore(now, stay.cleaningBufferMinutes).toISOString(),
          },
        });
        // doc 11 §8: the booking this stay fulfilled is completed in the same
        // transaction, which is what makes its retained room charge eligible
        // for the `D+1` payout — a checkout recorded without it would leave the
        // hotel unpaid for a stay it has already provided.
        await this.deps.bookingFulfilment.completeAtCheckout(uow, {
          stayId: stay.stayId,
          actorRef: gate.principal.accountId,
        });
        // doc 02 §3.2: the room needs cleaning; the minibar and the catalog learn
        // the stay ended, in this transaction.
        await this.housekeeping.markNeedsCleaning(uow, stay.roomId, stay.stayId, now);
        // doc 04 §5.2 (11): the room's cleaning work becomes a task a Cleaner
        // can claim, in this same transaction.
        const cleaningTaskId = await this.cleaningTasks.openForCheckout(
          uow,
          stay.roomId,
          stay.stayId,
          now,
        );
        // doc 08 §7 and §17: the stay's access dies with the stay, in this
        // transaction, so the next occupant of the room inherits neither a live
        // session nor a code that still works. Nothing about the orders
        // themselves moves — a checkout cancels nothing and refunds nothing.
        // `GUEST-DEC-008`: the retention countdown starts here, with the policy
        // version and the day count snapshotted — doc 12 §9 says an active stay
        // has no deadline, and a completed one always has one.
        await this.deps.retention.recordCheckout(uow, {
          hotelId: input.hotelId,
          stayId: stay.stayId,
          checkoutAt: now,
        });
        await this.deps.restaurantOrders.closeGuestAccess(uow, stay.stayId, now);
        await this.deps.minibar.advanceScheduled(uow, stay.roomId, 'stay.checked_out');
        await this.deps.lifecycle.finalizeIfClear(uow, 'ROOM', stay.roomId, {
          source: 'stay.checkout_record',
          actorAccountId: gate.principal.accountId,
        });
        await this.resolveConflictsReady(uow, stay, now);
        await recordPlatformAudit(uow, {
          action: 'stay.checkout_record',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: stay.stayId,
          payload: {
            roomId: stay.roomId,
            actualCheckoutAt: now.toISOString(),
            cleaningTaskId,
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'stay',
          aggregateId: stay.stayId,
          eventType: 'stay.checked_out',
          payload: {
            stayId: stay.stayId,
            roomId: stay.roomId,
            actualCheckoutAt: now.toISOString(),
            plannedCheckoutAt: stay.plannedCheckoutAt.toISOString(),
            readyNotBefore: readyNotBefore(now, stay.cleaningBufferMinutes).toISOString(),
          },
        });
        const result = await loadStayView(uow, completed, now);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * What the billing module needs to know about a stay, from the module that
   * owns it (CLAUDE.md §3): the room it is in, where the booking came from —
   * which decides whether a deposit is owed at all (`RC-DEC-003`) — the room
   * charge its confirmation snapshotted, and whether it is still live.
   */
  async billingFacts(
    uow: UnitOfWork,
    stayId: string,
  ): Promise<
    | {
        readonly stayId: string;
        readonly roomId: string;
        readonly categoryId: string;
        readonly source: StayRow['source'];
        readonly state: StayRow['state'];
        readonly roomChargeMnt: bigint;
        readonly minibarApplicable: boolean;
      }
    | undefined
  > {
    const stay = await new StayRepository(uow).byId(stayId);
    if (stay === undefined) return undefined;
    return {
      stayId: stay.stayId,
      roomId: stay.roomId,
      categoryId: stay.categoryId,
      source: stay.source,
      state: stay.state,
      roomChargeMnt: stay.roomChargeMnt,
      minibarApplicable: stay.minibarApplicable,
    };
  }

  private async refuseOpenObligations(uow: UnitOfWork, stay: StayRow): Promise<void> {
    const evidence = await probeSources(uow, CHECKOUT_OBLIGATION_SOURCES, stay.stayId);
    const unavailable = evidence.filter((entry) => entry.state === 'unavailable');
    if (unavailable.length > 0) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'DEPENDENCY_UNAVAILABLE: a checkout obligation could not be read',
        unavailable.map((entry) => ({ field: entry.sourceId, issue: 'unavailable' })),
      );
    }
    const blocked = evidence.filter((entry) => entry.state === 'blocked');
    if (blocked.length > 0) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'CHECKOUT_OBLIGATION_OPEN: the stay has an unsettled obligation',
        blocked.map((entry) => ({ field: entry.sourceId, issue: entry.detail ?? entry.sourceId })),
      );
    }
  }

  /**
   * doc 05 §23.2 (1): a conflict on this room resolves `RESOLVED_READY` when
   * the checkout leaves the room ready — buffer passed — before the booking's
   * planned check-in. Cleaning and minibar readiness are checked by the
   * check-in itself; the anchor is what this checkout decides.
   */
  private async resolveConflictsReady(uow: UnitOfWork, stay: StayRow, now: Date): Promise<void> {
    const conflicts = new ConflictRepository(uow);
    for (const conflict of await conflicts.openForRoom(stay.roomId)) {
      const ready = readyNotBefore(now, stay.cleaningBufferMinutes);
      if (ready.getTime() > conflict.plannedCheckInAt.getTime()) continue;
      const locked = await conflicts.lock(conflict.conflictId);
      if (locked === undefined || locked.state !== 'OPEN') continue;
      await conflicts.resolve({
        conflictId: locked.conflictId,
        expectedRevision: locked.revision,
        state: 'RESOLVED_READY',
        assignedRoomId: null,
        resolvedByAccountId: null,
        resolvedAt: now,
        reason: null,
        selfApproved: false,
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'booking_fulfillment_conflict',
        aggregateId: locked.conflictId,
        eventType: 'stay.conflict.resolved',
        payload: {
          conflictId: locked.conflictId,
          bookingRef: locked.bookingRef,
          state: 'RESOLVED_READY',
        },
      });
    }
  }
}
