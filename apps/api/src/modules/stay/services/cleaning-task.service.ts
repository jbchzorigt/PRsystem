import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { canTransitionCleaning } from '../domain/readiness';
import { CleaningTaskRepository } from '../repositories/cleaning-task.repository';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';
import type { CleaningTaskView } from './checkout-views';
import { cleaningTaskView } from './checkout-views';

/**
 * The Cleaner's cleaning queue (doc 04 §3 (3), §5.2 (11)–(14), §8).
 *
 * A completed checkout puts the room back to `Цэвэрлэгээ шаардлагатай` and
 * leaves one task behind. A Cleaner claims it — one statement, so a second
 * Cleaner is refused rather than sharing it — and the claim is what moves the
 * cleaning axis to `Цэвэрлэж байгаа`. Completing it records the routine refill
 * of the room's current configuration and marks the room `Цэвэр`.
 *
 * The refill is refused while a configuration change is pending: the old
 * version's targets are exactly what must not be topped up then, because the
 * room is waiting for a reconciliation against a different version
 * (doc 04 §5.2 (12), §5.3).
 */

const CLAIM = 'hotel.housekeeping.task_claim';
const CLEANER_ACTION = 'hotel.housekeeping.cleaning_status_p2530';

export interface CleaningTaskInput {
  readonly hotelId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface CompleteCleaningInput extends CleaningTaskInput {
  /** What the Cleaner actually put back in the room, per product. */
  readonly refilled: readonly { readonly productId: string; readonly quantity: number }[];
}

export class CleaningTaskService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /** doc 02 §3.2: the checkout leaves the task behind, in its own transaction. */
  async openForCheckout(
    uow: UnitOfWork,
    roomId: string,
    stayId: string,
    at: Date,
  ): Promise<string> {
    const tasks = new CleaningTaskRepository(uow);
    const { task } = await tasks.open({ roomId, stayId, openedAt: at });
    return task.taskId;
  }

