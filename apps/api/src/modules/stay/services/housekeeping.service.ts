import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { shareRoom } from '../../catalog/contracts/room-reads';
import type { CleaningState } from '../domain/readiness';
import { canTransitionCleaning } from '../domain/readiness';
import type { CleaningStateRow } from '../repositories/housekeeping.repository';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';

/**
 * The cleaning axis of a room (doc 06 §4, doc 04 §6, `STAY-DEC-008`,
 * `RC-DEC-014`): the Cleaner on 25,000₮ / 30,000₮ walks
 * `Цэвэрлэгээ шаардлагатай → Цэвэрлэж байгаа → Цэвэр`; the Manager of a
 * 20,000₮ hotel, which has no Cleaner, marks `Цэвэр` directly. Reception only
 * reads. Every transition is an append-only event with the server's time, and
 * that history is what a backdated check-in proves readiness from.
 *
 * The queue, the assigned task and the dashboard of doc 04 are Phase 09's;
 * this is the state they will drive.
 */

const CLEANER_ACTION = 'hotel.housekeeping.cleaning_status_p2530';
const MANAGER_P20_ACTION = 'hotel.housekeeping.cleaning_status_p20';

export interface CleaningView {
  readonly roomId: string;
  readonly state: CleaningState | null;
  readonly changedAt: string | null;
  readonly revision: number;
}

export function cleaningView(roomId: string, row: CleaningStateRow | undefined): CleaningView {
  return {
    roomId,
    state: row?.state ?? null,
    changedAt: row === undefined ? null : row.changedAt.toISOString(),
    revision: row?.revision ?? 0,
  };
}

export interface SetCleaningInput {
  readonly hotelId: string;
  readonly roomId: string;
  readonly idempotencyKey: string;
  readonly toState: Exclude<CleaningState, 'NEEDS_CLEANING'>;
  readonly expectedRevision: number;
}

export class HousekeepingService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /**
   * The actor's package decides which named action applies and which edges
   * are open: the two rows of doc 18 §3 are distinct permissions, so a
   * Manager on 25,000₮ holds neither and is refused as `NOT_FOUND`.
   */
  async setState(
    input: SetCleaningInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CleaningView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CLEANER_ACTION, MANAGER_P20_ACTION],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.cleaning_set', input.idempotencyKey, {
          roomId: input.roomId,
          toState: input.toState,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as CleaningView;
        const housekeeping = new HousekeepingRepository(uow);
        const room = await shareRoom(uow, input.roomId);
        const current = await housekeeping.lockState(input.roomId);
        await authorize();
        if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the cleaning state changed; reload and retry');
        }
        // Which edge set applies is a fact of the package, not of the role:
        // a Cleaner exists only on 25,000₮ / 30,000₮ (doc 04 §11).
        const roles = gate.membership.roles;
        const by = roles.includes('CLEANER') ? 'CLEANER' : 'MANAGER_P20';
        if (!canTransitionCleaning(current?.state ?? null, input.toState, by)) {
          throw new ApiError(
            'CONFLICT',
            `ILLEGAL_CLEANING_TRANSITION: ${current?.state ?? 'none'} -> ${input.toState}`,
          );
        }
        const at = serverNow(this.deps, uow);
        const written = await housekeeping.transition({
          roomId: input.roomId,
          from: current?.state ?? null,
          to: input.toState,
          actorAccountId: gate.principal.accountId,
          at,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.cleaning.set',
          outcome: 'allowed',
          targetType: 'room',
          targetRef: input.roomId,
          payload: { fromState: current?.state ?? null, toState: input.toState },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room',
          aggregateId: input.roomId,
          eventType: 'stay.cleaning.changed',
          payload: {
            roomId: input.roomId,
            fromState: current?.state ?? null,
            toState: input.toState,
            at: at.toISOString(),
          },
        });
        const result = cleaningView(input.roomId, written);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The system's own transition: a completed checkout puts the room back to
   * `Цэвэрлэгээ шаардлагатай` in the checkout's transaction (doc 02 §3.2).
   */
  async markNeedsCleaning(
    uow: UnitOfWork,
    roomId: string,
    stayId: string,
    at: Date,
  ): Promise<void> {
    const housekeeping = new HousekeepingRepository(uow);
    const current = await housekeeping.lockState(roomId);
    if (current?.state === 'NEEDS_CLEANING') return;
    await housekeeping.transition({
      roomId,
      from: current?.state ?? null,
      to: 'NEEDS_CLEANING',
      actorAccountId: null,
      stayId,
      at,
    });
  }

  async view(
    target: { hotelId: string; roomId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<
    CleaningView & { readonly history: readonly { toState: string; occurredAt: string }[] }
  > {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      [CLEANER_ACTION, MANAGER_P20_ACTION, 'hotel.stay.check_in', 'hotel.stay.check_in.read'],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const housekeeping = new HousekeepingRepository(uow);
        const state = await housekeeping.state(target.roomId);
        const history = await housekeeping.history(target.roomId);
        return {
          ...cleaningView(target.roomId, state),
          history: history.map((event) => ({
            toState: event.toState,
            occurredAt: event.occurredAt.toISOString(),
          })),
        };
      },
    );
  }
}
