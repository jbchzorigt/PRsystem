import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { appendOutboxEvent } from '@prsystem/db';
import type { ShiftReviewState, ShiftRow, ShiftState } from '../repositories/shift.repository';
import { ShiftRepository } from '../repositories/shift.repository';
import { rejectionOutcome, reviewAfterClose } from '../domain/shift';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow, sqlState } from './stay-context';

/**
 * The Reception shift (doc 03; doc 05 §19.1; doc 18 §3).
 *
 * Phase 08 wrote the bound a check-in needs — who opened the shift and when.
 * Phase 11 makes it the unit of cash accountability doc 03 describes: the
 * drawer it is opened over, the amount actually counted at the opening, the
 * count and variance at the close, the handover the incoming Reception
 * accepts, and the financial review that runs beside all of it without
 * blocking the next shift (`SHIFT-DEC-001`).
 *
 * The ledger arithmetic lives in the finance module, behind `CashLedgerPort`:
 * this service never selects from `platform.cash_movement` (CLAUDE.md §3).
 */

const OPEN_CLOSE = 'hotel.shift.open_close_handover';
const COUNT = 'hotel.cash.count';
const FINANCIAL_REVIEW = 'hotel.shift.financial_review';
const VARIANCE_REVIEW = 'hotel.shift.variance_self_close_review';

export interface ShiftView {
  readonly shiftId: string;
  readonly state: ShiftState;
  readonly openedByAccountId: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly locationId: string | null;
  readonly openingBalanceMnt: string | null;
  readonly expectedCashMnt: string | null;
  readonly countedCashMnt: string | null;
  readonly varianceMnt: string | null;
  readonly incomingCountedMnt: string | null;
  readonly handedToAccountId: string | null;
  readonly reviewState: ShiftReviewState;
  readonly selfReviewed: boolean;
  readonly revision: number;
}

const money = (value: bigint | null): string | null => (value === null ? null : value.toString());

export function shiftView(row: ShiftRow): ShiftView {
  return {
    shiftId: row.shiftId,
    state: row.state,
    openedByAccountId: row.openedByAccountId,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    locationId: row.locationId,
    openingBalanceMnt: money(row.openingBalanceMnt),
    expectedCashMnt: money(row.expectedCashMnt),
    countedCashMnt: money(row.countedCashMnt),
    varianceMnt: money(row.varianceMnt),
    incomingCountedMnt: money(row.incomingCountedMnt),
    handedToAccountId: row.handedToAccountId,
    reviewState: row.reviewState,
    selfReviewed: row.selfReviewed,
    revision: row.revision,
  };
}

/** The open shift a command needs, share-locked so it cannot close underneath it. */
export async function requireOpenShift(uow: UnitOfWork): Promise<ShiftRow> {
  const shift = await new ShiftRepository(uow).shareOpen();
  if (shift === undefined) {
    throw new ApiError('PRECONDITION_FAILED', 'NO_OPEN_SHIFT: open a Reception shift first');
  }
  return shift;
}

function requireAmount(value: bigint, what: string): bigint {
  if (value < 0n) throw new ApiError('VALIDATION_FAILED', `${what} is never negative`);
  return value;
}

function requireReason(reason: string | undefined, what: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', `${what} requires a reason (SHIFT-DEC-007)`);
  }
  if (trimmed.length > 300) throw new ApiError('VALIDATION_FAILED', 'the reason is too long');
  return trimmed;
}

export interface ReviewInput {
  readonly hotelId: string;
  readonly shiftId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly decision: 'ACCEPT' | 'REJECT';
  readonly reason?: string;
}