  async queue(
    input: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly CleaningTaskView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CLAIM, CLEANER_ACTION],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        return (await new CleaningTaskRepository(uow).queue()).map(cleaningTaskView);
      },
    );
  }

  /** doc 04 §8: two Cleaners, one task, one winner. */
  async claimTask(
    input: CleaningTaskInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CleaningTaskView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CLAIM,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.cleaning_task_claim', input.idempotencyKey, {
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as CleaningTaskView;
        const tasks = new CleaningTaskRepository(uow);
        const peek = await tasks.byId(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        await authorize();
        const now = serverNow(this.deps, uow);
        const taken = await tasks.claim({
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          accountId: gate.principal.accountId,
          at: now,
        });
        if (taken === undefined) {
          throw new ApiError('CONFLICT', 'the task was already taken; reload and retry');
        }
        // The claim is the Cleaner starting: the axis follows it, when the
        // edge is open (a room already marked clean is left alone).
        const housekeeping = new HousekeepingRepository(uow);
        const current = await housekeeping.lockState(taken.roomId);
        if (canTransitionCleaning(current?.state ?? null, 'CLEANING', 'CLEANER')) {
          await housekeeping.transition({
            roomId: taken.roomId,
            from: current?.state ?? null,
            to: 'CLEANING',
            actorAccountId: gate.principal.accountId,
            at: now,
          });
        }
        await recordPlatformAudit(uow, {
          action: 'stay.cleaning_task_claim',
          outcome: 'allowed',
          targetType: 'cleaning_task',
          targetRef: taken.taskId,
          payload: { roomId: taken.roomId },
        });
        const result = cleaningTaskView(taken);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 04 §5.2 (12)–(14): the routine refill and the room marked `Цэвэр`, in
   * one transaction. The Cleaner may only top up what the room's current
   * version targets, and never past that target.
   */
  async complete(
    input: CompleteCleaningInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CleaningTaskView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CLEANER_ACTION,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.cleaning_task_complete', input.idempotencyKey, {
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as CleaningTaskView;
        const tasks = new CleaningTaskRepository(uow);
        const peek = await tasks.byId(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const task = await tasks.lock(input.taskId);
        await authorize();
        if (task === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (task.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        if (task.state !== 'IN_PROGRESS') {
          throw new ApiError('CONFLICT', 'TASK_NOT_CLAIMED: claim the task before completing it');
        }
        if (task.claimedByAccountId !== gate.principal.accountId) {
          throw new ApiError('FORBIDDEN', 'TASK_NOT_YOURS: a Cleaner completes only its own task');
        }
        const now = serverNow(this.deps, uow);
        if (input.refilled.length > 0) {
          await this.routineRefill(uow, task.roomId, input.refilled, gate.principal.accountId);
        }
        const housekeeping = new HousekeepingRepository(uow);
        const current = await housekeeping.lockState(task.roomId);
        if (!canTransitionCleaning(current?.state ?? null, 'CLEAN', 'CLEANER')) {
          throw new ApiError(
            'CONFLICT',
            `ILLEGAL_CLEANING_TRANSITION: ${current?.state ?? 'none'} -> CLEAN`,
          );
        }
        await housekeeping.transition({
          roomId: task.roomId,
          from: current?.state ?? null,
          to: 'CLEAN',
          actorAccountId: gate.principal.accountId,
          at: now,
        });
        const finished = await tasks.finish({
          taskId: task.taskId,
          expectedRevision: task.revision,
          toState: 'COMPLETED',
          at: now,
        });
        if (finished === undefined) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        // doc 04 §4, `RML-DEC-002`: a retiring room waits for its Cleaner; with
        // the task closed the lifecycle may finalize.
        await this.deps.lifecycle.finalizeIfClear(uow, 'ROOM', task.roomId, {
          source: 'stay.cleaning_task_complete',
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.cleaning_task_complete',
          outcome: 'allowed',
          targetType: 'cleaning_task',
          targetRef: task.taskId,
          payload: {
            roomId: task.roomId,
            refilled: input.refilled.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
            })),
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'room',
          aggregateId: task.roomId,
          eventType: 'stay.cleaning_task_completed',
          payload: {
            taskId: task.taskId,
            roomId: task.roomId,
            stayId: task.stayId,
            completedAt: now.toISOString(),
          },
        });
        const result = cleaningTaskView(finished);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * The routine next-stay refill: bounded by the room's own current version and
   * refused entirely while a configuration change is pending (doc 04 §5.2 (12)).
   */
  private async routineRefill(
    uow: UnitOfWork,
    roomId: string,
    refilled: readonly { readonly productId: string; readonly quantity: number }[],
    actorAccountId: string,
  ): Promise<void> {
    const pin = await this.deps.minibar.checkInPin(uow, roomId);
    if (pin.blockers.includes('CONFIGURATION_CHANGE_PENDING')) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'CONFIGURATION_CHANGE_PENDING: this room is waiting for a reconciliation, not a refill',
      );
    }
    if (pin.configuration === null || pin.configuration.mode === 'OFF') {
      throw new ApiError('PRECONDITION_FAILED', 'MINIBAR_OFF: this room has no minibar to refill');
    }
    const targets = new Map(pin.items.map((item) => [item.productId, item.targetQuantity]));
    const held = new Map(pin.stock.map((line) => [line.productId, line.quantity]));
    for (const line of refilled) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new ApiError('VALIDATION_FAILED', 'a refilled quantity is a positive integer');
      }
      const target = targets.get(line.productId);
      if (target === undefined) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'PRODUCT_NOT_IN_CONFIGURATION: this room does not stock that product',
          [{ field: 'refilled', issue: line.productId }],
        );
      }
      const missing = Math.max(0, target - (held.get(line.productId) ?? 0));
      if (line.quantity > missing) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'REFILL_ABOVE_TARGET: a routine refill never puts more than the target in the room',
          [{ field: 'refilled', issue: `${line.productId}: at most ${String(missing)}` }],
        );
      }
      await this.deps.minibar.transferToRoom(uow, {
        roomId,
        productId: line.productId,
        quantity: line.quantity,
        actorAccountId,
      });
    }
  }
}
