import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { appendOutboxEvent } from '@prsystem/db';
import type { ShiftRow } from '../repositories/shift.repository';
import { ShiftRepository } from '../repositories/shift.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow, sqlState } from './stay-context';

/**
 * The operational Reception shift (doc 05 §19.1; doc 18 §3
 * `hotel.shift.open_close_handover`).
 *
 * Minimal on purpose: open, close, and "which shift is open now" — the fact a
 * check-in needs. The cash count, handover and financial review of doc 03 are
 * Phase 11's and extend this row rather than replacing it.
 */

const OPEN_CLOSE = 'hotel.shift.open_close_handover';

export interface ShiftView {
  readonly shiftId: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly openedByAccountId: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly revision: number;
}

export function shiftView(row: ShiftRow): ShiftView {
  return {
    shiftId: row.shiftId,
    state: row.state,
    openedByAccountId: row.openedByAccountId,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
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

export class ShiftService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  async open(
    input: { hotelId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ShiftView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      OPEN_CLOSE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.shift_open', input.idempotencyKey, {});
        if (claimed.kind === 'replay') return claimed.body as ShiftView;
        await authorize();
        const shifts = new ShiftRepository(uow);
        let row: ShiftRow;
        try {
          row = await shifts.open(gate.principal.accountId, serverNow(this.deps, uow));
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'SHIFT_ALREADY_OPEN: the hotel already has an open shift',
            );
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'stay.shift.open',
          outcome: 'allowed',
          targetType: 'reception_shift',
          targetRef: row.shiftId,
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'reception_shift',
          aggregateId: row.shiftId,
          eventType: 'stay.shift.opened',
          payload: { shiftId: row.shiftId, openedAt: row.openedAt.toISOString() },
        });
        const result = shiftView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

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
        if (locked.state !== 'OPEN') throw new ApiError('CONFLICT', 'the shift is already closed');
        const closed = await shifts.close(
          locked.shiftId,
          locked.revision,
          gate.principal.accountId,
          serverNow(this.deps, uow),
        );
        if (closed === undefined)
          throw new ApiError('CONFLICT', 'the shift changed; reload and retry');
        await recordPlatformAudit(uow, {
          action: 'stay.shift.close',
          outcome: 'allowed',
          targetType: 'reception_shift',
          targetRef: closed.shiftId,
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'reception_shift',
          aggregateId: closed.shiftId,
          eventType: 'stay.shift.closed',
          payload: { shiftId: closed.shiftId, closedAt: closed.closedAt?.toISOString() ?? null },
        });
        const result = shiftView(closed);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

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
}