export class ShiftService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  // --------------------------------------------------------------- opening

  /**
   * doc 03 §4.1: a shift opens over one drawer, with the amount the Reception
   * actually counted in it. Two Receptions opening on the same drawer meet the
   * partial unique index, not a service check (`CASH-DEC-001`).
   */
  async open(
    input: {
      hotelId: string;
      idempotencyKey: string;
      locationId?: string;
      openingCountedMnt: bigint;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OPEN_CLOSE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_open', input.idempotencyKey, {
          locationId: input.locationId ?? null,
          openingCountedMnt: input.openingCountedMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        await authorize();
        const opening = requireAmount(input.openingCountedMnt, 'an opening count');
        const at = serverNow(this.deps, uow);
        const locationId = await this.deps.cash.drawerForOpening(uow, input.locationId);
        if (locationId === undefined) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'NO_CASH_DRAWER: the hotel has no active cash drawer to open a shift over',
          );
        }
        const shifts = new ShiftRepository(uow);
        let row: ShiftRow;
        try {
          row = await shifts.open({
            openedByAccountId: gate.principal.accountId,
            at,
            locationId,
            openingBalanceMnt: opening,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'SHIFT_ALREADY_OPEN: the drawer or the account already has an active shift',
            );
          }
          throw error;
        }
        // doc 24 §3: the drawer's ledger starts once, at the count that opened it.
        await this.deps.cash.seedInitialFloat(uow, {
          locationId,
          amountMnt: opening,
          accountId: gate.principal.accountId,
          at,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.shift.open',
          outcome: 'allowed',
          targetType: 'reception_shift',
          targetRef: row.shiftId,
          payload: { locationId, openingBalanceMnt: opening.toString() },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'reception_shift',
          aggregateId: row.shiftId,
          eventType: 'stay.shift.opened',
          payload: {
            shiftId: row.shiftId,
            locationId,
            openedAt: row.openedAt.toISOString(),
            openingBalanceMnt: opening.toString(),
          },
        });
        const result = shiftView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  // --------------------------------------------------------------- closing

  /**
   * The shift as it is, locked, with the actor confirmed as the Reception
   * working it.
   *
   * The row is locked first and the permission evaluated on it, before any
   * refusal: an actor who does not hold the action is told nothing about
   * whether the shift exists or who is working it (CLAUDE.md §4).
   */
  private async lockOwnShift(
    uow: UnitOfWork,
    shiftId: string,
    expectedRevision: number,
    accountId: string,
    holder: 'OPENER' | 'RECIPIENT',
    authorize: () => Promise<void>,
  ): Promise<ShiftRow> {
    const locked = await new ShiftRepository(uow).lock(shiftId);
    await authorize();
    if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
    if (locked.revision !== expectedRevision) {
      throw new ApiError('CONFLICT', 'the shift changed; reload and retry');
    }
    const owner = holder === 'OPENER' ? locked.openedByAccountId : locked.handedToAccountId;
    if (owner !== accountId) {
      throw new ApiError(
        'FORBIDDEN',
        holder === 'OPENER'
          ? 'only the Reception working the shift can count it'
          : 'only the Reception the shift was handed to can act on it',
      );
    }
    return locked;
  }

  /**
   * doc 03 §4.6: the Reception counts the drawer and the shift moves to
   * `CLOSING`. The expectation is the ledger's, never the client's, and a
   * transfer still outstanding refuses the count (`CASH-DEC-006`).
   */
  async startClose(
    input: {
      hotelId: string;
      shiftId: string;
      idempotencyKey: string;
      expectedRevision: number;
      countedCashMnt: bigint;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      COUNT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_count', input.idempotencyKey, {
          shiftId: input.shiftId,
          countedCashMnt: input.countedCashMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const locked = await this.lockOwnShift(
          uow,
          input.shiftId,
          input.expectedRevision,
          gate.principal.accountId,
          'OPENER',
          authorize,
        );
        if (locked.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'the shift is no longer taking a first count');
        }
        const counted = requireAmount(input.countedCashMnt, 'a counted amount');
        const summary = await this.summarize(uow, locked);
        if (summary.pendingTransferCount > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'PENDING_TRANSFER: confirm or cancel the outstanding transfer before closing (CASH-DEC-006)',
          );
        }
        const variance = counted - summary.expectedCashMnt;
        const moved = await new ShiftRepository(uow).transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['OPEN'],
          to: 'CLOSING',
          expectedCashMnt: summary.expectedCashMnt,
          countedCashMnt: counted,
          varianceMnt: variance,
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.count',
          'stay.shift.counted',
          {
            expectedCashMnt: summary.expectedCashMnt.toString(),
            countedCashMnt: counted.toString(),
            varianceMnt: variance.toString(),
          },
        );
      },
    );
  }

  /** doc 03 §4.7: the counted drawer is handed to the incoming Reception. */
  async handOver(
    input: {
      hotelId: string;
      shiftId: string;
      idempotencyKey: string;
      expectedRevision: number;
      toAccountId: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OPEN_CLOSE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_handover', input.idempotencyKey, {
          shiftId: input.shiftId,
          toAccountId: input.toAccountId,
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const locked = await this.lockOwnShift(
          uow,
          input.shiftId,
          input.expectedRevision,
          gate.principal.accountId,
          'OPENER',
          authorize,
        );
        if (locked.state !== 'CLOSING') {
          throw new ApiError('CONFLICT', 'count the drawer before handing it over');
        }
        if (input.toAccountId === locked.openedByAccountId) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'a handover goes to another Reception; close the shift yourself instead',
          );
        }
        const moved = await new ShiftRepository(uow).transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['CLOSING'],
          to: 'HANDED_OVER',
          handedToAccountId: input.toAccountId,
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.hand_over',
          'stay.shift.handed_over',
          {
            toAccountId: input.toAccountId,
          },
        );
      },
    );
  }

  /**
   * doc 03 §4.8 and `SHIFT-DEC-007`: the incoming Reception disagrees with the
   * count, with a reason. The shift has not closed, so this is a recount rather
   * than a dispute.
   */
  async requestRecount(
    input: {
      hotelId: string;
      shiftId: string;
      idempotencyKey: string;
      expectedRevision: number;
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      COUNT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_recount', input.idempotencyKey, {
          shiftId: input.shiftId,
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const locked = await this.lockOwnShift(
          uow,
          input.shiftId,
          input.expectedRevision,
          gate.principal.accountId,
          'RECIPIENT',
          authorize,
        );
        if (locked.state !== 'HANDED_OVER') {
          throw new ApiError('CONFLICT', 'the shift is not waiting to be accepted');
        }
        const reason = requireReason(input.reason, 'a recount');
        const moved = await new ShiftRepository(uow).transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['HANDED_OVER'],
          to: 'RECOUNT_REQUIRED',
          reviewReason: reason,
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.recount_required',
          'stay.shift.recount_required',
          {
            reason,
          },
        );
      },
    );
  }

  /**
   * doc 03 §4.9 and `SHIFT-DEC-002`: the incoming Reception counts what it
   * receives. That amount, not the outgoing count, is what the next shift opens
   * with.
   */
  async acceptCash(
    input: {
      hotelId: string;
      shiftId: string;
      idempotencyKey: string;
      expectedRevision: number;
      incomingCountedMnt: bigint;
      reason?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      COUNT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_accept', input.idempotencyKey, {
          shiftId: input.shiftId,
          incomingCountedMnt: input.incomingCountedMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const locked = await this.lockOwnShift(
          uow,
          input.shiftId,
          input.expectedRevision,
          gate.principal.accountId,
          'RECIPIENT',
          authorize,
        );
        if (locked.state !== 'HANDED_OVER' && locked.state !== 'RECOUNT_REQUIRED') {
          throw new ApiError('CONFLICT', 'the shift is not waiting to be accepted');
        }
        const counted = requireAmount(input.incomingCountedMnt, 'a counted amount');
        // `SHIFT-DEC-007`: accepting a different amount than was handed over is
        // a disagreement on the record, so it carries a reason.
        const differs = locked.countedCashMnt !== null && locked.countedCashMnt !== counted;
        const reason = differs ? requireReason(input.reason, 'accepting a different count') : null;
        const moved = await new ShiftRepository(uow).transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['HANDED_OVER', 'RECOUNT_REQUIRED'],
          to: 'CASH_ACCEPTED',
          incomingCountedMnt: counted,
          ...(reason === null ? {} : { reviewReason: reason }),
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.cash_accepted',
          'stay.shift.cash_accepted',
          {
            incomingCountedMnt: counted.toString(),
          },
        );
      },
    );
  }

  /**
   * doc 03 §4.10: the accepted shift closes, and the financial review it needs
   * starts beside it — a pending review never blocks the next shift
   * (`SHIFT-DEC-001`).
   */
  async close(
    input: { hotelId: string; shiftId: string; idempotencyKey: string; expectedRevision: number },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OPEN_CLOSE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_close', input.idempotencyKey, {
          shiftId: input.shiftId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const shifts = new ShiftRepository(uow);
        const locked = await shifts.lock(input.shiftId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (locked.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the shift changed; reload and retry');
        }
        if (locked.state === 'CLOSED' || locked.state === 'SELF_CLOSED') {
          throw new ApiError('CONFLICT', 'the shift is already closed');
        }
        if (locked.state !== 'CASH_ACCEPTED') {
          throw new ApiError(
            'CONFLICT',
            'the incoming Reception has not accepted the cash yet (doc 03 §4.9)',
          );
        }
        const review = this.reviewAfterHandover(locked);
        const moved = await shifts.transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['CASH_ACCEPTED'],
          to: 'CLOSED',
          reviewState: review,
          closedByAccountId: gate.principal.accountId,
          closedAt: serverNow(this.deps, uow),
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.close',
          'stay.shift.closed',
          {
            reviewState: review,
          },
        );
      },
    );
  }

  /**
   * `SHIFT-DEC-003`: a Reception with nobody to hand to closes its own shift on
   * its own count. That is operationally terminal: with no variance it needs no
   * review at all, and with one it waits for a Hotel Admin while the next shift
   * starts regardless.
   */
  async selfClose(
    input: {
      hotelId: string;
      shiftId: string;
      idempotencyKey: string;
      expectedRevision: number;
      countedCashMnt: bigint;
      reason?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OPEN_CLOSE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_self_close', input.idempotencyKey, {
          shiftId: input.shiftId,
          countedCashMnt: input.countedCashMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const locked = await this.lockOwnShift(
          uow,
          input.shiftId,
          input.expectedRevision,
          gate.principal.accountId,
          'OPENER',
          authorize,
        );
        if (locked.state !== 'OPEN' && locked.state !== 'CLOSING') {
          throw new ApiError('CONFLICT', 'the shift is no longer the Reception’s to close');
        }
        const counted = requireAmount(input.countedCashMnt, 'a counted amount');
        const summary = await this.summarize(uow, locked);
        if (summary.pendingTransferCount > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'PENDING_TRANSFER: confirm or cancel the outstanding transfer before closing (CASH-DEC-006)',
          );
        }
        const variance = counted - summary.expectedCashMnt;
        const review = reviewAfterClose({
          selfClose: true,
          varianceMnt: variance,
          reviewerIsTheReception: true,
        });
        const reason = variance === 0n ? undefined : requireReason(input.reason, 'a variance');
        const moved = await new ShiftRepository(uow).transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: ['OPEN', 'CLOSING'],
          to: 'SELF_CLOSED',
          expectedCashMnt: summary.expectedCashMnt,
          countedCashMnt: counted,
          varianceMnt: variance,
          reviewState: review,
          closedByAccountId: gate.principal.accountId,
          closedAt: serverNow(this.deps, uow),
          ...(reason === undefined ? {} : { closeReason: reason }),
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.self_close',
          'stay.shift.self_closed',
          {
            expectedCashMnt: summary.expectedCashMnt.toString(),
            countedCashMnt: counted.toString(),
            varianceMnt: variance.toString(),
            reviewState: review,
          },
        );
      },
    );
  }

  // ---------------------------------------------------------------- review

  /**
   * doc 03 §6.2: the ordinary financial review of a handover close. It belongs
   * to a Manager, and only while the shift is actually waiting for one; a
   * Manager who worked the shift itself cannot be its reviewer, which is what
   * `SHIFT-DEC-004`'s Hotel Admin fallback is for.
   */
  async review(
    input: ReviewInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.applyReview(input, actor, request, FINANCIAL_REVIEW, 'MANAGER');
  }

  /**
   * `SHIFT-DEC-004`: the Hotel Admin's review — the self-close variance, the
   * dispute, and the small hotel where the only reviewer is the person who
   * worked the shift. Reviewing one's own shift is allowed here and recorded as
   * `self_reviewed` (`SHIFT-DEC-007`).
   */
  async adminReview(
    input: ReviewInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.applyReview(input, actor, request, VARIANCE_REVIEW, 'HOTEL_ADMIN');
  }

  private async applyReview(
    input: ReviewInput,
    actor: CommandActor,
    request: RequestContext,
    permission: string,
    reviewer: 'MANAGER' | 'HOTEL_ADMIN',
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      permission,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_review', input.idempotencyKey, {
          shiftId: input.shiftId,
          decision: input.decision,
        });
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        const shifts = new ShiftRepository(uow);
        const locked = await shifts.lock(input.shiftId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (locked.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the shift changed; reload and retry');
        }
        if (locked.reviewState === 'NOT_REQUIRED' || locked.reviewState === 'RESOLVED') {
          throw new ApiError('CONFLICT', 'the shift needs no further review');
        }
        const selfReviewed =
          gate.principal.accountId === locked.openedByAccountId ||
          gate.principal.accountId === locked.handedToAccountId;
        if (reviewer === 'MANAGER') {
          if (locked.reviewState !== 'PENDING_MANAGER') {
            throw new ApiError(
              'CONFLICT',
              'this review belongs to the Hotel Admin (SHIFT-DEC-003, -004)',
            );
          }
          if (selfReviewed) {
            throw new ApiError(
              'FORBIDDEN',
              'a shift is not reviewed by the account that worked it; the Hotel Admin reviews it (SHIFT-DEC-004)',
            );
          }
        }
        const closed = locked.state === 'CLOSED' || locked.state === 'SELF_CLOSED';
        const laterStarted =
          locked.locationId === null
            ? false
            : await shifts.laterShiftStarted(locked.locationId, locked.openedAt);
        let reviewState: ShiftReviewState;
        let reason: string | undefined;
        if (input.decision === 'ACCEPT') {
          reviewState = 'RESOLVED';
          reason =
            locked.varianceMnt !== null && locked.varianceMnt !== 0n
              ? requireReason(input.reason, 'approving a variance')
              : undefined;
        } else {
          // `SHIFT-DEC-005`: a closed shift is never reopened by a rejection.
          reviewState =
            rejectionOutcome(closed || laterStarted) === 'DISPUTED'
              ? 'DISPUTED'
              : 'PENDING_MANAGER';
          reason = requireReason(input.reason, 'a rejection');
        }
        const moved = await shifts.transition({
          shiftId: locked.shiftId,
          expectedRevision: locked.revision,
          from: [locked.state],
          to: locked.state,
          reviewState,
          reviewedByAccountId: gate.principal.accountId,
          reviewedAt: serverNow(this.deps, uow),
          ...(selfReviewed ? { selfReviewed: true } : {}),
          ...(reason === undefined ? {} : { reviewReason: reason }),
        });
        return this.finish(
          uow,
          claimed.idempotencyId,
          moved,
          'stay.shift.review',
          'stay.shift.reviewed',
          { decision: input.decision, reviewState, selfReviewed },
        );
      },
    );
  }

  // ----------------------------------------------------------------- reads

  async current(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView | null> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      [OPEN_CLOSE, 'hotel.shift.own_operational_view'],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const shift = await new ShiftRepository(uow).currentOpen();
        return shift === undefined ? null : shiftView(shift);
      },
    );
  }

  async byId(
    target: { hotelId: string; shiftId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      [OPEN_CLOSE, 'hotel.shift.own_operational_view', FINANCIAL_REVIEW],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const shift = await new ShiftRepository(uow).byId(target.shiftId);
        if (shift === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return shiftView(shift);
      },
    );
  }

  // --------------------------------------------------------------- helpers

  private async summarize(
    uow: UnitOfWork,
    shift: ShiftRow,
  ): Promise<{ expectedCashMnt: bigint; pendingTransferCount: number }> {
    return this.deps.cash.summarizeShift(uow, {
      shiftId: shift.shiftId,
      openingBalanceMnt: shift.openingBalanceMnt ?? 0n,
    });
  }

  private reviewAfterHandover(shift: ShiftRow): ShiftReviewState {
    return reviewAfterClose({
      selfClose: false,
      varianceMnt: shift.varianceMnt ?? 0n,
      reviewerIsTheReception: shift.handedToAccountId === shift.openedByAccountId,
    });
  }

  private async finish(
    uow: UnitOfWork,
    idempotencyId: string,
    moved: ShiftRow | undefined,
    action: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<ShiftView> {
    if (moved === undefined) throw new ApiError('CONFLICT', 'the shift changed; reload and retry');
    await recordPlatformAudit(uow, {
      action,
      outcome: 'allowed',
      targetType: 'reception_shift',
      targetRef: moved.shiftId,
      payload,
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'reception_shift',
      aggregateId: moved.shiftId,
      eventType,
      payload: { shiftId: moved.shiftId, state: moved.state, ...payload },
    });
    const result = shiftView(moved);
    await completeIdempotencyKey(uow, idempotencyId, 200, result);
    return result;
  }
}
